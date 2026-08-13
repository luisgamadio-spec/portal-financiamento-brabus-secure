(function(){
'use strict';
// Gestão das Bases dos Simuladores (ZeroKM/Seminovos) — Painel Master.
// Cada planilha tem parser + validação semântica PRÓPRIA (Fase 2, regra
// explícita: nada de parser genérico). Infra compartilhada abaixo é só
// leitura de XLSX/normalização/SHA-256 — nunca decide semântica de base.

// ---------------- utilidades compartilhadas ----------------
async function gsLerWorkbook(file){
  const buf = await file.arrayBuffer();
  return { wb: XLSX.read(buf, { type:'array', cellDates:true }), buf };
}
function gsSheetMatrix(wb, sheetName){
  const ws = wb.Sheets[sheetName || wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header:1, defval:null, raw:true });
}
async function gsSha256Hex(buf){
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest)).map(b=>b.toString(16).padStart(2,'0')).join('');
}
function gsNum(v){
  if(v===null||v===undefined||v==='') return null;
  if(typeof v==='number') return v;
  const s=String(v).trim().replace('%','').replace(',','.');
  const n=Number(s);
  return Number.isFinite(n) ? n : null;
}
function gsPrazoDeTexto(v){
  // aceita 12 / "12x" / "12" -> 12
  if(v===null||v===undefined) return null;
  if(typeof v==='number') return Math.round(v);
  const m=String(v).trim().match(/^(\d+)\s*x?/i);
  return m ? Number(m[1]) : null;
}
function gsAcharLinhaHeader(matrix, colunasEsperadas){
  // procura a primeira linha cujas células (normalizadas, minúsculas, sem
  // acento) contenham TODAS as colunas esperadas, na ordem que aparecerem
  // (não exige posição fixa) — evita presumir "linha 1" ou "linha 4".
  const norm = s => String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').trim().toLowerCase();
  const esperadasNorm = colunasEsperadas.map(norm);
  for(let i=0;i<matrix.length;i++){
    const linha = (matrix[i]||[]).map(norm);
    const todasPresentes = esperadasNorm.every(e => linha.some(c => c && c.includes(e)));
    if(todasPresentes) return i;
  }
  return -1;
}
function gsErroEstrutura(nomeBase){
  const e = new Error(`O arquivo selecionado não corresponde à estrutura esperada para ${nomeBase}.`);
  e.gsEstrutura = true;
  return e;
}

// ---------------- 1. Financiamento Linear (ZeroKM) ----------------
function parseLinearCoef(matrix){
  const h = gsAcharLinhaHeader(matrix, ['Prazo','Entrada','Taxa']);
  if(h<0) throw gsErroEstrutura('Financiamento Linear');
  const rows=[];
  for(let i=h+1;i<matrix.length;i++){
    const r=matrix[i]; if(!r||r.every(c=>c===null)) continue;
    const prazo=gsPrazoDeTexto(r[0]), entrada=gsNum(r[1]), taxa=gsNum(r[2]);
    if(prazo===null||entrada===null||taxa===null) continue;
    rows.push({prazo, entrada_pct:entrada, taxa});
  }
  if(!rows.length) throw gsErroEstrutura('Financiamento Linear');
  return { rows, avisos:[] };
}

// ---------------- 2. Taxas Subsidiadas (rebates.xlsx) ----------------
function parseTaxasSubsidiadas(matrix){
  const h = gsAcharLinhaHeader(matrix, ['Prazo','Taxa','Coeficiente','Rebate']);
  if(h<0) throw gsErroEstrutura('Taxas Subsidiadas');
  const rows=[];
  for(let i=h+1;i<matrix.length;i++){
    const r=matrix[i]; if(!r||r.every(c=>c===null)) continue;
    const prazo=gsPrazoDeTexto(r[0]);
    // trata texto tipo "0,00% (ZERO)" como taxa zero
    let taxaRaw=r[1];
    const taxa = (typeof taxaRaw==='string' && /zero/i.test(taxaRaw)) ? 0 : gsNum(taxaRaw);
    const coeficiente=gsNum(r[2]), rebate=gsNum(r[3]);
    if(prazo===null||taxa===null||coeficiente===null||rebate===null) continue;
    rows.push({prazo, taxa, coeficiente, rebate});
  }
  if(!rows.length) throw gsErroEstrutura('Taxas Subsidiadas');
  return { rows, avisos:[] };
}

// ---------------- 3. Taxa Botão (Copiar Taxa Banco) ----------------
function parseTaxaBotao(matrix){
  const h = gsAcharLinhaHeader(matrix, ['Prazo','Taxa']);
  if(h<0) throw gsErroEstrutura('Taxa Botão (Copiar Taxa Banco)');
  const rows=[];
  for(let i=h+1;i<matrix.length;i++){
    const r=matrix[i]; if(!r||r.every(c=>c===null)) continue;
    const prazo=gsPrazoDeTexto(r[0]), taxa=gsNum(r[1]);
    if(prazo===null||taxa===null) continue;
    rows.push({prazo, taxa_copiar:taxa});
  }
  if(!rows.length) throw gsErroEstrutura('Taxa Botão (Copiar Taxa Banco)');
  return { rows, avisos:[] };
}

// ---------------- 4. Simulador Balão ZeroKM (3 blocos empilhados) ----------------
function parseCoefBalaoZeroKm(matrix){
  const cols = ['Entrada mínima','Prazo','Máximo de Balão','Taxa de Juros'];
  const norm = s => String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').trim().toLowerCase();
  const colsNorm = cols.map(norm);
  const headers=[];
  for(let i=0;i<matrix.length;i++){
    const linha=(matrix[i]||[]).map(norm);
    if(colsNorm.every(e=>linha.some(c=>c&&c.includes(e)))) headers.push(i);
  }
  if(!headers.length) throw gsErroEstrutura('Simulador Balão ZeroKM');
  const rows=[];
  const mapaRotulo = { 'tradicional':'TRADICIONAL', 'semestral':'SEMESTRAL_ANUAL', 'anual':'SEMESTRAL_ANUAL', 'parcela unica':'PARCELA_UNICA', 'parcela única':'PARCELA_UNICA' };
  headers.forEach((h,idx)=>{
    // rótulo do bloco: procura texto reconhecido em até 3 linhas acima do header
    let bloco=null;
    for(let k=Math.max(0,h-3);k<h;k++){
      const txt=norm((matrix[k]||[]).find(c=>c!==null&&c!==undefined)||'');
      for(const chave in mapaRotulo){ if(txt.includes(chave)){ bloco=mapaRotulo[chave]; break; } }
      if(bloco) break;
    }
    if(!bloco) bloco = ['TRADICIONAL','SEMESTRAL_ANUAL','PARCELA_UNICA'][idx] || `BLOCO_${idx+1}`;
    const fim = headers[idx+1] ? headers[idx+1]-3 : matrix.length; // recua para não pegar rótulo do próximo bloco
    for(let i=h+1;i<Math.min(fim,matrix.length);i++){
      const r=matrix[i]; if(!r||r.every(c=>c===null)) continue;
      const entrada=gsNum(r[0]), prazo=gsPrazoDeTexto(r[1]), max=gsNum(r[2]), taxa=gsNum(r[3]);
      if(entrada===null||prazo===null||max===null||taxa===null) continue;
      const row={bloco, entrada_minima:entrada, prazo, max_balao:max, taxa};
      if(r[4]!==undefined && gsNum(r[4])!==null) row.coeficiente=gsNum(r[4]);
      rows.push(row);
    }
  });
  if(!rows.length) throw gsErroEstrutura('Simulador Balão ZeroKM');
  return { rows, avisos:[] };
}

// ---------------- 5. Simulador Balão Seminovos (2 blocos lado a lado) ----------------
function parseCoefBalaoSeminovos(matrix){
  const cols=['Entrada mínima','Prazo','Máximo de Balão','Taxa de Juros'];
  const norm = s => String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').trim().toLowerCase();
  const colsNorm=cols.map(norm);
  let headerRow=-1;
  const starts=[];
  for(let i=0;i<matrix.length && headerRow<0;i++){
    const linha=matrix[i]||[];
    for(let c=0;c<linha.length;c++){
      if(colsNorm[0] && norm(linha[c]).includes(colsNorm[0])){
        // confirma que as 4 colunas aparecem a partir daqui
        const janela = linha.slice(c,c+4).map(norm);
        if(colsNorm.every((e,idx)=> (janela[idx]||'').includes(e))){ starts.push(c); }
      }
    }
    if(starts.length){ headerRow=i; }
  }
  if(headerRow<0 || !starts.length) throw gsErroEstrutura('Simulador Balão Seminovos');
  const rows=[];
  starts.forEach(startCol=>{
    // faixa de ano: procura texto "AAAA...AAAA" na mesma coluna, 1-2 linhas acima
    let faixa=null;
    for(let k=Math.max(0,headerRow-2);k<headerRow;k++){
      const txt=String((matrix[k]||[])[startCol]||'').trim();
      const m=txt.match(/(\d{4}).*?(\d{4})/);
      if(m){ faixa=`${m[1]}_${m[2]}`; break; }
    }
    if(!faixa) faixa='FAIXA_DESCONHECIDA';
    for(let i=headerRow+1;i<matrix.length;i++){
      const r=matrix[i]||[];
      const entrada=gsNum(r[startCol]), prazo=gsPrazoDeTexto(r[startCol+1]), max=gsNum(r[startCol+2]), taxa=gsNum(r[startCol+3]);
      if(entrada===null||prazo===null||max===null||taxa===null) continue;
      rows.push({bloco:faixa, entrada_minima:entrada, prazo, max_balao:max, taxa});
    }
  });
  if(!rows.length) throw gsErroEstrutura('Simulador Balão Seminovos');
  return { rows, avisos:[] };
}

// ---------------- 6. Antecipação (compartilhada) ----------------
function parseAntecipacao(matrix){
  const h = gsAcharLinhaHeader(matrix, ['Parcela','Desconto']);
  if(h<0) throw gsErroEstrutura('Antecipação');
  const rows=[];
  for(let i=h+1;i<matrix.length;i++){
    const r=matrix[i]; if(!r||r.every(c=>c===null)) continue;
    const meses=gsPrazoDeTexto(r[0]), desconto=gsNum(r[1]);
    if(meses===null||desconto===null) continue;
    rows.push({meses_antecipacao:meses, desconto});
  }
  if(!rows.length) throw gsErroEstrutura('Antecipação');
  return { rows, avisos:[] };
}

// ---------------- 7. Financiamento Seminovos (coef seminovo.xlsx) ----------------
function parseCoefSeminovo(matrix){
  const norm = s => String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').trim().toLowerCase();
  const avisos=[];
  // localizar "Valor de Venda" para IGNORAR (é exemplo, não parâmetro)
  for(const r of matrix){ if(r && r.some(c=>norm(c).includes('valor de venda'))){ avisos.push('Linha "Valor de Venda" ignorada — é apenas exemplo usado para exibir a parcela calculada, não é parâmetro de negócio.'); break; } }
  // localizar linha de faixas de ano (contém padrão AAAA...AAAA em várias colunas)
  let faixaRow=-1, entradaRow=-1;
  for(let i=0;i<matrix.length;i++){
    const linha=matrix[i]||[];
    const qtdFaixas = linha.filter(c=>/\d{4}.*\d{4}/.test(String(c||''))).length;
    if(qtdFaixas>=2){ faixaRow=i; entradaRow=i+1; break; }
  }
  if(faixaRow<0) throw gsErroEstrutura('Financiamento Seminovos');
  const linhaFaixa=matrix[faixaRow]||[], linhaEntrada=matrix[entradaRow]||[];
  // mapeia cada coluna que tem uma faixa/entrada válida
  const colunas=[]; // {col, faixa, entrada}
  let faixaAtual=null;
  for(let c=0;c<Math.max(linhaFaixa.length, linhaEntrada.length);c++){
    const txtFaixa=String(linhaFaixa[c]||'').trim();
    const m=txtFaixa.match(/(\d{4}).*?(\d{4})/);
    if(m) faixaAtual=`${m[1]}-${m[2]}`;
    const txtEntrada=String(linhaEntrada[c]||'').trim();
    const me=txtEntrada.match(/(\d+)\s*%/);
    if(me && faixaAtual) colunas.push({col:c, faixa:faixaAtual, entrada_pct:Number(me[1])/100});
  }
  if(!colunas.length) throw gsErroEstrutura('Financiamento Seminovos');
  // a partir da linha seguinte, pares: "Prazo/ Parcela" (col rotulo, col+1 valor=texto, IGNORAR) / "Taxa de Juros" (valor real)
  const rows=[];
  for(let i=entradaRow+1;i<matrix.length-1;i++){
    const rotulo1=norm((matrix[i]||[])[0]);
    if(!rotulo1.includes('prazo')) continue;
    const rotulo2=norm((matrix[i+1]||[])[0]);
    if(!rotulo2.includes('taxa')) continue;
    const linhaTaxa=matrix[i+1]||[];
    colunas.forEach(({col,faixa,entrada_pct})=>{
      // a coluna de VALOR fica logo após a coluna de rótulo do bloco
      const prazoTxt=String((matrix[i]||[])[col+1]||'');
      const mprazo=prazoTxt.match(/^(\d+)\s*x/i);
      const prazo = mprazo ? Number(mprazo[1]) : null;
      const taxa=gsNum(linhaTaxa[col+1]);
      if(prazo===null||taxa===null) return;
      rows.push({faixa_ano:faixa, entrada_pct, prazo, taxa});
    });
  }
  if(!rows.length) throw gsErroEstrutura('Financiamento Seminovos');
  return { rows, avisos };
}

// ---------------- 8/9. Coparticipado (taxa coparticipado.xlsx / coparticipado semestral.xlsx) ----------------
function parseTabelaCoparticipadoGenerico(matrix, nomeBase){
  const norm = s => String(s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').trim().toLowerCase();
  const avisos=[];

  // 1) tabela geral: Prazo/Taxa/Rebate/Tx Sist/Entrada Mínima/Coef
  const hGeral = gsAcharLinhaHeader(matrix, ['Prazo','Taxa','Rebate','Entrada']);
  const geral=[];
  if(hGeral>=0){
    for(let i=hGeral+1;i<matrix.length;i++){
      const r=matrix[i]; if(!r||r.every(c=>c===null)) break; // tabela geral é contígua, para no primeiro vazio
      const prazo=gsPrazoDeTexto(r[0]);
      const taxaRaw=r[1];
      const taxa=(typeof taxaRaw==='string'&&/zero/i.test(taxaRaw))?0:gsNum(taxaRaw);
      const rebate=gsNum(r[2]), txSist=gsNum(r[3]), entradaMin=gsNum(r[4]), coef=gsNum(r[5]);
      if(prazo===null||taxa===null) continue;
      geral.push({prazo, taxa, rebate: rebate===null?0:rebate, tx_sist:txSist, entrada_minima:entradaMin, coeficiente:coef});
    }
  }

  // 2) matriz por modelo: Modelo do Carro / Entrada Mínima / Rebate TOTAL / Rebate Parte HPE / Rebate Parte Brabus / <prazos>x
  const hModelo = gsAcharLinhaHeader(matrix, ['Modelo','Entrada','Rebate']);
  if(hModelo<0) throw gsErroEstrutura(nomeBase);
  const headerModelo = matrix[hModelo]||[];
  // a coluna "Modelo do Carro" NÃO tem posição fixa — no arquivo real ela vem
  // depois das 6 colunas da tabela geral (mesma linha de cabeçalho). Localizar
  // pelo texto, como as demais colunas, em vez de presumir a coluna 0.
  let colModelo=-1, colEntrada=-1, colRebateTotal=-1, colHpe=-1, colBrabus=-1;
  const prazoCols=[]; // {col, prazo}
  headerModelo.forEach((c,idx)=>{
    const t=norm(c);
    if(t.includes('modelo')) colModelo=idx;
    else if(t.includes('entrada')) colEntrada=idx;
    else if(t.includes('rebate') && t.includes('total')) colRebateTotal=idx;
    else if(t.includes('hpe')) colHpe=idx;
    else if(t.includes('brabus')) colBrabus=idx;
    else { const m=String(c||'').match(/^(\d+)\s*x/i); if(m) prazoCols.push({col:idx, prazo:Number(m[1])}); }
  });
  if(colModelo<0||colEntrada<0||colRebateTotal<0||colHpe<0||colBrabus<0||!prazoCols.length) throw gsErroEstrutura(nomeBase);

  const rows=[];
  for(let i=hModelo+1;i<matrix.length;i++){
    const r=matrix[i]; if(!r||r.every(c=>c===null)) continue;
    const modelo=String(r[colModelo]||'').trim();
    if(!modelo) continue;
    const entradaMin=gsNum(r[colEntrada]), rebateTotal=gsNum(r[colRebateTotal]), hpe=gsNum(r[colHpe]), brabus=gsNum(r[colBrabus]);
    if(entradaMin===null||rebateTotal===null||hpe===null||brabus===null) continue;
    prazoCols.forEach(({col,prazo})=>{
      const taxa=gsNum(r[col]);
      if(taxa===null) return;
      rows.push({modelo, entrada_minima:entradaMin, rebate_total:rebateTotal, rebate_hpe:hpe, rebate_brabus:brabus, prazo, taxa});
    });
  }
  if(!rows.length) throw gsErroEstrutura(nomeBase);

  if(geral.length) avisos.push('Tabela geral (Prazo/Taxa/Rebate/Tx Sist/Entrada Mínima/Coef) encontrada — DADOS AUXILIARES / NÃO CONSUMIDOS pelo simulador atual. Preservada só para auditoria.');

  // resíduos: valores fora das duas áreas reconhecidas (heurística simples:
  // células numéricas soltas entre o fim da tabela geral e o início da
  // matriz de modelo, fora das colunas já mapeadas)
  let residuo=false;
  if(hGeral>=0){
    for(let i=hGeral+1;i<hModelo;i++){
      const r=matrix[i]||[];
      for(let c=6;c<r.length;c++){ // colunas depois da tabela geral (que tem 6 colunas)
        if(gsNum(r[c])!==null && c!==colModelo){ residuo=true; }
      }
    }
  }
  if(residuo) avisos.push('Valores fora das áreas de tabela reconhecidas foram ignorados.');

  return { rows, geral, avisos };
}
function parseTaxaCoparticipado(matrix){ return parseTabelaCoparticipadoGenerico(matrix, 'Plano Coparticipado'); }
function parseCoparticipadoSemestral(matrix){ return parseTabelaCoparticipadoGenerico(matrix, 'Semestral Triton/Outlander'); }

// ---------------- 10. Matriz de Coeficientes — Coparticipado (Coef Coparticipado.xlsx) ----------------
// Estrutura própria: Prazo/Taxa/Coeficiente/Status. A coluna Status é
// somente informativa (nunca usada como critério de validade — mesmo uma
// linha "PENDENTE — PREENCHER" é válida se Coeficiente já estiver
// preenchido; o parser não depende dessa coluna e continuaria funcionando
// se ela for removida da planilha no futuro).
function parseCoefCoparticipado(matrix){
  const h = gsAcharLinhaHeader(matrix, ['Prazo','Taxa','Coeficiente']);
  if(h<0) throw gsErroEstrutura('Matriz de Coeficientes — Coparticipado');
  const rows=[];
  const chaves=new Set();
  for(let i=h+1;i<matrix.length;i++){
    const r=matrix[i]; if(!r||r.every(c=>c===null)) continue;
    const prazo=gsPrazoDeTexto(r[0]);
    const taxaRaw=r[1];
    const taxa=(typeof taxaRaw==='string'&&/zero/i.test(taxaRaw))?0:gsNum(taxaRaw);
    const coeficiente=gsNum(r[2]);
    // Prazo inteiro>0, taxa numérica válida (0 é válido), coeficiente numérico finito>0.
    if(prazo===null||prazo<=0||taxa===null||coeficiente===null||coeficiente<=0) continue;
    const chave=`${prazo}|${taxa}`;
    if(chaves.has(chave)) throw new Error(`Duplicidade de chave lógica (prazo+taxa) encontrada: ${prazo}x / ${taxa}`);
    chaves.add(chave);
    rows.push({prazo, taxa, coeficiente});
  }
  if(!rows.length) throw gsErroEstrutura('Matriz de Coeficientes — Coparticipado');
  return { rows, avisos:[] };
}

window.GS_SIMULADORES = {
  gsLerWorkbook, gsSheetMatrix, gsSha256Hex, gsNum, gsPrazoDeTexto,
  parseLinearCoef, parseTaxasSubsidiadas, parseTaxaBotao,
  parseCoefBalaoZeroKm, parseCoefBalaoSeminovos, parseAntecipacao,
  parseCoefSeminovo, parseTaxaCoparticipado, parseCoparticipadoSemestral, parseCoefCoparticipado
};

// ==================== Painel Master — Gestão dos Simuladores (UI) ====================
// Mesma arquitetura do módulo "Gestão de Bases" (master-gestao-bases.js): modo
// homologação deny-by-default para qualquer RPC de escrita fora do host de
// produção do GitHub Pages, upload -> parser próprio -> dry-run -> prévia com
// comparação contra a base ACTIVE -> confirmação explícita (nunca automática).

const GS_PRODUCTION_HOSTS = ['luisgamadio-spec.github.io', 'brabus.blistiq.com.br'];
function gsIsProductionHost() {
  const h = ((typeof location !== 'undefined' && location.hostname) || '').toLowerCase();
  return GS_PRODUCTION_HOSTS.includes(h);
}
const GS_HOMOLOGATION_MODE = !gsIsProductionHost();
const GS_COMMIT_RPC_NAMES = new Set([
  'master_simulador_commit_linear', 'master_simulador_commit_taxas_subsidiadas', 'master_simulador_commit_taxa_botao',
  'master_simulador_commit_balao_zerokm', 'master_simulador_commit_balao_seminovos', 'master_simulador_commit_antecipacao',
  'master_simulador_commit_financiamento_seminovo', 'master_simulador_commit_coparticipado', 'master_simulador_commit_semestral_triton_outlander',
  'master_simulador_commit_coeficientes_coparticipado'
]);
// dry-run (leitura, nunca escreve) continua liberado mesmo em homologação —
// só a escrita real (p_dry_run !== true) é simulada.
function gsIsBlockedWrite(name, args) {
  return GS_COMMIT_RPC_NAMES.has(name) && !(args && args.p_dry_run === true);
}
function gsSimulateWrite(name, args) {
  console.warn(`[Gestão dos Simuladores] MODO HOMOLOGAÇÃO — escrita bloqueada: ${name}`, args);
  const fakeUuid = '00000000-0000-4000-8000-' + Math.random().toString(16).slice(2).padEnd(12, '0').slice(0, 12);
  return { ok: true, simulated: true, batch_id: fakeUuid };
}
async function gsRpc(name, args) {
  if (GS_HOMOLOGATION_MODE && gsIsBlockedWrite(name, args)) return gsSimulateWrite(name, args);
  if (typeof supabaseClient === 'undefined' || !supabaseClient) throw new Error('Supabase não inicializado.');
  const r = await supabaseClient.rpc(name, args || {});
  if (r.error) throw r.error;
  return r.data;
}

// ---------------- catálogo das 10 vitrines (9 tipos de base; Antecipação é
// compartilhada e aparece nos dois grupos) ----------------
const GS_BASE_DEFS = [
  { uid: 'ZK_COPARTICIPADO', tipoBase: 'COPARTICIPADO', grupo: 'ZEROKM', label: 'Plano Coparticipado',
    parser: 'parseTaxaCoparticipado', rpc: 'master_simulador_commit_coparticipado',
    montarArgs: r => ({ p_linhas_modelo: r.rows, p_linhas_geral: r.geral || [], p_linhas_coeficiente: [], p_avisos: r.avisos || [] }),
    nota: 'Matriz por modelo atualizada por taxa coparticipado.xlsx. O simulador consome a base ACTIVE (iframe/srcdoc, sem alteração de layout). Antes de ativar uma nova matriz, o sistema confere automaticamente se a Matriz de Coeficientes Coparticipado (base separada, abaixo) cobre todas as taxas — se faltar coeficiente, a ativação é bloqueada.' },
  { uid: 'ZK_COEFICIENTES_COPARTICIPADO', tipoBase: 'COEFICIENTES_COPARTICIPADO', grupo: 'ZEROKM', label: 'Matriz de Coeficientes — Coparticipado',
    parser: 'parseCoefCoparticipado', rpc: 'master_simulador_commit_coeficientes_coparticipado',
    montarArgs: r => ({ p_linhas: r.rows }),
    nota: 'Coeficientes financeiros por prazo e taxa utilizados pelo Plano Coparticipado. Antes de ativar, o sistema confere se a matriz de modelos ACTIVE do Plano Coparticipado continua totalmente coberta — se alguma combinação prazo/taxa ainda necessária for removida, a ativação é bloqueada.' },
  { uid: 'ZK_LINEAR', tipoBase: 'LINEAR_ZEROKM', grupo: 'ZEROKM', label: 'Financiamento Linear',
    parser: 'parseLinearCoef', rpc: 'master_simulador_commit_linear', montarArgs: r => ({ p_linhas: r.rows }) },
  { uid: 'ZK_SUBSIDIADAS', tipoBase: 'TAXAS_SUBSIDIADAS', grupo: 'ZEROKM', label: 'Taxas Subsidiadas',
    parser: 'parseTaxasSubsidiadas', rpc: 'master_simulador_commit_taxas_subsidiadas', montarArgs: r => ({ p_linhas: r.rows }) },
  { uid: 'ZK_TAXABOTAO', tipoBase: 'TAXA_BOTAO', grupo: 'ZEROKM', label: 'Copiar Taxa Banco (Taxa Botão)',
    parser: 'parseTaxaBotao', rpc: 'master_simulador_commit_taxa_botao', montarArgs: r => ({ p_linhas: r.rows }) },
  { uid: 'ZK_BALAO', tipoBase: 'BALAO_ZEROKM', grupo: 'ZEROKM', label: 'Simulador Balão',
    parser: 'parseCoefBalaoZeroKm', rpc: 'master_simulador_commit_balao_zerokm', montarArgs: r => ({ p_linhas: r.rows }),
    parcial: 'Atualiza: Tradicional e Semestral/Anual. Parcela Única permanece na configuração atual (o arquivo não traz o coeficiente que esse plano usa).' },
  { uid: 'ZK_SEMESTRAL', tipoBase: 'SEMESTRAL_TRITON_OUTLANDER', grupo: 'ZEROKM', label: 'Semestral Triton & Outlander',
    parser: 'parseCoparticipadoSemestral', rpc: 'master_simulador_commit_semestral_triton_outlander',
    montarArgs: r => ({ p_linhas_modelo: r.rows, p_linhas_geral: r.geral || [], p_avisos: r.avisos || [] }) },
  { uid: 'ZK_ANTECIPACAO', tipoBase: 'ANTECIPACAO', grupo: 'ZEROKM', label: 'Simulador de Antecipação', compartilhada: true,
    parser: 'parseAntecipacao', rpc: 'master_simulador_commit_antecipacao', montarArgs: r => ({ p_linhas: r.rows }) },
  { uid: 'SN_FINANCIAMENTO', tipoBase: 'FINANCIAMENTO_SEMINOVO', grupo: 'SEMINOVOS', label: 'Financiamento Seminovos',
    parser: 'parseCoefSeminovo', rpc: 'master_simulador_commit_financiamento_seminovo', montarArgs: r => ({ p_linhas: r.rows }) },
  { uid: 'SN_BALAO', tipoBase: 'BALAO_SEMINOVOS', grupo: 'SEMINOVOS', label: 'Simulador Balão',
    parser: 'parseCoefBalaoSeminovos', rpc: 'master_simulador_commit_balao_seminovos', montarArgs: r => ({ p_linhas: r.rows }) },
  { uid: 'SN_ANTECIPACAO', tipoBase: 'ANTECIPACAO', grupo: 'SEMINOVOS', label: 'Simulador de Antecipação', compartilhada: true,
    parser: 'parseAntecipacao', rpc: 'master_simulador_commit_antecipacao', montarArgs: r => ({ p_linhas: r.rows }) }
];

// ---------------- utilidades de exibição ----------------
function gsFmtDateTime(v) { if (!v) return '-'; try { return new Date(v).toLocaleString('pt-BR'); } catch (e) { return '-'; } }
function gsFmtNum(v) { return Number(v || 0).toLocaleString('pt-BR'); }
function gsFmtValor(v) {
  if (v === null || v === undefined) return '-';
  if (typeof v === 'number') return v.toLocaleString('pt-BR', { maximumFractionDigits: 8 });
  return String(v);
}

async function gsCarregarStatus() {
  const bases = await gsRpc('master_simulador_listar_bases', {}) || [];
  const byTipo = {};
  bases.forEach(b => { byTipo[b.tipo_base] = b; });
  return byTipo;
}

function gsCardHtml(def, statusByTipo) {
  const info = statusByTipo[def.tipoBase];
  const sharedBadge = def.compartilhada ? '<span class="gsSharedBadge" title="Mesma base ACTIVE usada por ZeroKM e Seminovos">BASE COMPARTILHADA</span>' : '';
  const bootstrapBadge = (info && info.bootstrap) ? '<span class="gsBootstrapBadge">BASE INICIAL / BOOTSTRAP</span>' : '';
  const partialBadge = def.parcial ? `<span class="gsPartialBadge" title="${def.parcial}">ATUALIZAÇÃO PARCIAL</span>` : '';
  const body = info ? `
      <div class="gbRow"><span>Status</span><b class="gbStatusOk">ACTIVE</b></div>
      <div class="gbRow"><span>Versão (batch)</span><b>${String(info.batch_id || '-').slice(0, 8)}</b></div>
      <div class="gbRow"><span>Arquivo</span><b>${info.arquivo_nome || '-'}</b></div>
      <div class="gbRow"><span>Importado em</span><b>${gsFmtDateTime(info.importado_em)}</b></div>
      <div class="gbRow"><span>Registros</span><b>${gsFmtNum(info.quantidade_registros)}</b></div>
      <div class="gbRow"><span>Responsável</span><b>${info.responsavel || '-'}</b></div>
    ` : '<p class="note">Nenhuma base ACTIVE encontrada.</p>';
  const avisos = (info && Array.isArray(info.avisos) && info.avisos.length)
    ? `<div class="gbWarn">${info.avisos.map(a => `<div>⚠️ ${typeof a === 'string' ? a : JSON.stringify(a)}</div>`).join('')}</div>` : '';
  const notaExtra = def.nota ? `<p class="note" style="margin-top:8px">${def.nota}</p>` : '';
  const parcialExtra = def.parcial ? `<p class="note gsPartialNote" style="margin-top:8px">⚠️ ${def.parcial}</p>` : '';
  return `<div class="gbCard">
      <h3>${def.label}${sharedBadge}${bootstrapBadge}${partialBadge}</h3>
      ${body}
      ${avisos}
      ${notaExtra}
      ${parcialExtra}
      <button class="portalModuleBtn" onclick="gsIniciarAtualizacao('${def.uid}')">ATUALIZAR BASE</button>
    </div>`;
}

async function gsRenderTab() {
  let statusByTipo = {};
  let erro = null;
  try { statusByTipo = await gsCarregarStatus(); }
  catch (e) { console.error('[Gestão dos Simuladores] Falha ao carregar status:', e); erro = e; }

  const gruposHtml = [['ZEROKM', 'ZeroKM'], ['SEMINOVOS', 'Seminovos']].map(([grupo, rotulo]) => {
    const itens = GS_BASE_DEFS.filter(d => d.grupo === grupo);
    return `<h3 class="gsGroupTitle">${rotulo}</h3><div class="gbGrid">${itens.map(d => gsCardHtml(d, statusByTipo)).join('')}</div>`;
  }).join('');

  const homologBanner = GS_HOMOLOGATION_MODE
    ? `<p class="note gbWarn" style="margin-bottom:12px">🧪 MODO HOMOLOGAÇÃO — nenhuma atualização de base será gravada (host: ${((typeof location !== 'undefined' && location.hostname) || '') || '(vazio)'})</p>`
    : '';
  const erroHtml = erro ? `<p class="note" style="color:#ff6b61">Não foi possível carregar o status das bases: ${String(erro.message || erro)}</p>` : '';

  return `<h2>Gestão dos Simuladores</h2>
    <p class="note">Atualize as bases de taxas/coeficientes/rebates que alimentam o Simulador ZeroKM e o Simulador Seminovos. As fórmulas de cálculo não são alteradas aqui — apenas a fonte de dados. A base ACTIVE atual permanece em uso pelo simulador até você revisar a prévia (dry-run) e confirmar explicitamente.</p>
    ${homologBanner}
    ${erroHtml}
    ${gruposHtml}
    <div id="gsModalOverlay" class="adminModalOverlay"></div>`;
}
window.renderGestaoSimuladoresTab = gsRenderTab;

// ---------------- modal ----------------
function gsModal(html) {
  const ov = document.getElementById('gsModalOverlay');
  if (!ov) return;
  ov.innerHTML = `<div class="adminModal" style="width:min(760px,100%)">${html}</div>`;
  ov.classList.add('show');
}
function gsCloseModal() {
  const ov = document.getElementById('gsModalOverlay');
  if (!ov) return;
  ov.classList.remove('show');
  ov.innerHTML = '';
}
window.gsCloseModal = gsCloseModal;
function gsProgressModal(titulo) {
  gsModal(`<h3>${titulo}</h3><div class="gbProgressWrap"><div id="gsProgressBar" class="gbProgressBar" style="width:60%"></div></div><p class="note">Lendo e validando o arquivo localmente antes de qualquer chamada ao servidor...</p>`);
}

// ---------------- fluxo: upload -> parser -> dry-run -> prévia ----------------
window.gsIniciarAtualizacao = function (uid) {
  const def = GS_BASE_DEFS.find(d => d.uid === uid);
  if (!def) return;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.xlsx,.xls';
  input.onchange = () => {
    const file = input.files && input.files[0];
    if (!file) return;
    gsProcessarArquivo(def, file).catch(e => {
      console.error('[Gestão dos Simuladores] Erro no processamento:', e);
      gsModal(`<h3>Arquivo rejeitado</h3><p style="color:#ff8a8a">${String(e.message || e)}</p>
        <p class="note">A base ACTIVE atual não foi alterada.</p>
        <div class="adminModalActions"><button onclick="gsCloseModal()">Fechar</button></div>`);
    });
  };
  input.click();
};

async function gsProcessarArquivo(def, file) {
  gsProgressModal(`Lendo ${file.name}...`);
  const G = window.GS_SIMULADORES;
  const { wb, buf } = await G.gsLerWorkbook(file);
  const matrix = G.gsSheetMatrix(wb);
  const sha256 = await G.gsSha256Hex(buf);
  const parsed = G[def.parser](matrix); // lança erro de estrutura (gsErroEstrutura) se o arquivo for de outra base
  const argsBase = Object.assign({ p_arquivo_nome: file.name, p_arquivo_sha256: sha256 }, def.montarArgs(parsed));
  const dry = await gsRpc(def.rpc, Object.assign({}, argsBase, { p_dry_run: true }));
  gsMostrarPreview(def, file, argsBase, dry);
}

function gsMostrarPreview(def, file, argsBase, dry) {
  // a maioria das RPCs retorna "comparacao_com_active"; a de Coparticipado
  // retorna "comparacao_matriz_modelo" (nome próprio, pois há uma segunda
  // comparação independente para a tabela de coeficiente/TX_COEF).
  const comp = dry.comparacao_com_active || dry.comparacao_matriz_modelo || {};
  const novos = comp.novos || 0, alterados = comp.alterados || 0, semAlt = comp.sem_alteracao || 0, removidos = comp.removidos || 0;
  const detalhes = comp.detalhe_alterados || [];
  const cols = detalhes.length ? Object.keys(detalhes[0]) : [];
  const detalheHtml = detalhes.length
    ? `<div class="gsTableWrap"><table class="gsTable"><thead><tr>${cols.map(c => `<th>${c}</th>`).join('')}</tr></thead>
        <tbody>${detalhes.map(r => `<tr>${cols.map(c => `<td>${gsFmtValor(r[c])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
    : '<p class="note">Nenhuma linha com valor alterado em relação à base ACTIVE atual.</p>';

  const avisosExtras = [];
  if (dry.aviso_tabela_geral) avisosExtras.push(dry.aviso_tabela_geral);
  if (dry.base_compartilhada) avisosExtras.push(dry.base_compartilhada);
  if (Array.isArray(argsBase.p_avisos)) argsBase.p_avisos.forEach(a => avisosExtras.push(a));
  if (dry.linhas_coeficiente) avisosExtras.push(`Este arquivo também traz ${dry.linhas_coeficiente} linha(s) para a tabela de coeficiente (prazo/taxa→coeficiente) — comparação separada, não exibida nesta prévia resumida.`);
  const avisosHtml = avisosExtras.length ? `<div class="gbWarn">${avisosExtras.map(a => `<div>⚠️ ${a}</div>`).join('')}</div>` : '';

  const linhasValidas = dry.linhas_validas ?? dry.linhas_modelo_validas ?? 0;

  gsModal(`<h3>${def.label} — PRÉVIA (DRY-RUN, nada foi gravado)</h3>
    <div class="gbRow"><span>Arquivo</span><b>${file.name}</b></div>
    <div class="gbRow"><span>Linhas válidas no arquivo</span><b>${gsFmtNum(linhasValidas)}</b></div>
    <div class="gbRow"><span>Novos</span><b>${gsFmtNum(novos)}</b></div>
    <div class="gbRow"><span>Alterados</span><b>${gsFmtNum(alterados)}</b></div>
    <div class="gbRow"><span>Sem alteração</span><b>${gsFmtNum(semAlt)}</b></div>
    <div class="gbRow"><span>Removidos (não estão mais no arquivo)</span><b>${gsFmtNum(removidos)}</b></div>
    <h4 style="margin:14px 0 4px;font-size:13px">Detalhe das linhas alteradas (chave lógica, valor atual, valor novo)</h4>
    ${detalheHtml}
    ${avisosHtml}
    <p class="note">A base ACTIVE atual continua sendo usada pelo simulador até você confirmar.</p>
    <div id="gsDiagMsg" class="adminMsg"></div>
    <div class="adminModalActions">
      <button class="secondary" onclick="gsCancelar()">CANCELAR</button>
      <button onclick="gsConfirmar()">CONFIRMAR ATUALIZAÇÃO</button>
    </div>`);
  window.__gsOnConfirmar = async () => {
    const result = await gsRpc(def.rpc, Object.assign({}, argsBase, { p_dry_run: false }));
    gsMostrarSucesso(def, file, result);
  };
}

window.gsCancelar = function () {
  gsCloseModal();
  if (typeof toastAdmin === 'function') toastAdmin('Atualização cancelada. A base ACTIVE anterior continua em uso.', 'warn');
};
window.gsConfirmar = async function () {
  const btn = document.querySelector('#gsModalOverlay .adminModalActions button:last-child');
  if (btn) btn.disabled = true;
  const msg = document.getElementById('gsDiagMsg');
  try {
    if (typeof window.__gsOnConfirmar === 'function') await window.__gsOnConfirmar();
  } catch (e) {
    console.error('[Gestão dos Simuladores] Erro ao confirmar:', e);
    if (msg) { msg.textContent = 'Erro ao confirmar: ' + String(e.message || e); msg.className = 'adminMsg err'; }
    if (btn) btn.disabled = false;
  }
};
function gsMostrarSucesso(def, file, result) {
  const tituloLinha = GS_HOMOLOGATION_MODE
    ? '<p style="color:#ffb020"><b>🧪 SIMULAÇÃO CONCLUÍDA — nenhuma alteração foi realizada no banco</b></p>'
    : '<p><b>BASE ATUALIZADA COM SUCESSO</b></p>';
  gsModal(`<h3>${GS_HOMOLOGATION_MODE ? '🧪' : '✅'} ${def.label}</h3>
    ${tituloLinha}
    <div class="gbRow"><span>Arquivo</span><b>${file.name}</b></div>
    <div class="gbRow"><span>Novo batch (versão)</span><b>${String((result && result.batch_id) || '-').slice(0, 8)}</b></div>
    <div class="gbRow"><span>Data/hora</span><b>${gsFmtDateTime(new Date())}</b></div>
    <div class="adminModalActions"><button onclick="gsCloseModal();gsAtualizarCards()">Fechar</button></div>`);
  if (typeof toastAdmin === 'function') toastAdmin(GS_HOMOLOGATION_MODE ? 'Simulação concluída — nenhuma alteração foi gravada.' : 'Base atualizada com sucesso.');
}
window.gsAtualizarCards = function () { if (typeof renderMasterAdmin === 'function') renderMasterAdmin(); };
})();
