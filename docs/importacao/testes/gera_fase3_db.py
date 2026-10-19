"""Gera o SQL de banco que acompanha a tela nova (nada é aplicado aqui):
  1) lotes VALIDATING sem atividade há 6 h -> ARQUIVADO (sozinho, no início de qualquer importação; linhas preservadas);
  2) begin_import NÃO reabre lote já confirmado (VALIDATED) do mesmo arquivo: recusa com aviso e não mexe em nada;
  3) registro da duração de cada importação (tabela + RPC) com aviso na Auditoria acima de 5 s por chamada ou em falha;
  4) leitura das últimas durações para a tela.
Saída: fase3_db.sql e fase3_db_rollback.sql."""
import os, sys
AQUI = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.join(AQUI, "..", "hpe"))
from rpc import sql
bi = sql("select pg_get_functiondef('public.master_operational_begin_import'::regproc) d")[0]["d"]
def troca(t, a, b):
    assert t.count(a) == 1, a[:60]; return t.replace(a, b)
novo = troca(bi.replace(chr(13) + chr(10), chr(10)), """  select b.id
    into v_batch_id
    from public.portal_import_batches b
   where b.source_type = v_source_type
     and b.source_sha256 = v_sha
   for update;
""", """  -- Fase 3 (19/10/2026): lotes em validação abandonados (sem atividade há 6 h) são arquivados sozinhos.
  -- Nada é apagado: as linhas ficam, o lote só deixa de aparecer como "em validação".
  update public.portal_import_batches a
     set status = 'ARQUIVADO',
         validation_message = format('Arquivado automaticamente: envio iniciado em %s e não concluído em 6 horas.',
           to_char(coalesce(a.ultima_atividade_em, a.created_at) at time zone 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI'))
   where a.status = 'VALIDATING'
     and coalesce(a.ultima_atividade_em, a.created_at) < now() - interval '6 hours'
     and not (a.source_type = v_source_type and a.source_sha256 = v_sha);

  select b.id, b.status, b.completed_at
    into v_batch_id, v_status_existente, v_concluido_existente
    from public.portal_import_batches b
   where b.source_type = v_source_type
     and b.source_sha256 = v_sha
   for update;

  -- Fase 3: o mesmo arquivo de um lote já CONFIRMADO não reabre o lote (reabrir tirava a base oficial do ar
  -- até a nova confirmação e, se o envio falhasse, a base anterior não ficava preservada).
  if v_status_existente = 'VALIDATED' then
    raise exception 'Este arquivo já foi importado e confirmado em %. Nada foi alterado.',
      to_char(v_concluido_existente at time zone 'America/Sao_Paulo', 'DD/MM/YYYY "às" HH24:MI')
      using errcode = 'P0001', hint = 'ARQUIVO_JA_CONFIRMADO';
  end if;
""")
novo = troca(novo, """  v_sha text := lower(trim(coalesce(p_source_sha256, '')));
begin""", """  v_sha text := lower(trim(coalesce(p_source_sha256, '')));
  v_status_existente text;
  v_concluido_existente timestamptz;
begin""")
novo = troca(novo, """      status, imported_by, completed_at
    )
    values (
      v_source_type, trim(p_original_filename), v_sha, p_rows_read,
      'VALIDATING', auth.uid(), null
    )""", """      status, imported_by, completed_at, ultima_atividade_em
    )
    values (
      v_source_type, trim(p_original_filename), v_sha, p_rows_read,
      'VALIDATING', auth.uid(), null, now()
    )""")
novo = troca(novo, """           status = 'VALIDATING',
           completed_at = null""", """           status = 'VALIDATING',
           completed_at = null,
           ultima_atividade_em = now(),
           validation_message = null""")

sql_txt = f"""-- FASE 3 (banco) da importação de bases — 19/10/2026. Desfazer: fase3_db_rollback.sql.

-- 1) situação ARQUIVADO e momento da última atividade do lote
alter table public.portal_import_batches drop constraint portal_import_batches_status_check;
alter table public.portal_import_batches add constraint portal_import_batches_status_check
  check (status = any (array['VALIDATING', 'VALIDATED', 'IMPORTED', 'REJECTED', 'ROLLED_BACK', 'ARQUIVADO']));
alter table public.portal_import_batches add column if not exists ultima_atividade_em timestamptz;

-- 2) begin_import: arquiva abandonados e não reabre lote confirmado
{novo.rstrip()};

-- 3) duração de cada importação
create table if not exists public.portal_import_duracoes (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid references public.portal_import_batches(id),
  source_type text not null check (source_type = any (array['COLABORADORES', 'SALES_CURRENT', 'FINANCE_CURRENT', 'SPF_CURRENT'])),
  arquivo text,
  linhas integer check (linhas >= 0),
  partes integer check (partes >= 0),
  total_ms integer not null check (total_ms >= 0),
  maior_chamada_ms integer not null check (maior_chamada_ms >= 0),
  etapas jsonb,
  resultado text not null check (resultado = any (array['SUCESSO', 'FALHA', 'BLOQUEADA'])),
  erro text,
  alerta boolean not null default false,
  registrado_por uuid not null default auth.uid(),
  criado_em timestamptz not null default now()
);
create index if not exists idx_import_duracoes_criado_em on public.portal_import_duracoes (criado_em desc);
alter table public.portal_import_duracoes enable row level security;
revoke all on table public.portal_import_duracoes from public, anon, authenticated;

create or replace function public.master_operational_registrar_duracao(p_dados jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'pg_catalog', 'public'
as $function$
-- Fase 3/4 (19/10/2026): registra a duração de uma importação (medida pela tela, chamada a chamada).
-- Aviso na Auditoria do Painel Master quando alguma chamada passa de 5 s (o limite do banco é 8 s) ou quando falha.
declare
  c_limite_ms constant integer := 5000;
  v_maior integer := greatest(coalesce((p_dados->>'maior_chamada_ms')::integer, 0), 0);
  v_total integer := greatest(coalesce((p_dados->>'total_ms')::integer, 0), 0);
  v_resultado text := upper(coalesce(p_dados->>'resultado', 'SUCESSO'));
  v_tipo text := upper(coalesce(p_dados->>'source_type', ''));
  v_alerta boolean;
  v_batch uuid;
  v_rotulo text;
begin
  if not public.is_master() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;
  if v_tipo not in ('COLABORADORES', 'SALES_CURRENT', 'FINANCE_CURRENT', 'SPF_CURRENT') or v_resultado not in ('SUCESSO', 'FALHA', 'BLOQUEADA') then
    raise exception 'Dados de duração inválidos.' using errcode = '22023';
  end if;
  -- só aceita lote que existe e é do próprio usuário (ou nenhum, quando a falha foi antes de abrir o lote)
  select b.id into v_batch from public.portal_import_batches b
   where b.id = nullif(p_dados->>'batch_id', '')::uuid and b.imported_by = auth.uid();
  v_alerta := v_maior > c_limite_ms or v_resultado = 'FALHA';
  insert into public.portal_import_duracoes (batch_id, source_type, arquivo, linhas, partes, total_ms, maior_chamada_ms, etapas, resultado, erro, alerta)
  values (v_batch, v_tipo, left(p_dados->>'arquivo', 200), nullif(p_dados->>'linhas', '')::integer, nullif(p_dados->>'partes', '')::integer,
          v_total, v_maior, p_dados->'etapas', v_resultado, left(p_dados->>'erro', 500), v_alerta);
  v_rotulo := case v_tipo when 'SALES_CURRENT' then 'Base 01' when 'FINANCE_CURRENT' then 'Base 02' when 'SPF_CURRENT' then 'Base 03' else 'Colaboradores' end;
  if v_alerta then
    insert into public.auditoria (tipo, descricao, base_origem, resolvido)
    values (case when v_resultado = 'FALHA' then 'IMPORTACAO_FALHOU' else 'IMPORTACAO_LENTA' end,
            left(format('%s (%s): %s em %s s no total; maior chamada %s s (aviso acima de %s s; o banco corta em 8 s).%s',
              v_rotulo, coalesce(p_dados->>'arquivo', '—'), case v_resultado when 'FALHA' then 'FALHOU' when 'BLOQUEADA' then 'bloqueada pelas travas' else 'concluída' end,
              round(v_total / 1000.0, 1), round(v_maior / 1000.0, 1), c_limite_ms / 1000,
              case when v_resultado = 'FALHA' then ' Erro: ' || coalesce(left(p_dados->>'erro', 200), '—') else '' end), 2000),
            'Gestão de Bases', false);
  end if;
  return jsonb_build_object('alerta', v_alerta, 'limite_ms', c_limite_ms, 'maior_chamada_ms', v_maior);
end;
$function$;
revoke all on function public.master_operational_registrar_duracao(jsonb) from public, anon;
grant execute on function public.master_operational_registrar_duracao(jsonb) to authenticated;

create or replace function public.master_operational_list_duracoes(p_limite integer default 20)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to 'pg_catalog', 'public'
as $function$
begin
  if not public.is_master() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(to_jsonb(x) order by x.criado_em desc) from (
      select d.source_type, d.arquivo, d.linhas, d.partes, d.total_ms, d.maior_chamada_ms, d.resultado, d.erro, d.alerta, d.criado_em
      from public.portal_import_duracoes d order by d.criado_em desc limit least(greatest(coalesce(p_limite, 20), 1), 100)) x
  ), '[]'::jsonb);
end;
$function$;
revoke all on function public.master_operational_list_duracoes(integer) from public, anon;
grant execute on function public.master_operational_list_duracoes(integer) to authenticated;
"""
open(os.path.join(AQUI, "fase3_db.sql"), "w", encoding="utf-8", newline="\n").write(sql_txt)
rb = f"""-- Desfaz a FASE 3 (banco). Os lotes que estiverem ARQUIVADO voltam a VALIDATING antes de recolocar a regra antiga.
drop function if exists public.master_operational_list_duracoes(integer);
drop function if exists public.master_operational_registrar_duracao(jsonb);
drop table if exists public.portal_import_duracoes;
{bi.rstrip()};
update public.portal_import_batches set status = 'VALIDATING' where status = 'ARQUIVADO';
alter table public.portal_import_batches drop column if exists ultima_atividade_em;
alter table public.portal_import_batches drop constraint portal_import_batches_status_check;
alter table public.portal_import_batches add constraint portal_import_batches_status_check
  check (status = any (array['VALIDATING', 'VALIDATED', 'IMPORTED', 'REJECTED', 'ROLLED_BACK']));
"""
open(os.path.join(AQUI, "fase3_db_rollback.sql"), "w", encoding="utf-8", newline="\n").write(rb)
print("ok")
