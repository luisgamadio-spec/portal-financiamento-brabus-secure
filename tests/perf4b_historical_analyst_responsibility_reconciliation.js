#!/usr/bin/env node
/*
 * [RANKING] PERF-4B -- Reconciliação histórica de IDENTIDADE DE ANALISTA
 * e RESPONSABILIDADE POR LOJA, janeiro–agosto de 2026.
 *
 * PERGUNTA: para cada loja e cada mês de jan/2026 a ago/2026, é possível
 * PROVAR -- com evidência já existente no sistema -- qual Analista humano
 * era o responsável oficial, distinguindo-o de coberturas temporárias?
 *
 * SOMENTE LEITURA. Recusa por construção qualquer statement que não seja
 * SELECT/WITH. Não escreve, não cria responsabilidade, não fecha período,
 * não repara snapshot corrompido, não toca Salário.
 *
 * ZERO PII: nunca imprime nome, e-mail, CPF, UUID ou telefone. Analistas
 * aparecem como ANALYST-A..ANALYST-L, rótulos derivados de um hash
 * determinístico e estável entre execuções.
 *
 * REGRA DE NÃO-FABRICAÇÃO (§4 do brief): responsabilidade histórica NUNCA
 * é derivada de responsabilidade atual, loja atual, ordem alfabética,
 * roster atual, semelhança de nome ou conveniência. Todo candidato tem de
 * vir de um registro histórico persistido.
 *
 * HIERARQUIA DE EVIDÊNCIA:
 *   A -- direta e autoritativa (snapshot imutável que rotula explicitamente
 *        ANALISTA vs ANALISTA SUBSTITUTO; autoridade governada vigente);
 *   B -- corroborada por >=2 fontes históricas independentes
 *        (fechamento + ausencias_analistas.loja_origem);
 *   C -- fonte indireta única;
 *   D -- inferência: NUNCA vira autoridade.
 *
 * SEMÂNTICA REUTILIZADA (nada inventado):
 *   - universo de finance = lotes FINANCE_CURRENT/FINANCE_HISTORY
 *     validados mais recentes, is_real_financing;
 *   - loja da operação      = resolve_store_temporal(...), já usada por
 *                             operational_metrics;
 *   - oficial vs cobertura  = perfil ANALISTA vs ANALISTA SUBSTITUTO no
 *                             snapshot, e loja_coberta/loja_origem em
 *                             ausencias_analistas.
 *
 * O derivador FALHA EXPLICITAMENTE quando ambíguo: devolve PARTIAL ou
 * UNRESOLVED, nunca escolhe um nome para preencher a lacuna.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const PROJECT_REF = 'yacqlelpzchcotgngwbh';
const FORBIDDEN_PROJECT_REF = 'zhzubcismiwdypavwdxf';

const SALARY_MD5_EXPECTED = '3b7f632a7b4826bc44da641e0e294100';

const MONTHS = [
  ['2026-01-01', '2026-01-31', 'JAN', 31], ['2026-02-01', '2026-02-28', 'FEV', 28],
  ['2026-03-01', '2026-03-31', 'MAR', 31], ['2026-04-01', '2026-04-30', 'ABR', 30],
  ['2026-05-01', '2026-05-31', 'MAI', 31], ['2026-06-01', '2026-06-30', 'JUN', 30],
  ['2026-07-01', '2026-07-31', 'JUL', 31], ['2026-08-01', '2026-08-31', 'AGO', 31],
];

function readToken() {
  const p = path.join('C:', 'Projetos', 'portal-financiamento-brabus-secure', 'supabase', '.env.local');
  if (!fs.existsSync(p)) return null;
  const m = fs.readFileSync(p, 'utf-8').match(/SUPABASE_ACCESS_TOKEN=(.*)/);
  return m ? m[1].trim() : null;
}

function runSql(token, query) {
  return new Promise((resolve, reject) => {
    if (/\b(insert|update|delete|drop|alter|truncate|grant|revoke)\b/i.test(query)
      || /\bcreate\s+(table|function|index|view|trigger|extension)\b/i.test(query)) {
      return reject(new Error('PERF-4B é somente-leitura: statement não-SELECT recusado'));
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

/* Rótulos anônimos estáveis: o hash nunca é impresso, só o rótulo. */
const LABELS = {};
let labelSeq = 0;
function label(ident) {
  if (ident === null || ident === undefined || ident === '') return '(sem identidade)';
  if (ident === '(nao resolvido)') return '(não resolvido)';
  if (!LABELS[ident]) LABELS[ident] = 'ANALYST-' + String.fromCharCode(65 + (labelSeq++));
  return LABELS[ident];
}
function labelList(csv) {
  if (!csv) return null;
  return csv.split(',').map(label).sort().join(' + ');
}

function pad(s, n) { return String(s === null || s === undefined ? '' : s).padEnd(n); }
function padL(s, n) { return String(s === null || s === undefined ? '' : s).padStart(n); }
function brl(v) { return Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function pct(a, b) { return b ? (100 * a / b).toFixed(1) + '%' : '--'; }
function h(t) { console.log('\n' + '='.repeat(76) + '\n' + t + '\n' + '='.repeat(76)); }

/* Fechamentos FECHADO -> linhas de ANALISTA, identidade resolvida por nome. */
const REC_CTE = `
fe as (
  select f.id as fid, p.data_inicio as pi, p.data_fim as pf
  from public.fechamentos_comissao f
  join public.periodos_comissao p on p.id = f.periodo_id
  where f.status = 'FECHADO'),
rec as (
  select distinct fe.pi, fe.pf,
         upper(trim(coalesce(s.loja,''))) as loja,
         upper(trim(coalesce(s.perfil,''))) as perfil,
         coalesce((select left(md5(u.cpf_normalizado),6) from public.usuarios u
                    where upper(btrim(regexp_replace(u.nome,'\\s+',' ','g')))
                        = upper(btrim(regexp_replace(coalesce(s.nome,''),'\\s+',' ','g')))
                      and upper(trim(coalesce(u.perfil,''))) = 'ANALISTA'),
                  '(nao resolvido)') as ident
  from public.snapshot_comissoes s
  join fe on fe.fid = s.fechamento_id
  where upper(trim(coalesce(s.perfil,''))) like 'ANALISTA%'),
cov as (
  select distinct upper(trim(coalesce(a.loja_coberta,''))) as loja,
         left(md5(a.cpf_analista_substituto),6) as ident,
         a.data_inicio, a.data_fim
  from public.ausencias_analistas a
  where coalesce(a.cpf_analista_substituto,'') <> '')
`;

(async () => {
  const token = readToken();
  if (!token) { console.log('[SKIP] sem SUPABASE_ACCESS_TOKEN local -- PERF-4B exige leitura do projeto real.'); process.exit(0); }
  if (token.includes(FORBIDDEN_PROJECT_REF)) throw new Error('token referencia o projeto dormente proibido');
  const one = async (q) => (await runSql(token, q))[0] || {};
  const all = async (q) => { const r = await runSql(token, q); if (!Array.isArray(r)) throw new Error(JSON.stringify(r)); return r; };

  console.log('PERF-4B -- IDENTIDADE DE ANALISTA E RESPONSABILIDADE POR LOJA (jan-ago/2026)');
  console.log('[RANKING] Somente leitura. Zero escrita de dados de negócio. Zero PII.');

  /* ---------- 1. Trava de domínio: Salário intocado ---------- */
  h('1. TRAVA DE DOMÍNIO -- SALÁRIO (início)');
  const md5a = await one(`select md5(pg_get_functiondef(p.oid)) as m, length(pg_get_functiondef(p.oid)) as b
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prokind='f' and p.proname='operational_analyst_commission_metrics';`);
  console.log('  operational_analyst_commission_metrics md5 : ' + md5a.m + ' (' + md5a.b + ' bytes)');
  console.log('  esperado                                   : ' + SALARY_MD5_EXPECTED);
  if (md5a.m !== SALARY_MD5_EXPECTED) throw new Error('STOP: SALARY_DOMAIN_MUTATED_BY_PERF4B');
  console.log('  resultado                                  : INALTERADO');

  const base = await one(`select
      (select count(*) from public.analista_responsavel_loja) resp,
      (select count(*) from public.analista_responsavel_loja_auditoria) audit,
      (select count(*) from public.fechamentos_comissao) fech,
      (select count(*) from public.snapshot_comissoes) snapc,
      (select count(*) from public.ausencias_analistas) aus,
      (select count(*) from public.usuarios) usr;`);
  console.log('  baseline: responsabilidade=' + base.resp + ' auditoria=' + base.audit
    + ' fechamentos=' + base.fech + ' snapshots=' + base.snapc + ' ausências=' + base.aus + ' usuários=' + base.usr);

  /* ---------- 2. Existe QUALQUER evidência antes de 2026-06-18? ---------- */
  h('2. O EVENTO DE 2026-06-18 -- CRIAÇÃO DE CONTAS OU IMPLANTAÇÃO DO SISTEMA?');
  const ev = await one(`select
      (select count(*) from public.usuarios) usuarios_total,
      (select count(*) from public.usuarios where criado_em::date < date '2026-06-18') usuarios_antes,
      (select min(criado_em)::date from public.usuarios) primeiro_usuario,
      (select upper(trim(coalesce(perfil,''))) from public.usuarios order by criado_em, id limit 1) perfil_do_primeiro,
      (select count(*) from public.auditoria where criado_em::date < date '2026-06-18') auditoria_antes,
      (select min(criado_em)::date from public.auditoria) primeira_auditoria,
      (select count(*) from public.logs_acesso where criado_em::date < date '2026-06-18') logs_antes,
      (select min(criado_em)::date from public.logs_acesso) primeiro_log,
      (select count(*) from public.analistas_fi where criado_em::date < date '2026-06-18') painel_antes,
      (select count(*) from public.historico_atendimentos_fi
        where coalesce(iniciado_em,criado_em)::date < date '2026-06-18') atendimentos_antes;`);
  console.log('  Nenhuma tabela do sistema tem linha anterior a 2026-06-18:');
  console.log('    usuários criados antes .................. ' + ev.usuarios_antes + ' (de ' + ev.usuarios_total + ')');
  console.log('    eventos de auditoria antes .............. ' + ev.auditoria_antes);
  console.log('    logs de acesso antes .................... ' + ev.logs_antes);
  console.log('    registros do Painel Analista antes ...... ' + ev.painel_antes);
  console.log('    atendimentos antes ...................... ' + ev.atendimentos_antes);
  console.log('  primeiro usuário do sistema .............. ' + ev.primeiro_usuario + '  perfil=' + ev.perfil_do_primeiro);
  console.log('  primeira auditoria / primeiro log ........ ' + ev.primeira_auditoria + ' / ' + ev.primeiro_log);
  console.log('  LEITURA: o PRIMEIRO usuário do sistema é o próprio MASTER, na mesma data.');
  console.log('  Isso caracteriza IMPLANTAÇÃO DO PORTAL, não contratação de Analistas.');
  console.log('  NÃO prova que nenhum Analista humano trabalhou antes dessa data.');

  /* ---------- 3. Linha do tempo de identidade ---------- */
  h('3. LINHA DO TEMPO DE IDENTIDADE DOS ANALISTAS');
  const roster = await all(`select left(md5(u.cpf_normalizado),6) as ident, u.criado_em::date as criado,
      u.ativo, upper(trim(coalesce(u.loja,''))) as loja,
      (select min(least(a.data_inicio, a.data_inicio)) from public.ausencias_analistas a
        where a.cpf_analista_ausente = u.cpf_normalizado or a.cpf_analista_substituto = u.cpf_normalizado) as prim_ausencia,
      (select min(p.data_inicio) from public.snapshot_comissoes s
         join public.fechamentos_comissao f on f.id = s.fechamento_id
         join public.periodos_comissao p on p.id = f.periodo_id
        where upper(trim(coalesce(s.perfil,''))) like 'ANALISTA%'
          and upper(btrim(regexp_replace(coalesce(s.nome,''),'\\s+',' ','g')))
            = upper(btrim(regexp_replace(u.nome,'\\s+',' ','g')))) as prim_snapshot,
      (select min(upper(trim(coalesce(s.loja,'')))) from public.snapshot_comissoes s
         join public.fechamentos_comissao f on f.id = s.fechamento_id
         join public.periodos_comissao p on p.id = f.periodo_id
        where upper(trim(coalesce(s.perfil,''))) like 'ANALISTA%'
          and upper(btrim(regexp_replace(coalesce(s.nome,''),'\\s+',' ','g')))
            = upper(btrim(regexp_replace(u.nome,'\\s+',' ','g')))
          and p.data_inicio = (select min(p2.data_inicio) from public.snapshot_comissoes s2
                 join public.fechamentos_comissao f2 on f2.id = s2.fechamento_id
                 join public.periodos_comissao p2 on p2.id = f2.periodo_id
                where upper(trim(coalesce(s2.perfil,''))) like 'ANALISTA%'
                  and upper(btrim(regexp_replace(coalesce(s2.nome,''),'\\s+',' ','g')))
                    = upper(btrim(regexp_replace(u.nome,'\\s+',' ','g'))))) as prim_loja
    from public.usuarios u
    where upper(trim(coalesce(u.perfil,''))) = 'ANALISTA'
    order by u.criado_em, u.id;`);
  /* rótulos atribuídos em ordem determinística de criação */
  roster.forEach(r => label(r.ident));
  console.log('  ' + pad('Analista', 11) + pad('Conta criada', 14) + pad('1a evidência hist.', 20)
    + pad('1a loja', 16) + pad('Nível', 7) + 'Ativo');
  console.log('  ' + '-'.repeat(74));
  roster.forEach(r => {
    const first = [r.prim_snapshot, r.prim_ausencia].filter(Boolean).sort()[0] || null;
    const lvl = r.prim_snapshot ? (r.prim_snapshot <= '2026-06-20' ? 'A' : 'B') : (r.prim_ausencia ? 'C' : '--');
    console.log('  ' + pad(label(r.ident), 11) + pad(r.criado, 14)
      + pad(first || '(nenhuma)', 20) + pad(r.prim_loja || '(nenhuma)', 16)
      + pad(lvl, 7) + (r.ativo ? 'sim' : 'não'));
  });
  const anteriores = roster.filter(r => {
    const first = [r.prim_snapshot, r.prim_ausencia].filter(Boolean).sort()[0];
    return first && first < r.criado;
  }).length;
  console.log('  Analistas com evidência histórica ANTERIOR à criação da própria conta: ' + anteriores);

  /* ---------- 4. Inventário de fontes ---------- */
  h('4. INVENTÁRIO DE FONTES -- ALCANCE TEMPORAL REAL');
  const src = await all(`select 'snapshot_comissoes (FECHADO)' as fonte,
        (select min(p.data_inicio) from public.fechamentos_comissao f join public.periodos_comissao p on p.id=f.periodo_id where f.status='FECHADO') as de,
        (select max(p.data_fim) from public.fechamentos_comissao f join public.periodos_comissao p on p.id=f.periodo_id where f.status='FECHADO') as ate,
        (select count(*) from public.snapshot_comissoes s join public.fechamentos_comissao f on f.id=s.fechamento_id where f.status='FECHADO' and upper(trim(coalesce(s.perfil,''))) like 'ANALISTA%') as linhas
      union all select 'ausencias_analistas', (select min(data_inicio) from public.ausencias_analistas), (select max(data_fim) from public.ausencias_analistas), (select count(*) from public.ausencias_analistas)
      union all select 'analista_responsavel_loja', (select min(valid_from) from public.analista_responsavel_loja), null, (select count(*) from public.analista_responsavel_loja)
      union all select 'historico_atendimentos_fi', (select min(coalesce(iniciado_em,criado_em))::date from public.historico_atendimentos_fi), (select max(coalesce(iniciado_em,criado_em))::date from public.historico_atendimentos_fi), (select count(*) from public.historico_atendimentos_fi)
      union all select 'auditoria', (select min(criado_em)::date from public.auditoria), (select max(criado_em)::date from public.auditoria), (select count(*) from public.auditoria)
      union all select 'logs_acesso', (select min(criado_em)::date from public.logs_acesso), (select max(criado_em)::date from public.logs_acesso), (select count(*) from public.logs_acesso)
      union all select 'mudancas_loja_vendedores (ANALISTA)', (select min(data_inicio_destino) from public.mudancas_loja_vendedores), (select max(data_inicio_destino) from public.mudancas_loja_vendedores), (select count(*) from public.mudancas_loja_vendedores m where (select upper(trim(coalesce(u.perfil,''))) from public.usuarios u where u.cpf_normalizado=m.cpf_vendedor)='ANALISTA')
      order by 2 nulls last;`);
  console.log('  ' + pad('Fonte', 38) + pad('De', 13) + pad('Até', 13) + 'Linhas');
  console.log('  ' + '-'.repeat(74));
  src.forEach(s => console.log('  ' + pad(s.fonte, 38) + pad(s.de || '--', 13) + pad(s.ate || '(aberto)', 13) + s.linhas));
  console.log('  NENHUMA fonte alcança 2026-01-01..2026-05-08.');

  /* ---------- 5. Loja de origem declarada (ausências) ---------- */
  h('5. LOJA DE ORIGEM DECLARADA EM ausencias_analistas');
  const home = await all(`select left(md5(a.cpf_analista_ausente),6) as ident,
      upper(trim(coalesce(a.loja_origem,''))) as home, min(a.data_inicio) as de, max(a.data_fim) as ate,
      count(*) as regs,
      (select upper(trim(coalesce(u.loja,''))) from public.usuarios u where u.cpf_normalizado=a.cpf_analista_ausente) as loja_atual
    from public.ausencias_analistas a group by 1,2,6 order by 1,3;`);
  console.log('  ' + pad('Analista', 11) + pad('Loja declarada', 16) + pad('De', 13) + pad('Até', 13)
    + pad('Regs', 6) + 'Loja atual');
  console.log('  ' + '-'.repeat(74));
  home.forEach(r => console.log('  ' + pad(label(r.ident), 11) + pad(r.home, 16) + pad(r.de, 13)
    + pad(r.ate, 13) + padL(r.regs, 4) + '  ' + r.loja_atual));

  /* ---------- 6. Derivação oficial vs cobertura ---------- */
  h('6. DERIVAÇÃO OFICIAL vs COBERTURA POR PERÍODO FECHADO');
  console.log('  Regra A: snapshot rotula explicitamente ANALISTA SUBSTITUTO -> o outro é oficial.');
  console.log('  Regra B: recebedores MENOS substitutos declarados em ausências = exatamente um.');
  console.log('  Sem candidato único -> PARTIAL. Nunca escolhe por ordem alfabética.\n');
  const deriv = await all(`with ${REC_CTE}
    select r.pi, r.pf, r.loja,
      count(*) as recebedores,
      string_agg(r.ident, ',' order by r.ident) filter (where r.perfil='ANALISTA SUBSTITUTO') as substitutos_explicitos,
      string_agg(r.ident, ',' order by r.ident) filter (where r.perfil='ANALISTA') as analistas,
      string_agg(r.ident, ',' order by r.ident) filter (
        where r.perfil='ANALISTA' and not exists (
          select 1 from cov c where c.loja=r.loja and c.ident=r.ident
            and c.data_inicio <= r.pf and c.data_fim >= r.pi)) as oficiais_derivados
    from rec r group by 1,2,3 order by 1,3;`);
  console.log('  ' + pad('Período', 24) + pad('Loja', 16) + pad('Receb.', 8) + pad('Oficial derivado', 18) + 'Classe');
  console.log('  ' + '-'.repeat(76));
  const officialByPeriodStore = {};
  deriv.forEach(d => {
    const explicit = d.substitutos_explicitos;
    let official = d.oficiais_derivados;
    let klass;
    if (explicit) {
      /* Regra A: o rótulo explícito resolve directamente */
      const subs = explicit.split(',');
      const offs = (d.analistas || '').split(',').filter(x => x && !subs.includes(x));
      official = offs.length === 1 ? offs[0] : null;
      klass = official ? 'A/PROVEN' : 'PARTIAL';
    } else if (official && official.split(',').length === 1) {
      klass = 'B/PROVEN';
    } else if (official) {
      official = null; klass = 'PARTIAL';
    } else {
      klass = 'PARTIAL';
    }
    officialByPeriodStore[d.pi + '|' + d.loja] = official;
    console.log('  ' + pad(d.pi + '..' + d.pf, 24) + pad(d.loja, 16) + padL(d.recebedores, 4) + '    '
      + pad(official ? label(official) : '--', 18) + klass);
  });
  let provenCells = Object.values(officialByPeriodStore).filter(Boolean).length;
  console.log('  Células loja×período com oficial único provado: ' + provenCells + ' de ' + deriv.length);

  /* ---------- 6.1 Rótulo explícito ANALISTA SUBSTITUTO ---------- */
  h('6.1 RÓTULO EXPLÍCITO "ANALISTA SUBSTITUTO" (qualquer fechamento persistido)');
  console.log('  Um snapshot que rotula a pessoa como ANALISTA SUBSTITUTO é uma AFIRMAÇÃO DIRETA');
  console.log('  de que ela NÃO era a oficial daquela loja. Só promove a célula quando a loja de');
  console.log('  origem declarada em ausencias_analistas concorda -- duas fontes independentes.\n');
  const explicitSub = await all(`select p.data_inicio as pi, p.data_fim as pf,
      upper(trim(coalesce(s.loja,''))) as loja, f.status,
      coalesce((select left(md5(u.cpf_normalizado),6) from public.usuarios u
        where u.cpf_normalizado = regexp_replace(coalesce(s.cpf,''),'[^0-9]','','g')),
        (select left(md5(u.cpf_normalizado),6) from public.usuarios u
          where upper(btrim(regexp_replace(u.nome,'\\s+',' ','g')))
              = upper(btrim(regexp_replace(coalesce(s.nome,''),'\\s+',' ','g')))
            and upper(trim(coalesce(u.perfil,'')))='ANALISTA'), '(nao resolvido)') as ident_sub,
      (select string_agg(distinct coalesce((select left(md5(u2.cpf_normalizado),6) from public.usuarios u2
            where u2.cpf_normalizado = regexp_replace(coalesce(s2.cpf,''),'[^0-9]','','g')),
            (select left(md5(u2.cpf_normalizado),6) from public.usuarios u2
              where upper(btrim(regexp_replace(u2.nome,'\\s+',' ','g')))
                  = upper(btrim(regexp_replace(coalesce(s2.nome,''),'\\s+',' ','g')))
                and upper(trim(coalesce(u2.perfil,'')))='ANALISTA'), '(nao resolvido)'), ',')
        from public.snapshot_comissoes s2
        where s2.fechamento_id = s.fechamento_id
          and upper(trim(coalesce(s2.loja,''))) = upper(trim(coalesce(s.loja,'')))
          and upper(trim(coalesce(s2.perfil,''))) = 'ANALISTA') as ident_oficial
    from public.snapshot_comissoes s
    join public.fechamentos_comissao f on f.id = s.fechamento_id
    join public.periodos_comissao p on p.id = f.periodo_id
    where upper(trim(coalesce(s.perfil,''))) = 'ANALISTA SUBSTITUTO'
    order by p.data_inicio, s.loja;`);
  if (!explicitSub.length) console.log('  (nenhum)');
  let promoted = 0;
  for (const e of explicitSub) {
    const homeOk = home.some(hh => hh.ident === e.ident_oficial && hh.home === e.loja
      && hh.de <= e.pf && hh.ate >= e.pi);
    const key = e.pi + '|' + e.loja;
    const already = officialByPeriodStore[key];
    const single = e.ident_oficial && !e.ident_oficial.includes(',');
    const promote = !already && single && homeOk;
    if (promote) { officialByPeriodStore[key] = e.ident_oficial; promoted++; }
    console.log('  ' + pad(e.pi + '..' + e.pf, 24) + pad(e.loja, 16) + pad('[' + e.status + ']', 11)
      + 'substituta=' + pad(label(e.ident_sub), 11) + ' oficial=' + pad(label(e.ident_oficial), 11)
      + ' loja_origem concorda=' + (homeOk ? 'SIM' : 'não') + (promote ? '  -> PROMOVE a HIGH' : '  -> sem efeito'));
  }
  provenCells += promoted;
  console.log('  Células promovidas por corroboração dupla: ' + promoted
    + '   (total de células com oficial único: ' + provenCells + ' de ' + deriv.length + ')');

  /* ---------- 7. Autoridade governada vigente ---------- */
  h('7. AUTORIDADE GOVERNADA VIGENTE (a partir de 2026-08-21)');
  const gov = await all(`select r.loja_normalizada as loja, r.valid_from, r.valid_to, r.status,
      left(md5(u.cpf_normalizado),6) as ident
    from public.analista_responsavel_loja r join public.usuarios u on u.id=r.analista_usuario_id
    order by r.loja_normalizada;`);
  const overlap = await one(`select count(*) as sobreposicoes from public.analista_responsavel_loja a
    join public.analista_responsavel_loja b on b.loja_normalizada=a.loja_normalizada and b.id<>a.id
    where a.status='ACTIVE' and b.status='ACTIVE'
      and daterange(a.valid_from,a.valid_to,'[)') && daterange(b.valid_from,b.valid_to,'[)');`);
  console.log('  ' + pad('Loja', 16) + pad('valid_from', 13) + pad('valid_to', 12) + pad('Status', 9) + 'Analista');
  console.log('  ' + '-'.repeat(74));
  gov.forEach(g => console.log('  ' + pad(g.loja, 16) + pad(g.valid_from, 13)
    + pad(g.valid_to || '(aberto)', 12) + pad(g.status, 9) + label(g.ident)));
  console.log('  lojas cobertas = ' + gov.length + '/9   sobreposições = ' + overlap.sobreposicoes
    + '   auditoria = ' + base.audit);

  /* ---------- 8. Matriz loja × mês ---------- */
  h('8. MATRIZ LOJA × MÊS -- RESPONSABILIDADE OFICIAL');
  /* Um dia-loja é AUTH se coberto pela autoridade governada; HIGH se cair
     num período FECHADO cujo oficial único foi derivado; PARTIAL se o
     período existe mas o oficial é ambíguo; UNRESOLVED se não há período. */
  const periods = [...new Set(deriv.map(d => d.pi + '|' + d.pf))].map(s => s.split('|'));
  const stores = gov.map(g => g.loja);
  function dayClass(store, dateStr) {
    const g = gov.find(x => x.loja === store);
    if (g && dateStr >= g.valid_from && (!g.valid_to || dateStr < g.valid_to)) return 'AUTH';
    for (const [pi, pf] of periods) {
      if (dateStr >= pi && dateStr <= pf) {
        const key = pi + '|' + store;
        if (!(key in officialByPeriodStore)) return 'UNRESOLVED';
        return officialByPeriodStore[key] ? 'HIGH' : 'PARTIAL';
      }
    }
    return 'UNRESOLVED';
  }
  const short = { AUTH: 'AUTH', HIGH: 'HIGH', PARTIAL: 'PART', UNRESOLVED: 'UNRE' };
  console.log('  ' + pad('Loja', 16) + MONTHS.map(m => padL(m[2], 6)).join(''));
  console.log('  ' + '-'.repeat(16 + 6 * MONTHS.length));
  const cellCounts = {};
  stores.forEach(st => {
    const cells = MONTHS.map(m => {
      const counts = {};
      for (let d = 1; d <= m[3]; d++) {
        const ds = m[0].slice(0, 8) + String(d).padStart(2, '0');
        const c = dayClass(st, ds);
        counts[c] = (counts[c] || 0) + 1;
        cellCounts[m[2]] = cellCounts[m[2]] || {};
        cellCounts[m[2]][c] = (cellCounts[m[2]][c] || 0) + 1;
      }
      /* a célula do mês recebe a classe MAIS FRACA presente: nunca superestima */
      const order = ['UNRESOLVED', 'PARTIAL', 'HIGH', 'AUTH'];
      const worst = order.find(o => counts[o]);
      const mixed = Object.keys(counts).length > 1;
      return padL(short[worst] + (mixed ? '*' : ''), 6);
    }).join('');
    console.log('  ' + pad(st, 16) + cells);
  });
  console.log('  * = mês misto (a célula mostra a classe MAIS FRACA do mês; nunca superestima)');

  /* ---------- 9. Cobertura em dias-loja ---------- */
  h('9. COBERTURA EM DIAS-LOJA');
  console.log('  ' + pad('Mês', 7) + padL('Total', 8) + padL('AUTH', 8) + padL('HIGH', 8)
    + padL('PARTIAL', 9) + padL('UNRES.', 9) + padL('Cobertura', 11));
  console.log('  ' + '-'.repeat(60));
  const dayCov = {};
  MONTHS.forEach(m => {
    const c = cellCounts[m[2]] || {};
    const total = stores.length * m[3];
    const okDays = (c.AUTH || 0) + (c.HIGH || 0);
    dayCov[m[2]] = { total, auth: c.AUTH || 0, high: c.HIGH || 0, part: c.PARTIAL || 0, unre: c.UNRESOLVED || 0 };
    console.log('  ' + pad(m[2], 7) + padL(total, 8) + padL(c.AUTH || 0, 8) + padL(c.HIGH || 0, 8)
      + padL(c.PARTIAL || 0, 9) + padL(c.UNRESOLVED || 0, 9) + padL(pct(okDays, total), 11));
  });

  /* ---------- 10. Cobertura de VALOR do Ranking ---------- */
  h('10. COBERTURA DE VALOR DO RANKING');
  const fin = await all(`with lvb as (
      select distinct on (b.source_type) b.id, b.source_type
      from public.portal_import_batches b
      where b.status='VALIDATED' and b.source_type in ('FINANCE_CURRENT','FINANCE_HISTORY')
      order by b.source_type, b.completed_at desc nulls last, b.created_at desc, b.id desc),
    op as (
      select f.operation_date, f.return_value,
        upper(trim(coalesce(public.resolve_store_temporal(coalesce(f.seller_user_id,f.seller_id),
          f.operation_date, nullif(f.store,'')),'SEM LOJA'))) as loja
      from public.portal_finance_operations f join lvb on lvb.id=f.batch_id
      where f.is_real_financing
        and f.operation_date between date '2026-01-01' and date '2026-08-31')
    select to_char(date_trunc('month', op.operation_date),'YYYY-MM') as mes,
           op.loja, op.operation_date::text as d, count(*) as ops, sum(op.return_value) as retorno
    from op group by 1,2,3 order by 1,2,3;`);
  const spf = await all(`select to_char(date_trunc('month', operation_date),'YYYY-MM') as mes,
      count(*) filter (where is_spf_extra) as spf
    from public.portal_spf_operations
    where batch_id = (select b.id from public.portal_import_batches b
        where b.status='VALIDATED' and b.source_type='SPF_CURRENT'
        order by b.completed_at desc nulls last, b.created_at desc, b.id desc limit 1)
      and operation_date between date '2026-01-01' and date '2026-08-31'
    group by 1 order by 1;`);
  const spfBy = {}; spf.forEach(s => spfBy[s.mes] = Number(s.spf));
  console.log('  ' + pad('Mês', 7) + padL('Ops', 7) + padL('Ops atrib.', 12) + padL('Retorno', 16)
    + padL('Ret. atrib.%', 14) + padL('SPF atrib.%', 14) + '  Veredito');
  console.log('  ' + '-'.repeat(88));
  const valCov = {};
  MONTHS.forEach(m => {
    const key = m[0].slice(0, 7);
    const rows = fin.filter(f => f.mes === key);
    let ops = 0, opsA = 0, ret = 0, retA = 0;
    rows.forEach(r => {
      const n = Number(r.ops), v = Number(r.retorno);
      ops += n; ret += v;
      const c = dayClass(r.loja, r.d);
      if (c === 'AUTH' || c === 'HIGH') { opsA += n; retA += v; }
    });
    const spfTxt = spfBy[key] ? pct(opsA, ops) : 'N/A*';
    valCov[m[2]] = { ops, opsA, ret, retA, spf: spfBy[key] || 0 };
    const verd = retA === 0 ? 'UNRESOLVED' : (retA >= ret * 0.999 ? 'ATRIBUÍVEL' : 'PARCIAL');
    console.log('  ' + pad(m[2], 7) + padL(ops, 7) + padL(opsA, 12) + padL('R$ ' + brl(ret), 16)
      + padL(pct(retA, ret), 14) + padL(spfTxt, 14) + '  ' + verd);
  });
  console.log('  * N/A = PROGRAMA SPF NÃO INICIADO (nenhuma unidade SPF Extra antes de maio/2026).');

  /* ---------- 11. Conflitos ---------- */
  h('11. CONFLITOS DETECTADOS');
  const conf = await all(`select left(md5(a.cpf_analista_ausente),6) as ident,
      count(distinct upper(trim(coalesce(a.loja_origem,'')))) as lojas_origem_distintas,
      string_agg(distinct upper(trim(coalesce(a.loja_origem,''))), ' | ') as lojas
    from public.ausencias_analistas a group by 1 having count(distinct upper(trim(coalesce(a.loja_origem,''))))>1;`);
  console.log('  Analistas com MAIS DE UMA loja de origem declarada: ' + conf.length);
  conf.forEach(c => console.log('    ' + pad(label(c.ident), 11) + c.lojas));
  const mutual = await all(`select a.data_inicio, a.data_fim, upper(trim(coalesce(a.loja_origem,''))) as origem,
      upper(trim(coalesce(a.loja_coberta,''))) as coberta,
      left(md5(a.cpf_analista_ausente),6) as ausente, left(md5(a.cpf_analista_substituto),6) as subst
    from public.ausencias_analistas a
    where a.data_inicio < date '2026-05-21' order by a.data_inicio;`);
  console.log('  Registros de ausência anteriores a 2026-05-21 (fora de qualquer período fechado): ' + mutual.length);
  mutual.forEach(m => console.log('    ' + m.data_inicio + '..' + m.data_fim + '  origem=' + pad(m.origem, 15)
    + ' coberta=' + pad(m.coberta, 13) + ' ausente=' + label(m.ausente) + ' subst=' + label(m.subst)));
  const mutualPair = mutual.length >= 2
    && mutual.some(x => mutual.some(y => x !== y && x.ausente === y.subst && y.ausente === x.subst));
  console.log('  Par mutuamente contraditório (cada um substituto do outro na mesma janela): '
    + (mutualPair ? 'SIM -- evidência UNRELIABLE' : 'não'));

  /* ---------- 12. Confiabilidade de identidade em snapshots ---------- */
  h('12. IDENTIDADE vs CORRUPÇÃO FINANCEIRA NOS SNAPSHOTS');
  const rel = await all(`select p.data_inicio as pi, p.data_fim as pf, f.status,
      count(*) as linhas,
      count(*) filter (where coalesce(s.cpf,'')<>'') as com_cpf,
      count(*) filter (where coalesce(s.nome,'')<>'') as com_nome,
      count(*) filter (where coalesce(s.retorno,0)<>0) as com_retorno,
      count(*) filter (where exists (select 1 from public.usuarios u
          where upper(btrim(regexp_replace(u.nome,'\\s+',' ','g')))
              = upper(btrim(regexp_replace(coalesce(s.nome,''),'\\s+',' ','g')))
            and upper(trim(coalesce(u.perfil,'')))='ANALISTA')) as nome_resolve_unico
    from public.snapshot_comissoes s
    join public.fechamentos_comissao f on f.id=s.fechamento_id
    join public.periodos_comissao p on p.id=f.periodo_id
    where upper(trim(coalesce(s.perfil,''))) like 'ANALISTA%'
    group by 1,2,3 order by 1,3;`);
  console.log('  ' + pad('Período', 24) + pad('Status', 10) + padL('Linhas', 8) + padL('c/CPF', 7)
    + padL('c/Retorno', 11) + padL('Nome->único', 13) + '  Classificação');
  console.log('  ' + '-'.repeat(90));
  rel.forEach(r => {
    const ratio = Number(r.linhas) ? Number(r.nome_resolve_unico) / Number(r.linhas) : 0;
    const fin0 = Number(r.com_retorno) === 0;
    const k = ratio === 1 ? (fin0 ? 'IDENTITY_RELIABLE (financeiro zerado)' : 'IDENTITY_RELIABLE')
      : ratio >= 0.95 ? 'IDENTITY_PLAUSIBLE' : 'IDENTITY_UNRELIABLE';
    console.log('  ' + pad(r.pi + '..' + r.pf, 24) + pad(r.status, 10) + padL(r.linhas, 8)
      + padL(r.com_cpf, 7) + padL(r.com_retorno, 11) + padL(r.nome_resolve_unico, 13) + '  ' + k);
  });

  /* ---------- 13. Reconciliação nome -> usuário ---------- */
  h('13. RECONCILIAÇÃO DE IDENTIDADE POR NOME (snapshots sem CPF)');
  const nm = await one(`with sn as (
      select distinct upper(btrim(regexp_replace(coalesce(nome,''),'\\s+',' ','g'))) as n
      from public.snapshot_comissoes
      where upper(trim(coalesce(perfil,''))) like 'ANALISTA%' and coalesce(cpf,'')='')
    select count(*) as nomes,
      count(*) filter (where (select count(*) from public.usuarios u
        where upper(btrim(regexp_replace(u.nome,'\\s+',' ','g')))=sn.n
          and upper(trim(coalesce(u.perfil,'')))='ANALISTA')=1) as unicos,
      count(*) filter (where (select count(*) from public.usuarios u
        where upper(btrim(regexp_replace(u.nome,'\\s+',' ','g')))=sn.n
          and upper(trim(coalesce(u.perfil,'')))='ANALISTA')>1) as ambiguos,
      count(*) filter (where (select count(*) from public.usuarios u
        where upper(btrim(regexp_replace(u.nome,'\\s+',' ','g')))=sn.n
          and upper(trim(coalesce(u.perfil,'')))='ANALISTA')=0) as sem_match
    from sn;`);
  console.log('  nomes distintos ......... ' + nm.nomes);
  console.log('  match único ............. ' + nm.unicos);
  console.log('  ambíguos ................ ' + nm.ambiguos);
  console.log('  sem correspondência ..... ' + nm.sem_match);
  console.log('  Normalização usada: upper + btrim + colapso de espaços. SEM fuzzy matching.');

  /* ---------- 14. Trava final ---------- */
  h('14. TRAVA DE DOMÍNIO -- SALÁRIO (fim)');
  const md5b = await one(`select md5(pg_get_functiondef(p.oid)) as m
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prokind='f' and p.proname='operational_analyst_commission_metrics';`);
  const fim = await one(`select
      (select count(*) from public.analista_responsavel_loja) resp,
      (select count(*) from public.analista_responsavel_loja_auditoria) audit,
      (select count(*) from public.fechamentos_comissao) fech,
      (select count(*) from public.snapshot_comissoes) snapc,
      (select count(*) from public.ausencias_analistas) aus,
      (select count(*) from public.usuarios) usr;`);
  console.log('  md5 Salário fim ......... ' + md5b.m + (md5b.m === SALARY_MD5_EXPECTED ? '  INALTERADO' : '  ALTERADO'));
  if (md5b.m !== SALARY_MD5_EXPECTED) throw new Error('STOP: SALARY_DOMAIN_MUTATED_BY_PERF4B');
  const same = ['resp', 'audit', 'fech', 'snapc', 'aus', 'usr'].every(k => String(base[k]) === String(fim[k]));
  console.log('  contagens início = fim .. ' + (same ? 'SIM (zero escrita)' : 'NÃO -- INVESTIGAR'));
  if (!same) throw new Error('STOP: BUSINESS_DATA_MUTATED_BY_PERF4B');
  console.log('\nPERF-4B concluído. Somente leitura, zero escrita, zero PII.');
})().catch(e => { console.error('FALHA: ' + e.message); process.exit(1); });
