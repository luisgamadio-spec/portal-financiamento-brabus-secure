#!/usr/bin/env node
/*
 * [RANKING] PERF-5D.2A -- reparo do container do snapshot historico.
 *
 * Prova, contra o banco REAL, os quatro reparos e o que eles NAO mudaram:
 *
 *   G29 -- snapshot de periodo FECHADO recusa INSERT, UPDATE e DELETE nas
 *          tres tabelas; o fechamento legitimo continua funcionando porque
 *          grava com o periodo ainda OPEN;
 *   G30 -- a recusa e governada (PERF-5C ...) e nunca um erro interno de
 *          PL/pgSQL sobre campo de record inexistente;
 *   G32 -- a versao de regra 2026.2 congela o conjunto fora de escopo como
 *          DADO, o snapshot copia esse conjunto, e a leitura historica
 *          sobrevive ao apagamento da tabela mutavel de autoridade;
 *   G31 -- a linhagem de refechamento e explicita: v3 -> v2 -> v1.
 *
 * E prova que NENHUM resultado de negocio mudou: residuo zero, os oito
 * podios, o empate de junho, agosto, H8 e H10.
 *
 * SEGURANCA: todo ensaio roda dentro de BEGIN...ROLLBACK e o script recusa
 * por construcao qualquer bloco com statement COMMIT. O estado oficial e
 * conferido antes e depois. ZERO PII de cliente.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const PROJECT_REF = 'yacqlelpzchcotgngwbh';
const FORBIDDEN_PROJECT_REF = 'zhzubcismiwdypavwdxf';
const SALARY_MD5 = '3b7f632a7b4826bc44da641e0e294100';
const RESOLVE_STORE_MD5 = 'b3772d6468ef9c19d08448fa70701598';

const PODIO = {
  '2026-01': ['CAMILE', 43, 'BÁRBARA', 35], '2026-02': ['GIOVANNA', 50, 'CAMILE', 43],
  '2026-03': ['GIOVANNA', 50, 'FERNANDA', 35], '2026-04': ['WILLIAN', 50, 'Daiane', 35],
  '2026-05': ['DOUGLAS', 57, 'CAMILE', 35], '2026-06': ['CAMILE', 82, 'DOUGLAS', 52],
  '2026-07': ['DOUGLAS', 58, 'WILLIAN', 50], '2026-08': ['WILLIAN', 50, 'CAMILE', 43],
};
const SPF_APLICAVEL = { '2026-01': false, '2026-02': false, '2026-03': false, '2026-04': false,
  '2026-05': true, '2026-06': true, '2026-07': true, '2026-08': true };

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log('  PASS  ' + name + (extra ? '  ' + extra : '')); }
  else { failed++; console.log('  FAIL  ' + name + (extra ? '  ' + extra : '')); }
}
function h(t) { console.log('\n' + '='.repeat(78) + '\n' + t + '\n' + '='.repeat(78)); }

function readToken() {
  const p = path.join('C:', 'Projetos', 'portal-financiamento-brabus-secure', 'supabase', '.env.local');
  if (!fs.existsSync(p)) return null;
  const m = fs.readFileSync(p, 'utf-8').match(/SUPABASE_ACCESS_TOKEN=(.*)/);
  return m ? m[1].trim() : null;
}
function runSql(token, query) {
  if (/^\s*begin\s*;/im.test(query) && query.split('\n').some(l => /^\s*commit\s*(;|$)/i.test(l))) {
    return Promise.reject(new Error('bloco transacional com COMMIT recusado'));
  }
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query });
    const req = https.request({
      hostname: 'api.supabase.com', path: `/v1/projects/${PROJECT_REF}/database/query`, method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { resolve(d); } }); });
    req.on('error', reject); req.write(body); req.end();
  });
}

const ESTADO = `select (select count(*) from public.performance_periodo) periodos,
 (select count(*) from public.performance_snapshot) snapshots,
 (select count(*) from public.performance_snapshot_resultado) resultados,
 (select count(*) from public.performance_snapshot_detalhe) detalhes,
 (select count(*) from public.performance_auditoria) auditoria,
 (select count(*) from public.performance_loja_fora_de_escopo) fora_escopo`;

const IMPERSONA = `do $imp$ begin
  perform set_config('request.jwt.claims', json_build_object('sub',
    (select auth_user_id from public.usuarios where ativo
      and upper(trim(coalesce(perfil,'')))='MASTER' and auth_user_id is not null
      order by criado_em limit 1))::text, true);
end $imp$;`;

const MESES = `generate_series(date '2026-01-01', date '2026-08-01', interval '1 month') d(mes)`;
const CALC = `public.performance_calcular_periodo(d.mes::date, (d.mes + interval '1 month - 1 day')::date) c`;

(async () => {
  const token = readToken();
  if (!token) { console.log('[SKIP] sem SUPABASE_ACCESS_TOKEN local.'); process.exit(0); }
  if (token.includes(FORBIDDEN_PROJECT_REF)) throw new Error('token do projeto dormente');
  const one = async q => { const r = await runSql(token, q); return Array.isArray(r) ? (r[0] || {}) : { _e: JSON.stringify(r) }; };
  const all = async q => { const r = await runSql(token, q); return Array.isArray(r) ? r : []; };

  console.log('PERF-5D.2A -- REPARO DO CONTAINER DO SNAPSHOT HISTORICO');

  /* ---------- 1. Trava de dominio ---------- */
  h('1. TRAVA DE DOMINIO RANKING x SALARIO');
  const md5 = await one(`select
    (select md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='operational_analyst_commission_metrics') sal,
    (select length(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='operational_analyst_commission_metrics') bytes,
    (select md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='resolve_store_temporal') res`);
  ok('1.1 funcao de Salario intacta', md5.sal === SALARY_MD5, md5.sal);
  ok('1.2 tamanho da funcao de Salario intacto (16301)', Number(md5.bytes) === 16301);
  ok('1.3 resolvedor compartilhado intacto', md5.res === RESOLVE_STORE_MD5, md5.res);

  /* ---------- 2. Estado oficial antes ---------- */
  h('2. ESTADO OFICIAL ANTES');
  const ini = await one(ESTADO);
  const CHAVE = JSON.stringify(ini);
  ok('2.1 ZERO periodos oficiais', Number(ini.periodos) === 0);
  ok('2.2 ZERO snapshots oficiais', Number(ini.snapshots) === 0);
  ok('2.3 ZERO resultados oficiais', Number(ini.resultados) === 0);
  ok('2.4 ZERO detalhes oficiais', Number(ini.detalhes) === 0);
  ok('2.5 auditoria do incidente preservada (40)', Number(ini.auditoria) === 40, ini.auditoria + '');
  ok('2.6 autoridade H10 presente (1 loja)', Number(ini.fora_escopo) === 1);

  /* ---------- 3. G32 -- nova versao de regra, aditiva ---------- */
  h('3. G32 -- VERSAO DE REGRA CONGELA H10 SEM MUTAR A ANTERIOR');
  const rv = await all(`select versao, normalizacao_loja_versao norm, lojas_fora_de_escopo::text fora,
    pontos_retorno_novos_1 rn1, pontos_retorno_novos_2 rn2,
    pontos_retorno_seminovos_1 rs1, pontos_retorno_seminovos_2 rs2,
    pontos_und_financiado_1 uf1, pontos_und_financiado_2 uf2,
    pontos_und_spf_1 us1, pontos_und_spf_2 us2,
    regra_empate emp, regra_atividade_zero zero, resolver_g4 g4, aplicabilidade_g6 g6,
    spf_programa_inicio ini, spf_maio_override maio, spf_percentual_bruto pct
    from public.performance_regra_versao order by criado_em`);
  const v1 = rv.find(x => x.versao === '2026.1'), v2 = rv.find(x => x.versao === '2026.2');
  ok('3.1 a versao 2026.1 continua existindo', !!v1);
  ok('3.2 a 2026.1 NAO foi mutada no descritor', v1 && v1.norm === 'PERF5C_H7', v1 && v1.norm);
  ok('3.3 a 2026.1 declara conjunto vazio (antecede H10)', v1 && v1.fora === '{}', v1 && v1.fora);
  ok('3.4 existe a nova versao 2026.2', !!v2);
  ok('3.5 a 2026.2 nomeia H7 e H10', v2 && v2.norm === 'PERF5D2A_H7_H10', v2 && v2.norm);
  ok('3.6 a 2026.2 congela REVENDA como fora de escopo', v2 && v2.fora === '{REVENDA}', v2 && v2.fora);
  const iguais = ['rn1','rn2','rs1','rs2','uf1','uf2','us1','us2','emp','zero','g4','g6','ini','maio','pct'];
  ok('3.7 a 2026.2 preserva TODOS os valores de pontuacao da 2026.1',
    v1 && v2 && iguais.every(k => String(v1[k]) === String(v2[k])),
    iguais.filter(k => v1 && v2 && String(v1[k]) !== String(v2[k])).join(',') || 'identicos');
  ok('3.8 somente duas versoes de regra existem', rv.length === 2, rv.length + '');
  const nova = await one(`select rv.versao from public.performance_regra_versao rv
    order by rv.criado_em desc limit 1`);
  ok('3.9 um periodo novo adotaria a 2026.2', nova.versao === '2026.2', nova.versao);
  const col = await all(`select table_name, is_nullable, column_default from information_schema.columns
    where table_schema='public' and column_name='lojas_fora_de_escopo' order by 1`);
  ok('3.10 a versao de regra tem o conjunto como coluna NOT NULL',
    col.some(c => c.table_name === 'performance_regra_versao' && c.is_nullable === 'NO'));
  ok('3.11 o snapshot tem o conjunto como coluna NOT NULL',
    col.some(c => c.table_name === 'performance_snapshot' && c.is_nullable === 'NO'));

  /* ---------- 4. G32 -- auto-descricao real, nao rotulo ---------- */
  h('4. G32 -- A LEITURA HISTORICA SOBREVIVE AO APAGAMENTO DA CONFIG MUTAVEL');
  const g32 = await all(`begin;
${IMPERSONA}
create temp table _g(passo text, payload jsonb) on commit drop;
do $x$
declare j jsonb; p uuid; sn uuid; rv uuid;
begin
  j := public.master_performance_criar_periodo(date '2026-01-01');
  p := (j->>'periodo_id')::uuid;
  j := public.master_performance_fechar_periodo(p, 'prova G32');
  sn := (j->>'snapshot_id')::uuid;
  select regra_versao_id into rv from public.performance_snapshot where id=sn;
  insert into _g select 'antes', to_jsonb(x) from (
    select (select lojas_fora_de_escopo::text from public.performance_snapshot where id=sn) snap_fora,
      (select operacoes_consideradas from public.performance_snapshot where id=sn) ops) x;
  delete from public.performance_loja_fora_de_escopo;
  insert into _g select 'depois', to_jsonb(x) from (
    select (select lojas_fora_de_escopo::text from public.performance_snapshot where id=sn) snap_fora,
      (select count(*) from public.performance_loja_fora_de_escopo) tabela_mutavel,
      ('REVENDA' = any (public.performance_lojas_fora_de_escopo_versao(rv))) fora_pela_regra,
      (select count(*) from public.performance_calcular_periodo(
         date '2026-01-01', date '2026-01-31', rv) c where c.loja='REVENDA') revenda_congelado,
      (select coalesce(sum(c.operacoes),0)::int from public.performance_calcular_periodo(
         date '2026-01-01', date '2026-01-31', rv) c) ops_congelado,
      (select count(*) from public.performance_calcular_periodo(
         date '2026-01-01', date '2026-01-31') c where c.loja='REVENDA') revenda_corrente) x;
end $x$;
select * from _g;
rollback;`);
  const gA = (g32.find(r => r.passo === 'antes') || {}).payload || {};
  const gD = (g32.find(r => r.passo === 'depois') || {}).payload || {};
  ok('4.1 o snapshot congela o conjunto fora de escopo', gA.snap_fora === '{REVENDA}', gA.snap_fora);
  ok('4.2 a tabela mutavel foi realmente esvaziada na sonda', Number(gD.tabela_mutavel) === 0);
  ok('4.3 o snapshot AINDA diz que REVENDA estava fora', gD.snap_fora === '{REVENDA}', gD.snap_fora);
  ok('4.4 a versao de regra AINDA responde que REVENDA esta fora', gD.fora_pela_regra === true);
  ok('4.5 o recalculo pela regra congelada NAO traz REVENDA de volta',
    Number(gD.revenda_congelado) === 0, gD.revenda_congelado + ' linha(s)');
  ok('4.6 o recalculo congelado reproduz o mesmo universo',
    Number(gD.ops_congelado) === Number(gA.ops), gD.ops_congelado + ' x ' + gA.ops);
  ok('4.7 sem a regra congelada, REVENDA voltaria -- e o que torna o congelamento necessario',
    Number(gD.revenda_corrente) === 1, gD.revenda_corrente + ' linha(s)');

  /* ---------- 5. G29 -- travas cobrem INSERT ---------- */
  h('5. G29 -- AS TRAVAS COBREM INSERT, UPDATE E DELETE');
  const trg = await all(`select c.relname tabela, pg_get_triggerdef(t.oid) def
    from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and not t.tgisinternal
      and c.relname in ('performance_snapshot','performance_snapshot_resultado','performance_snapshot_detalhe')
    order by 1`);
  ok('5.1 as tres tabelas de snapshot tem trava', trg.length === 3, trg.length + '');
  ['performance_snapshot', 'performance_snapshot_resultado', 'performance_snapshot_detalhe']
    .forEach((t, i) => {
      const d = (trg.find(x => x.tabela === t) || {}).def || '';
      ok('5.' + (i + 2) + ' ' + t + ' cobre INSERT, UPDATE e DELETE',
        /INSERT/i.test(d) && /UPDATE/i.test(d) && /DELETE/i.test(d));
    });
  ok('5.5 a auditoria segue append-only em UPDATE/DELETE',
    /BEFORE DELETE OR UPDATE/i.test((await one(`select pg_get_triggerdef(t.oid) def from pg_trigger t
      join pg_class c on c.oid=t.tgrelid where c.relname='performance_auditoria' and not t.tgisinternal`)).def || ''));

  /* ---------- 6. G29 + G30 -- matriz viva de recusa ---------- */
  h('6. MATRIZ VIVA -- TODA MUTACAO NAO AUTORIZADA E RECUSADA E GOVERNADA');
  const mat = await all(`begin;
${IMPERSONA}
create temp table _t(tentativa text, bloqueado boolean, governado boolean,
  erro_interno boolean, erro text) on commit drop;
create temp table _c(chave text, valor text) on commit drop;
do $x$
declare j jsonb; p uuid; sn uuid; rid uuid; did uuid; aid bigint; outro uuid;
begin
  j := public.master_performance_criar_periodo(date '2026-01-01');
  p := (j->>'periodo_id')::uuid;
  j := public.master_performance_fechar_periodo(p, 'matriz 5D.2A');
  sn := (j->>'snapshot_id')::uuid;
  select id into rid from public.performance_snapshot_resultado where snapshot_id=sn limit 1;
  select id into did from public.performance_snapshot_detalhe where snapshot_id=sn limit 1;
  select id into aid from public.performance_auditoria order by id limit 1;
  select u.id into outro from public.usuarios u where u.ativo
    and not exists (select 1 from public.performance_snapshot_resultado q
      where q.snapshot_id=sn and q.analista_usuario_id=u.id) limit 1;

  begin
    insert into public.performance_snapshot_resultado (snapshot_id, analista_usuario_id,
      retorno_novos, retorno_seminovos, und_financiado, und_spf, pontos_retorno_novos,
      pontos_retorno_seminovos, pontos_und_financiado, pontos_und_spf, pontos_total, max_score)
    values (sn, outro, 1, 1, 1, 1, 35, 35, 15, 15, 100, 100);
    insert into _t values ('INSERT resultado', false, false, false, null);
  exception when others then insert into _t values ('INSERT resultado', true,
    sqlerrm like 'PERF-5C%', sqlerrm like '%has no field%', sqlerrm); end;

  begin
    insert into public.performance_snapshot_detalhe (snapshot_id, analista_usuario_id,
      loja, departamento, operacoes, retorno, spf_unidades, responsabilidade_procedencia)
    values (sn, outro, 'LOJA FANTASMA', 'NOVOS', 1, 1, 0, 'FORJADO');
    insert into _t values ('INSERT detalhe', false, false, false, null);
  exception when others then insert into _t values ('INSERT detalhe', true,
    sqlerrm like 'PERF-5C%', sqlerrm like '%has no field%', sqlerrm); end;

  begin
    insert into public.performance_snapshot (periodo_id, snapshot_versao, regra_versao_id,
      responsabilidade_procedencias, resolver_g4, spf_aplicavel, max_score,
      fonte_fingerprint, operacoes_consideradas, retorno_total, operacoes_nao_atribuidas)
    select p, 99, regra_versao_id, array[]::text[], 'STRICT_DATE_BOUNDED', false, 85,
      'forjado', 0, 0, 0 from public.performance_periodo where id=p;
    insert into _t values ('INSERT cabecalho', false, false, false, null);
  exception when others then insert into _t values ('INSERT cabecalho', true,
    sqlerrm like 'PERF-5C%', sqlerrm like '%has no field%', sqlerrm); end;

  begin update public.performance_snapshot_resultado set pontos_total=999 where id=rid;
    insert into _t values ('UPDATE resultado', false, false, false, null);
  exception when others then insert into _t values ('UPDATE resultado', true,
    sqlerrm like 'PERF-5C%', sqlerrm like '%has no field%', sqlerrm); end;

  begin delete from public.performance_snapshot_resultado where id=rid;
    insert into _t values ('DELETE resultado', false, false, false, null);
  exception when others then insert into _t values ('DELETE resultado', true,
    sqlerrm like 'PERF-5C%', sqlerrm like '%has no field%', sqlerrm); end;

  begin update public.performance_snapshot_detalhe set operacoes=999 where id=did;
    insert into _t values ('UPDATE detalhe', false, false, false, null);
  exception when others then insert into _t values ('UPDATE detalhe', true,
    sqlerrm like 'PERF-5C%', sqlerrm like '%has no field%', sqlerrm); end;

  begin delete from public.performance_snapshot_detalhe where id=did;
    insert into _t values ('DELETE detalhe', false, false, false, null);
  exception when others then insert into _t values ('DELETE detalhe', true,
    sqlerrm like 'PERF-5C%', sqlerrm like '%has no field%', sqlerrm); end;

  begin update public.performance_snapshot set retorno_total=1 where id=sn;
    insert into _t values ('UPDATE cabecalho', false, false, false, null);
  exception when others then insert into _t values ('UPDATE cabecalho', true,
    sqlerrm like 'PERF-5C%', sqlerrm like '%has no field%', sqlerrm); end;

  begin delete from public.performance_snapshot where id=sn;
    insert into _t values ('DELETE cabecalho', false, false, false, null);
  exception when others then insert into _t values ('DELETE cabecalho', true,
    sqlerrm like 'PERF-5C%', sqlerrm like '%has no field%', sqlerrm); end;

  begin update public.performance_auditoria set motivo='x' where id=aid;
    insert into _t values ('UPDATE auditoria', false, false, false, null);
  exception when others then insert into _t values ('UPDATE auditoria', true,
    sqlerrm like 'PERF-5C%', sqlerrm like '%has no field%', sqlerrm); end;

  begin delete from public.performance_auditoria where id=aid;
    insert into _t values ('DELETE auditoria', false, false, false, null);
  exception when others then insert into _t values ('DELETE auditoria', true,
    sqlerrm like 'PERF-5C%', sqlerrm like '%has no field%', sqlerrm); end;

  insert into _c values ('resultados', (select count(*)::text from public.performance_snapshot_resultado where snapshot_id=sn));
  insert into _c values ('detalhes', (select count(*)::text from public.performance_snapshot_detalhe where snapshot_id=sn));
  insert into _c values ('snapshots_do_periodo', (select count(*)::text from public.performance_snapshot where periodo_id=p));
  insert into _c values ('ops', (select operacoes_consideradas::text from public.performance_snapshot where id=sn));
  insert into _c values ('nao_atribuidas', (select operacoes_nao_atribuidas::text from public.performance_snapshot where id=sn));
end $x$;
select 'm' t, tentativa a, bloqueado::text b, governado::text c, erro_interno::text d from _t
union all select 'c', chave, valor, '', '' from _c;
rollback;`);
  const M = mat.filter(r => r.t === 'm');
  const C = Object.fromEntries(mat.filter(r => r.t === 'c').map(r => [r.a, r.b]));
  const ALVOS = ['INSERT resultado', 'INSERT detalhe', 'INSERT cabecalho', 'UPDATE resultado',
    'DELETE resultado', 'UPDATE detalhe', 'DELETE detalhe', 'UPDATE cabecalho', 'DELETE cabecalho',
    'UPDATE auditoria', 'DELETE auditoria'];
  ok('6.1 a matriz cobriu as 11 tentativas', M.length === 11, M.length + '');
  ALVOS.forEach((t, i) => {
    const r = M.find(x => x.a === t);
    ok('6.' + (i + 2) + ' ' + t + ' recusado', r && r.b === 'true');
  });
  ok('6.13 TODA recusa e governada (mensagem PERF-5C)',
    M.every(r => r.c === 'true'), M.filter(r => r.c !== 'true').map(r => r.a).join(',') || 'todas');
  ok('6.14 NENHUMA recusa e erro interno de campo de record (G30)',
    M.every(r => r.d === 'false'), M.filter(r => r.d !== 'false').map(r => r.a).join(',') || 'nenhuma');
  ok('6.15 os resultados do snapshot ficaram intactos', Number(C.resultados) === 8, C.resultados);
  ok('6.16 os detalhes do snapshot ficaram intactos', Number(C.detalhes) === 18, C.detalhes);
  ok('6.17 nenhum cabecalho extra foi criado', Number(C.snapshots_do_periodo) === 1, C.snapshots_do_periodo);
  ok('6.18 o fechamento legitimo continua funcionando', Number(C.ops) === 148, C.ops + ' ops');
  ok('6.19 nenhuma operacao ficou sem atribuicao', Number(C.nao_atribuidas) === 0);

  /* ---------- 7. G30 -- forma da trava ---------- */
  h('7. G30 -- A TRAVA RAMIFICA ANTES DE TOCAR CAMPO DE TABELA');
  const fn = await one(`select pg_get_functiondef(p.oid) def from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
      and p.proname='performance_snapshot_imutavel'`);
  const d = fn.def || '';
  ok('7.1 ramifica por TG_OP antes de ler o record', /if tg_op = 'DELETE' then v_rec := old; else v_rec := new; end if;/i.test(d));
  ok('7.2 a excecao de supersession fica ANINHADA sob a checagem de tabela',
    /if tg_table_name = 'performance_snapshot' and tg_op = 'UPDATE' then\s*\n\s*if /i.test(d));
  ok('7.3 nao ha CASE unico citando old e new no retorno', !/return case tg_op/i.test(d));
  ok('7.4 o retorno usa IF explicito', /if tg_op = 'DELETE' then return old; else return new; end if;/i.test(d));
  ok('7.5 o cabecalho resolve o periodo direto (INSERT nao consulta a si mesmo)',
    /where p\.id = v_rec\.periodo_id/i.test(d));
  ok('7.6 mantem registro duravel da recusa no log do servidor', /raise warning/i.test(d));
  ok('7.7 a excecao governada continua sendo levantada', /snapshot de periodo FECHADO e imutavel/i.test(d));

  /* ---------- 8. G31 -- linhagem explicita ---------- */
  h('8. G31 -- LINHAGEM EXPLICITA v3 -> v2 -> v1');
  const lin = await all(`begin;
${IMPERSONA}
create temp table _v(fase text, payload jsonb) on commit drop;
do $x$
declare j jsonb; p uuid; s1 uuid; s2 uuid; s3 uuid;
begin
  j := public.master_performance_criar_periodo(date '2026-06-01');
  p := (j->>'periodo_id')::uuid;
  j := public.master_performance_fechar_periodo(p, 'v1'); s1 := (j->>'snapshot_id')::uuid;
  j := public.master_performance_reabrir_periodo(p, 'reabertura 1');
  j := public.master_performance_fechar_periodo(p, 'v2'); s2 := (j->>'snapshot_id')::uuid;
  j := public.master_performance_reabrir_periodo(p, 'reabertura 2');
  j := public.master_performance_fechar_periodo(p, 'v3'); s3 := (j->>'snapshot_id')::uuid;
  insert into _v select 'cadeia', to_jsonb(x) from (
    select s.snapshot_versao v,
      (s.supersedes_snapshot_id is null) sem_anterior,
      (s.supersedes_snapshot_id = s1) aponta_v1,
      (s.supersedes_snapshot_id = s2) aponta_v2,
      (s.superseded_at is not null) superado,
      (select count(*) from public.performance_snapshot_resultado q where q.snapshot_id=s.id) res,
      (select count(*) from public.performance_snapshot_detalhe t where t.snapshot_id=s.id) det,
      s.lojas_fora_de_escopo::text fora
    from public.performance_snapshot s where s.periodo_id=p order by s.snapshot_versao) x;
  insert into _v select 'periodo', to_jsonb(x) from (
    select pe.status, (pe.current_snapshot_id = s3) aponta_v3,
      (select count(*) from public.performance_snapshot where periodo_id=p) total
    from public.performance_periodo pe where pe.id=p) x;
end $x$;
select * from _v;
rollback;`);
  const cad = lin.filter(r => r.fase === 'cadeia').map(r => r.payload)
    .sort((a, b) => a.v - b.v);
  const per = (lin.find(r => r.fase === 'periodo') || {}).payload || {};
  ok('8.1 tres versoes foram criadas', cad.length === 3, cad.length + '');
  ok('8.2 v1 nao supera ninguem', cad[0] && cad[0].v === 1 && cad[0].sem_anterior === true);
  ok('8.3 v2 aponta explicitamente para v1', cad[1] && cad[1].v === 2 && cad[1].aponta_v1 === true);
  ok('8.4 v3 aponta explicitamente para v2', cad[2] && cad[2].v === 3 && cad[2].aponta_v2 === true);
  ok('8.5 v1 e v2 ficam marcadas como superadas',
    cad[0] && cad[0].superado === true && cad[1] && cad[1].superado === true);
  ok('8.6 v3 e a vigente e nao esta superada', cad[2] && cad[2].superado === false);
  ok('8.7 as linhas de resultado das versoes anteriores foram preservadas',
    cad.every(x => Number(x.res) === Number(cad[0].res) && Number(x.res) > 0), cad.map(x => x.res).join('/'));
  ok('8.8 as linhas de detalhe das versoes anteriores foram preservadas',
    cad.every(x => Number(x.det) === Number(cad[0].det) && Number(x.det) > 0), cad.map(x => x.det).join('/'));
  ok('8.9 cada versao congela o conjunto fora de escopo',
    cad.every(x => x.fora === '{REVENDA}'));
  ok('8.10 o periodo aponta para a versao vigente', per.aponta_v3 === true);
  ok('8.11 as tres versoes coexistem', Number(per.total) === 3, per.total + '');

  /* ---------- 9. Resultados de negocio inalterados ---------- */
  h('9. NENHUM RESULTADO DE NEGOCIO MUDOU');
  const res = await all(`select to_char(d.mes,'YYYY-MM') mes,
      coalesce(sum(c.operacoes) filter (where c.analista_usuario_id is null),0)::int residuo
    from ${MESES} cross join lateral ${CALC} group by 1 order by 1`);
  ok('9.1 os oito meses calculam', res.length === 8, res.length + '');
  res.forEach((m, i) => ok('9.' + (i + 2) + ' ' + m.mes + ' residuo elegivel = 0',
    Number(m.residuo) === 0, m.residuo + ''));
  const ens = await all(`begin;
${IMPERSONA}
create temp table _s(mes text, nome text, total int, und_fin int, und_spf int,
  rs numeric, spf_ok boolean, maxs int, regra text, fora text) on commit drop;
do $x$
declare m date; j jsonb; p uuid; sn uuid;
begin
  for m in select generate_series(date '2026-01-01', date '2026-08-01', interval '1 month')::date loop
    j := public.master_performance_criar_periodo(m);
    p := (j->>'periodo_id')::uuid;
    j := public.master_performance_fechar_periodo(p, 'PERF-5D.2A ensaio');
    sn := (j->>'snapshot_id')::uuid;
    insert into _s select to_char(m,'YYYY-MM'), split_part(btrim(u.nome),' ',1),
      q.pontos_total, q.und_financiado, q.und_spf, q.retorno_seminovos,
      (j->>'spf_aplicavel')::boolean, q.max_score, j->>'regra_versao',
      (select lojas_fora_de_escopo::text from public.performance_snapshot where id=sn)
    from public.performance_snapshot_resultado q
    join public.usuarios u on u.id=q.analista_usuario_id where q.snapshot_id=sn;
  end loop;
end $x$;
select * from _s order by mes, total desc, nome;
rollback;`);
  ok('9.10 o ensaio cobriu os oito meses', new Set(ens.map(x => x.mes)).size === 8);
  ok('9.11 todo snapshot usaria a versao de regra 2026.2',
    ens.every(x => x.regra === '2026.2'));
  ok('9.12 todo snapshot congela {REVENDA}', ens.every(x => x.fora === '{REVENDA}'));
  let i9 = 13;
  for (const [mes, [vN, vP, sN, sP]] of Object.entries(PODIO)) {
    const L = ens.filter(x => x.mes === mes).sort((a, b) => b.total - a.total);
    const v = L[0];
    ok('9.' + (i9++) + ' ' + mes + ' vencedor ' + vN + ' com ' + vP,
      v && v.nome === vN && Number(v.total) === vP, v ? v.nome + '=' + v.total : '-');
    const vice = L.filter(x => Number(x.total) !== Number(v.total))[0];
    ok('9.' + (i9++) + ' ' + mes + ' vice com ' + sP,
      vice && Number(vice.total) === sP && L.some(x => x.nome === sN && Number(x.total) === sP));
    ok('9.' + (i9++) + ' ' + mes + ' SPF aplicavel = ' + SPF_APLICAVEL[mes] + ' e teto ' + (SPF_APLICAVEL[mes] ? 100 : 85),
      L.every(x => x.spf_ok === SPF_APLICAVEL[mes] && Number(x.maxs) === (SPF_APLICAVEL[mes] ? 100 : 85)));
  }

  /* ---------- 10. Empate de junho e agosto ---------- */
  h('10. EMPATE DE JUNHO E RECUPERACAO DE AGOSTO');
  const jun = ens.filter(x => x.mes === '2026-06');
  const jW = jun.find(x => x.nome === 'WILLIAN'), jC = jun.find(x => x.nome === 'CAMILE');
  ok('10.1 junho Willian UND Financiado = 28', jW && Number(jW.und_fin) === 28, jW && jW.und_fin + '');
  ok('10.2 junho Camile UND Financiado = 28', jC && Number(jC.und_fin) === 28, jC && jC.und_fin + '');
  ok('10.3 junho Willian totaliza 30', jW && Number(jW.total) === 30, jW && jW.total + '');
  ok('10.4 junho Camile totaliza 82', jC && Number(jC.total) === 82, jC && jC.total + '');
  const ago = ens.filter(x => x.mes === '2026-08');
  const aW = ago.find(x => x.nome === 'WILLIAN'), aF = ago.find(x => x.nome === 'FERNANDA'),
    aJ = ago.find(x => x.nome === 'JACENIR');
  ok('10.5 agosto Willian 34 UND / 50 pontos', aW && Number(aW.und_fin) === 34 && Number(aW.total) === 50);
  ok('10.6 agosto Fernanda 27 UND / 25 pontos', aF && Number(aF.und_fin) === 27 && Number(aF.total) === 25);
  ok('10.7 agosto Jacenir 19 UND / 17 pontos', aJ && Number(aJ.und_fin) === 19 && Number(aJ.total) === 17);
  ok('10.8 agosto Jacenir Retorno Seminovos = 53.473,88',
    aJ && Math.abs(Number(aJ.rs) - 53473.88) < 0.005, aJ && aJ.rs);

  /* ---------- 11. Estado oficial depois ---------- */
  h('11. ESTADO OFICIAL DEPOIS -- NADA FOI FECHADO');
  const fim = await one(ESTADO);
  ok('11.1 estado oficial identico ao inicial', JSON.stringify(fim) === CHAVE, JSON.stringify(fim));
  ok('11.2 ZERO periodos oficiais', Number(fim.periodos) === 0);
  ok('11.3 ZERO snapshots oficiais', Number(fim.snapshots) === 0);
  ok('11.4 ZERO resultados oficiais', Number(fim.resultados) === 0);
  ok('11.5 ZERO detalhes oficiais', Number(fim.detalhes) === 0);
  ok('11.6 auditoria segue com 40 linhas -- sem vazamento de ensaio',
    Number(fim.auditoria) === 40, fim.auditoria + '');
  ok('11.7 a autoridade H10 continua com 1 loja', Number(fim.fora_escopo) === 1);
  const md5f = await one(`select
    (select md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='operational_analyst_commission_metrics') sal,
    (select md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname='resolve_store_temporal') res`);
  ok('11.8 funcao de Salario intacta ao fim', md5f.sal === SALARY_MD5);
  ok('11.9 resolvedor compartilhado intacto ao fim', md5f.res === RESOLVE_STORE_MD5);
  const resp = await one(`select count(*) filter (where status='ACTIVE') ativo,
    count(*) filter (where status='SUPERSEDED') sup from public.analista_responsavel_loja`);
  ok('11.10 responsabilidade inalterada (23 ACTIVE / 4 SUPERSEDED)',
    Number(resp.ativo) === 23 && Number(resp.sup) === 4, resp.ativo + '/' + resp.sup);

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FALHA: ' + e.message); process.exit(1); });
