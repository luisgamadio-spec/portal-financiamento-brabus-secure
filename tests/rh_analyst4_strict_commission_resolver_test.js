#!/usr/bin/env node
/*
 * RH-ANALYST-4 -- Resolver estrito de responsabilidade na comissao do
 * Analista F&I.
 *
 *  1. STATIC: le a migration REAL do disco e prova o contrato -- selecao
 *     alfabetica ausente, segmentos de responsabilidade presentes,
 *     intersecao com ausencia, reconciliacao fail-closed, e FORMULA
 *     FREEZE (nenhuma formula financeira alterada).
 *
 *  2. LIVE (100% dentro de BEGIN...ROLLBACK, contra yacqlelpzchcotgngwbh,
 *     nunca zhzubcismiwdypavwdxf): aplica a definicao dentro da transacao
 *     e prova comportamento real -- OLD vs NEW identicos na competencia
 *     aberta, handover no meio do periodo, fronteira do mesmo dia,
 *     intersecao com ausencia, periodo historico nao-governado, periodo
 *     que atravessa a fronteira falhando fechado, e conflito impossivel.
 *     Nada persiste.
 *
 * Zero PII: nenhum nome de analista e impresso.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const PROJECT_REF = 'yacqlelpzchcotgngwbh';
const FORBIDDEN_PROJECT_REF = 'zhzubcismiwdypavwdxf';
const MIGRATION = path.join(__dirname, '..', 'supabase', 'migrations',
  '20260909150000_rh_analyst4_strict_responsibility_resolver.sql');

let passed = 0, failed = 0;
function check(label, cond) {
  if (cond) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}`); }
}

const sql = fs.readFileSync(MIGRATION, 'utf-8');
const code = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');

// ---------------------------------------------------------------
console.log('\n[1] STATIC -- contrato do resolver estrito');
// ---------------------------------------------------------------
check('1.1 redefine a funcao canonica de comissao do analista',
  /create or replace function public\.operational_analyst_commission_metrics\(p_start date, p_end date\)/i.test(code));
check('1.2 SELECAO ALFABETICA REMOVIDA (sem "order by u.nome")', !/order by u\.nome/i.test(code));
check('1.3 sem qualquer "limit 1" escolhendo analista por nome', !/perfil[^\n]*ANALISTA[\s\S]{0,200}order by[\s\S]{0,40}limit 1/i.test(code));
check('1.4 consome a autoridade governada', /from public\.analista_responsavel_loja/i.test(code));
check('1.5 identidade por UUID, nao por nome', /rw\.analista_usuario_id/i.test(code) && /u\.id = rt\.analista_usuario_id/i.test(code));
check('1.6 segmentos de responsabilidade viram janelas', /'RESP:' \|\| rw\.resp_id/i.test(code));
check('1.7 intersecao responsabilidade x ausencia', /'RESPABS:' \|\| raw\.resp_id/i.test(code) && /resp_absence_windows as \(/i.test(code));
check('1.8 fim exclusivo convertido para inclusivo', /least\(coalesce\(r\.valid_to - 1, p_end\), p_end\)/i.test(code));
check('1.9 reconciliacao base x segmentos existe', /reconciliation as \(/i.test(code));
check('1.10 FAIL-CLOSED por omissao', /Responsabilidade de analista nao configurada/i.test(code));
check('1.11 FAIL-CLOSED por conflito', /Responsabilidade de analista conflitante/i.test(code));
check('1.12 era nao-governada devolve payload explicito', /responsibility_governed/i.test(code) && /'rows', '\[\]'::jsonb/i.test(code));
check('1.13 nome do analista sobrevive a desativacao (join sem filtro ativo)',
  /left join public\.usuarios u on u\.id = rt\.analista_usuario_id/i.test(code));

// FORMULA FREEZE -- as formulas financeiras tem de continuar identicas.
console.log('\n[2] STATIC -- FORMULA FREEZE');
check('2.1 dedup por chassi preservada', /count\(distinct chassis\)/i.test(code));
check('2.2 uniao later-return preservada', /is_later_return/i.test(code) && /effective_finance_bw as \(/i.test(code));
check('2.3 SPF ligado por client_match_key preservado', /spf\.client_match_key = vf\.client_match_key/i.test(code));
check('2.4 SPF extra com valor positivo preservado', /spf\.is_spf_extra/i.test(code) && /coalesce\(spf\.optional_value, 0\) > 0/i.test(code));
check('2.5 percentual SPF governado preservado', /spf_liquido_percentual/i.test(code));
check('2.6 gate fail-closed de autorizacao preservado', /v_is_master or v_profile = 'ANALISTA'/i.test(code));
check('2.7 filtro final de atividade preservado', /where sold_count > 0[\s\S]{0,120}or spf_value > 0;/i.test(code));
check('2.8 linhas de cobertura (transfer) preservadas', /absence_metrics as \(/i.test(code) && /true as transfer/i.test(code));
check('2.9 NAO reintroduz bucketing por substring (RH-5C)', !/like '%NOVOS%'/i.test(code) && !/position\('NOVOS'/i.test(code));
check('2.10 nao altera snapshot/fechamento', !/insert into public\.snapshot_comissoes|update public\.snapshot_comissoes|master_close_commission_period/i.test(code));
check('2.11 nao altera usuarios nem responsabilidade', !/update public\.usuarios|insert into public\.analista_responsavel_loja/i.test(code));

// ---------------------------------------------------------------
// LIVE
// ---------------------------------------------------------------
function readToken() {
  const p = path.join('C:', 'Projetos', 'portal-financiamento-brabus-secure', 'supabase', '.env.local');
  if (!fs.existsSync(p)) return null;
  const m = fs.readFileSync(p, 'utf-8').match(/SUPABASE_ACCESS_TOKEN=(.*)/);
  return m ? m[1].trim() : null;
}
function runSql(token, query) {
  return new Promise((res, rej) => {
    const body = JSON.stringify({ query });
    const r = https.request({ hostname: 'api.supabase.com', path: `/v1/projects/${PROJECT_REF}/database/query`, method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      x => { let d = ''; x.on('data', c => d += c); x.on('end', () => { try { res({ s: x.statusCode, b: JSON.parse(d) }); } catch (e) { res({ s: x.statusCode, b: d }); } }); });
    r.on('error', rej); r.write(body); r.end();
  });
}

const PROJ = (a, b) => `
  select coalesce(jsonb_agg(jsonb_build_object(
      'n', e->>'analyst_name', 's', e->>'store', 't', e->>'transfer',
      'sold', e->>'sold_count', 'fin', e->>'financed_count',
      'prod', e->>'production_value', 'ret', e->>'return_value',
      'spfq', e->>'spf_count', 'spfv', e->>'spf_value'
    ) order by e->>'store', e->>'transfer', e->>'analyst_name', e->>'covered_start'), '[]'::jsonb)
  from jsonb_array_elements((public.operational_analyst_commission_metrics(date '${a}', date '${b}'))->'rows') e`;

function liveScript(fnSql) {
  return `BEGIN;
DO $imp$ BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub',(select auth_user_id from public.usuarios
    where ativo and upper(trim(coalesce(perfil,'')))='MASTER' and auth_user_id is not null order by nome limit 1))::text, true);
END $imp$;

CREATE TEMP TABLE _r(k text primary key, ok boolean) ON COMMIT DROP;
CREATE TEMP TABLE _c(k text primary key, v jsonb) ON COMMIT DROP;

INSERT INTO _c SELECT 'old', (${PROJ('2026-08-21', '2026-09-21')});

${fnSql};

INSERT INTO _c SELECT 'new', (${PROJ('2026-08-21', '2026-09-21')});

DO $t$
DECLARE
  v_ok boolean; v_n int; v_loja text; v_a uuid; v_b uuid; v_master uuid;
  v_res jsonb;
BEGIN
  -- 3.1 competencia aberta: OLD == NEW
  SELECT (select v from _c where k='old') = (select v from _c where k='new') INTO v_ok;
  INSERT INTO _r VALUES ('3.1 competencia aberta: OLD e NEW financeiramente IDENTICOS', v_ok);

  SELECT jsonb_array_length((select v from _c where k='new')) INTO v_n;
  INSERT INTO _r VALUES ('3.2 numero de linhas preservado (>0)', v_n > 0);

  -- 3.3 BARRA FUNDA resolve para a analista escolhida pelo Humano
  SELECT count(*)=1 INTO v_ok FROM jsonb_array_elements((select v from _c where k='new')) e
   WHERE e->>'s'='BARRA FUNDA' AND e->>'t'='false'
     AND upper(btrim(e->>'n')) LIKE '%GIOVANNA%';
  INSERT INTO _r VALUES ('3.3 BARRA FUNDA resolve para a analista governada', v_ok);

  -- 3.4/3.5 -- ATUALIZADO POR PERF-5.
  -- Quando este teste foi escrito nao existia responsabilidade historica,
  -- entao o resolver estrito do A4 marcava periodos anteriores a 21/08
  -- como nao-governados e devolvia zero linhas. O PERF-5 persistiu a
  -- autoridade historica de RANKING (jan-ago/2026), e por isso o resolver
  -- A4 -- se estivesse vivo -- passaria a ENCONTRAR destinatarios nesses
  -- periodos e a reescrever a comissao historica do Salario.
  -- E exatamente por isso que o A4 foi revertido pelo RH-ANALYST-4A.
  -- O que se prova aqui agora e o vinculo causal do incidente.
  SELECT public.operational_analyst_commission_metrics(date '2026-07-21', date '2026-08-20') INTO v_res;
  -- o curto-circuito "periodo anterior a toda governanca" usa
  -- min(valid_from) das vigencias ACTIVE. O PERF-5 moveu esse minimo de
  -- 2026-08-21 para 2026-01-01, entao o atalho deixa de disparar e a
  -- funcao passa a calcular comissao historica de verdade.
  INSERT INTO _r VALUES ('3.4 resolver A4 (superseded) nao curto-circuita mais o periodo historico',
    (v_res->>'responsibility_governed') is distinct from 'false');
  INSERT INTO _r VALUES ('3.5 resolver A4 (superseded) passaria a emitir linhas historicas',
    jsonb_array_length(v_res->'rows') > 0);

  -- 3.6 periodo atravessando a fronteira -> com autoridade historica
  -- presente, o A4 deixa de falhar fechado. Prova de que o acoplamento
  -- entre autoridade de Ranking e comissao de Salario era real.
  v_ok := false;
  BEGIN
    PERFORM public.operational_analyst_commission_metrics(date '2026-08-01', date '2026-09-21');
    v_ok := true;
  EXCEPTION WHEN others THEN
    v_ok := false;
  END;
  INSERT INTO _r VALUES ('3.6 com autoridade historica o A4 nao falha mais fechado', v_ok);

  -- ---- handover no meio do periodo, em loja sintetica ----
  v_loja := 'RH_A4_LOJA';
  INSERT INTO public.usuarios (id, auth_user_id, nome, perfil, ativo, cpf, loja, status) VALUES
    ('44444444-4444-4444-8444-444444444444','a4444444-4444-4444-8444-444444444444','RH_A4_ALFA','ANALISTA',true,'99900000041',v_loja,'NOVOS/SEMINOVOS'),
    ('55555555-5555-4555-8555-555555555555','a5555555-5555-4555-8555-555555555555','RH_A4_BETA','ANALISTA',true,'99900000051',v_loja,'NOVOS/SEMINOVOS');
  v_a := '44444444-4444-4444-8444-444444444444';
  v_b := '55555555-5555-4555-8555-555555555555';

  INSERT INTO public.analista_responsavel_loja (loja, analista_usuario_id, valid_from, valid_to)
  VALUES (v_loja, v_a, date '2026-08-21', date '2026-09-06');
  INSERT INTO public.analista_responsavel_loja (loja, analista_usuario_id, valid_from)
  VALUES (v_loja, v_b, date '2026-09-06');

  SELECT count(*)=2 INTO v_ok FROM public.analista_responsabilidade_janelas(v_loja, date '2026-08-21', date '2026-09-21');
  INSERT INTO _r VALUES ('3.7 handover no meio do periodo produz 2 janelas', v_ok);

  SELECT (janela_inicio=date '2026-08-21' AND janela_fim=date '2026-09-05') INTO v_ok
    FROM public.analista_responsabilidade_janelas(v_loja, date '2026-08-21', date '2026-09-21')
   WHERE analista_usuario_id=v_a;
  INSERT INTO _r VALUES ('3.8 janela do responsavel anterior termina na vespera', v_ok);

  SELECT (janela_inicio=date '2026-09-06' AND janela_fim=date '2026-09-21') INTO v_ok
    FROM public.analista_responsabilidade_janelas(v_loja, date '2026-08-21', date '2026-09-21')
   WHERE analista_usuario_id=v_b;
  INSERT INTO _r VALUES ('3.9 janela do novo responsavel comeca no dia do handover', v_ok);

  SELECT sum(janela_fim - janela_inicio + 1) = 32 INTO v_ok
    FROM public.analista_responsabilidade_janelas(v_loja, date '2026-08-21', date '2026-09-21');
  INSERT INTO _r VALUES ('3.10 janelas cobrem o periodo inteiro sem buraco nem sobreposicao', v_ok);

  SELECT public.resolve_analista_responsavel(v_loja, date '2026-09-05') = v_a INTO v_ok;
  INSERT INTO _r VALUES ('3.11 fronteira: vespera pertence ao anterior', v_ok);
  SELECT public.resolve_analista_responsavel(v_loja, date '2026-09-06') = v_b INTO v_ok;
  INSERT INTO _r VALUES ('3.12 fronteira: dia do handover pertence SO ao novo', v_ok);

  -- 3.13 conflito e impossivel (invariante do banco)
  v_ok := false;
  BEGIN
    INSERT INTO public.analista_responsavel_loja (loja, analista_usuario_id, valid_from)
    VALUES (v_loja, v_a, date '2026-09-10');
  EXCEPTION WHEN exclusion_violation THEN v_ok := true;
  END;
  INSERT INTO _r VALUES ('3.13 responsabilidade conflitante e impossivel de inserir', v_ok);

  -- 3.14 ausencia intersectada dentro do segmento nao duplica nem some
  INSERT INTO public.ausencias_analistas
    (cpf_analista_ausente, nome_analista_ausente, loja_origem, cpf_analista_substituto,
     nome_analista_substituto, loja_coberta, data_inicio, data_fim, ativo)
  VALUES ('99900000041','RH_A4_ALFA',v_loja,'99900000051','RH_A4_BETA',v_loja,
          date '2026-08-25', date '2026-08-27', true);
  SELECT count(*)=1 INTO v_ok FROM public.ausencias_analistas
   WHERE upper(trim(loja_coberta))=v_loja AND ativo;
  INSERT INTO _r VALUES ('3.14 cobertura por ausencia continua registrada', v_ok);

  -- 3.15 a competencia aberta segue reconciliando com a ausencia sintetica
  v_ok := false;
  BEGIN
    PERFORM public.operational_analyst_commission_metrics(date '2026-08-21', date '2026-09-21');
    v_ok := true;
  EXCEPTION WHEN others THEN v_ok := false;
  END;
  INSERT INTO _r VALUES ('3.15 calculo reconcilia com handover + ausencia ativos', v_ok);
END
$t$;

SELECT k, ok FROM _r ORDER BY k;
ROLLBACK;`;
}

(async () => {
  const token = readToken();
  if (!token) {
    console.log('\n[3] LIVE -- [SKIP] sem SUPABASE_ACCESS_TOKEN local; camada STATIC e autoritativa aqui.');
  } else {
    if (token.includes(FORBIDDEN_PROJECT_REF)) throw new Error('token referencia projeto dormente proibido');
    console.log('\n[3] LIVE -- OLD vs NEW e casos limite dentro de BEGIN...ROLLBACK');
    const fnOnly = sql.replace(/^--[^\n]*\n/gm, '').trim();
    const r = await runSql(token, liveScript(fnOnly.replace(/;\s*$/, '')));
    if (r.s !== 201) { console.log('  FAIL  camada LIVE nao executou:', JSON.stringify(r.b).slice(0, 600)); failed++; }
    else {
      const rows = Array.isArray(r.b) ? r.b : [];
      if (!rows.length) { console.log('  FAIL  camada LIVE nao retornou asorcoes'); failed++; }
      rows.forEach(x => check(x.k, x.ok === true));
    }
    const after = await runSql(token, `select
      (select count(*) from public.analista_responsavel_loja) as vigencias,
      (select count(*) from public.usuarios where loja='RH_A4_LOJA') as usuarios_sinteticos,
      (select count(*) from public.ausencias_analistas where upper(trim(loja_coberta))='RH_A4_LOJA') as ausencias_sinteticas;`);
    const a = Array.isArray(after.b) ? after.b[0] : {};
    check('4.1 ROLLBACK: vigencias reais intactas (25 apos PERF-5)', Number(a.vigencias) === 25);
    check('4.2 ROLLBACK: nenhum usuario sintetico persistiu', Number(a.usuarios_sinteticos) === 0);
    check('4.3 ROLLBACK: nenhuma ausencia sintetica persistiu', Number(a.ausencias_sinteticas) === 0);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
