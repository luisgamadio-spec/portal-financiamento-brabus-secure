-- Avaliações de Seminovos — Fase 2: vistoria (28/10/2026)
-- Só objetos NOVOS (novos_f2.sql). Nenhuma função ou tabela existente muda.
-- Backup: avaliacoes_fase2_backup_antes.sql | Desfazer: avaliacoes_fase2_desfazer.sql
begin;

do $trava$
begin
  if md5(pg_get_functiondef('public._aval_contexto()'::regprocedure)) <> '6b54a9b8e39f28a7b6f0ac9be2f1b478' then
    raise exception 'TRAVA: public._aval_contexto() mudou desde a conferência -- conferir a mudança e regenerar a migração';
  end if;
  if md5(pg_get_functiondef('public._aval_carregar(uuid,jsonb)'::regprocedure)) <> '54419227f050155e385c8ecb30433793' then
    raise exception 'TRAVA: public._aval_carregar(uuid,jsonb) mudou desde a conferência -- conferir a mudança e regenerar a migração';
  end if;
  if md5(pg_get_functiondef('public.portal_modulos_permitidos()'::regprocedure)) <> '59abb8b9f5298478c8fb7334edd66c78' then
    raise exception 'TRAVA: public.portal_modulos_permitidos() mudou desde a conferência -- conferir a mudança e regenerar a migração';
  end if;
  if md5(pg_get_functiondef('public.aval_contexto()'::regprocedure)) <> 'bda1697da36d46cf36827a09e23e943c' then
    raise exception 'TRAVA: public.aval_contexto() mudou desde a conferência -- conferir a mudança e regenerar a migração';
  end if;
  if md5(pg_get_functiondef('public.aval_obter(uuid)'::regprocedure)) <> '06b5f8340c634bc6f5105d8fc64fa19b' then
    raise exception 'TRAVA: public.aval_obter(uuid) mudou desde a conferência -- conferir a mudança e regenerar a migração';
  end if;
  if md5(pg_get_functiondef('public.aval_salvar_identificacao(uuid,jsonb)'::regprocedure)) <> '2dc807a3a969f5f065004b5b2b792e18' then
    raise exception 'TRAVA: public.aval_salvar_identificacao(uuid,jsonb) mudou desde a conferência -- conferir a mudança e regenerar a migração';
  end if;
  if exists (select 1 from pg_class where relnamespace = 'public'::regnamespace and relname in ('aval_tabela_reparos', 'aval_vistorias', 'aval_avarias', 'aval_fotos'))
     or exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname in ('_aval_checklist_opcoes', '_aval_peca_info', '_aval_pode_editar', '_aval_tabela_vigente', '_aval_tipos_avaria', '_aval_vistoria_json', 'aval_foto_preparar', 'aval_foto_registrar', 'aval_foto_remover', 'aval_fotos_listar', 'aval_master_salvar_reparos', 'aval_reparos_listar', 'aval_vistoria_concluir', 'aval_vistoria_obter', 'aval_vistoria_salvar'))
     or exists (select 1 from storage.buckets where id = 'avaliacoes-fotos') then
    raise exception 'TRAVA: objetos da Fase 2 já existem';
  end if;
end $trava$;

-- ============================================================================
-- Avaliações de Seminovos — Fase 2: vistoria (objetos NOVOS; nenhum existente muda)
-- Avarias por peça (tipo e gravidade), fotos num bucket privado, checklist e a
-- tabela de custos de reparo (versões, editável pelo Master; começa "a definir").
-- Mesmo padrão da Fase 1: tabelas fechadas para a API (RLS ligada, sem regra, sem
-- privilégio) e funções SECURITY DEFINER que conferem perfil, loja e módulo.
-- Fotos: só a Edge Function avaliacao-fotos lê/grava o bucket (chave de serviço),
-- depois de a função aval_foto_preparar conferir o acesso com o JWT de quem chama.
-- ============================================================================

-- ---------- tabelas ----------------------------------------------------------

create table public.aval_tabela_reparos (
  id uuid primary key default gen_random_uuid(),
  versao integer not null unique check (versao > 0),
  itens jsonb not null,
  observacao text,
  vigente_desde timestamptz not null default now(),
  criado_por uuid references public.usuarios(id),
  criado_em timestamptz not null default now()
);
comment on table public.aval_tabela_reparos is
  'Custos de reparo por item × gravidade (LEVE/MEDIA/GRAVE), em versões. Vigente = maior versão. Valor nulo = a definir.';

create table public.aval_vistorias (
  avaliacao_id uuid primary key references public.aval_avaliacoes(id),
  checklist jsonb not null default '{}'::jsonb,
  concluida_em timestamptz,
  concluida_por uuid references public.usuarios(id),
  atualizado_em timestamptz not null default now(),
  atualizado_por uuid references public.usuarios(id)
);

-- id gerado no celular (uuid): o mesmo rascunho pode ser reenviado sem duplicar
create table public.aval_avarias (
  id uuid primary key,
  avaliacao_id uuid not null references public.aval_avaliacoes(id),
  peca text not null,
  grupo text not null,
  item text not null,
  tipo text not null,
  gravidade text not null check (gravidade in ('LEVE','MEDIA','GRAVE')),
  observacao text check (length(observacao) <= 300),
  criado_por uuid references public.usuarios(id),
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create index aval_avarias_avaliacao_idx on public.aval_avarias (avaliacao_id);

create table public.aval_fotos (
  id uuid primary key,
  avaliacao_id uuid not null references public.aval_avaliacoes(id),
  avaria_id uuid references public.aval_avarias(id) on delete set null,
  caminho text not null unique,
  bytes integer check (bytes > 0 and bytes <= 2097152),
  status text not null default 'PENDENTE' check (status in ('PENDENTE','ENVIADA','REMOVIDA')),
  criado_por uuid references public.usuarios(id),
  criado_em timestamptz not null default now(),
  enviada_em timestamptz
);
create index aval_fotos_avaliacao_idx on public.aval_fotos (avaliacao_id, status);
create index aval_fotos_avaria_idx on public.aval_fotos (avaria_id);

do $$
declare t text;
begin
  foreach t in array array['aval_tabela_reparos','aval_vistorias','aval_avarias','aval_fotos'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
  end loop;
end $$;

-- tabela inicial: todos os valores "a definir" (o Luis preenche com a oficina)
insert into public.aval_tabela_reparos (versao, itens, observacao)
select 1, jsonb_object_agg(i, jsonb_build_object('LEVE', null, 'MEDIA', null, 'GRAVE', null)),
       'Versão inicial: todos os custos a definir (preencher com a oficina).'
  from unnest(array['Porta','Para-lama','Capô','Teto','Tampa','Lateral traseira / caçamba','Caçamba (assoalho)','Para-choque',
                    'Coluna','Para-brisa','Vidro traseiro','Vidro lateral','Farol','Lanterna','Grade','Retrovisor','Roda','Pneu']) i;

-- bucket privado das fotos: sem regra de acesso em storage.objects = só a chave de serviço lê/grava
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avaliacoes-fotos', 'avaliacoes-fotos', false, 2097152, array['image/jpeg']);

-- ---------- funções internas -------------------------------------------------

-- Peça da vistoria -> grupo (tipos de avaria) e item da tabela de reparos. Nome fora da lista = nulo (recusado).
create or replace function public._aval_peca_info(p text)
returns jsonb language sql immutable set search_path = pg_catalog, public as $$
  select case
    when p ~ '^Porta (dianteira|traseira) (esquerda|direita)$' then '{"grupo":"lataria","item":"Porta"}'
    when p ~ '^Para-lama dianteiro (esquerdo|direito)$' then '{"grupo":"lataria","item":"Para-lama"}'
    when p = 'Capô' then '{"grupo":"lataria","item":"Capô"}'
    when p = 'Teto' then '{"grupo":"lataria","item":"Teto"}'
    when p in ('Tampa traseira', 'Tampa do porta-malas', 'Tampa da caçamba') then '{"grupo":"lataria","item":"Tampa"}'
    when p ~ '^(Lateral traseira|Caçamba \(lateral\)) (esquerda|direita)$' then '{"grupo":"lataria","item":"Lateral traseira / caçamba"}'
    when p = 'Caçamba (assoalho)' then '{"grupo":"lataria","item":"Caçamba (assoalho)"}'
    when p ~ '^Para-choque (dianteiro|traseiro)$' then '{"grupo":"para-choque","item":"Para-choque"}'
    when p ~ '^Coluna [ABC] (esquerda|direita)$' then '{"grupo":"estrutura","item":"Coluna"}'
    when p = 'Para-brisa' then '{"grupo":"vidro","item":"Para-brisa"}'
    when p = 'Vidro traseiro' then '{"grupo":"vidro","item":"Vidro traseiro"}'
    when p ~ '^Vidro (da porta (dianteira|traseira) (esquerda|direita)|lateral traseiro (esquerdo|direito))$' then '{"grupo":"vidro","item":"Vidro lateral"}'
    when p ~ '^Farol (esquerdo|direito)$' then '{"grupo":"farol","item":"Farol"}'
    when p ~ '^Lanterna traseira (esquerda|direita)$' then '{"grupo":"farol","item":"Lanterna"}'
    when p = 'Grade' then '{"grupo":"grade","item":"Grade"}'
    when p ~ '^Retrovisor (esquerdo|direito)$' then '{"grupo":"retrovisor","item":"Retrovisor"}'
    when p ~ '^Roda (dianteira|traseira) (esquerda|direita)$' then '{"grupo":"roda","item":"Roda"}'
    when p ~ '^Pneu ((dianteiro|traseiro) (esquerdo|direito)|estepe)$' then '{"grupo":"pneu","item":"Pneu"}'
  end::jsonb
$$;

-- Tipos de avaria aceitos em cada grupo de peça (os mesmos da tela).
create or replace function public._aval_tipos_avaria(p_grupo text)
returns text[] language sql immutable set search_path = pg_catalog, public as $$
  select case p_grupo
    when 'lataria' then array['Risco','Amassado','Pintura danificada','Repintura','Ferrugem']
    when 'para-choque' then array['Risco','Amassado','Trinca/quebra','Pintura danificada','Repintura']
    when 'vidro' then array['Risco','Trinca/quebra']
    when 'farol' then array['Trinca/quebra','Embaçado/infiltração','Opaco/amarelado','Faltando']
    when 'grade' then array['Risco','Trinca/quebra','Faltando']
    when 'roda' then array['Risco','Empeno','Faltando']
    when 'pneu' then array['Desgaste','Corte/bolha','Remendo','Faltando']
    when 'retrovisor' then array['Risco','Trinca/quebra','Faltando']
    when 'estrutura' then array['Amassado','Trinca/solda','Repintura']
  end
$$;

-- Checklist depois da lataria: pergunta -> respostas aceitas.
create or replace function public._aval_checklist_opcoes()
returns jsonb language sql immutable set search_path = pg_catalog, public as $$
  select '{"interior":["BOM","REGULAR","RUIM"],"luzes_painel":["NENHUMA","ACESAS"],"ar_condicionado":["GELA","FRACO","NAO_FUNCIONA"],
           "chave_reserva":["TEM","NAO_TEM"],"manual":["TEM","NAO_TEM"],"revisoes":["EM_DIA","PARCIAIS","SEM_COMPROVACAO"]}'::jsonb
$$;

create or replace function public._aval_tabela_vigente()
returns public.aval_tabela_reparos
language sql stable security definer
set search_path = pg_catalog, public
as $$ select * from public.aval_tabela_reparos order by versao desc limit 1 $$;

-- Pode alterar a vistoria: quem cria avaliações, com a avaliação em rascunho ou devolvida.
create or replace function public._aval_pode_editar(p_av public.aval_avaliacoes, p_ctx jsonb)
returns boolean language sql immutable set search_path = pg_catalog, public as $$
  select coalesce((p_ctx->>'pode_criar')::boolean, false) and p_av.status in ('RASCUNHO', 'DEVOLVIDA')
$$;

-- Estado da vistoria para a tela: avarias com o custo da tabela vigente, fotos, checklist e pendências.
create or replace function public._aval_vistoria_json(p_av public.aval_avaliacoes, p_ctx jsonb)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
declare
  v_tab public.aval_tabela_reparos := public._aval_tabela_vigente();
  v_vis public.aval_vistorias%rowtype;
  v_avarias jsonb;
  v_total numeric;
  v_a_definir integer;
  v_sem_foto integer;
  v_check_ok integer;
begin
  select * into v_vis from public.aval_vistorias where avaliacao_id = p_av.id;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', a.id, 'peca', a.peca, 'grupo', a.grupo, 'item', a.item, 'tipo', a.tipo, 'gravidade', a.gravidade,
           'observacao', a.observacao, 'custo', (v_tab.itens->a.item->>a.gravidade)::numeric,
           'fotos', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'status', f.status) order by f.criado_em)
                                from public.aval_fotos f where f.avaria_id = a.id and f.status <> 'REMOVIDA'), '[]'::jsonb))
           order by a.criado_em, a.id), '[]'::jsonb),
         sum((v_tab.itens->a.item->>a.gravidade)::numeric),
         count(*) filter (where (v_tab.itens->a.item->>a.gravidade) is null),
         count(*) filter (where a.gravidade in ('MEDIA','GRAVE')
                            and not exists (select 1 from public.aval_fotos f where f.avaria_id = a.id and f.status = 'ENVIADA'))
    into v_avarias, v_total, v_a_definir, v_sem_foto
    from public.aval_avarias a where a.avaliacao_id = p_av.id;
  select count(*) into v_check_ok from jsonb_object_keys(public._aval_checklist_opcoes()) k
   where coalesce(v_vis.checklist, '{}'::jsonb) ? k;
  return jsonb_build_object(
    'avaliacao_id', p_av.id, 'carroceria', p_av.carroceria, 'status', p_av.status,
    'pode_editar', public._aval_pode_editar(p_av, p_ctx),
    'avarias', v_avarias,
    'checklist', coalesce(v_vis.checklist, '{}'::jsonb),
    'concluida_em', v_vis.concluida_em,
    'tabela_versao', v_tab.versao,
    -- total só quando todos os custos existem; senão "a definir" (nunca um número parcial)
    'total_reparos', case when v_a_definir = 0 then coalesce(v_total, 0) end,
    'custos_a_definir', v_a_definir,
    'avarias_sem_foto', v_sem_foto,
    'checklist_respondidos', v_check_ok,
    'checklist_total', (select count(*) from jsonb_object_keys(public._aval_checklist_opcoes())),
    'fotos_gerais', coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'status', f.status) order by f.criado_em)
                                from public.aval_fotos f where f.avaliacao_id = p_av.id and f.avaria_id is null and f.status <> 'REMOVIDA'), '[]'::jsonb));
end $$;

-- ---------- funções da tela --------------------------------------------------

create or replace function public.aval_vistoria_obter(p_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
declare
  v_ctx jsonb := public._aval_contexto();
  v public.aval_avaliacoes%rowtype := public._aval_carregar(p_id, v_ctx);
begin
  return public._aval_vistoria_json(v, v_ctx);
end $$;

-- Salva o rascunho inteiro da vistoria (o que o celular tem): avarias que sumiram são apagadas
-- (as fotos delas ficam marcadas REMOVIDA), as outras são criadas/atualizadas pelo id do celular.
-- Qualquer mudança reabre uma vistoria já concluída.
create or replace function public.aval_vistoria_salvar(p_id uuid, p_estado jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  v_ctx jsonb := public._aval_contexto();
  v_uid uuid := (v_ctx->>'usuario_id')::uuid;
  v public.aval_avaliacoes%rowtype := public._aval_carregar(p_id, v_ctx);
  v_opc jsonb := public._aval_checklist_opcoes();
  v_vis public.aval_vistorias%rowtype;
  v_x jsonb;
  v_info jsonb;
  v_ids uuid[] := array[]::uuid[];
  v_id uuid;
  v_grav text;
  v_obs text;
  v_check jsonb := '{}'::jsonb;
  v_k text;
  v_mudou boolean := false;
  v_n integer;
begin
  if not public._aval_pode_editar(v, v_ctx) then
    raise exception 'Só é possível alterar a vistoria de avaliações em rascunho ou devolvidas.' using errcode = '22023';
  end if;
  if v.carroceria is null then
    raise exception 'Informe a carroceria na identificação antes da vistoria.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_estado) is distinct from 'object' or jsonb_typeof(coalesce(p_estado->'avarias', '[]'::jsonb)) <> 'array' then
    raise exception 'Rascunho da vistoria inválido.' using errcode = '22023';
  end if;
  if jsonb_array_length(coalesce(p_estado->'avarias', '[]'::jsonb)) > 150 then
    raise exception 'Muitas avarias numa avaliação (máximo 150).' using errcode = '22023';
  end if;

  -- checklist: só perguntas e respostas conhecidas
  if jsonb_typeof(coalesce(p_estado->'checklist', '{}'::jsonb)) <> 'object' then
    raise exception 'Checklist inválido.' using errcode = '22023';
  end if;
  for v_k in select jsonb_object_keys(coalesce(p_estado->'checklist', '{}'::jsonb)) loop
    if not (v_opc ? v_k) or not (v_opc->v_k ? (p_estado->'checklist'->>v_k)) then
      raise exception 'Resposta inválida no checklist (%).', v_k using errcode = '22023';
    end if;
    v_check := v_check || jsonb_build_object(v_k, p_estado->'checklist'->>v_k);
  end loop;

  -- avarias: valida tudo antes de gravar
  for v_x in select value from jsonb_array_elements(coalesce(p_estado->'avarias', '[]'::jsonb)) loop
    begin
      v_id := (v_x->>'id')::uuid;
    exception when others then
      raise exception 'Avaria sem identificador válido.' using errcode = '22023';
    end;
    if v_id is null or v_id = any(v_ids) then
      raise exception 'Avaria repetida ou sem identificador.' using errcode = '22023';
    end if;
    v_info := public._aval_peca_info(v_x->>'peca');
    if v_info is null then
      raise exception 'Peça desconhecida: %.', left(coalesce(v_x->>'peca', ''), 60) using errcode = '22023';
    end if;
    if not ((v_x->>'tipo') = any(public._aval_tipos_avaria(v_info->>'grupo'))) then
      raise exception 'Tipo de avaria % não vale para %.', left(coalesce(v_x->>'tipo', ''), 40), v_x->>'peca' using errcode = '22023';
    end if;
    if (v_x->>'gravidade') is null or (v_x->>'gravidade') not in ('LEVE','MEDIA','GRAVE') then
      raise exception 'Gravidade inválida.' using errcode = '22023';
    end if;
    if length(coalesce(v_x->>'observacao', '')) > 300 then
      raise exception 'Observação da avaria com mais de 300 caracteres.' using errcode = '22023';
    end if;
    if exists (select 1 from public.aval_avarias where id = v_id and avaliacao_id <> v.id) then
      raise exception 'Avaria de outra avaliação.' using errcode = '22023';
    end if;
    v_ids := array_append(v_ids, v_id);
  end loop;

  -- apaga as que saíram (fotos delas: REMOVIDA)
  update public.aval_fotos set status = 'REMOVIDA'
   where avaliacao_id = v.id and status <> 'REMOVIDA'
     and avaria_id in (select id from public.aval_avarias where avaliacao_id = v.id and not (id = any(v_ids)));
  delete from public.aval_avarias where avaliacao_id = v.id and not (id = any(v_ids));
  get diagnostics v_n = row_count;
  v_mudou := v_n > 0;

  for v_x in select value from jsonb_array_elements(coalesce(p_estado->'avarias', '[]'::jsonb)) loop
    v_info := public._aval_peca_info(v_x->>'peca');
    v_grav := v_x->>'gravidade';
    v_obs := nullif(trim(coalesce(v_x->>'observacao', '')), '');
    insert into public.aval_avarias (id, avaliacao_id, peca, grupo, item, tipo, gravidade, observacao, criado_por)
    values ((v_x->>'id')::uuid, v.id, v_x->>'peca', v_info->>'grupo', v_info->>'item', v_x->>'tipo', v_grav, v_obs, v_uid)
    on conflict (id) do update set peca = excluded.peca, grupo = excluded.grupo, item = excluded.item, tipo = excluded.tipo,
                                   gravidade = excluded.gravidade, observacao = excluded.observacao, atualizado_em = now()
     where (aval_avarias.peca, aval_avarias.tipo, aval_avarias.gravidade, coalesce(aval_avarias.observacao, ''))
           is distinct from (excluded.peca, excluded.tipo, excluded.gravidade, coalesce(excluded.observacao, ''));
    get diagnostics v_n = row_count;
    v_mudou := v_mudou or v_n > 0;
  end loop;

  select * into v_vis from public.aval_vistorias where avaliacao_id = v.id;
  if v_vis.avaliacao_id is null then
    insert into public.aval_vistorias (avaliacao_id, checklist, atualizado_por) values (v.id, v_check, v_uid);
    insert into public.aval_eventos (avaliacao_id, usuario_id, tipo) values (v.id, v_uid, 'VISTORIA_INICIADA');
  elsif v_mudou or v_vis.checklist is distinct from v_check then
    update public.aval_vistorias set checklist = v_check, atualizado_em = now(), atualizado_por = v_uid,
                                     concluida_em = null, concluida_por = null
     where avaliacao_id = v.id;
    if v_vis.concluida_em is not null then
      insert into public.aval_eventos (avaliacao_id, usuario_id, tipo) values (v.id, v_uid, 'VISTORIA_REABERTA');
    end if;
  end if;
  update public.aval_avaliacoes set atualizado_em = now() where id = v.id;
  return public._aval_vistoria_json((select a from public.aval_avaliacoes a where a.id = v.id), v_ctx);
end $$;

-- Conclui a vistoria: checklist completo e foto enviada em toda avaria média ou grave.
create or replace function public.aval_vistoria_concluir(p_id uuid)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  v_ctx jsonb := public._aval_contexto();
  v_uid uuid := (v_ctx->>'usuario_id')::uuid;
  v public.aval_avaliacoes%rowtype := public._aval_carregar(p_id, v_ctx);
  v_est jsonb;
begin
  if not public._aval_pode_editar(v, v_ctx) then
    raise exception 'Só é possível concluir a vistoria de avaliações em rascunho ou devolvidas.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.aval_vistorias where avaliacao_id = v.id) then
    raise exception 'A vistoria ainda não foi feita.' using errcode = '22023';
  end if;
  v_est := public._aval_vistoria_json(v, v_ctx);
  if (v_est->>'checklist_respondidos')::int < (v_est->>'checklist_total')::int then
    raise exception 'Responda todo o checklist antes de concluir.' using errcode = '22023';
  end if;
  if (v_est->>'avarias_sem_foto')::int > 0 then
    raise exception 'Falta foto em % avaria(s) média(s) ou grave(s).', v_est->>'avarias_sem_foto' using errcode = '22023';
  end if;
  update public.aval_vistorias set concluida_em = now(), concluida_por = v_uid where avaliacao_id = v.id;
  insert into public.aval_eventos (avaliacao_id, usuario_id, tipo, detalhe)
  values (v.id, v_uid, 'VISTORIA_CONCLUIDA', jsonb_build_object('avarias', jsonb_array_length(v_est->'avarias'),
          'tabela_versao', v_est->'tabela_versao', 'total_reparos', v_est->'total_reparos'));
  update public.aval_avaliacoes set atualizado_em = now() where id = v.id;
  return public._aval_vistoria_json(v, v_ctx);
end $$;

-- ---------- fotos (chamadas pela Edge Function avaliacao-fotos) ---------------

-- 1º passo, com o JWT de quem chama: confere acesso e reserva o caminho no bucket.
create or replace function public.aval_foto_preparar(p_avaliacao uuid, p_avaria uuid, p_foto uuid, p_bytes integer)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  v_ctx jsonb := public._aval_contexto();
  v_uid uuid := (v_ctx->>'usuario_id')::uuid;
  v public.aval_avaliacoes%rowtype := public._aval_carregar(p_avaliacao, v_ctx);
  v_f public.aval_fotos%rowtype;
  c_max_fotos constant integer := 80;
begin
  if not public._aval_pode_editar(v, v_ctx) then
    raise exception 'Só é possível enviar fotos de avaliações em rascunho ou devolvidas.' using errcode = '22023';
  end if;
  if p_foto is null or p_bytes is null or p_bytes <= 0 or p_bytes > 2097152 then
    raise exception 'Foto inválida (máximo 2 MB).' using errcode = '22023';
  end if;
  if p_avaria is not null and not exists (select 1 from public.aval_avarias where id = p_avaria and avaliacao_id = v.id) then
    raise exception 'A avaria desta foto ainda não foi salva.' using errcode = '22023';
  end if;
  select * into v_f from public.aval_fotos where id = p_foto;
  if v_f.id is not null then
    if v_f.avaliacao_id <> v.id then
      raise exception 'Foto de outra avaliação.' using errcode = '22023';
    end if;
    return jsonb_build_object('caminho', v_f.caminho, 'ja_enviada', v_f.status = 'ENVIADA');
  end if;
  if (select count(*) from public.aval_fotos where avaliacao_id = v.id and status <> 'REMOVIDA') >= c_max_fotos then
    raise exception 'Limite de % fotos por avaliação.', c_max_fotos using errcode = '54000';
  end if;
  insert into public.aval_fotos (id, avaliacao_id, avaria_id, caminho, criado_por)
  values (p_foto, v.id, p_avaria, v.id::text || '/' || p_foto::text || '.jpg', v_uid)
  returning * into v_f;
  return jsonb_build_object('caminho', v_f.caminho, 'ja_enviada', false);
end $$;

-- 2º passo, só com a chave de serviço, depois de o arquivo estar no bucket.
create or replace function public.aval_foto_registrar(p_foto uuid, p_bytes integer)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
begin
  update public.aval_fotos set status = 'ENVIADA', bytes = p_bytes, enviada_em = now()
   where id = p_foto and status = 'PENDENTE';
  return jsonb_build_object('id', p_foto, 'status', (select status from public.aval_fotos where id = p_foto));
end $$;

-- Fotos que quem chama pode ver (a Edge Function gera links temporários para estes caminhos).
create or replace function public.aval_fotos_listar(p_id uuid)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
declare
  v_ctx jsonb := public._aval_contexto();
  v public.aval_avaliacoes%rowtype := public._aval_carregar(p_id, v_ctx);
begin
  return coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'avaria_id', f.avaria_id, 'caminho', f.caminho) order by f.criado_em)
                     from public.aval_fotos f where f.avaliacao_id = v.id and f.status = 'ENVIADA'), '[]'::jsonb);
end $$;

create or replace function public.aval_foto_remover(p_foto uuid)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  v_ctx jsonb := public._aval_contexto();
  v_f public.aval_fotos%rowtype;
  v public.aval_avaliacoes%rowtype;
begin
  select * into v_f from public.aval_fotos where id = p_foto;
  if v_f.id is null then
    raise exception 'Foto não encontrada.' using errcode = 'P0002';
  end if;
  v := public._aval_carregar(v_f.avaliacao_id, v_ctx);
  if not public._aval_pode_editar(v, v_ctx) then
    raise exception 'Só é possível remover fotos de avaliações em rascunho ou devolvidas.' using errcode = '22023';
  end if;
  update public.aval_fotos set status = 'REMOVIDA' where id = v_f.id;
  update public.aval_vistorias set concluida_em = null, concluida_por = null, atualizado_em = now()
   where avaliacao_id = v.id and concluida_em is not null;
  return public._aval_vistoria_json(v, v_ctx);
end $$;

-- ---------- tabela de reparos (Master) ----------------------------------------

create or replace function public.aval_reparos_listar()
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog, public
as $$
declare v_ctx jsonb := public._aval_contexto();
begin
  if not coalesce((v_ctx->>'pode_regras')::boolean, false) then
    raise exception 'Tabela de reparos: acesso exclusivo do Master.' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('versao', t.versao, 'itens', t.itens, 'observacao', t.observacao,
                                                       'vigente_desde', t.vigente_desde, 'criado_por', u.nome) order by t.versao desc)
                     from public.aval_tabela_reparos t left join public.usuarios u on u.id = t.criado_por), '[]'::jsonb);
end $$;

create or replace function public.aval_master_salvar_reparos(p_itens jsonb, p_observacao text)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog, public
as $$
declare
  v_ctx jsonb := public._aval_contexto();
  v_base jsonb := (public._aval_tabela_vigente()).itens;
  v_item text;
  v_g text;
  v_raw text;
  v_val numeric;
  v_novo jsonb := '{}'::jsonb;
  v_linha jsonb;
  v_versao integer;
begin
  if not coalesce((v_ctx->>'pode_regras')::boolean, false) then
    raise exception 'Tabela de reparos: acesso exclusivo do Master.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_itens) is distinct from 'object' then
    raise exception 'Tabela inválida.' using errcode = '22023';
  end if;
  -- só os itens da tabela (a lista não muda pela tela)
  for v_item in select jsonb_object_keys(v_base) loop
    v_linha := '{}'::jsonb;
    foreach v_g in array array['LEVE','MEDIA','GRAVE'] loop
      v_raw := nullif(trim(coalesce(p_itens->v_item->>v_g, '')), '');
      if v_raw is null then
        v_linha := v_linha || jsonb_build_object(v_g, null);
        continue;
      end if;
      begin
        v_val := v_raw::numeric;
      exception when others then
        raise exception 'Valor inválido em % (%).', v_item, v_g using errcode = '22023';
      end;
      if v_val < 0 or v_val > 200000 then
        raise exception 'Valor fora da faixa em % (%).', v_item, v_g using errcode = '22023';
      end if;
      v_linha := v_linha || jsonb_build_object(v_g, round(v_val, 2));
    end loop;
    v_novo := v_novo || jsonb_build_object(v_item, v_linha);
  end loop;
  select coalesce(max(versao), 0) + 1 into v_versao from public.aval_tabela_reparos;
  insert into public.aval_tabela_reparos (versao, itens, observacao, criado_por)
  values (v_versao, v_novo, nullif(trim(coalesce(p_observacao, '')), ''), (v_ctx->>'usuario_id')::uuid);
  insert into public.auditoria (tipo, descricao, base_origem, vendedor, cpf, loja, resolvido)
  values ('AVAL_TABELA_REPAROS', format('Tabela de reparos das Avaliações: versão %s criada por %s', v_versao, v_ctx->>'nome'),
          'Avaliações de Seminovos', v_ctx->>'nome', '', null, true);
  return jsonb_build_object('versao', v_versao, 'itens', v_novo);
end $$;

-- ---------- quem executa o quê ----------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'public._aval_peca_info(text)', 'public._aval_tipos_avaria(text)', 'public._aval_checklist_opcoes()',
    'public._aval_tabela_vigente()', 'public._aval_pode_editar(public.aval_avaliacoes, jsonb)',
    'public._aval_vistoria_json(public.aval_avaliacoes, jsonb)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  foreach f in array array[
    'public.aval_vistoria_obter(uuid)', 'public.aval_vistoria_salvar(uuid, jsonb)', 'public.aval_vistoria_concluir(uuid)',
    'public.aval_foto_preparar(uuid, uuid, uuid, integer)', 'public.aval_fotos_listar(uuid)', 'public.aval_foto_remover(uuid)',
    'public.aval_reparos_listar()', 'public.aval_master_salvar_reparos(jsonb, text)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  revoke all on function public.aval_foto_registrar(uuid, integer) from public, anon, authenticated;
  grant execute on function public.aval_foto_registrar(uuid, integer) to service_role;
end $$;

commit;
