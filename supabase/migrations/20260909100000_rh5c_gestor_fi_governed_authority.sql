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
-- 5. New RPC: operational_gestor_fi_commission(p_start, p_end)
-- ============================================================
-- MASTER-only, read-only, live/current-period equivalent of V1's
-- calcGestorFIGrupo() + showGestorFICommission() -- a faithful,
-- config-driven port (Pattern C auth gate, matching
-- master_close_commission_period's own inline MASTER row-lookup style
-- since this function also needs v_actor for parity with that
-- convention, even though it performs no writes).
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
  v_share numeric;
  v_share_minimo numeric;
  v_faixa_baixo numeric;
  v_faixa_alto numeric;
  v_bonus_unit numeric;
  v_spf_liquido_percentual numeric;
  v_faixa numeric;
  v_spf_liquido numeric;
  v_base numeric;
  v_comissao_principal numeric;
  v_bonus_spf numeric;
  v_comissao_final numeric;
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

  -- Formula: byte-identical to calcGestorFIGrupo() (portal-app.js:
  -- 6252-6284), with the 3 former literals now sourced from governed
  -- config (defaults reproduce the exact same numbers).
  v_share := case when v_vendidas > 0 then (v_financiadas::numeric / v_vendidas::numeric) * 100 else 0 end;
  v_faixa := case when v_share < v_share_minimo then v_faixa_baixo / 100 else v_faixa_alto / 100 end;
  v_spf_liquido := round(v_spf * (v_spf_liquido_percentual / 100), 2);
  v_base := round(v_retorno + v_spf_liquido, 2);
  v_comissao_principal := round(v_base * v_faixa, 2);
  v_bonus_spf := round(v_spf_qty * v_bonus_unit, 2);
  v_comissao_final := round(v_comissao_principal + v_bonus_spf, 2);

  return jsonb_build_object(
    'pronto', true,
    'period_start', p_start,
    'period_end', p_end,
    'beneficiary_name', v_beneficiary.nome,
    'vendidas', v_vendidas,
    'financiadas', v_financiadas,
    'share', round(v_share, 4),
    'producao', v_producao,
    'retorno', v_retorno,
    'spf', v_spf,
    'spf_qty', v_spf_qty,
    'spf_liquido', v_spf_liquido,
    'base', v_base,
    'faixa', v_faixa,
    'comissao_principal', v_comissao_principal,
    'bonus_spf', v_bonus_spf,
    'comissao_final', v_comissao_final,
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
-- ROLLBACK (NOT executed by this file -- keep as a separate, reviewed
-- step if this migration is ever applied and later needs reverting)
-- ============================================================
-- drop function if exists public.operational_gestor_fi_commission(date, date);
-- create or replace function public.master_update_portal_config(p_key text, p_value numeric, p_description text default null::text) ... -- restore the pre-RH-5C body (17-line whitelist array without the 4 gestor_fi_* keys), captured live before this migration.
-- create or replace function public.operational_portal_config() ... -- restore the pre-RH-5C body (16-key allowlist without the 4 gestor_fi_* keys), captured live before this migration.
-- delete from public.configuracoes where chave in ('gestor_fi_share_minimo','gestor_fi_faixa_share_baixo','gestor_fi_faixa_share_alto','gestor_fi_bonus_spf');
-- drop index if exists public.usuarios_gestor_fi_beneficiario_unique;
-- alter table public.usuarios drop column if exists gestor_fi_beneficiario;
