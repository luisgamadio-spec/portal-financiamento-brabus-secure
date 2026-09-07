#!/usr/bin/env node
/*
 * FASE 3.J -- verificação de paridade disco vs. servido para os
 * arquivos compartilhados de que o Coparticipado/Score dependem.
 *
 * Motivação: a Fase 3.I corrigiu assets/js/score-coparticipated-
 * secure-adapter.js, mas o Human continuou vendo o comportamento
 * antigo em localhost:8081 -- não porque o servidor local estivesse
 * servindo um arquivo errado (disco == servido, hash idêntico,
 * confirmado), mas porque o <script src="..."> desse arquivo nunca
 * teve nenhum parâmetro de cache-busting, e o servidor (python -m
 * http.server) não envia Cache-Control/ETag -- só Last-Modified --
 * deixando o navegador livre para servir uma cópia em cache desse
 * ÚNICO sub-recurso mesmo depois de um refresh do HTML principal.
 *
 * Este script NÃO faz parte da suíte automática padrão (depende de um
 * servidor local já em execução) -- rodar manualmente quando
 * localhost:8081 (ou outra porta, via argv[2]) estiver no ar, a
 * partir da raiz do repositório:
 *   node tests/served_asset_cache_check.js [porta]
 *
 * Verifica, para cada arquivo compartilhado crítico:
 *   1) hash do disco == hash servido (detecta document root errado /
 *      arquivo diferente / processo servindo outra árvore);
 *   2) o HTML que referencia o arquivo usa uma URL com querystring de
 *      cache-busting (?v=...) -- para que uma futura correção neste
 *      mesmo arquivo NUNCA mais dependa de o navegador decidir
 *      revalidar um recurso sem Cache-Control explícito.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');

const PORT = process.argv[2] || '8081';
const REPO_ROOT = path.join(__dirname, '..');

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

let passed = 0, failed = 0;
function check(label, cond) {
  if (cond) { passed++; console.log('PASS - ' + label); }
  else { failed++; console.log('FAIL - ' + label); }
}

async function checkDiskServedParity(relPath) {
  const diskBuf = fs.readFileSync(path.join(REPO_ROOT, relPath));
  const diskHash = sha256(diskBuf);
  const url = `http://127.0.0.1:${PORT}/${relPath.replace(/\\/g, '/')}`;
  const resp = await get(url);
  const servedHash = sha256(resp.body);
  check(`${relPath}: HTTP 200`, resp.status === 200);
  check(`${relPath}: disk SHA-256 == served SHA-256 (${diskHash.slice(0, 12)}...)`, diskHash === servedHash);
  return { diskHash, servedHash };
}

function checkCacheBusted(htmlRelPath, scriptBasename) {
  const html = fs.readFileSync(path.join(REPO_ROOT, htmlRelPath), 'utf-8');
  const re = new RegExp(`<script src="[^"]*${scriptBasename}(\\?[^"]*)?"`, 'i');
  const m = html.match(re);
  check(`${htmlRelPath}: referencia ${scriptBasename} com querystring de cache-busting (?v=...)`, !!(m && m[1] && /\?v=/.test(m[1])));
}

async function main() {
  console.log(`Checando servidor local em http://127.0.0.1:${PORT}/ ...`);
  try {
    await get(`http://127.0.0.1:${PORT}/index.html`);
  } catch (e) {
    console.log(`Servidor local não encontrado na porta ${PORT} -- este script requer um servidor rodando (ex.: "python -m http.server ${PORT}" a partir da raiz do repo). Pulando (não é falha de teste, é pré-requisito ausente).`);
    process.exit(0);
  }

  await checkDiskServedParity('assets/js/score-coparticipated-secure-adapter.js');
  checkCacheBusted('modules/coparticipado.html', 'score-coparticipated-secure-adapter.js');
  checkCacheBusted('modules/score.html', 'score-coparticipated-secure-adapter.js');

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}
main().catch(e => { console.error('FATAL:', e); process.exit(1); });
