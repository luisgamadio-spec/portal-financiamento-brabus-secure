#!/usr/bin/env node
/*
 * RH-ANALYST-2 -- Autoridade de responsabilidade oficial do Analista F&I.
 *
 * Duas camadas, mesmo padrão já estabelecido em
 * tests/p2_rh_operational_scope_test.js:
 *
 *  1. STATIC: o texto REAL da migration é lido do disco e inspecionado
 *     contra as proibições/invariantes desta Wave -- identidade por UUID,
 *     intervalo semiaberto, EXCLUDE de sobreposição, fail-closed, gate
 *     MASTER, nenhuma alteração de objeto existente, nenhuma atribuição
 *     de responsável.
 *
 *  2. LIVE (somente-leitura em efeito, 100% dentro de BEGIN...ROLLBACK):
 *     a MESMA migration lida do disco é executada contra o Postgres real
 *     (yacqlelpzchcotgngwbh, guardado explicitamente -- nunca
 *     zhzubcismiwdypavwdxf), com usuários sintéticos, e o comportamento
 *     temporal é provado de verdade: sobreposição rejeitada, handover,
 *     fronteira do mesmo dia, janelas de meio de período, fail-closed,
 *     auditoria e gate de permissão. Tudo é revertido -- nada persiste
 *     (verificado explicitamente ao final).
 *
 * Zero PII. Zero dado de negócio real. Zero escrita persistente.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const PROJECT_REF = 'yacqlelpzchcotgngwbh';
const FORBIDDEN_PROJECT_REF = 'zhzubcismiwdypavwdxf';
const MIGRATION = path.join(
  __dirname, '..', 'supabase', 'migrations',
  '20260909120000_rh_analyst2_analista_responsavel_loja.sql'
);

let passed = 0, failed = 0;
function check(label, cond) {
  if (cond) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}`); }
}

const sql = fs.readFileSync(MIGRATION, 'utf-8');
// Corpo sem os comentários de linha, para as asserções estruturais não
// serem satisfeitas por texto de comentário.
const code = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n');

// ---------------------------------------------------------------
console.log('\n[1] STATIC -- contrato da migration');
// ---------------------------------------------------------------
check('1.1 cria a tabela de responsabilidade', /create table if not exists public\.analista_responsavel_loja\b/i.test(code));
check('1.2 identidade canônica é usuarios.id (uuid + FK)', /analista_usuario_id\s+uuid\s+not null\s+references public\.usuarios\(id\)/i.test(code));
check('1.3 NÃO usa nome/CPF/e-mail como identidade da responsabilidade', !/analista_(nome|cpf|email)\s+text/i.test(code));
check('1.4 intervalo semiaberto: valid_from + valid_to nulável', /valid_from\s+date\s+not null/i.test(code) && /valid_to\s+date\s*,/i.test(code));
check('1.5 check de intervalo válido', /valid_to is null or valid_to > valid_from/i.test(code));
check('1.6 INVARIANTE: EXCLUDE de sobreposição por loja', /exclude using gist\s*\(\s*loja_normalizada with =\s*,\s*daterange\(valid_from, valid_to, '\[\)'\) with &&\s*\)/i.test(code));
check('1.7 invariante só vale para vigências ACTIVE', /where \(status = 'ACTIVE'\)/i.test(code));
check('1.8 btree_gist habilitado (requisito do EXCLUDE)', /create extension if not exists btree_gist/i.test(code));
check('1.9 loja normalizada por coluna gerada', /loja_normalizada text generated always as \(upper\(btrim\(loja\)\)\) stored/i.test(code));
check('1.10 resolver por data existe', /create or replace function public\.resolve_analista_responsavel\(/i.test(code));
check('1.11 resolver de JANELAS existe (meio de período)', /create or replace function public\.analista_responsabilidade_janelas\(/i.test(code));
check('1.12 janelas convertem fim exclusivo -> inclusivo', /least\(coalesce\(r\.valid_to - 1, p_end\), p_end\)/i.test(code));
check('1.13 diagnóstico de cobertura existe (Fase 3)', /create or replace function public\.analista_responsabilidade_cobertura\(/i.test(code));
check('1.14 escrita é MASTER-only', /upper\(trim\(coalesce\(u\.perfil, ''\)\)\) = 'MASTER'/i.test(code) && /Acesso exclusivo do perfil Master/i.test(code));
check('1.15 auditoria append-only existe', /create table if not exists public\.analista_responsavel_loja_auditoria/i.test(code));
check('1.16 handover fecha a vigência anterior, não a apaga', /update public\.analista_responsavel_loja\s+set valid_to = p_valid_from/i.test(code) && !/delete from public\.analista_responsavel_loja/i.test(code));
check('1.17 RLS habilitada sem policies', /alter table public\.analista_responsavel_loja enable row level security/i.test(code) && !/create policy/i.test(code));
check('1.18 grants revogados de anon', /revoke all on public\.analista_responsavel_loja from public, anon, authenticated/i.test(code));

// Proibições absolutas desta Wave.
check('1.19 NÃO altera operational_analyst_commission_metrics', !/operational_analyst_commission_metrics/i.test(code));
check('1.20 NÃO atribui responsável a ninguém (nenhum INSERT de dados)', !/insert into public\.analista_responsavel_loja\s*\(\s*loja[\s\S]{0,200}values\s*\(\s*'/i.test(code));
check('1.21 NÃO desativa nem altera usuários', !/update public\.usuarios/i.test(code));
check('1.22 NÃO toca snapshot/fechamento/comissão', !/snapshot_comissoes|fechamentos_comissao|master_close_commission_period/i.test(code));
check('1.23 NÃO toca ausencias_analistas', !/alter table public\.ausencias_analistas|drop .*ausencias_analistas/i.test(code));
// A frase "order by u.nome limit 1" APARECE no comment on table, como
// documentação da regra que esta autoridade vai substituir na Fase 4 --
// por isso a asserção é sobre DROP/redefinição real, não sobre o texto.
check('1.24 NÃO faz DROP de nenhuma função/objeto existente', !/drop function|drop table|drop index/i.test(code));
check('1.25 marcada como NÃO APLICADA', /NOT APPLIED/i.test(sql));

// ---------------------------------------------------------------
// LIVE -- tudo dentro de BEGIN ... ROLLBACK
// ---------------------------------------------------------------
function readToken() {
  const p = path.join('C:', 'Projetos', 'portal-financiamento-brabus-secure', 'supabase', '.env.local');
  if (!fs.existsSync(p)) return null;
  const m = fs.readFileSync(p, 'utf-8').match(/SUPABASE_ACCESS_TOKEN=(.*)/);
  return m ? m[1].trim() : null;
}

function runSql(token, query) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query });
    const req = https.request({
      hostname: 'api.supabase.com',
      path: `/v1/projects/${PROJECT_REF}/database/query`,
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch (e) { resolve({ status: res.statusCode, body: d }); } });
    });
    req.on('error', reject);
    req.write(body); req.end();
  });
}

const LOJA = 'RH_A2_LOJA_SINTETICA';

function liveScript(migrationSql) {
  return `BEGIN;

${migrationSql}

-- Fixtures sintéticos: 1 MASTER + 2 ANALISTA na MESMA loja sintética.
-- Provam de saída que dois ANALISTA ativos na mesma loja continuam
-- permitidos -- o que muda é quem é o RESPONSÁVEL pela comissão.
INSERT INTO public.usuarios (id, auth_user_id, nome, perfil, ativo, cpf, loja, status) VALUES
  ('11111111-1111-4111-8111-111111111111','a1111111-1111-4111-8111-111111111111','RH_A2_MASTER','MASTER',true,'99900000001','${LOJA}','MASTER'),
  ('22222222-2222-4222-8222-222222222222','a2222222-2222-4222-8222-222222222222','RH_A2_ANALISTA_ALFA','ANALISTA',true,'99900000002','${LOJA}','NOVOS/SEMINOVOS'),
  ('33333333-3333-4333-8333-333333333333','a3333333-3333-4333-8333-333333333333','RH_A2_ANALISTA_BETA','ANALISTA',true,'99900000003','${LOJA}','NOVOS/SEMINOVOS');

CREATE TEMP TABLE _res(k text primary key, ok boolean) ON COMMIT DROP;

DO $t$
DECLARE
  v_a uuid := '22222222-2222-4222-8222-222222222222';
  v_b uuid := '33333333-3333-4333-8333-333333333333';
  v_master uuid := 'a1111111-1111-4111-8111-111111111111';
  v_analista_auth uuid := 'a2222222-2222-4222-8222-222222222222';
  v_ok boolean;
  v_n int;
  v_uuid uuid;
  r record;
BEGIN
  -- (2.1) dois ANALISTA ativos na mesma loja continuam existindo
  SELECT count(*)=2 INTO v_ok FROM public.usuarios
   WHERE ativo AND upper(perfil)='ANALISTA' AND loja='${LOJA}';
  INSERT INTO _res VALUES ('2.1 dois ANALISTA ativos na mesma loja permanecem permitidos', v_ok);

  -- (2.2) sem configuração, resolver devolve NULL (fail-closed na origem)
  SELECT public.resolve_analista_responsavel('${LOJA}', DATE '2026-09-05') IS NULL INTO v_ok;
  INSERT INTO _res VALUES ('2.2 sem responsavel configurado o resolver devolve NULL', v_ok);

  -- (2.3) primeira vigência, aberta
  INSERT INTO public.analista_responsavel_loja (loja, analista_usuario_id, valid_from)
  VALUES ('${LOJA}', v_a, DATE '2026-09-01');
  SELECT public.resolve_analista_responsavel('${LOJA}', DATE '2026-09-05') = v_a INTO v_ok;
  INSERT INTO _res VALUES ('2.3 vigencia aberta resolve o responsavel', v_ok);

  -- (2.4) INVARIANTE: segunda vigência sobreposta é rejeitada pelo banco
  v_ok := false;
  BEGIN
    INSERT INTO public.analista_responsavel_loja (loja, analista_usuario_id, valid_from)
    VALUES ('${LOJA}', v_b, DATE '2026-09-05');
  EXCEPTION WHEN exclusion_violation THEN v_ok := true;
  END;
  INSERT INTO _res VALUES ('2.4 sobreposicao de responsabilidade REJEITADA pelo banco', v_ok);

  -- (2.5) mesma rejeição para grafia diferente da loja (normalização)
  v_ok := false;
  BEGIN
    INSERT INTO public.analista_responsavel_loja (loja, analista_usuario_id, valid_from)
    VALUES (lower('${LOJA}') || '  ', v_b, DATE '2026-09-07');
  EXCEPTION WHEN exclusion_violation THEN v_ok := true;
  END;
  INSERT INTO _res VALUES ('2.5 normalizacao impede burlar a invariante por grafia', v_ok);

  -- (2.6) escrita por nao-MASTER e negada
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_analista_auth)::text, true);
  v_ok := false;
  BEGIN
    PERFORM public.master_definir_analista_responsavel('${LOJA}', v_b, DATE '2026-09-10', 'tentativa');
  EXCEPTION WHEN insufficient_privilege THEN v_ok := true;
  END;
  INSERT INTO _res VALUES ('2.7 ANALISTA nao pode definir responsavel (42501)', v_ok);

  -- (2.7) handover governado por MASTER
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_master)::text, true);
  PERFORM public.master_definir_analista_responsavel('${LOJA}', v_b, DATE '2026-09-10', 'handover de teste');

  SELECT count(*)=2 INTO v_ok FROM public.analista_responsavel_loja
   WHERE loja_normalizada = upper('${LOJA}') AND status='ACTIVE';
  INSERT INTO _res VALUES ('2.8 handover cria a segunda vigencia sem apagar a primeira', v_ok);

  -- (2.8) fronteira do mesmo dia: 09 e do A, 10 e do B
  SELECT public.resolve_analista_responsavel('${LOJA}', DATE '2026-09-09') = v_a INTO v_ok;
  INSERT INTO _res VALUES ('2.9 vespera do handover pertence ao responsavel anterior', v_ok);
  SELECT public.resolve_analista_responsavel('${LOJA}', DATE '2026-09-10') = v_b INTO v_ok;
  INSERT INTO _res VALUES ('2.10 dia do handover pertence SOMENTE ao novo responsavel', v_ok);

  -- (2.9) vigencia anterior fechada em 10 (exclusivo) e nova aberta
  SELECT count(*)=1 INTO v_ok FROM public.analista_responsavel_loja
   WHERE analista_usuario_id=v_a AND valid_to = DATE '2026-09-10';
  INSERT INTO _res VALUES ('2.11 vigencia anterior fechada com fim EXCLUSIVO no dia do handover', v_ok);
  SELECT count(*)=1 INTO v_ok FROM public.analista_responsavel_loja
   WHERE analista_usuario_id=v_b AND valid_to IS NULL;
  INSERT INTO _res VALUES ('2.12 nova vigencia fica aberta (valid_to NULL)', v_ok);

  -- (2.10) JANELAS de meio de periodo: 01..20 deve virar A 01..09 e B 10..20
  SELECT count(*)=2 INTO v_ok
    FROM public.analista_responsabilidade_janelas('${LOJA}', DATE '2026-09-01', DATE '2026-09-20');
  INSERT INTO _res VALUES ('2.13 periodo com handover produz exatamente 2 janelas', v_ok);

  SELECT (janela_inicio = DATE '2026-09-01' AND janela_fim = DATE '2026-09-09') INTO v_ok
    FROM public.analista_responsabilidade_janelas('${LOJA}', DATE '2026-09-01', DATE '2026-09-20')
   WHERE analista_usuario_id = v_a;
  INSERT INTO _res VALUES ('2.14 janela do analista anterior e 01..09 (sem invadir o dia 10)', v_ok);

  SELECT (janela_inicio = DATE '2026-09-10' AND janela_fim = DATE '2026-09-20') INTO v_ok
    FROM public.analista_responsabilidade_janelas('${LOJA}', DATE '2026-09-01', DATE '2026-09-20')
   WHERE analista_usuario_id = v_b;
  INSERT INTO _res VALUES ('2.15 janela do novo responsavel e 10..20', v_ok);

  -- (2.11) as janelas ladrilham o periodo: sem buraco e sem sobreposicao
  SELECT bool_and(gap = 1) INTO v_ok FROM (
    SELECT janela_inicio - lag(janela_fim) OVER (ORDER BY janela_inicio) AS gap
    FROM public.analista_responsabilidade_janelas('${LOJA}', DATE '2026-09-01', DATE '2026-09-20')
  ) z WHERE gap IS NOT NULL;
  INSERT INTO _res VALUES ('2.16 janelas contiguas: sem buraco e sem sobreposicao de dia', v_ok);

  SELECT sum(janela_fim - janela_inicio + 1) = 20 INTO v_ok
    FROM public.analista_responsabilidade_janelas('${LOJA}', DATE '2026-09-01', DATE '2026-09-20');
  INSERT INTO _res VALUES ('2.17 janelas cobrem exatamente os 20 dias do periodo', v_ok);

  -- (2.12) periodo anterior a qualquer vigencia nao produz janela
  SELECT count(*)=0 INTO v_ok
    FROM public.analista_responsabilidade_janelas('${LOJA}', DATE '2026-08-01', DATE '2026-08-20');
  INSERT INTO _res VALUES ('2.18 periodo sem responsabilidade configurada nao produz janela', v_ok);

  -- (2.13) loja desconhecida nunca resolve
  SELECT public.resolve_analista_responsavel('LOJA_QUE_NAO_EXISTE', DATE '2026-09-15') IS NULL INTO v_ok;
  INSERT INTO _res VALUES ('2.19 loja sem autoridade configurada devolve NULL (fail-closed)', v_ok);

  -- (2.14) auditoria append-only registrou handover + criacao
  SELECT count(*) INTO v_n FROM public.analista_responsavel_loja_auditoria
   WHERE loja = upper('${LOJA}');
  INSERT INTO _res VALUES ('2.20 auditoria registrou o handover (>=2 eventos)', v_n >= 2);
  SELECT count(*)=1 INTO v_ok FROM public.analista_responsavel_loja_auditoria
   WHERE acao='HANDOVER_CLOSED' AND analista_anterior=v_a AND analista_novo=v_b;
  INSERT INTO _res VALUES ('2.21 auditoria preserva analista anterior E novo', v_ok);

  -- (2.15) usuarios nao foram alterados por nada disto
  SELECT count(*)=2 INTO v_ok FROM public.usuarios
   WHERE ativo AND upper(perfil)='ANALISTA' AND loja='${LOJA}';
  INSERT INTO _res VALUES ('2.22 nenhum usuario foi desativado ou movido', v_ok);

  -- (2.16) cobertura: MASTER enxerga o diagnostico; ANALISTA nao
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_master)::text, true);
  SELECT (public.analista_responsabilidade_cobertura(DATE '2026-09-01', DATE '2026-09-20') ? 'rows') INTO v_ok;
  INSERT INTO _res VALUES ('2.23 MASTER consegue ler o diagnostico de cobertura', v_ok);

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_analista_auth)::text, true);
  v_ok := false;
  BEGIN
    PERFORM public.analista_responsabilidade_cobertura(DATE '2026-09-01', DATE '2026-09-20');
  EXCEPTION WHEN insufficient_privilege THEN v_ok := true;
  END;
  INSERT INTO _res VALUES ('2.24 ANALISTA nao le o diagnostico de cobertura', v_ok);
END
$t$;

SELECT k, ok FROM _res ORDER BY k;

ROLLBACK;`;
}

async function runLive() {
  const token = readToken();
  if (!token) {
    console.log('\n[2] LIVE -- [SKIP] sem SUPABASE_ACCESS_TOKEN local; a camada STATIC acima é autoritativa neste ambiente.');
    return;
  }
  if (token.includes(FORBIDDEN_PROJECT_REF)) {
    throw new Error('token referencia o projeto dormente proibido');
  }

  console.log('\n[2] LIVE -- migration real executada dentro de BEGIN...ROLLBACK');
  const r = await runSql(token, liveScript(sql));
  if (r.status !== 201) {
    console.log('  FAIL  camada LIVE não executou:', JSON.stringify(r.body).slice(0, 500));
    failed++;
    return;
  }
  const rows = Array.isArray(r.body) ? r.body : [];
  if (!rows.length) {
    console.log('  FAIL  camada LIVE não retornou asserções');
    failed++;
    return;
  }
  rows.forEach(row => check(row.k, row.ok === true));

  // Prova de que NADA persistiu.
  const after = await runSql(token, `select
      (select count(*) from pg_class where relname='analista_responsavel_loja') as tabela,
      (select count(*) from public.usuarios where loja='${LOJA}') as usuarios_sinteticos;`);
  const a = Array.isArray(after.body) ? after.body[0] : {};
  check('3.1 ROLLBACK: a tabela NÃO foi criada em produção', Number(a.tabela) === 0);
  check('3.2 ROLLBACK: nenhum usuário sintético persistiu', Number(a.usuarios_sinteticos) === 0);
}

(async () => {
  try { await runLive(); }
  catch (e) { console.log('  FAIL  erro na camada LIVE:', e.message); failed++; }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
