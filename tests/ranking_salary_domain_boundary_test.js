#!/usr/bin/env node
/*
 * RH-ANALYST-4A -- GUARDA PERMANENTE DE FRONTEIRA ENTRE DOMINIOS.
 *
 * Este teste existe por causa de um incidente real: ao preparar a
 * autoridade do NOVO RANKING, a Wave RH-ANALYST-4 fez o
 * ACOMPANHAMENTO DE SALARIOS consumir analista_responsavel_loja. Como
 * essa autoridade so comeca em 2026-08-21, TODO periodo anterior passou
 * a devolver zero linhas -- sumindo com as linhas oficiais do Analista
 * E com as linhas de COBERTURA de ferias/ausencia.
 *
 * Duas guardas permanentes:
 *
 *   [A] FRONTEIRA -- a funcao canonica de comissao do Salario NAO pode
 *       referenciar a autoridade de responsabilidade do Ranking, e a
 *       fundacao do Ranking tem de continuar existindo e sendo dona
 *       dela. Se alguem reintroduzir o acoplamento, isto quebra.
 *
 *   [B] COBERTURA -- pelo menos um periodo testado precisa conter
 *       linhas transfer=true. Nunca mais aceitar uma migration de
 *       resolver de Salario so porque um periodo SEM cobertura
 *       produziu hash identico (foi exatamente esse o ponto cego).
 *
 * Somente leitura: recusa qualquer statement que nao seja SELECT.
 * Zero PII: nenhum nome, CPF, e-mail ou UUID e impresso.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const PROJECT_REF = 'yacqlelpzchcotgngwbh';
const FORBIDDEN_PROJECT_REF = 'zhzubcismiwdypavwdxf';

// Definicao autentica do Salario, anterior ao incidente.
const AUTHENTIC_MD5 = '3b7f632a7b4826bc44da641e0e294100';
// Periodo com cobertura real comprovada na auditoria forense.
const COVERAGE_PERIOD = ['2026-07-21', '2026-08-20'];
const SECOND_COVERAGE_PERIOD = ['2026-05-21', '2026-06-20'];

let passed = 0, failed = 0;
function check(label, cond) {
  if (cond) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}`); }
}

function readToken() {
  const p = path.join('C:', 'Projetos', 'portal-financiamento-brabus-secure', 'supabase', '.env.local');
  if (!fs.existsSync(p)) return null;
  const m = fs.readFileSync(p, 'utf-8').match(/SUPABASE_ACCESS_TOKEN=(.*)/);
  return m ? m[1].trim() : null;
}

function runSql(token, query) {
  return new Promise((resolve, reject) => {
    if (/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke)\b/i.test(query)) {
      return reject(new Error('teste somente-leitura: statement nao-SELECT recusado'));
    }
    const body = JSON.stringify({ query });
    const req = https.request({
      hostname: 'api.supabase.com',
      path: `/v1/projects/${PROJECT_REF}/database/query`,
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(d); } });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

// ---------------------------------------------------------------
console.log('\n[1] STATIC -- a migration corretiva restaura o corpo autentico');
// ---------------------------------------------------------------
{
  const p = path.join(__dirname, '..', 'supabase', 'migrations',
    '20260909160000_rh_analyst4a_restore_salary_commission_semantics.sql');
  const exists = fs.existsSync(p);
  check('1.1 migration corretiva existe', exists);
  if (exists) {
    const sql = fs.readFileSync(p, 'utf-8');
    const code = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');
    check('1.2 redefine a funcao canonica de comissao do Salario',
      /create or replace function public\.operational_analyst_commission_metrics\(p_start date, p_end date\)/i.test(code));
    check('1.3 restaura a selecao alfabetica do Salario (restauracao deliberada)', /order by u\.nome/i.test(code));
    check('1.4 NAO referencia a tabela de responsabilidade do Ranking', !/analista_responsavel_loja/i.test(code));
    check('1.5 NAO referencia o resolver de janelas do Ranking', !/analista_responsabilidade_janelas/i.test(code));
    check('1.6 NAO carrega a flag de governanca introduzida pelo incidente', !/responsibility_governed/i.test(code));
    check('1.7 preserva as linhas de cobertura (transfer/absence)',
      /absence_metrics as \(/i.test(code) && /true as transfer/i.test(code) && /covered_start/i.test(code));
    check('1.8 preserva a subtracao de ausencia do analista oficial', /left join absence_sums a on a\.store = st\.store/i.test(code));
    check('1.9 nao cria nem altera tabela alguma', !/create table|alter table|drop table/i.test(code));
    check('1.10 nao escreve em responsabilidade, ausencia, usuarios ou snapshot',
      !/insert into public\.(analista_responsavel_loja|ausencias_analistas|usuarios|snapshot_comissoes)/i.test(code)
      && !/update public\.(analista_responsavel_loja|ausencias_analistas|usuarios|snapshot_comissoes)/i.test(code));
    check('1.11 documenta o incidente e o adiamento explicito', /RH-ANALYST-4A/i.test(sql) && /ADIADA/i.test(sql));
  }
}

(async () => {
  const token = readToken();
  if (!token) {
    console.log('\n[2..4] LIVE -- [SKIP] sem SUPABASE_ACCESS_TOKEN local; a camada STATIC e autoritativa aqui.');
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
  }
  if (token.includes(FORBIDDEN_PROJECT_REF)) throw new Error('token referencia o projeto dormente proibido');
  const one = async (q) => (await runSql(token, q))[0] || {};

  // -------------------------------------------------------------
  console.log('\n[2] GUARDA A -- fronteira Salario x Ranking (live)');
  // -------------------------------------------------------------
  const b = await one(`select
    (select md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.prokind='f' and p.proname='operational_analyst_commission_metrics') as salario_md5,
    (select (pg_get_functiondef(p.oid) like '%analista_responsavel_loja%') from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.prokind='f' and p.proname='operational_analyst_commission_metrics') as salario_ref_tabela,
    (select (pg_get_functiondef(p.oid) like '%analista_responsabilidade_janelas%') from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.prokind='f' and p.proname='operational_analyst_commission_metrics') as salario_ref_resolver,
    (select (pg_get_functiondef(p.oid) like '%responsibility_governed%') from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.prokind='f' and p.proname='operational_analyst_commission_metrics') as salario_flag_gov,
    (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f'
      and p.proname in ('resolve_analista_responsavel','analista_responsabilidade_janelas',
                        'analista_responsabilidade_cobertura','master_definir_analista_responsavel')) as ranking_fns,
    (select count(*) from pg_class where relname='analista_responsavel_loja' and relkind='r') as ranking_tabela;`);

  check('2.1 Salario NAO referencia a tabela de responsabilidade', b.salario_ref_tabela === false);
  check('2.2 Salario NAO referencia o resolver de janelas', b.salario_ref_resolver === false);
  check('2.3 Salario NAO carrega a flag de governanca do incidente', b.salario_flag_gov === false);
  check('2.4 Salario esta no corpo AUTENTICO pre-incidente', b.salario_md5 === AUTHENTIC_MD5);
  check('2.5 fundacao do Ranking continua existindo (tabela)', Number(b.ranking_tabela) === 1);
  check('2.6 fundacao do Ranking continua existindo (4 funcoes)', Number(b.ranking_fns) === 4);

  // -------------------------------------------------------------
  console.log('\n[3] GUARDA B -- cobertura de ferias/ausencia visivel');
  // -------------------------------------------------------------
  const cov = async ([a, z]) => one(`select
      jsonb_array_length(res->'rows') as total,
      (select count(*) from jsonb_array_elements(res->'rows') e where e->>'transfer'='true')  as cobertura,
      (select count(*) from jsonb_array_elements(res->'rows') e where e->>'transfer'='false') as oficiais,
      (select count(*) from jsonb_array_elements(res->'rows') e
         where e->>'transfer'='true' and e->>'covered_start' is not null and e->>'covered_end' is not null) as com_datas
    from (select public.operational_analyst_commission_metrics(date '${a}', date '${z}') as res) t`);

  // impersonar MASTER apenas para leitura
  await runSql(token, `select 1`);
  const imp = `select set_config('request.jwt.claims', json_build_object('sub',(select auth_user_id from public.usuarios
      where ativo and upper(trim(coalesce(perfil,'')))='MASTER' and auth_user_id is not null order by nome limit 1))::text, false) is not null as ok`;
  await runSql(token, imp);

  const c1 = await one(`${imp.replace('select ', 'with imp as (select ').replace(' as ok', ' as ok) select ')}
      jsonb_array_length(res->'rows') as total,
      (select count(*) from jsonb_array_elements(res->'rows') e where e->>'transfer'='true')  as cobertura,
      (select count(*) from jsonb_array_elements(res->'rows') e where e->>'transfer'='false') as oficiais,
      (select count(*) from jsonb_array_elements(res->'rows') e
         where e->>'transfer'='true' and e->>'covered_start' is not null and e->>'covered_end' is not null) as com_datas
    from imp, (select public.operational_analyst_commission_metrics(date '${COVERAGE_PERIOD[0]}', date '${COVERAGE_PERIOD[1]}') as res) t`);

  check('3.1 periodo com cobertura devolve linhas (nao vazio)', Number(c1.total) > 0);
  check('3.2 periodo com cobertura contem linhas transfer=true', Number(c1.cobertura) > 0);
  check('3.3 periodo com cobertura contem linhas oficiais', Number(c1.oficiais) > 0);
  check('3.4 toda linha de cobertura traz covered_start e covered_end',
    Number(c1.com_datas) === Number(c1.cobertura) && Number(c1.cobertura) > 0);

  const c2 = await one(`${imp.replace('select ', 'with imp as (select ').replace(' as ok', ' as ok) select ')}
      jsonb_array_length(res->'rows') as total,
      (select count(*) from jsonb_array_elements(res->'rows') e where e->>'transfer'='true') as cobertura
    from imp, (select public.operational_analyst_commission_metrics(date '${SECOND_COVERAGE_PERIOD[0]}', date '${SECOND_COVERAGE_PERIOD[1]}') as res) t`);
  check('3.5 segundo periodo historico tambem devolve linhas', Number(c2.total) > 0);
  check('3.6 segundo periodo historico tambem tem cobertura', Number(c2.cobertura) > 0);

  // -------------------------------------------------------------
  console.log('\n[4] Fundacao do Ranking permanece intacta');
  // -------------------------------------------------------------
  const r = await one(`select
      (select count(*) from public.analista_responsavel_loja where status='ACTIVE') as vigencias,
      (select count(distinct upper(trim(coalesce(loja,'')))) from public.usuarios
         where ativo and upper(trim(coalesce(perfil,'')))='ANALISTA') as lojas,
      (select count(*) from public.analista_responsavel_loja where valid_from < date '2026-08-21') as retroativas,
      (select count(*) from public.analista_responsavel_loja a join public.analista_responsavel_loja b
         on b.id<>a.id and b.loja_normalizada=a.loja_normalizada and a.status='ACTIVE' and b.status='ACTIVE'
        and daterange(a.valid_from,a.valid_to,'[)') && daterange(b.valid_from,b.valid_to,'[)')) as overlaps,
      (select count(*) from public.analista_responsavel_loja r2 join public.usuarios u on u.id=r2.analista_usuario_id
        where r2.loja_normalizada='BARRA FUNDA' and r2.status='ACTIVE' and upper(btrim(u.nome)) like '%GIOVANNA%') as bf_ok,
      (select count(*) from public.usuarios where ativo and upper(trim(coalesce(perfil,'')))='ANALISTA'
         and upper(trim(coalesce(loja,'')))='BARRA FUNDA') as bf_analistas,
      (select count(*) from public.analista_responsavel_loja_auditoria) as auditoria;`);
  check('4.1 uma vigencia ACTIVE por loja com analista', Number(r.vigencias) === Number(r.lojas) && Number(r.vigencias) > 0);
  check('4.2 nenhuma responsabilidade retroativa', Number(r.retroativas) === 0);
  check('4.3 zero sobreposicoes', Number(r.overlaps) === 0);
  check('4.4 BARRA FUNDA continua com a responsavel decidida pelo Humano', Number(r.bf_ok) === 1);
  check('4.5 os dois analistas de BARRA FUNDA continuam ativos', Number(r.bf_analistas) === 2);
  check('4.6 auditoria de responsabilidade preservada', Number(r.auditoria) > 0);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
