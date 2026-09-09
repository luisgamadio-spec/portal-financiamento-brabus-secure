-- RH-5C -- Governed commission authority for the live (open-period)
-- "Comissão do Gestor de F&I" view.
--
-- *** DRAFTED ONLY. NOT APPLIED. ***
-- This file was written during RH-5C's forensic/design phase and is
-- committed to disk for review, but was deliberately NOT run against
-- the live database (`supabase db push` / equivalent) in this Wave.
-- Real commission logic affecting real payouts warrants an explicit
-- human go-ahead before it touches production, even though this
-- Wave's own brief pre-authorizes exactly this kind of write under
-- strict conditions (see the RH-5C final report, section 20/21).
--
-- SCOPE: moves V1's calcGestorFIGrupo() (portal-app.js:6252-6284) --
-- today 100% client-side JavaScript, with 3 literal, non-configurable
-- constants (0.0016, 0.0030, 30) and a single hardcoded beneficiary
-- UUID (GESTOR_FI_USUARIO_ID_SEGURO, portal-app.js:6291) -- into
-- governed server authority, for the CURRENT/open period only.
-- Historical (closed) periods already have this data as real, frozen
-- snapshot_comissoes rows (perfil='GESTOR F&I') written by V1's own
-- close pipeline -- confirmed live: 19 such rows exist across 19 real
-- closings. Nothing about historical data changes here; RH-5C's
-- companion V2 change (already implemented, tested, committed
-- separately) surfaces those existing rows more clearly.
--
-- Every default below is chosen so this migration, on first apply,
-- reproduces V1's exact current behavior byte-for-byte -- this is an
-- AUTHORITY MIGRATION, not a commission-policy change (RH-5C brief
-- Gate 13).

-- ============================================================
-- 1. Governed beneficiary identity (replaces the hardcoded UUID)
-- ============================================================
-- V1's own code comment (portal-app.js:6285-6290) already explains WHY
-- a hardcoded id was chosen over "first MASTER alphabetically": more
-- than one active MASTER exists, and a silent fallback was judged
-- fragile. That reasoning argues for an EXPLICIT flag, not against
-- governance -- a boolean on the identity row this schema already
-- trusts (usuarios), fail-closed the same way V1 already fails closed
-- (0 or >1 flagged users blocks the feature, never guesses).
alter table public.usuarios
  add column if not exists gestor_fi_beneficiario boolean not null default false;

-- Enforce "at most one" at the database layer (a second layer under
-- the RPC's own defensive count check below, not a replacement for it).
create unique index if not exists usuarios_gestor_fi_beneficiario_unique
  on public.usuarios (gestor_fi_beneficiario)
  where gestor_fi_beneficiario;

comment on column public.usuarios.gestor_fi_beneficiario is
  'RH-5C: governed replacement for the V1 frontend hardcoded GESTOR_FI_USUARIO_ID_SEGURO constant. At most one active row should carry true (enforced by usuarios_gestor_fi_beneficiario_unique); operational_gestor_fi_commission() fails closed (pronto=false) if zero or more than one active user is flagged.';

-- NOTE: this migration does NOT set this flag on any real user. Doing
-- so requires knowing which real person V1's current hardcoded UUID
-- points to, matching them to their usuarios.id, and is a deliberate,
-- reviewed, one-time data change -- not something this schema
-- migration should do blindly. See the RH-5C report's explicit
-- recommendation on this point.

-- ============================================================
-- 2. Governed Gestor F&I config keys (replaces the 3 literal constants)
-- ============================================================
-- Defaults reproduce V1's current literals EXACTLY:
--   share < 40        -> faixa 0.0016 (0.16%)
--   share >= 40        -> faixa 0.0030 (0.30%)
--   bonus_spf           -> R$30 per SPF unit
-- Namespaced gestor_fi_* -- deliberately NOT aliased onto the existing
-- shared share_minimo/bonus_spf_analista keys, because V1 itself never
-- reads those for this formula (confirmed by forensic audit: the `40`
-- and `30` here are independent literals, not cfgNum('share_minimo')/
-- cfgNum('bonus_spf_analista')). Silently coupling them now would be a
-- real behavior change, not a byte-identical migration.
insert into public.configuracoes (chave, valor, descricao, atualizado_em)
values
  ('gestor_fi_share_minimo', '40', 'RH-5C: limiar de share (%) usado apenas pela Comissão do Gestor de F&I -- independente de share_minimo (vendedor/gerente/analista).', now()),
  ('gestor_fi_faixa_share_baixo', '0.16', 'RH-5C: faixa (%) aplicada quando o share do Grupo está abaixo de gestor_fi_share_minimo.', now()),
  ('gestor_fi_faixa_share_alto', '0.30', 'RH-5C: faixa (%) aplicada quando o share do Grupo está no limiar de gestor_fi_share_minimo ou acima.', now()),
  ('gestor_fi_bonus_spf', '30', 'RH-5C: bônus (R$) por unidade de SPF extra, Comissão do Gestor de F&I.', now())
on conflict (chave) do nothing;
-- `do nothing` (not `do update`), matching this Wave's own Gate 34
-- ("prove it does not already exist... do not overwrite silently") --
-- confirmed live via read-only audit these 4 keys do not exist today.

-- ============================================================
-- 3. Extend the READ path: operational_portal_config()
-- ============================================================
-- Byte-identical to the live function this migration was captured
-- from (read live via pg_get_functiondef, RH-5C forensic audit),
-- PLUS the 4 new keys appended to the allowlist array. No other line
-- changed.
create or replace function public.operational_portal_config()
 returns jsonb
 language sql
 stable security definer
 set search_path to 'pg_catalog', 'public'
as $function$
  select case
    when auth.uid() is null then
      jsonb_build_object('rows', '[]'::jsonb)
    else
      jsonb_build_object(
        'rows',
        coalesce(
          jsonb_agg(
            jsonb_build_object('chave', c.chave, 'valor', c.valor)
            order by c.chave
          ),
          '[]'::jsonb
        )
      )
  end
  from public.configuracoes c
  where c.chave = any (array[
    'share_minimo',
    'spf_liquido_percentual',
    'bonus_spf_analista',
    'limite_retorno_novos',
    'limite_retorno_seminovos',
    'vendedor_faixa_baixo_share_baixo',
    'vendedor_faixa_baixo_share_alto',
    'vendedor_faixa_alto_share_baixo',
    'vendedor_faixa_alto_share_alto',
    'gerente_faixa_share_baixo',
    'gerente_faixa_share_alto',
    'analista_faixa_share_baixo',
    'analista_faixa_share_alto',
    'permissoes_modulos_dinamicas',
    'ia_texto_habilitada',
    'ia_voz_habilitada',
    'gestor_fi_share_minimo',
    'gestor_fi_faixa_share_baixo',
    'gestor_fi_faixa_share_alto',
    'gestor_fi_bonus_spf'
  ]);
$function$;

-- ============================================================
-- 4. Extend the WRITE path: master_update_portal_config()
-- ============================================================
-- Byte-identical to the live function (read live via
-- pg_get_functiondef), PLUS the 4 new keys appended to the whitelist
-- array. No other line changed -- same MASTER-only gate, same numeric
-- range validation, same percentage-pattern validation (all 4 new key
-- names deliberately include 'share'/'faixa' where the value really is
-- a percentage, so the existing `p_value > 100` guard applies to them
-- automatically; gestor_fi_bonus_spf correctly does NOT match those
-- substrings, exactly like the pre-existing bonus_spf_analista=150).
create or replace function public.master_update_portal_config(p_key text, p_value numeric, p_description text default null::text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_key text := trim(coalesce(p_key, ''));
  v_actor public.usuarios;
  v_old text;
begin
  select u.* into v_actor
  from public.usuarios u
  where u.auth_user_id = auth.uid()
    and u.ativo is true
    and upper(trim(coalesce(u.perfil, ''))) = 'MASTER'
  limit 1;

  if v_actor.id is null then
    raise exception 'Acesso exclusivo do perfil Master.'
      using errcode = '42501';
  end if;

  if not (v_key = any (array[
    'share_minimo',
    'spf_liquido_percentual',
    'bonus_spf_analista',
    'limite_retorno_novos',
    'limite_retorno_seminovos',
    'vendedor_faixa_baixo_share_baixo',
    'vendedor_faixa_baixo_share_alto',
    'vendedor_faixa_alto_share_baixo',
    'vendedor_faixa_alto_share_alto',
    'gerente_faixa_share_baixo',
    'gerente_faixa_share_alto',
    'analista_faixa_share_baixo',
    'analista_faixa_share_alto',
    'gestor_fi_share_minimo',
    'gestor_fi_faixa_share_baixo',
    'gestor_fi_faixa_share_alto',
    'gestor_fi_bonus_spf'
  ])) then
    raise exception 'Parâmetro não autorizado.' using errcode = '22023';
  end if;

  if p_value is null or p_value < 0 or p_value > 1000000000 then
    raise exception 'Valor fora do intervalo permitido.' using errcode = '22023';
  end if;

  if (v_key like '%share%' or v_key like '%percentual%' or v_key like '%faixa%')
     and p_value > 100 then
    raise exception 'Percentual fora do intervalo de 0 a 100.'
      using errcode = '22023';
  end if;

  select c.valor into v_old
  from public.configuracoes c
  where c.chave = v_key;

  insert into public.configuracoes (chave, valor, descricao, atualizado_em)
  values (v_key, p_value::text, coalesce(p_description, ''), now())
  on conflict (chave) do update
    set valor = excluded.valor,
        descricao = excluded.descricao,
        atualizado_em = excluded.atualizado_em;

  insert into public.auditoria (
    tipo, descricao, base_origem, loja, vendedor, cpf, resolvido
  ) values (
    'CONFIGURACAO',
    format('Parâmetro %s alterado de %s para %s', v_key, coalesce(v_old, '(vazio)'), p_value),
    'Painel Master',
    coalesce(v_actor.loja, ''),
    v_actor.nome,
    v_actor.cpf,
    false
  );

  return jsonb_build_object('status', 'OK', 'chave', v_key, 'valor', p_value);
end;
$function$;

-- ============================================================
-- 5a. Pure formula: _operational_gestor_fi_formula(...)
-- ============================================================
-- RH-5C.1: split out of the original single RPC specifically so the
-- formula can be parity-tested with synthetic numeric inputs (Section
-- 16/17 -- "no business-table fixtures") without ever touching
-- usuarios/configuracoes/portal_sales/etc. Zero DB reads, zero auth,
-- zero side effects -- a straight arithmetic port of calcGestorFIGrupo
-- (portal-app.js:6252-6284), taking every config value as a parameter
-- instead of reading it, so a parity harness can pass both the current
-- defaults AND deliberately-changed values (Section 13/19 "golden
-- Faixa consistency" -- proving classification follows governed
-- config, never stale frontend literals).
create or replace function public._operational_gestor_fi_formula(
  p_vendidas integer,
  p_financiadas integer,
  p_retorno numeric,
  p_spf numeric,
  p_spf_qty integer,
  p_share_minimo numeric,
  p_faixa_baixo numeric,
  p_faixa_alto numeric,
  p_bonus_unit numeric,
  p_spf_liquido_percentual numeric
)
 returns jsonb
 language sql
 immutable
 set search_path to 'pg_catalog', 'public'
as $function$
  -- Every intermediate value carries full numeric precision, exactly
  -- mirroring the JS reference's own zero-internal-rounding contract
  -- (RH-5C.1 Gate 7 finding -- an earlier draft rounded intermediate
  -- values and could diverge from the JS reference by up to a cent).
  select jsonb_build_object(
    'share', case when p_vendidas > 0 then (p_financiadas::numeric / p_vendidas::numeric) * 100 else 0 end,
    'faixa',
      case when (case when p_vendidas > 0 then (p_financiadas::numeric / p_vendidas::numeric) * 100 else 0 end) < p_share_minimo
        then p_faixa_baixo / 100
        else p_faixa_alto / 100
      end,
    'spf_liquido', p_spf * (p_spf_liquido_percentual / 100),
    'base', p_retorno + (p_spf * (p_spf_liquido_percentual / 100)),
    'comissao_principal',
      (p_retorno + (p_spf * (p_spf_liquido_percentual / 100))) *
      (case when (case when p_vendidas > 0 then (p_financiadas::numeric / p_vendidas::numeric) * 100 else 0 end) < p_share_minimo
        then p_faixa_baixo / 100
        else p_faixa_alto / 100
      end),
    'bonus_spf', p_spf_qty * p_bonus_unit,
    'comissao_final',
      ((p_retorno + (p_spf * (p_spf_liquido_percentual / 100))) *
      (case when (case when p_vendidas > 0 then (p_financiadas::numeric / p_vendidas::numeric) * 100 else 0 end) < p_share_minimo
        then p_faixa_baixo / 100
        else p_faixa_alto / 100
      end)) + (p_spf_qty * p_bonus_unit)
  );
$function$;

revoke all on function public._operational_gestor_fi_formula(integer, integer, numeric, numeric, integer, numeric, numeric, numeric, numeric, numeric) from public;
revoke all on function public._operational_gestor_fi_formula(integer, integer, numeric, numeric, integer, numeric, numeric, numeric, numeric, numeric) from anon;
grant execute on function public._operational_gestor_fi_formula(integer, integer, numeric, numeric, integer, numeric, numeric, numeric, numeric, numeric) to authenticated, service_role;

comment on function public._operational_gestor_fi_formula(integer, integer, numeric, numeric, integer, numeric, numeric, numeric, numeric, numeric) is
  'RH-5C.1: pure, side-effect-free port of calcGestorFIGrupo() (portal-app.js:6252-6284). Every input is a parameter -- no table reads, no auth -- specifically so it can be parity-tested with synthetic fixtures. Leading underscore marks it internal/non-API; operational_gestor_fi_commission() is the real authorized entry point.';

-- ============================================================
-- 5b. New RPC: operational_gestor_fi_commission(p_start, p_end)
-- ============================================================
-- MASTER-only, read-only, live/current-period equivalent of V1's
-- calcGestorFIGrupo() + showGestorFICommission() -- resolves real
-- inputs (auth, beneficiary, governed metrics/config) then delegates
-- the arithmetic itself to the pure formula function above (single
-- source of truth -- Gate 19).
--
-- Deliberately reuses operational_commission_metrics(p_start, p_end)
-- internally for its `totals` object -- the SAME pre-aggregated group
-- total the live V1 code already reads (never re-summed from
-- individual rows, matching V1's own explicit warning that summing
-- rows overestimates a real competência's total by 4x).
create or replace function public.operational_gestor_fi_commission(p_start date, p_end date)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_actor public.usuarios;
  v_beneficiary_count integer;
  v_beneficiary public.usuarios;
  v_metrics jsonb;
  v_totals jsonb;
  v_share_minimo numeric;
  v_faixa_baixo numeric;
  v_faixa_alto numeric;
  v_bonus_unit numeric;
  v_spf_liquido_percentual numeric;
  v_formula jsonb;
  v_vendidas integer;
  v_financiadas integer;
  v_producao numeric;
  v_retorno numeric;
  v_spf numeric;
  v_spf_qty integer;
begin
  -- Auth gate: MASTER only, matching master_close_commission_period's
  -- own inline pattern (Pattern C, RH-5C schema audit).
  select u.* into v_actor
  from public.usuarios u
  where u.auth_user_id = auth.uid()
    and u.ativo is true
    and upper(trim(coalesce(u.perfil, ''))) = 'MASTER'
  limit 1;

  if v_actor.id is null then
    raise exception 'Acesso exclusivo do perfil Master.'
      using errcode = '42501';
  end if;

  if p_start is null or p_end is null or p_start > p_end then
    raise exception 'Periodo invalido.' using errcode = '22023';
  end if;

  -- Beneficiary identity: fail closed on 0 or >1 flagged active users,
  -- exactly matching V1's own gestorFIIdentidadeSegura() fail-closed
  -- contract (returns null / blocks, never guesses).
  select count(*) into v_beneficiary_count
  from public.usuarios u
  where u.gestor_fi_beneficiario is true and u.ativo is true;

  if v_beneficiary_count <> 1 then
    return jsonb_build_object(
      'pronto', false,
      'motivo', case
        when v_beneficiary_count = 0 then 'NENHUM_BENEFICIARIO_CONFIGURADO'
        else 'MULTIPLOS_BENEFICIARIOS_CONFIGURADOS'
      end
    );
  end if;

  select u.* into v_beneficiary
  from public.usuarios u
  where u.gestor_fi_beneficiario is true and u.ativo is true
  limit 1;

  -- Reuse the same governed aggregate the live V1 code reads (never
  -- re-summed from individual rows).
  v_metrics := public.operational_commission_metrics(p_start, p_end);
  v_totals := coalesce(v_metrics -> 'totals', '{}'::jsonb);

  v_vendidas := coalesce((v_totals ->> 'sold_count')::integer, 0);
  v_financiadas := coalesce((v_totals ->> 'financed_count')::integer, 0);
  v_producao := coalesce((v_totals ->> 'production_value')::numeric, 0);
  v_retorno := coalesce((v_totals ->> 'return_value')::numeric, 0);
  v_spf := coalesce((v_totals ->> 'spf_value')::numeric, 0);
  v_spf_qty := coalesce((v_totals ->> 'spf_count')::integer, 0);

  -- Config reads, same sanitize-then-cast pattern used throughout this
  -- schema (configuracoes.valor is text).
  select
    max(case when chave = 'gestor_fi_share_minimo' and replace(valor, ',', '.') ~ '^[0-9]+([.][0-9]+)?$' then replace(valor, ',', '.')::numeric end),
    max(case when chave = 'gestor_fi_faixa_share_baixo' and replace(valor, ',', '.') ~ '^[0-9]+([.][0-9]+)?$' then replace(valor, ',', '.')::numeric end),
    max(case when chave = 'gestor_fi_faixa_share_alto' and replace(valor, ',', '.') ~ '^[0-9]+([.][0-9]+)?$' then replace(valor, ',', '.')::numeric end),
    max(case when chave = 'gestor_fi_bonus_spf' and replace(valor, ',', '.') ~ '^[0-9]+([.][0-9]+)?$' then replace(valor, ',', '.')::numeric end),
    max(case when chave = 'spf_liquido_percentual' and replace(valor, ',', '.') ~ '^[0-9]+([.][0-9]+)?$' then replace(valor, ',', '.')::numeric end)
  into v_share_minimo, v_faixa_baixo, v_faixa_alto, v_bonus_unit, v_spf_liquido_percentual
  from public.configuracoes
  where chave in ('gestor_fi_share_minimo', 'gestor_fi_faixa_share_baixo', 'gestor_fi_faixa_share_alto', 'gestor_fi_bonus_spf', 'spf_liquido_percentual');

  v_share_minimo := coalesce(v_share_minimo, 40);
  v_faixa_baixo := coalesce(v_faixa_baixo, 0.16);
  v_faixa_alto := coalesce(v_faixa_alto, 0.30);
  v_bonus_unit := coalesce(v_bonus_unit, 30);
  v_spf_liquido_percentual := coalesce(v_spf_liquido_percentual, 70);

  v_formula := public._operational_gestor_fi_formula(
    v_vendidas, v_financiadas, v_retorno, v_spf, v_spf_qty,
    v_share_minimo, v_faixa_baixo, v_faixa_alto, v_bonus_unit, v_spf_liquido_percentual
  );

  return jsonb_build_object(
    'pronto', true,
    'period_start', p_start,
    'period_end', p_end,
    'beneficiary_name', v_beneficiary.nome,
    'vendidas', v_vendidas,
    'financiadas', v_financiadas,
    'share', round((v_formula ->> 'share')::numeric, 4),
    'producao', v_producao,
    'retorno', v_retorno,
    'spf', v_spf,
    'spf_qty', v_spf_qty,
    'spf_liquido', (v_formula ->> 'spf_liquido')::numeric,
    'base', (v_formula ->> 'base')::numeric,
    'faixa', (v_formula ->> 'faixa')::numeric,
    'comissao_principal', (v_formula ->> 'comissao_principal')::numeric,
    'bonus_spf', (v_formula ->> 'bonus_spf')::numeric,
    'comissao_final', (v_formula ->> 'comissao_final')::numeric,
    'contains_client_identity', false,
    'contains_personal_documents', false
  );
end;
$function$;

revoke all on function public.operational_gestor_fi_commission(date, date) from public;
revoke all on function public.operational_gestor_fi_commission(date, date) from anon;
grant execute on function public.operational_gestor_fi_commission(date, date) to authenticated, service_role;

comment on function public.operational_gestor_fi_commission(date, date) is
  'RH-5C: governed, config-driven live (open-period) equivalent of V1''s calcGestorFIGrupo(). MASTER-only. Returns pronto=false with a reason code if 0 or >1 active users are flagged gestor_fi_beneficiario, never a guessed/fabricated identity. Never returns cpf. Historical/closed periods are unaffected -- they already read from snapshot_comissoes via master_commission_snapshot.';

-- ============================================================
-- 6a. Pure formula: _operational_commission_faixa_formula(...)
-- ============================================================
-- RH-5C.1 -- FIX-THE-DRIFT (Human Decision A, RH-5C.1 brief Section 2):
-- byte-identical, config-driven port of commissionCalc() (portal-app.js:
-- 111-131), PLUS a semantic share_tier/retorno_tier/faixa_level the
-- ORIGINAL commissionCalc() already implicitly computes but never
-- returns -- faixaBadge() (portal-app.js:62) tries to reverse-engineer
-- this same tier information by comparing the raw faixa fraction
-- against its OWN independent hardcoded literals (400/450/20/15),
-- which drifts silently from the real config-driven faixa the moment
-- an admin changes a threshold (RH-5C forensic finding). This function
-- eliminates that class of bug by construction: share_tier/
-- retorno_tier are the SAME branch decisions the financial faixa
-- itself is computed from, never a second independent comparison.
--
-- Zero DB reads, zero auth, zero side effects -- every config value is
-- a parameter, exactly like _operational_gestor_fi_formula above, for
-- the same parity-testing reason (Section 16/17).
create or replace function public._operational_commission_faixa_formula(
  p_status text,
  p_cls text, -- 'seller' | 'manager' | 'analyst'
  p_vendidas numeric,
  p_financiadas numeric,
  p_retorno numeric,
  p_spf numeric,
  p_spf_qty numeric,
  p_share_minimo numeric,
  p_spf_liquido_percentual numeric,
  p_limite_retorno_novos numeric,
  p_limite_retorno_seminovos numeric,
  p_vendedor_faixa_baixo_share_baixo numeric,
  p_vendedor_faixa_baixo_share_alto numeric,
  p_vendedor_faixa_alto_share_baixo numeric,
  p_vendedor_faixa_alto_share_alto numeric,
  p_gerente_faixa_share_baixo numeric,
  p_gerente_faixa_share_alto numeric,
  p_analista_faixa_share_baixo numeric,
  p_analista_faixa_share_alto numeric,
  p_bonus_spf_analista numeric
)
 returns jsonb
 language plpgsql
 immutable
 set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_share numeric;
  v_spf_liquido numeric;
  v_rent_total numeric;
  v_faixa numeric;
  v_comissao_principal numeric;
  v_comissao_spf numeric := 0;
  v_comissao_total numeric;
  v_share_tier text;
  v_retorno_tier text := null;
  v_is_semi boolean;
  v_limite numeric;
  v_faixa_level text;
begin
  -- share/spfLiquido/rentTotal: identical for every role, matching
  -- commissionCalc()'s own pre-branch computation (portal-app.js:112-115).
  v_share := case when coalesce(p_vendidas, 0) > 0 then (coalesce(p_financiadas, 0) / p_vendidas) * 100 else 0 end;
  v_spf_liquido := coalesce(p_spf, 0) * (p_spf_liquido_percentual / 100);
  v_rent_total := coalesce(p_retorno, 0) + v_spf_liquido;
  v_share_tier := case when v_share >= p_share_minimo then 'ALTO' else 'BAIXO' end;

  if p_cls = 'manager' then
    v_faixa := case when v_share_tier = 'ALTO' then p_gerente_faixa_share_alto / 100 else p_gerente_faixa_share_baixo / 100 end;
  elsif p_cls = 'analyst' then
    v_faixa := case when v_share_tier = 'ALTO' then p_analista_faixa_share_alto / 100 else p_analista_faixa_share_baixo / 100 end;
    v_comissao_spf := coalesce(p_spf_qty, 0) * p_bonus_spf_analista;
  else
    -- seller: byte-identical to commissionCalc()'s isSemi/limite branch
    -- (portal-app.js:123-126), including the "NOVOS/SEMINOVOS" combined
    -- status exclusion.
    v_is_semi := upper(coalesce(p_status, '')) like '%SEMINOVOS%' and upper(coalesce(p_status, '')) not like '%NOVOS/SEMINOVOS%';
    v_limite := case when v_is_semi then p_limite_retorno_seminovos else p_limite_retorno_novos end;
    v_retorno_tier := case when v_rent_total < v_limite then 'BAIXO' else 'ALTO' end;
    if v_retorno_tier = 'BAIXO' then
      v_faixa := case when v_share_tier = 'ALTO' then p_vendedor_faixa_baixo_share_alto / 100 else p_vendedor_faixa_baixo_share_baixo / 100 end;
    else
      v_faixa := case when v_share_tier = 'ALTO' then p_vendedor_faixa_alto_share_alto / 100 else p_vendedor_faixa_alto_share_baixo / 100 end;
    end if;
  end if;

  v_comissao_principal := v_rent_total * v_faixa;
  v_comissao_total := v_comissao_principal + v_comissao_spf;

  -- FIX-THE-DRIFT semantic classification: manager/analyst have exactly
  -- 2 reachable tiers (never a 3rd "red" state -- matching V1's own
  -- reachable branches, not fabricating a state V1 never had); seller
  -- has 4 (2x2), collapsed to 3 semantic levels for the badge.
  v_faixa_level := case
    when p_cls in ('manager', 'analyst') then (case when v_share_tier = 'ALTO' then 'MAXIMA' else 'MINIMA' end)
    else (case
      when v_share_tier = 'ALTO' and v_retorno_tier = 'ALTO' then 'MAXIMA'
      when v_share_tier = 'BAIXO' and v_retorno_tier = 'BAIXO' then 'MINIMA'
      else 'INTERMEDIARIA'
    end)
  end;

  return jsonb_build_object(
    'share', v_share,
    'spf_liquido', v_spf_liquido,
    'rent_total', v_rent_total,
    'faixa', v_faixa,
    'share_tier', v_share_tier,
    'retorno_tier', v_retorno_tier,
    'faixa_level', v_faixa_level,
    'comissao_principal', v_comissao_principal,
    'comissao_spf', v_comissao_spf,
    'comissao_total', v_comissao_total
  );
end;
$function$;

revoke all on function public._operational_commission_faixa_formula(text, text, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric) from public;
revoke all on function public._operational_commission_faixa_formula(text, text, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric) from anon;
grant execute on function public._operational_commission_faixa_formula(text, text, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric) to authenticated, service_role;

comment on function public._operational_commission_faixa_formula(text, text, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric) is
  'RH-5C.1: pure, side-effect-free port of commissionCalc() (portal-app.js:111-131), FIX-THE-DRIFT variant -- returns share_tier/retorno_tier/faixa_level derived from the SAME branch decisions the financial faixa itself uses, replacing faixaBadge()''s independent hardcoded classification. Every input is a parameter -- no table reads, no auth.';

-- ============================================================
-- 6b. New RPC: operational_commission_faixa_rows(p_start, p_end)
-- ============================================================
-- MASTER-only (per-row Faixa across every seller/manager/analyst is
-- exactly the aggregate view only MASTER already sees in Equipe/
-- Analistas today -- scoping this identically avoids inventing a new,
-- untested cross-profile authorization matrix in the same Wave that
-- also activates live financial writes). Assembles rows from the SAME
-- 2 existing governed RPCs V2 already calls (operational_commission_
-- metrics for sellers, operational_analyst_commission_metrics_v2 for
-- analysts) plus the SAME store+department manager-bucketing already
-- proven correct in commission-aggregation-v1-reference.js (PM-5J),
-- reproduced here in SQL -- then delegates every row's arithmetic to
-- the single pure formula function above (Gate 19: one canonical
-- calculation contract, not three separate implementations).
create or replace function public.operational_commission_faixa_rows(p_start date, p_end date)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_actor public.usuarios;
  v_cfg record;
  v_seller_metrics jsonb;
  v_analyst_metrics jsonb;
  v_seller_rows jsonb;
  v_analyst_rows jsonb;
  v_row jsonb;
  v_result jsonb := '[]'::jsonb;
  v_calc jsonb;
  v_manager_buckets jsonb;
begin
  select u.* into v_actor
  from public.usuarios u
  where u.auth_user_id = auth.uid()
    and u.ativo is true
    and upper(trim(coalesce(u.perfil, ''))) = 'MASTER'
  limit 1;

  if v_actor.id is null then
    raise exception 'Acesso exclusivo do perfil Master.'
      using errcode = '42501';
  end if;

  if p_start is null or p_end is null or p_start > p_end then
    raise exception 'Periodo invalido.' using errcode = '22023';
  end if;

  -- Same sanitize-then-cast config read pattern as every other
  -- function in this schema (configuracoes.valor is text). All 13
  -- pre-existing keys -- none of these are new, all already governed.
  select
    max(case when chave = 'share_minimo' and replace(valor, ',', '.') ~ '^[0-9]+([.][0-9]+)?$' then replace(valor, ',', '.')::numeric end) as share_minimo,
    max(case when chave = 'spf_liquido_percentual' and replace(valor, ',', '.') ~ '^[0-9]+([.][0-9]+)?$' then replace(valor, ',', '.')::numeric end) as spf_liquido_percentual,
    max(case when chave = 'limite_retorno_novos' and replace(valor, ',', '.') ~ '^[0-9]+([.][0-9]+)?$' then replace(valor, ',', '.')::numeric end) as limite_retorno_novos,
    max(case when chave = 'limite_retorno_seminovos' and replace(valor, ',', '.') ~ '^[0-9]+([.][0-9]+)?$' then replace(valor, ',', '.')::numeric end) as limite_retorno_seminovos,
    max(case when chave = 'vendedor_faixa_baixo_share_baixo' and replace(valor, ',', '.') ~ '^[0-9]+([.][0-9]+)?$' then replace(valor, ',', '.')::numeric end) as vfbb,
    max(case when chave = 'vendedor_faixa_baixo_share_alto' and replace(valor, ',', '.') ~ '^[0-9]+([.][0-9]+)?$' then replace(valor, ',', '.')::numeric end) as vfba,
    max(case when chave = 'vendedor_faixa_alto_share_baixo' and replace(valor, ',', '.') ~ '^[0-9]+([.][0-9]+)?$' then replace(valor, ',', '.')::numeric end) as vfab,
    max(case when chave = 'vendedor_faixa_alto_share_alto' and replace(valor, ',', '.') ~ '^[0-9]+([.][0-9]+)?$' then replace(valor, ',', '.')::numeric end) as vfaa,
    max(case when chave = 'gerente_faixa_share_baixo' and replace(valor, ',', '.') ~ '^[0-9]+([.][0-9]+)?$' then replace(valor, ',', '.')::numeric end) as gfb,
    max(case when chave = 'gerente_faixa_share_alto' and replace(valor, ',', '.') ~ '^[0-9]+([.][0-9]+)?$' then replace(valor, ',', '.')::numeric end) as gfa,
    max(case when chave = 'analista_faixa_share_baixo' and replace(valor, ',', '.') ~ '^[0-9]+([.][0-9]+)?$' then replace(valor, ',', '.')::numeric end) as afb,
    max(case when chave = 'analista_faixa_share_alto' and replace(valor, ',', '.') ~ '^[0-9]+([.][0-9]+)?$' then replace(valor, ',', '.')::numeric end) as afa,
    max(case when chave = 'bonus_spf_analista' and replace(valor, ',', '.') ~ '^[0-9]+([.][0-9]+)?$' then replace(valor, ',', '.')::numeric end) as bonus_spf
  into v_cfg
  from public.configuracoes
  where chave in ('share_minimo', 'spf_liquido_percentual', 'limite_retorno_novos', 'limite_retorno_seminovos',
    'vendedor_faixa_baixo_share_baixo', 'vendedor_faixa_baixo_share_alto', 'vendedor_faixa_alto_share_baixo', 'vendedor_faixa_alto_share_alto',
    'gerente_faixa_share_baixo', 'gerente_faixa_share_alto', 'analista_faixa_share_baixo', 'analista_faixa_share_alto', 'bonus_spf_analista');

  -- ---- VENDEDOR rows ----
  v_seller_metrics := public.operational_commission_metrics(p_start, p_end);
  v_seller_rows := coalesce(v_seller_metrics -> 'rows', '[]'::jsonb);

  for v_row in select * from jsonb_array_elements(v_seller_rows)
  loop
    v_calc := public._operational_commission_faixa_formula(
      v_row ->> 'department', 'seller',
      (v_row ->> 'sold_count')::numeric, (v_row ->> 'financed_count')::numeric, (v_row ->> 'return_value')::numeric,
      (v_row ->> 'spf_value')::numeric, (v_row ->> 'spf_count')::numeric,
      coalesce(v_cfg.share_minimo, 40), coalesce(v_cfg.spf_liquido_percentual, 70),
      coalesce(v_cfg.limite_retorno_novos, 12000), coalesce(v_cfg.limite_retorno_seminovos, 8000),
      coalesce(v_cfg.vfbb, 10), coalesce(v_cfg.vfba, 15), coalesce(v_cfg.vfab, 15), coalesce(v_cfg.vfaa, 20),
      coalesce(v_cfg.gfb, 3), coalesce(v_cfg.gfa, 4), coalesce(v_cfg.afb, 3.5), coalesce(v_cfg.afa, 4.5),
      coalesce(v_cfg.bonus_spf, 150)
    );
    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'perfil', 'VENDEDOR', 'seller_id', v_row -> 'seller_id', 'store', v_row -> 'store', 'department', v_row -> 'department',
      'faixa', v_calc -> 'faixa', 'faixa_level', v_calc -> 'faixa_level', 'share_tier', v_calc -> 'share_tier', 'retorno_tier', v_calc -> 'retorno_tier'
    ));
  end loop;

  -- ---- GERENTE buckets (store+department, matching commission-
  -- aggregation-v1-reference.js's own gerenteBuckets logic exactly:
  -- a row whose department contains both NOVOS and SEMINOVOS
  -- contributes to BOTH buckets) ----
  with dept_rows as (
    select
      r ->> 'store' as store,
      dep.g as department,
      coalesce((r ->> 'sold_count')::numeric, 0) as vendidas,
      coalesce((r ->> 'financed_count')::numeric, 0) as financiadas,
      coalesce((r ->> 'return_value')::numeric, 0) as retorno,
      coalesce((r ->> 'spf_value')::numeric, 0) as spf,
      coalesce((r ->> 'spf_count')::numeric, 0) as spf_qty
    from jsonb_array_elements(v_seller_rows) r
    cross join lateral (
      select unnest(array_remove(array[
        case when upper(coalesce(r ->> 'department', '')) like '%NOVOS%' then 'NOVOS' end,
        case when upper(coalesce(r ->> 'department', '')) like '%SEMINOVOS%' then 'SEMINOVOS' end
      ], null)) as g
    ) dep
  ),
  buckets as (
    select store, department, sum(vendidas) as vendidas, sum(financiadas) as financiadas,
      sum(retorno) as retorno, sum(spf) as spf, sum(spf_qty) as spf_qty
    from dept_rows
    group by store, department
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'perfil', 'GERENTE', 'store', b.store, 'department', b.department,
    'calc', public._operational_commission_faixa_formula(
      'GERENTE ' || b.department, 'manager', b.vendidas, b.financiadas, b.retorno, b.spf, b.spf_qty,
      coalesce(v_cfg.share_minimo, 40), coalesce(v_cfg.spf_liquido_percentual, 70),
      coalesce(v_cfg.limite_retorno_novos, 12000), coalesce(v_cfg.limite_retorno_seminovos, 8000),
      coalesce(v_cfg.vfbb, 10), coalesce(v_cfg.vfba, 15), coalesce(v_cfg.vfab, 15), coalesce(v_cfg.vfaa, 20),
      coalesce(v_cfg.gfb, 3), coalesce(v_cfg.gfa, 4), coalesce(v_cfg.afb, 3.5), coalesce(v_cfg.afa, 4.5),
      coalesce(v_cfg.bonus_spf, 150)
    )
  )), '[]'::jsonb)
  into v_manager_buckets
  from buckets b;

  select v_result || coalesce(jsonb_agg(jsonb_build_object(
    'perfil', 'GERENTE', 'store', mb -> 'store', 'department', mb -> 'department',
    'faixa', mb -> 'calc' -> 'faixa', 'faixa_level', mb -> 'calc' -> 'faixa_level', 'share_tier', mb -> 'calc' -> 'share_tier', 'retorno_tier', mb -> 'calc' -> 'retorno_tier'
  )), '[]'::jsonb)
  into v_result
  from jsonb_array_elements(v_manager_buckets) mb;

  -- ---- ANALISTA rows ----
  v_analyst_metrics := public.operational_analyst_commission_metrics_v2(p_start, p_end);
  v_analyst_rows := coalesce(v_analyst_metrics -> 'rows', '[]'::jsonb);

  for v_row in select * from jsonb_array_elements(v_analyst_rows)
  loop
    v_calc := public._operational_commission_faixa_formula(
      'ANALISTA', 'analyst',
      (v_row ->> 'sold_count')::numeric, (v_row ->> 'financed_count')::numeric, (v_row ->> 'return_value')::numeric,
      (v_row ->> 'spf_value')::numeric, (v_row ->> 'spf_count')::numeric,
      coalesce(v_cfg.share_minimo, 40), coalesce(v_cfg.spf_liquido_percentual, 70),
      coalesce(v_cfg.limite_retorno_novos, 12000), coalesce(v_cfg.limite_retorno_seminovos, 8000),
      coalesce(v_cfg.vfbb, 10), coalesce(v_cfg.vfba, 15), coalesce(v_cfg.vfab, 15), coalesce(v_cfg.vfaa, 20),
      coalesce(v_cfg.gfb, 3), coalesce(v_cfg.gfa, 4), coalesce(v_cfg.afb, 3.5), coalesce(v_cfg.afa, 4.5),
      coalesce(v_cfg.bonus_spf, 150)
    );
    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'perfil', 'ANALISTA', 'store', v_row -> 'store',
      'faixa', v_calc -> 'faixa', 'faixa_level', v_calc -> 'faixa_level', 'share_tier', v_calc -> 'share_tier', 'retorno_tier', v_calc -> 'retorno_tier'
    ));
  end loop;

  return jsonb_build_object('rows', v_result, 'contains_client_identity', false, 'contains_personal_documents', false);
end;
$function$;

revoke all on function public.operational_commission_faixa_rows(date, date) from public;
revoke all on function public.operational_commission_faixa_rows(date, date) from anon;
grant execute on function public.operational_commission_faixa_rows(date, date) to authenticated, service_role;

comment on function public.operational_commission_faixa_rows(date, date) is
  'RH-5C.1: MASTER-only. Server-authoritative per-row Faixa classification for VENDEDOR/GERENTE/ANALISTA, current/open period only. Never returns seller/analyst identity beyond what operational_commission_metrics/operational_analyst_commission_metrics_v2 already expose to this caller -- this function adds classification fields only.';

-- ============================================================
-- ROLLBACK (NOT executed by this file -- keep as a separate, reviewed
-- step if this migration is ever applied and later needs reverting)
-- ============================================================
-- drop function if exists public.operational_gestor_fi_commission(date, date);
-- drop function if exists public._operational_gestor_fi_formula(integer, integer, numeric, numeric, integer, numeric, numeric, numeric, numeric, numeric);
-- drop function if exists public.operational_commission_faixa_rows(date, date);
-- drop function if exists public._operational_commission_faixa_formula(text, text, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric, numeric);
-- create or replace function public.master_update_portal_config(p_key text, p_value numeric, p_description text default null::text) ... -- restore the pre-RH-5C body (17-line whitelist array without the 4 gestor_fi_* keys), captured live before this migration.
-- create or replace function public.operational_portal_config() ... -- restore the pre-RH-5C body (16-key allowlist without the 4 gestor_fi_* keys), captured live before this migration.
-- delete from public.configuracoes where chave in ('gestor_fi_share_minimo','gestor_fi_faixa_share_baixo','gestor_fi_faixa_share_alto','gestor_fi_bonus_spf');
-- drop index if exists public.usuarios_gestor_fi_beneficiario_unique;
-- alter table public.usuarios drop column if exists gestor_fi_beneficiario;
