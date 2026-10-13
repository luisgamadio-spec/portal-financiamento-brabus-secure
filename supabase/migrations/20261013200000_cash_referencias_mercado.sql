-- Cash Conversion — referências de mercado (Selic, CDI, Focus, IR, FGC, produtos de referência).
-- Uma linha por data de vigência (histórico preservado); a tela e a Brabus IA leem a mais recente.
-- Leitura: qualquer usuário ativo do Portal, só pela função. Gravação: só o Master, só pela função, com auditoria.

create table if not exists public.cash_referencias_mercado (
  id                      uuid primary key default gen_random_uuid(),
  vigencia                date not null unique,           -- data a que as taxas se referem
  fonte                   text not null,
  selic_aa                numeric(7,4) not null check (selic_aa > 0 and selic_aa < 100),
  cdi_aa                  numeric(7,4) not null check (cdi_aa > 0 and cdi_aa < 100),
  cdi_12m_pct             numeric(7,4) not null check (cdi_12m_pct > 0 and cdi_12m_pct < 100),
  cdi_12m_ate             date not null,                  -- fim do período de 12 meses do acumulado
  focus_data              date not null,
  focus_selic             jsonb not null,                 -- [{"fim_de": 2026, "selic_aa": 13.25}, ...] em ordem de ano
  focus_ipca_ano          integer not null,
  focus_ipca_pct          numeric(7,4) not null,
  ir_faixas               jsonb not null,                 -- [{"ate_dias": 180, "aliquota_pct": 22.5}, ..., {"ate_dias": null, "aliquota_pct": 15}]
  fgc_limite_instituicao  numeric(14,2) not null check (fgc_limite_instituicao > 0),
  fgc_teto_total          numeric(14,2) not null check (fgc_teto_total > 0),
  fgc_teto_anos           integer not null check (fgc_teto_anos > 0),
  produtos                jsonb not null,                 -- produtos de referência (ver seed)
  criado_em               timestamptz not null default now(),
  criado_por              text not null
);

alter table public.cash_referencias_mercado enable row level security;
revoke all on table public.cash_referencias_mercado from public, anon, authenticated;

-- Validação do conteúdo (usada pela gravação do Master). Devolve null se ok, ou a mensagem do erro.
create or replace function public._cash_referencias_valida(p jsonb)
returns text
language plpgsql
immutable
set search_path to 'pg_catalog', 'public'
as $function$
declare
  f jsonb; ultimo_ano int := 0; ultimo_dia int := 0; n int := 0; tem_aberta boolean := false;
begin
  if p is null or jsonb_typeof(p) <> 'object' then return 'Dados ausentes.'; end if;
  if coalesce(trim(p->>'fonte'), '') = '' then return 'Informe a fonte.'; end if;
  if (p->>'vigencia') is null or (p->>'cdi_12m_ate') is null or (p->>'focus_data') is null then return 'Informe as datas (vigência, fim do CDI 12 meses, data do Focus).'; end if;
  if (p->>'cdi_aa')::numeric > (p->>'selic_aa')::numeric then return 'CDI acima da Selic: confira os valores.'; end if;
  if jsonb_typeof(p->'focus_selic') <> 'array' or jsonb_array_length(p->'focus_selic') = 0 then return 'Informe a trajetória do Focus.'; end if;
  for f in select * from jsonb_array_elements(p->'focus_selic') loop
    if (f->>'fim_de')::int <= ultimo_ano or not ((f->>'selic_aa')::numeric > 0 and (f->>'selic_aa')::numeric < 100) then
      return 'Focus: anos em ordem crescente e Selic entre 0 e 100.';
    end if;
    ultimo_ano := (f->>'fim_de')::int;
  end loop;
  if jsonb_typeof(p->'ir_faixas') <> 'array' then return 'Informe as faixas de IR.'; end if;
  for f in select * from jsonb_array_elements(p->'ir_faixas') loop
    n := n + 1;
    if tem_aberta then return 'IR: a faixa sem limite de dias deve ser a última.'; end if;
    if not ((f->>'aliquota_pct')::numeric >= 0 and (f->>'aliquota_pct')::numeric < 100) then return 'IR: alíquota inválida.'; end if;
    if f->'ate_dias' is null or f->'ate_dias' = 'null'::jsonb then tem_aberta := true;
    elsif (f->>'ate_dias')::int <= ultimo_dia then return 'IR: faixas em ordem crescente de dias.';
    else ultimo_dia := (f->>'ate_dias')::int; end if;
  end loop;
  if n = 0 or not tem_aberta then return 'IR: a última faixa deve ser sem limite de dias.'; end if;
  if jsonb_typeof(p->'produtos') <> 'array' or jsonb_array_length(p->'produtos') = 0 then return 'Informe os produtos de referência.'; end if;
  for f in select * from jsonb_array_elements(p->'produtos') loop
    if coalesce(f->>'id', '') = '' or coalesce(f->>'nome', '') = '' or (f->>'indexador') not in ('SELIC', 'CDI')
       or not ((f->>'pct_indexador')::numeric > 0 and (f->>'pct_indexador')::numeric <= 200)
       or jsonb_typeof(f->'isento_ir_pf') <> 'boolean' or (f->>'garantia') not in ('SOBERANO', 'FGC') then
      return 'Produto inválido: id, nome, indexador (SELIC/CDI), % do indexador, isento_ir_pf e garantia (SOBERANO/FGC).';
    end if;
  end loop;
  return null;
exception when others then
  return 'Dados em formato inválido: ' || sqlerrm;
end;
$function$;
revoke all on function public._cash_referencias_valida(jsonb) from public, anon, authenticated;

-- Leitura: a referência mais recente já vigente, com a idade em dias e o aviso de desatualizada (mais de 50 dias:
-- o intervalo entre reuniões do Copom chega a 49 dias).
create or replace function public.cash_referencias_mercado()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  r public.cash_referencias_mercado; hoje date := (now() at time zone 'America/Sao_Paulo')::date; dias int;
begin
  if public.current_portal_profile() is null then
    raise exception 'Acesso restrito a usuários do Portal.' using errcode = '42501';
  end if;
  select * into r from public.cash_referencias_mercado where vigencia <= hoje order by vigencia desc limit 1;
  if r.id is null then return null; end if;
  dias := hoje - r.vigencia;
  return jsonb_build_object(
    'vigencia', r.vigencia, 'fonte', r.fonte,
    'selic_aa', r.selic_aa, 'cdi_aa', r.cdi_aa, 'cdi_12m_pct', r.cdi_12m_pct, 'cdi_12m_ate', r.cdi_12m_ate,
    'focus_data', r.focus_data, 'focus_selic', r.focus_selic, 'focus_ipca_ano', r.focus_ipca_ano, 'focus_ipca_pct', r.focus_ipca_pct,
    'ir_faixas', r.ir_faixas,
    'fgc_limite_instituicao', r.fgc_limite_instituicao, 'fgc_teto_total', r.fgc_teto_total, 'fgc_teto_anos', r.fgc_teto_anos,
    'produtos', r.produtos,
    'dias_desde_vigencia', dias, 'desatualizada', dias > 50,
    'atualizado_em', r.criado_em);
end;
$function$;
revoke all on function public.cash_referencias_mercado() from public, anon;
grant execute on function public.cash_referencias_mercado() to authenticated;

-- Gravação: só o Master. Mesma vigência = corrige a linha; vigência nova = nova linha (o histórico fica).
create or replace function public.master_salvar_cash_referencias_mercado(p_dados jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_nome text; v_erro text; v_id uuid;
begin
  if not public.is_master() then
    raise exception 'Acesso exclusivo do perfil Master.' using errcode = '42501';
  end if;
  v_erro := public._cash_referencias_valida(p_dados);
  if v_erro is not null then
    return jsonb_build_object('sucesso', false, 'mensagem', v_erro);
  end if;
  select u.nome into v_nome from public.usuarios u where u.auth_user_id = auth.uid() and u.ativo limit 1;
  insert into public.cash_referencias_mercado (vigencia, fonte, selic_aa, cdi_aa, cdi_12m_pct, cdi_12m_ate, focus_data, focus_selic,
    focus_ipca_ano, focus_ipca_pct, ir_faixas, fgc_limite_instituicao, fgc_teto_total, fgc_teto_anos, produtos, criado_por)
  values ((p_dados->>'vigencia')::date, trim(p_dados->>'fonte'), (p_dados->>'selic_aa')::numeric, (p_dados->>'cdi_aa')::numeric,
    (p_dados->>'cdi_12m_pct')::numeric, (p_dados->>'cdi_12m_ate')::date, (p_dados->>'focus_data')::date, p_dados->'focus_selic',
    (p_dados->>'focus_ipca_ano')::int, (p_dados->>'focus_ipca_pct')::numeric, p_dados->'ir_faixas',
    (p_dados->>'fgc_limite_instituicao')::numeric, (p_dados->>'fgc_teto_total')::numeric, (p_dados->>'fgc_teto_anos')::int,
    p_dados->'produtos', coalesce(v_nome, 'Master'))
  on conflict (vigencia) do update set
    fonte = excluded.fonte, selic_aa = excluded.selic_aa, cdi_aa = excluded.cdi_aa, cdi_12m_pct = excluded.cdi_12m_pct,
    cdi_12m_ate = excluded.cdi_12m_ate, focus_data = excluded.focus_data, focus_selic = excluded.focus_selic,
    focus_ipca_ano = excluded.focus_ipca_ano, focus_ipca_pct = excluded.focus_ipca_pct, ir_faixas = excluded.ir_faixas,
    fgc_limite_instituicao = excluded.fgc_limite_instituicao, fgc_teto_total = excluded.fgc_teto_total,
    fgc_teto_anos = excluded.fgc_teto_anos, produtos = excluded.produtos, criado_em = now(), criado_por = excluded.criado_por
  returning id into v_id;
  perform public.master_admin_audit_event('CASH_REFERENCIAS',
    format('Referências de mercado do Cash Conversion salvas (vigência %s, Selic %s%%, CDI %s%%).',
      p_dados->>'vigencia', p_dados->>'selic_aa', p_dados->>'cdi_aa'), '', '');
  return jsonb_build_object('sucesso', true, 'mensagem', 'Referências salvas.', 'id', v_id);
end;
$function$;
revoke all on function public.master_salvar_cash_referencias_mercado(jsonb) from public, anon;
grant execute on function public.master_salvar_cash_referencias_mercado(jsonb) to authenticated;

-- Carga inicial: Relatório SELIC e Investimentos — Outubro/2026 (13/10/2026).
insert into public.cash_referencias_mercado (vigencia, fonte, selic_aa, cdi_aa, cdi_12m_pct, cdi_12m_ate, focus_data, focus_selic,
  focus_ipca_ano, focus_ipca_pct, ir_faixas, fgc_limite_instituicao, fgc_teto_total, fgc_teto_anos, produtos, criado_por)
values (
  date '2026-10-13',
  'Relatório SELIC e Investimentos — Outubro/2026 (13/10/2026). Fontes: Banco Central (Copom e SGS 432), B3 (Taxa DI), Boletim Focus de 13/10/2026, FGC e Receita Federal.',
  13.75, 13.65, 14.47, date '2026-09-30', date '2026-10-13',
  '[{"fim_de": 2026, "selic_aa": 13.25}, {"fim_de": 2027, "selic_aa": 12.00}]'::jsonb,
  2026, 5.22,
  '[{"ate_dias": 180, "aliquota_pct": 22.5}, {"ate_dias": 360, "aliquota_pct": 20.0}, {"ate_dias": 720, "aliquota_pct": 17.5}, {"ate_dias": null, "aliquota_pct": 15.0}]'::jsonb,
  250000, 1000000, 4,
  '[{"id": "tesouro_selic", "nome": "Tesouro Selic", "indexador": "SELIC", "pct_indexador": 100, "isento_ir_pf": false, "garantia": "SOBERANO"},
    {"id": "cdb_100_cdi", "nome": "CDB 100% do CDI", "indexador": "CDI", "pct_indexador": 100, "isento_ir_pf": false, "garantia": "FGC"},
    {"id": "lci_lca_85_cdi", "nome": "LCI/LCA 85% do CDI", "indexador": "CDI", "pct_indexador": 85, "isento_ir_pf": true, "garantia": "FGC"}]'::jsonb,
  'Carga inicial (migração)')
on conflict (vigencia) do nothing;
