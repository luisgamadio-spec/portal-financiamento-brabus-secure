#!/usr/bin/env node
/*
 * RH-ANALYST-3 -- verificação LIVE, SOMENTE LEITURA, do estado governado
 * de responsabilidade do Analista F&I após o apply + bootstrap.
 *
 * Não cria, não altera e não remove nada: só SELECT contra o projeto real
 * (yacqlelpzchcotgngwbh, guardado explicitamente -- nunca
 * zhzubcismiwdypavwdxf). Serve como regressão permanente: se alguém
 * introduzir uma sobreposição, apagar uma vigência, criar autoridade
 * retroativa ou mexer no roster de BARRA FUNDA, este teste quebra.
 *
 * Decisões humanas codificadas aqui:
 *   - Option C: uma loja tem no máximo UM analista responsável por vez;
 *   - BARRA FUNDA -> Giovanna, a partir de 2026-08-21 (prospectivo);
 *   - nenhuma responsabilidade antes de 2026-08-21.
 *
 * Zero PII: nenhum nome, CPF, e-mail ou UUID é impresso.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const PROJECT_REF = 'yacqlelpzchcotgngwbh';
const FORBIDDEN_PROJECT_REF = 'zhzubcismiwdypavwdxf';
const START_DATE = '2026-08-21';

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
      return reject(new Error('este teste é somente-leitura; statement não-SELECT recusado'));
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

(async () => {
  const token = readToken();
  if (!token) {
    console.log('[SKIP] sem SUPABASE_ACCESS_TOKEN local -- este teste exige acesso de leitura ao projeto real.');
    process.exit(0);
  }
  if (token.includes(FORBIDDEN_PROJECT_REF)) throw new Error('token referencia o projeto dormente proibido');

  const one = async (q) => (await runSql(token, q))[0] || {};

  console.log('\n[1] Fundação aplicada');
  const o = await one(`select
    (select count(*) from pg_class where relname='analista_responsavel_loja' and relkind='r') as tabela,
    (select count(*) from pg_class where relname='analista_responsavel_loja_auditoria' and relkind='r') as auditoria,
    (select count(*) from pg_extension where extname='btree_gist') as btree_gist,
    (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
       and p.proname in ('resolve_analista_responsavel','analista_responsabilidade_janelas',
                         'analista_responsabilidade_cobertura','master_definir_analista_responsavel')) as funcoes,
    (select count(*) from pg_constraint where conname='analista_responsavel_loja_sem_sobreposicao' and contype='x') as invariante,
    (select count(*) from pg_class where relname='analista_responsavel_loja' and relrowsecurity) as rls,
    (select count(*) from information_schema.role_table_grants
       where table_schema='public' and table_name like 'analista_responsavel%'
         and grantee in ('anon','authenticated')) as grants_indevidos;`);
  check('1.1 tabela de responsabilidade existe', Number(o.tabela) === 1);
  check('1.2 tabela de auditoria existe', Number(o.auditoria) === 1);
  check('1.3 btree_gist instalado', Number(o.btree_gist) === 1);
  check('1.4 as 4 funções canônicas existem', Number(o.funcoes) === 4);
  check('1.5 INVARIANTE de sobreposição ativa no banco (contype=x)', Number(o.invariante) === 1);
  check('1.6 RLS habilitada', Number(o.rls) === 1);
  check('1.7 anon/authenticated NÃO têm grant de tabela', Number(o.grants_indevidos) === 0);

  console.log('\n[2] Cobertura das lojas com analista ativo');
  const c = await one(`select
    (select count(distinct upper(trim(coalesce(loja,'')))) from public.usuarios
       where ativo and upper(trim(coalesce(perfil,'')))='ANALISTA') as lojas_com_analista,
    (select count(*) from public.analista_responsavel_loja where status='ACTIVE') as vigencias_ativas,
    (select count(*) from public.analista_responsavel_loja) as vigencias_totais;`);
  check('2.1 uma vigência ACTIVE por loja com analista ativo',
    Number(c.lojas_com_analista) === Number(c.vigencias_ativas) && Number(c.vigencias_ativas) > 0);
  check('2.2 nenhuma vigência extra fora das ACTIVE', Number(c.vigencias_totais) === Number(c.vigencias_ativas));

  const gaps = await one(`select count(*) as sem_responsavel from (
      select upper(trim(coalesce(loja,''))) as loja from public.usuarios
       where ativo and upper(trim(coalesce(perfil,'')))='ANALISTA' group by 1) l
    where public.resolve_analista_responsavel(l.loja, date '${START_DATE}') is null;`);
  check('2.3 nenhuma loja fica sem responsável na data de início', Number(gaps.sem_responsavel) === 0);

  const today = await one(`select count(*) as sem_responsavel_hoje from (
      select upper(trim(coalesce(loja,''))) as loja from public.usuarios
       where ativo and upper(trim(coalesce(perfil,'')))='ANALISTA' group by 1) l
    where public.resolve_analista_responsavel(l.loja, current_date) is null;`);
  check('2.4 nenhuma loja fica sem responsável hoje', Number(today.sem_responsavel_hoje) === 0);

  console.log('\n[3] Invariante temporal');
  const ov = await one(`select count(*) as sobrepostos
    from public.analista_responsavel_loja a
    join public.analista_responsavel_loja b
      on b.id <> a.id and b.loja_normalizada = a.loja_normalizada
     and a.status='ACTIVE' and b.status='ACTIVE'
     and daterange(a.valid_from,a.valid_to,'[)') && daterange(b.valid_from,b.valid_to,'[)');`);
  check('3.1 zero sobreposições de responsabilidade', Number(ov.sobrepostos) === 0);

  const dates = await one(`select
      count(*) filter (where valid_from < date '${START_DATE}') as retroativas,
      count(*) filter (where valid_from = date '${START_DATE}') as na_data_autorizada,
      count(*) as total from public.analista_responsavel_loja;`);
  check('3.2 NENHUMA autoridade retroativa (nada antes de 2026-08-21)', Number(dates.retroativas) === 0);
  check('3.3 todas as vigências iniciais na data autorizada', Number(dates.na_data_autorizada) === Number(dates.total));

  const before = await one(`select count(*) as resolvem_antes from (
      select upper(trim(coalesce(loja,''))) as loja from public.usuarios
       where ativo and upper(trim(coalesce(perfil,'')))='ANALISTA' group by 1) l
    where public.resolve_analista_responsavel(l.loja, date '2026-08-20') is not null;`);
  check('3.4 fail-closed antes da vigência: nada resolve em 2026-08-20', Number(before.resolvem_antes) === 0);

  console.log('\n[4] BARRA FUNDA -- decisão explícita do Humano');
  const bf = await one(`select
      (select count(*) from public.analista_responsavel_loja where loja_normalizada='BARRA FUNDA' and status='ACTIVE') as vigencias,
      (select count(*) from public.analista_responsavel_loja r join public.usuarios u on u.id=r.analista_usuario_id
        where r.loja_normalizada='BARRA FUNDA' and upper(btrim(u.nome)) like '%GIOVANNA%'
          and r.valid_from = date '${START_DATE}' and r.valid_to is null and r.status='ACTIVE') as giovanna_ok,
      (select count(*) from public.usuarios where ativo and upper(trim(coalesce(perfil,'')))='ANALISTA'
         and upper(trim(coalesce(loja,'')))='BARRA FUNDA') as analistas_ativos_bf,
      (select count(*) from public.usuarios where ativo and upper(trim(coalesce(perfil,'')))='ANALISTA'
         and upper(trim(coalesce(loja,'')))='BARRA FUNDA' and upper(btrim(nome)) not like '%GIOVANNA%') as segundo_analista;`);
  check('4.1 BARRA FUNDA tem exatamente UMA vigência', Number(bf.vigencias) === 1);
  check('4.2 resolve para a analista escolhida pelo Humano, aberta, desde 2026-08-21', Number(bf.giovanna_ok) === 1);
  check('4.3 BARRA FUNDA mantém DOIS analistas ativos (roster != responsabilidade)', Number(bf.analistas_ativos_bf) === 2);
  check('4.4 o segundo analista continua ativo e intocado', Number(bf.segundo_analista) === 1);

  console.log('\n[5] Auditoria');
  const au = await one(`select
      (select count(*) from public.analista_responsavel_loja_auditoria) as eventos,
      (select count(*) from public.analista_responsavel_loja) as vigencias,
      (select count(*) from public.analista_responsavel_loja_auditoria where acao='CREATED') as criados,
      (select count(*) from public.analista_responsavel_loja_auditoria where analista_novo is null) as sem_analista,
      (select count(*) from public.analista_responsavel_loja_auditoria where valid_from <> date '${START_DATE}') as data_divergente;`);
  check('5.1 um evento de auditoria por vigência', Number(au.eventos) === Number(au.vigencias));
  check('5.2 todos os eventos são CREATED', Number(au.criados) === Number(au.eventos));
  check('5.3 todo evento nomeia o analista', Number(au.sem_analista) === 0);
  check('5.4 toda auditoria registra a data de vigência autorizada', Number(au.data_divergente) === 0);

  console.log('\n[6] Nada de folha foi tocado');
  const p = await one(`select
      (select count(*) from public.fechamentos_comissao) as fechamentos,
      (select count(*) from public.ausencias_analistas) as ausencias,
      (select count(*) from public.usuarios where ativo) as usuarios_ativos,
      (select (pg_get_functiondef(pr.oid) ~ 'order by u.nome') from pg_proc pr join pg_namespace n on n.oid=pr.pronamespace
        where n.nspname='public' and pr.prokind='f' and pr.proname='operational_analyst_commission_metrics') as regra_alfabetica_ainda_live,
      (select (pg_get_functiondef(pr.oid) like '%analista_responsavel_loja%') from pg_proc pr join pg_namespace n on n.oid=pr.pronamespace
        where n.nspname='public' and pr.prokind='f' and pr.proname='operational_analyst_commission_metrics') as consome_autoridade;`);
  check('6.1 fechamentos preservados (nenhuma competência fechada aqui)', Number(p.fechamentos) === 24);
  check('6.2 ausências/coberturas preservadas', Number(p.ausencias) === 26);
  check('6.3 roster de usuários ativos preservado', Number(p.usuarios_ativos) === 100);
  // RH-ANALYST-4A: a decisão do Humano é que o SALÁRIO mantém o seu
  // comportamento próprio -- inclusive a seleção alfabética, que é
  // reconhecidamente imperfeita mas pertence ao domínio do Salário.
  // A autoridade governada é do RANKING e o Salário NÃO deve consumi-la;
  // foi exatamente esse acoplamento que apagou as linhas de cobertura
  // de férias nos períodos anteriores a 2026-08-21.
  check('6.4 RPC de comissão mantém o comportamento próprio do Salário', p.regra_alfabetica_ainda_live === true);
  check('6.5 RPC de comissão NÃO consome a autoridade do Ranking', p.consome_autoridade === false);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
