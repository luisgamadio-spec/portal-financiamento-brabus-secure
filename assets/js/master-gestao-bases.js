/* Gestão de Bases — módulo MASTER.
   Consome as RPCs administrativas já existentes (master_operational_begin_import /
   import_sales / import_finance / import_spf / finalize_import) mais três RPCs
   criadas para este módulo:
   - master_operational_list_batches / master_operational_list_sellers (leitura —
     necessárias porque portal_import_batches e portal_sellers têm RLS habilitado
     sem policy de leitura direta);
   - master_operational_apply_base03 (leitura em modo p_dry_run=true para o
     diagnóstico prévio; escrita transacional em p_dry_run=false — localiza sozinha
     a Base 02/FINANCE_CURRENT oficial e aplica enriquecimento financeiro + SPF
     em uma única transação atômica, sem depender de sessão do navegador).
   Nenhum segredo é usado aqui além do supabaseClient público já existente na página. */
(function () {
  'use strict';

  const CHUNK_SIZE = 500;
  const SOURCE_LABELS = {
    SALES_CURRENT: 'BASE 01 — Vendas',
    FINANCE_CURRENT: 'BASE 02 — Financiamentos',
    SPF_CURRENT: 'BASE 03 — Complementar / F&I',
    COLABORADORES: 'Colaboradores / Vendedores (legado, opcional)'
  };
  const SOURCE_ORDER = ['SALES_CURRENT', 'FINANCE_CURRENT', 'SPF_CURRENT', 'COLABORADORES'];

  // ---------------- modo homologação (deny-by-default) ----------------
  // Backend é o MESMO Supabase de produção em qualquer host (não existe ambiente
  // "local" separado). Para permitir homologar a interface sem risco de escrita
  // real, toda RPC de escrita da Gestão de Bases passa por este bloqueio,
  // centralizado em gbRpc — não depende de esconder botão nem de cada função
  // "lembrar" de checar. Só o hostname exato do GitHub Pages é tratado como
  // produção; qualquer outro host (localhost, IP, file://, futuro domínio não
  // previsto) cai em homologação por padrão.
  const GB_PRODUCTION_HOSTS = ['luisgamadio-spec.github.io', 'brabus.blistiq.com.br'];
  function gbIsProductionHost() {
    const h = ((typeof location !== 'undefined' && location.hostname) || '').toLowerCase();
    return GB_PRODUCTION_HOSTS.includes(h);
  }
  const GB_HOMOLOGATION_MODE = !gbIsProductionHost();
  const GB_WRITE_RPC_NAMES = new Set([
    'master_operational_begin_import',
    'master_operational_import_sales',
    'master_operational_import_finance',
    'master_operational_import_spf',
    'master_operational_import_sellers',
    'master_operational_finalize_import',
    'master_operational_enrich_analytics' // não é mais chamada por este módulo, mas fica bloqueada por segurança
  ]);
  function gbIsBlockedWrite(name, args) {
    if (GB_WRITE_RPC_NAMES.has(name)) return true;
    // apply_base03 só escreve quando p_dry_run !== true — a leitura (diagnóstico) continua liberada.
    if (name === 'master_operational_apply_base03' && args && args.p_dry_run !== true) return true;
    return false;
  }
  // Simula um retorno plausível, do MESMO formato do RPC real, sem tocar o banco.
  // Usado só como rede de segurança (defesa em profundidade) — o fluxo da Base 03
  // já evita chegar aqui construindo o resultado simulado a partir de números
  // reais do dry_run (ver gbProcessarBase03).
  function gbSimulateWrite(name, args) {
    console.warn(`[Gestão de Bases] MODO HOMOLOGAÇÃO — escrita bloqueada: ${name}`, args);
    const fakeUuid = '00000000-0000-4000-8000-' + Math.random().toString(16).slice(2).padEnd(12, '0').slice(0, 12);
    switch (name) {
      case 'master_operational_begin_import':
        return fakeUuid;
      case 'master_operational_import_sales':
      case 'master_operational_import_finance':
      case 'master_operational_import_spf':
      case 'master_operational_import_sellers':
        return Array.isArray(args && args.p_rows) ? args.p_rows.length : 0;
      case 'master_operational_finalize_import':
        return true;
      case 'master_operational_enrich_analytics':
        return Array.isArray(args && args.p_rows) ? args.p_rows.length : 0;
      case 'master_operational_apply_base03':
        return {
          dry_run: false, simulated: true,
          finance_batch_id: fakeUuid, finance_rows_matched: 0,
          spf_batch_id: fakeUuid, spf_rows_received: 0, spf_accepted: 0, spf_rejected: 0
        };
      default:
        return null;
    }
  }

  // Estado da sessão (some ao recarregar a página). Usado só para acompanhar um
  // upload de Base 02 ainda não confirmado nesta aba (reprocessar pendentes de
  // vendedor após atualizar Colaboradores). A Base 03 NÃO depende mais disto —
  // ela localiza a Base 02 oficial (VALIDATED) direto no banco, em qualquer sessão.
  const GB_SESSION = {
    financeBatch: null, // {batchId, pendentesRaw:[{raw,rowNumber}]}
    lastMissingSellers: [] // [{nbs, seller_source_name}] — só para exibir na tela, some ao recarregar
  };
  let GB_SELLERS_CACHE = null; // {byNbs: {nbs:{cpf_normalizado,store,name}}}

  // ---------------- utilitários ----------------
  function gbNormalize(v) {
    return (v ?? '').toString().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toUpperCase().replace(/\s+/g, ' ').trim();
  }
  // Só entra em ação para valores que já chegam como texto (ex.: alguém digitou
  // "1.234,56" numa célula, ou um campo textual sendo reaproveitado como número).
  // Células numéricas reais do Excel chegam como Number puro via gbReadSheet
  // (raw:true) e retornam no fast-path acima — não passam por este parser.
  // Heurística: entre "," e ".", o separador que aparece por ÚLTIMO na string é
  // o decimal (só pode haver um decimal; separadores de milhar podem repetir a
  // cada 3 dígitos, mas nunca vêm depois do decimal). Cobre os dois formatos
  // (BR: 16.499,40 / US: 16,499.40) sem adivinhar por "qual aparece primeiro" —
  // foi exatamente esse tipo de heurística frágil que corrompeu return_value
  // (16.499,40 lido como texto formatado "16,499.40" virava 16,50).
  function gbAsNumber(v) {
    if (v === null || v === undefined || v === '') return 0;
    if (typeof v === 'number') return isFinite(v) ? v : 0;
    let s = String(v).trim().replace('R$', '').trim();
    if (!s) return 0;
    const lastComma = s.lastIndexOf(',');
    const lastDot = s.lastIndexOf('.');
    if (lastComma > -1 && lastDot > -1) {
      if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
      else s = s.replace(/,/g, '');
    } else if (lastComma > -1) {
      s = s.replace(',', '.');
    }
    const n = Number(s);
    return isFinite(n) ? n : 0;
  }
  function gbOnlyDigits(v) { return (v ?? '').toString().replace(/\D/g, ''); }
  function gbCleanChassis(v) { return (v ?? '').toString().toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  function gbParseDateBR(v) {
    if (!v) return null;
    if (v instanceof Date && !isNaN(v.getTime())) {
      return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
    }
    const s = String(v).trim();
    const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (!m) return null;
    return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  // Época do workbook lido por último (1900 vs 1904) — necessária para
  // gbParseExcelDate converter seriais numéricos de data corretamente.
  // Definida em gbReadSheet a cada arquivo carregado.
  let GB_LAST_DATE1904 = false;
  // Extensão de gbParseDateBR EXCLUSIVA para campos declaradamente de data.
  // Cobre o caso comprovado na Base 03 real: célula com valor correto de data
  // (serial do Excel, ex.: 46172.686111114) mas formatada como "General" em vez
  // de um formato de data — cellDates:true do SheetJS não converte esse tipo de
  // célula para Date (a conversão dele depende do formato de exibição, não do
  // valor), então ela chega aqui como Number puro. NÃO usar esta função para
  // nenhum campo que não seja semanticamente uma data (ver gbAsNumber para
  // valores monetários/numéricos — permanece inalterada).
  function gbParseExcelDate(v) {
    const iso = gbParseDateBR(v);
    if (iso) return iso;
    if (typeof v === 'number' && isFinite(v) && v > 0) {
      const epochMs = GB_LAST_DATE1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
      const d = new Date(epochMs + Math.floor(v) * 86400000);
      if (!isNaN(d.getTime())) {
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      }
    }
    return null;
  }
  function gbChunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
  }
  // Comparação de nome de coluna tolerante a espaços duplos/acentos/caixa —
  // os arquivos brutos têm inconsistências desse tipo (ex.: "Retorno  Liquido").
  function gbGetCol(row, names) {
    for (const wanted of names) {
      const wn = gbNormalize(wanted);
      for (const key of Object.keys(row)) {
        if (gbNormalize(key) === wn) {
          const v = row[key];
          if (v !== undefined && v !== null && v !== '') return v;
        }
      }
    }
    return '';
  }
  async function gbSha256Hex(arrayBuffer) {
    const digest = await crypto.subtle.digest('SHA-256', arrayBuffer);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function gbReadSheet(file, headerAnchor) {
    if (typeof XLSX === 'undefined') throw new Error('Biblioteca XLSX não carregada.');
    const buf = await file.arrayBuffer();
    // cellDates:true + raw:true: lê o valor NATIVO da célula (Number puro para
    // número, Date para data), em vez do texto formatado de exibição.
    // Comprovado (Base 02, julho/2026, 27 registros reais): células numéricas
    // com separador de milhar na formatação do Excel, ao serem lidas como texto
    // formatado (raw:false), produzem strings como "16,499.40" que um parser de
    // número (qualquer heurística de separador BR/US) pode interpretar errado —
    // "16.499,40" virava "16,50" (÷ ~1000) em return_value. Ler o valor nativo
    // elimina essa ambiguidade na origem, sem depender de adivinhar formato.
    // Datas continuam OK: gbParseDateBR já trata `instanceof Date` (para colunas
    // que são datas reais no Excel) e também texto "DD/MM/AAAA..." (para colunas
    // já armazenadas como texto no arquivo-fonte, como é o caso hoje de "Data
    // Venda" — confirmado, não é célula de data nativa, é texto).
    const wb = XLSX.read(buf, { type: 'array', cellDates: true });
    GB_LAST_DATE1904 = !!(wb.Workbook && wb.Workbook.WBProps && wb.Workbook.WBProps.date1904);
    if (!wb.SheetNames.length) throw new Error('Planilha vazia ou ilegível.');
    const ws = wb.Sheets[wb.SheetNames[0]];
    const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true });
    const needle = gbNormalize(headerAnchor);
    let headerIdx = matrix.findIndex(r => Array.isArray(r) && r.some(c => gbNormalize(c).includes(needle)));
    if (headerIdx < 0) headerIdx = 0;
    const headerRow = matrix[headerIdx] || [];
    const headers = headerRow.map(h => (h ?? '').toString().trim());
    if (!headers.some(Boolean)) throw new Error('Não foi possível localizar o cabeçalho da planilha.');
    const rows = matrix.slice(headerIdx + 1)
      .filter(r => Array.isArray(r) && r.some(c => c !== ''))
      .map(r => {
        const o = {};
        headers.forEach((h, i) => { if (h) o[h] = r[i] ?? ''; });
        return o;
      });
    return { rows, buf };
  }

  async function gbRpc(name, args) {
    if (GB_HOMOLOGATION_MODE && gbIsBlockedWrite(name, args)) {
      return gbSimulateWrite(name, args);
    }
    if (typeof supabaseClient === 'undefined' || !supabaseClient) {
      throw new Error('Supabase não inicializado.');
    }
    const r = await supabaseClient.rpc(name, args || {});
    if (r.error) throw r.error;
    return r.data;
  }

  async function gbLoadSellersCache(force) {
    if (GB_SELLERS_CACHE && !force) return GB_SELLERS_CACHE;
    const rows = await gbRpc('master_operational_list_sellers', {}) || [];
    const byNbs = {};
    rows.forEach(s => {
      const nbs = gbNormalize(s.nbs);
      if (nbs) byNbs[nbs] = s;
    });
    GB_SELLERS_CACHE = { byNbs, raw: rows };
    return GB_SELLERS_CACHE;
  }

  // ---------------- mapeamento BASE 01 (Vendas) ----------------
  // Mapeamento comprovado por cruzamento direto com produção (1.507/1.507 chassis
  // batendo). "Tipo" = 'Usado' -> SEMINOVOS; qualquer outro valor ('Novo',
  // 'Internet Pub', 'Internet Fro') -> NOVOS (também comprovado: 111/111 chassis
  // Internet Pub/Fro já em produção estão como NOVOS).
  function gbBuildBase01Row(raw, rowNumber, sellersByNbs) {
    const tipo = gbNormalize(gbGetCol(raw, ['Tipo']));
    const department = tipo === 'USADO' ? 'SEMINOVOS' : 'NOVOS';
    const chassis = gbCleanChassis(gbGetCol(raw, ['Chassi Completo', 'Chassi']));
    const nbs = gbNormalize(gbGetCol(raw, ['Vendedor']));
    const seller = sellersByNbs[nbs] || null;
    return {
      source_row_number: rowNumber,
      sale_date: gbParseDateBR(gbGetCol(raw, ['Data venda', 'Data Venda'])),
      chassis,
      chassis_short: chassis.slice(-6),
      seller_cpf: gbOnlyDigits(gbGetCol(raw, ['CPF do Vendedor'])),
      seller_source_name: String(gbGetCol(raw, ['Nome Vendedor Completo'])).trim(),
      seller_nbs: nbs,
      // Para vendedor RESOLVIDO, loja vem do cadastro (portal_sellers via NBS),
      // não do texto bruto "Empresa Vendedora" — comprovado por amostragem
      // completa que diverge do cadastro em ~277/1114 linhas resolvidas (ex.:
      // Nações grafada "NACOES UNIDAS" num lote e "NACOES" nos anteriores,
      // quebrando o cruzamento com Base 02/vendedores/analista). Mesma regra
      // já usada em gbBuildBase02Row.
      // Para vendedor NÃO resolvido, preserva o comportamento anterior (texto
      // do arquivo) — decisão deliberada de escopo: essa correção ataca só o
      // caso comprovado (vendedor identificado, loja divergente do cadastro).
      // O tratamento de linhas sem vendedor resolvido fica para decisão
      // separada, ainda não tomada.
      store: seller ? gbNormalize(seller.store) : gbNormalize(gbGetCol(raw, ['Empresa Vendedora'])),
      sale_value: gbAsNumber(gbGetCol(raw, ['Valor Venda'])),
      department,
      source_kind: 'CURRENT',
      source_transaction: null,
      // "Modelo" é a coluna real do nome do veículo (comprovado por amostragem:
      // "Veículo" é na verdade o grupo/marca, ex. "VU-PEUGEOT"). Nunca era
      // enviada ao import — Análise por Modelos dependia de um backfill manual
      // feito fora do fluxo de importação, que não se repetia em cargas novas.
      vehicle_model: String(gbGetCol(raw, ['Modelo'])).trim() || null,
      _diagOk: !!(chassis && gbParseDateBR(gbGetCol(raw, ['Data venda', 'Data Venda'])) && ['NOVOS', 'SEMINOVOS'].includes(department))
    };
  }

  // ---------------- mapeamento BASE 02 (Financiamentos) ----------------
  // "store" e "seller_cpf" não existem como coluna direta na Base 02 — comprovado
  // por cruzamento que ambos vêm do cadastro do vendedor (portal_sellers) via NBS
  // ("Vendedor"). Sem esse cruzamento, store/seller_cpf ficariam vazios.
  function gbBase02Classify(descRaw) {
    const desc = gbNormalize(descRaw);
    return {
      is_real_financing: desc === 'POR PLANO-FINANCIAMENTO' || desc === 'FINANCIAMENTO',
      is_later_return: desc.includes('LANCAMENTO RETORNO POSTERIOR') || desc === 'LANCAMENTO RETORNO POSTERIOR',
      is_spf: desc.includes('SPF EXTRA')
    };
  }
  function gbBuildBase02Row(raw, rowNumber, sellersByNbs) {
    const nbs = gbNormalize(gbGetCol(raw, ['Vendedor']));
    const seller = sellersByNbs[nbs] || null;
    const descRaw = gbGetCol(raw, ['Descrição Serviço', 'Descricao Servico']);
    const cls = gbBase02Classify(descRaw);
    const chassis = gbCleanChassis(gbGetCol(raw, ['Chassi Completo']));
    const clientKey = gbNormalize(gbGetCol(raw, ['Cliente']));
    return {
      source_row_number: rowNumber,
      operation_date: gbParseDateBR(gbGetCol(raw, ['Data Venda'])),
      chassis,
      chassis_short: chassis.slice(-6),
      seller_cpf: seller ? seller.cpf_normalizado : '',
      seller_source_name: String(gbGetCol(raw, ['Nome completo vendedor'])).trim(),
      seller_nbs: nbs,
      store: seller ? gbNormalize(seller.store) : '',
      service_description: String(descRaw || '').trim(),
      is_real_financing: cls.is_real_financing,
      is_later_return: cls.is_later_return,
      is_spf: cls.is_spf,
      return_value: gbAsNumber(gbGetCol(raw, ['Retorno Liquido', 'Retorno  Liquido', 'Retorno Bruto', 'Retorno'])),
      financed_or_service_value: gbAsNumber(gbGetCol(raw, ['Valor Serviço', 'Valor Servico'])),
      client_match_key: clientKey,
      source_kind: 'CURRENT',
      // "Plano" é campo nativo da própria Base 02 (não depende da Base 03) —
      // persistido diretamente no import, ao contrário do que a versão
      // anterior fazia (só gravava via enriquecimento acoplado à Base 03).
      finance_code: String(gbGetCol(raw, ['Plano'])).trim() || null,
      // campo auxiliar — não faz parte do payload de import_finance.
      _diagOk: !!(gbParseDateBR(gbGetCol(raw, ['Data Venda'])) && (chassis || cls.is_later_return))
    };
  }

  // ---------------- mapeamento COLABORADORES (Vendedores) ----------------
  // Formato já usado historicamente para este source_type — confirmado por
  // cruzamento (ALEXANDRES/DENISESI batendo cpf/nome/loja já em produção).
  function gbBuildColaboradorRow(raw) {
    const name = String(gbGetCol(raw, ['Nome'])).trim();
    const status = String(gbGetCol(raw, ['STATUS', 'Status'])).trim().toUpperCase().replace(/\s*\/\s*/g, '/');
    return {
      cpf: gbOnlyDigits(gbGetCol(raw, ['CPF'])),
      nbs: gbNormalize(gbGetCol(raw, ['NBS'])),
      name,
      normalized_name: gbNormalize(name),
      store: gbNormalize(gbGetCol(raw, ['Loja'])),
      profile_type: gbNormalize(gbGetCol(raw, ['TIPO', 'Tipo'])),
      status
    };
  }

  // ---------------- mapeamento BASE 03 (Complementar / F&I) ----------------
  // Mesma prioridade oficial de classificação já validada no restante do projeto
  // (planTypeFromFields / scoreB03PlanRow): SUBSIDIADO > REVERSÃO > COPARTICIPADO > BALÃO.
  function gbScoreBase03Row(codigoIFRaw, tcDevolvidaRaw, balaoRaw) {
    const ifTxt = gbNormalize(codigoIFRaw);
    const ifNum = gbAsNumber(codigoIFRaw);
    const tcNum = gbAsNumber(tcDevolvidaRaw);
    const balaoNum = gbAsNumber(balaoRaw);
    if (ifNum === 999 || ifTxt.includes('SUBSIDIADO')) return 100;
    if (ifNum === 777 || ifTxt.includes('REVERSAO')) return 90;
    if (tcNum === 1 || ifTxt.includes('COPARTICIPADO')) return 85;
    if (balaoNum > 0) return 80;
    return 0;
  }
  function gbContainsSpfExtra(nomeOpcional) {
    return gbNormalize(nomeOpcional).includes('SPF EXTRA');
  }
  // Constrói uma linha operacional da Base 03 pronta para portal_spf_operations —
  // usada tanto para linhas principais (uma operação real, is_spf_extra=false)
  // quanto para linhas complementares SPF Extra (is_spf_extra=true). Todos os
  // campos vêm diretamente das colunas da própria linha; forward-fill (quando
  // aplicável) é feito pelo chamador, não aqui.
  function gbBuildBase03OperationalRow(raw, rowNumber, isSpfExtra) {
    return {
      source_row_number: rowNumber,
      operation_date: gbParseExcelDate(gbGetCol(raw, ['Op - Data Inclusão', 'Op - Data Contrato'])),
      client_match_key: gbNormalize(gbGetCol(raw, ['Cli - Nome'])),
      store: gbNormalize(gbGetCol(raw, ['Inst - Ponto de Venda'])),
      department: gbNormalize(gbGetCol(raw, ['Inst - Departamento'])),
      modality: gbNormalize(gbGetCol(raw, ['Op - Modalidade'])),
      operation_code: String(gbGetCol(raw, ['Op - Código'])).trim(),
      status: gbNormalize(gbGetCol(raw, ['Op - Situação'])),
      bank: gbNormalize(gbGetCol(raw, ['Op Fin - Banco'])),
      financed_value: gbAsNumber(gbGetCol(raw, ['Op Fin - Financiado (R$)'])),
      optional_name: String(gbGetCol(raw, ['Opcional - Nome'])).trim(),
      optional_value: gbAsNumber(gbGetCol(raw, ['Opcional - Valor (R$)'])),
      is_spf_extra: isSpfExtra,
      installments: gbAsNumber(gbGetCol(raw, ['Op Fin - Quantidade Parcelas'])) || null,
      installment_value: gbAsNumber(gbGetCol(raw, ['Op Fin - PMT (R$)'])) || null,
      balloon_payment: null,
      balloon_value: gbAsNumber(gbGetCol(raw, ['Op Fin - Balão PMT (R$)'])) || null,
      finance_code: String(gbGetCol(raw, ['Tabela - Código IF'])).trim() || null,
      tc_returned: String(gbGetCol(raw, ['Tabela - TC Devolvida (R$)'])).trim() || null
    };
  }
  // Constrói, por cliente, o melhor sinal de classificação da Base 03 —
  // usado para enriquecer o lote FINANCE aberto na mesma sessão.
  function gbBuildBase03ClientIndex(base03Rows) {
    const bestByClient = {};
    base03Rows.forEach(raw => {
      const clientKey = gbNormalize(gbGetCol(raw, ['Cli - Nome']));
      if (!clientKey) return;
      const codigoIFRaw = gbGetCol(raw, ['Tabela - Código IF']);
      const tcDevolvidaRaw = gbGetCol(raw, ['Tabela - TC Devolvida (R$)']);
      const balaoRaw = gbGetCol(raw, ['Op Fin - Balão PMT (R$)']);
      const score = gbScoreBase03Row(codigoIFRaw, tcDevolvidaRaw, balaoRaw);
      const prev = bestByClient[clientKey];
      if (!prev || score > prev.score) {
        bestByClient[clientKey] = {
          score,
          codigoIF: codigoIFRaw !== '' ? String(codigoIFRaw).trim() : null,
          tcDevolvida: tcDevolvidaRaw !== '' ? gbAsNumber(tcDevolvidaRaw) : null,
          balaoValor: balaoRaw !== '' ? gbAsNumber(balaoRaw) : null,
          parcelas: gbAsNumber(gbGetCol(raw, ['Op Fin - Quantidade Parcelas'])) || null,
          pmt: gbAsNumber(gbGetCol(raw, ['Op Fin - PMT (R$)'])) || null
        };
      }
    });
    return bestByClient;
  }

  // ---------------- chamadas RPC em lotes de até 500 ----------------
  async function gbImportChunked(rpcName, batchId, rows, onProgress) {
    let accepted = 0;
    const chunks = gbChunk(rows, CHUNK_SIZE);
    for (let i = 0; i < chunks.length; i++) {
      const count = await gbRpc(rpcName, { p_batch_id: batchId, p_rows: chunks[i] });
      accepted += Number(count) || 0;
      if (onProgress) onProgress(Math.min((i + 1) * CHUNK_SIZE, rows.length), rows.length);
    }
    return accepted;
  }

  // ---------------- status atual das bases (cards) ----------------
  async function gbLoadStatus() {
    const batches = await gbRpc('master_operational_list_batches', {}) || [];
    // Só o lote VALIDATED mais recente é "a base oficial" hoje. Não usamos lotes
    // VALIDATING vindos do banco para decidir o que mostrar como "pendente" —
    // pode haver lotes VALIDATING órfãos (upload cancelado, teste antigo, ou
    // até anteriores à existência deste módulo) que nunca foram finalizados e
    // não têm relação nenhuma com a sessão atual do MASTER. O aviso de "lote
    // pendente" usa GB_SESSION (em memória, só desta sessão) — ver gbCardHtml.
    const result = {};
    SOURCE_ORDER.forEach(src => {
      const ofSource = batches.filter(b => b.source_type === src);
      const validated = ofSource.filter(b => b.status === 'VALIDATED')
        .sort((a, b) => new Date(b.completed_at || b.created_at) - new Date(a.completed_at || a.created_at))[0] || null;
      result[src] = { validated };
    });
    return result;
  }

  function gbFmtDateTime(v) {
    if (!v) return '-';
    try { return new Date(v).toLocaleString('pt-BR'); } catch (e) { return '-'; }
  }
  function gbFmtDate(v) {
    if (!v) return '-';
    try { return new Date(v + 'T00:00:00').toLocaleDateString('pt-BR'); } catch (e) { return '-'; }
  }
  function gbFmtNum(v) { return Number(v || 0).toLocaleString('pt-BR'); }

  function gbCardHtml(sourceType, statusInfo) {
    const label = SOURCE_LABELS[sourceType];
    const v = statusInfo.validated;
    // Baseado em estado da sessão (memória), não em consulta ao banco — evita
    // confundir lotes VALIDATING órfãos/antigos com uma atualização em andamento
    // desta sessão (ver gbLoadStatus).
    const pendingBadge = (sourceType === 'FINANCE_CURRENT' && GB_SESSION.financeBatch)
      ? `<div class="gbPendingNote">⏳ A Base 02 desta sessão está em validação — confirme-a para torná-la oficial.</div>`
      : '';
    // Fase 21.6 — usuarios (cadastro/convite) já é a fonte de verdade para
    // vendedores atuais; Colaboradores deixou de ser requisito para que um
    // vendedor novo seja reconhecido pelas Bases 01/02 (basta o cadastro
    // ter Login NBS preenchido). Preservada só como enriquecimento
    // histórico/legado opcional — nunca mais aparece como pendência.
    const legadoNote = (sourceType === 'COLABORADORES')
      ? `<p class="note" style="margin-top:8px">Não é mais necessário para que vendedores novos sejam reconhecidos — o cadastro no Portal (com Login NBS) já é suficiente. Use somente para enriquecer/atualizar dados históricos legados.</p>`
      : '';
    const body = v ? `
      <div class="gbRow"><span>Arquivo</span><b>${v.original_filename || '-'}</b></div>
      <div class="gbRow"><span>Atualizado em</span><b>${gbFmtDateTime(v.completed_at)}</b></div>
      <div class="gbRow"><span>Período</span><b>${gbFmtDate(v.period_start)} → ${gbFmtDate(v.period_end)}</b></div>
      <div class="gbRow"><span>Linhas lidas</span><b>${gbFmtNum(v.rows_read)}</b></div>
      <div class="gbRow"><span>Aceitas</span><b>${gbFmtNum(v.rows_accepted)}</b></div>
      <div class="gbRow"><span>Rejeitadas</span><b>${gbFmtNum(v.rows_rejected)}</b></div>
      <div class="gbRow"><span>Status</span><b class="gbStatusOk">VALIDADO</b></div>
    ` : `<p class="note">Nenhuma carga validada ainda para esta base.</p>`;
    return `<div class="gbCard">
      <h3>${label}</h3>
      ${body}
      ${pendingBadge}
      ${legadoNote}
      <button class="portalModuleBtn" onclick="gbIniciarAtualizacao('${sourceType}')">ATUALIZAR</button>
    </div>`;
  }

  async function gbRenderTab() {
    let statusHtml = '<p class="note">Carregando status das bases...</p>';
    try {
      const status = await gbLoadStatus();
      statusHtml = `<div class="gbGrid">
        ${SOURCE_ORDER.map(src => gbCardHtml(src, status[src])).join('')}
      </div>`;
    } catch (e) {
      console.error('[Gestão de Bases] Falha ao carregar status:', e);
      statusHtml = `<p class="note" style="color:#ff6b61">Não foi possível carregar o status das bases: ${String(e.message || e)}</p>`;
    }
    const homologBanner = GB_HOMOLOGATION_MODE
      ? `<p class="note gbWarn" style="margin-bottom:12px">🧪 MODO HOMOLOGAÇÃO — nenhuma alteração será gravada (host: ${((typeof location !== 'undefined' && location.hostname) || '') || '(vazio)'})</p>`
      : '';
    return `<h2>Gestão de Bases</h2>
      <p class="note">Bases operacionais do portal: Vendas, Financiamentos e Complementar. A base atual permanece válida até você confirmar a atualização.</p>
      ${homologBanner}
      ${statusHtml}
      <div id="gbModalOverlay" class="adminModalOverlay"></div>`;
  }
  window.renderGestaoBasesTab = gbRenderTab;

  // ---------------- modal / diagnóstico ----------------
  function gbModal(html) {
    const ov = document.getElementById('gbModalOverlay');
    if (!ov) return;
    ov.innerHTML = `<div class="adminModal" style="width:min(640px,100%)">${html}</div>`;
    ov.classList.add('show');
  }
  function gbCloseModal() {
    const ov = document.getElementById('gbModalOverlay');
    if (!ov) return;
    ov.classList.remove('show');
    ov.innerHTML = '';
  }
  window.gbCloseModal = gbCloseModal;

  function gbProgressModal(titulo) {
    gbModal(`<h3>${titulo}</h3><div class="gbProgressWrap"><div id="gbProgressBar" class="gbProgressBar"></div></div><p id="gbProgressText" class="note">Iniciando...</p>`);
  }
  function gbSetProgress(done, total) {
    const pct = total ? Math.round((done / total) * 100) : 0;
    const bar = document.getElementById('gbProgressBar');
    const txt = document.getElementById('gbProgressText');
    if (bar) bar.style.width = pct + '%';
    if (txt) txt.textContent = `${gbFmtNum(done)} / ${gbFmtNum(total)} registros (${pct}%)`;
  }

  // ---------------- fluxo BASE 01 ----------------
  // Base 03 não depende mais de sessão: master_operational_apply_base03 localiza
  // sozinha a Base 02 (FINANCE_CURRENT) oficial no banco. Se não houver nenhuma
  // Base 02 validada ainda, a própria RPC recusa com mensagem clara (ver catch
  // de gbProcessarArquivo) — não há guard client-side aqui.
  window.gbIniciarAtualizacao = function (sourceType) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.xlsx,.xls';
    input.onchange = () => {
      const file = input.files && input.files[0];
      if (!file) return;
      gbProcessarArquivo(sourceType, file).catch(e => {
        console.error('[Gestão de Bases] Erro no processamento:', e);
        gbModal(`<h3>Erro</h3><p style="color:#ff8a8a">${String(e.message || e)}</p>
          <p class="note">A base oficial anterior não foi alterada.</p>
          <div class="adminModalActions"><button onclick="gbCloseModal()">Fechar</button></div>`);
      });
    };
    input.click();
  };

  async function gbProcessarArquivo(sourceType, file) {
    gbProgressModal(`Lendo ${file.name}...`);
    const anchor = sourceType === 'SALES_CURRENT' ? 'Chassi'
      : sourceType === 'FINANCE_CURRENT' ? 'Descrição Serviço'
      : sourceType === 'COLABORADORES' ? 'NBS'
      : 'Op - Código';
    const { rows: rawRows, buf } = await gbReadSheet(file, anchor);
    if (!rawRows.length) throw new Error('Arquivo vazio ou sem linhas de dados reconhecíveis.');
    const sha256 = await gbSha256Hex(buf);

    if (sourceType === 'SALES_CURRENT') return gbProcessarBase01(file, rawRows, sha256);
    if (sourceType === 'FINANCE_CURRENT') return gbProcessarBase02(file, rawRows, sha256);
    if (sourceType === 'SPF_CURRENT') return gbProcessarBase03(file, rawRows, sha256);
    if (sourceType === 'COLABORADORES') return gbProcessarColaboradores(file, rawRows, sha256);
    throw new Error('Tipo de base desconhecido.');
  }

  async function gbProcessarBase01(file, rawRows, sha256) {
    const sellers = await gbLoadSellersCache();
    const mapped = rawRows.map((r, i) => gbBuildBase01Row(r, i + 1, sellers.byNbs));
    const semDepartamento = mapped.filter(r => !r._diagOk).length;
    const rowsToSend = mapped.map(({ _diagOk, ...rest }) => rest);

    // Vendedores cujo NBS não resolveu contra o cadastro — essas linhas mantêm
    // por ora o texto bruto do arquivo como loja (decisão temporária, ver
    // gbBuildBase01Row); aqui só sinalizamos no diagnóstico, não mudamos o
    // valor. O placeholder literal "NBS" (venda sem vendedor individual
    // identificado no arquivo-fonte) é contado à parte, não é erro de cadastro.
    const missingByNbs = {};
    let semVendedorNoArquivo = 0;
    mapped.forEach((r, i) => {
      if (!r.seller_nbs || sellers.byNbs[r.seller_nbs]) return;
      if (r.seller_nbs === 'NBS') { semVendedorNoArquivo++; return; }
      missingByNbs[r.seller_nbs] = { nbs: r.seller_nbs, nome: rawRows[i]['Nome Vendedor Completo'] || r.seller_nbs };
    });
    const missingList = Object.values(missingByNbs);

    gbSetProgress(0, rowsToSend.length);
    const batchId = await gbRpc('master_operational_begin_import', {
      p_source_type: 'SALES_CURRENT', p_original_filename: file.name, p_source_sha256: sha256, p_rows_read: rowsToSend.length
    });
    const accepted = await gbImportChunked('master_operational_import_sales', batchId, rowsToSend, gbSetProgress);
    const rejected = rowsToSend.length - accepted;

    const avisos = [];
    if (semDepartamento) avisos.push(`${semDepartamento} registro(s) com departamento não reconhecido — foram enviados mesmo assim e podem ter sido rejeitados pela validação do servidor.`);
    if (missingList.length) avisos.push(`${missingList.length} código(s) de vendedor (coluna "Vendedor") não encontrado(s) no cadastro — a loja dessas linhas usou o texto do arquivo (comportamento provisório, sem regra definitiva ainda).`);
    if (semVendedorNoArquivo) avisos.push(`${gbFmtNum(semVendedorNoArquivo)} linha(s) sem vendedor individual identificado no próprio arquivo (código "NBS") — a loja dessas linhas usou o texto do arquivo, comportamento inalterado.`);

    gbMostrarDiagnostico({
      titulo: 'BASE 01 — VENDAS',
      arquivo: file.name,
      linhasLidas: rowsToSend.length,
      aceitas: accepted,
      rejeitadas: rejected,
      avisos,
      listaPendente: missingList,
      onConfirmar: async () => {
        await gbRpc('master_operational_finalize_import', {
          p_batch_id: batchId, p_rows_accepted: accepted, p_rows_rejected: rejected,
          p_validation_message: `Gestão de Bases: ${accepted} aceitas, ${rejected} rejeitadas.`
        });
        gbMostrarSucesso('BASE 01 — VENDAS', file.name, accepted);
      }
    });
  }

  async function gbProcessarBase02(file, rawRows, sha256) {
    gbSetProgress(0, rawRows.length);
    const sellers = await gbLoadSellersCache();
    const mapped = rawRows.map((r, i) => gbBuildBase02Row(r, i + 1, sellers.byNbs));
    const rowsToSend = mapped.map(({ _diagOk, ...rest }) => rest);

    // Lista real (não só contagem) dos vendedores não encontrados no cadastro,
    // deduplicada por NBS, para o MASTER conseguir ver exatamente quem falta.
    const missingByNbs = {};
    mapped.forEach((r, i) => {
      if (!r.seller_cpf && r.seller_nbs) {
        missingByNbs[r.seller_nbs] = { nbs: r.seller_nbs, nome: rawRows[i]['Nome completo vendedor'] || r.seller_nbs };
      }
    });
    const missingList = Object.values(missingByNbs);

    const batchId = await gbRpc('master_operational_begin_import', {
      p_source_type: 'FINANCE_CURRENT', p_original_filename: file.name, p_source_sha256: sha256, p_rows_read: rowsToSend.length
    });
    const accepted = await gbImportChunked('master_operational_import_finance', batchId, rowsToSend, gbSetProgress);
    const rejected = rowsToSend.length - accepted;

    // Guarda em memória (só desta sessão) os dados necessários para reprocessar
    // as linhas sem vendedor assim que os Colaboradores forem atualizados.
    // A Base 03 não depende mais disto (ver master_operational_apply_base03).
    GB_SESSION.financeBatch = {
      batchId,
      pendentesRaw: rawRows
        .map((raw, i) => ({ raw, rowNumber: i + 1 }))
        .filter((_, i) => !mapped[i].seller_cpf && mapped[i].seller_nbs)
    };
    GB_SESSION.lastMissingSellers = missingList;

    gbMostrarDiagnostico({
      titulo: 'BASE 02 — FINANCIAMENTOS',
      arquivo: file.name,
      linhasLidas: rowsToSend.length,
      aceitas: accepted,
      rejeitadas: rejected,
      avisos: missingList.length ? [`${missingList.length} registro(s) cujo vendedor (coluna "Vendedor") não foi encontrado no cadastro — loja/CPF ficaram em branco para essas linhas.`] : [],
      listaPendente: missingList,
      extra: '<p class="note">Este lote permanece em validação até você confirmar. A Base 03 pode ser atualizada a qualquer momento, mesmo depois de confirmar esta Base 02 — ela localiza a versão oficial automaticamente.</p>',
      onConfirmar: async () => {
        await gbRpc('master_operational_finalize_import', {
          p_batch_id: batchId, p_rows_accepted: accepted, p_rows_rejected: rejected,
          p_validation_message: `Gestão de Bases: ${accepted} aceitas, ${rejected} rejeitadas.`
        });
        GB_SESSION.financeBatch = null;
        gbMostrarSucesso('BASE 02 — FINANCIAMENTOS', file.name, accepted);
      }
    });
  }

  async function gbProcessarBase03(file, rawRows, sha256) {
    gbSetProgress(0, rawRows.length);

    // Base 03 completa tem 3 tipos de linha (confirmado por mapeamento completo
    // do arquivo real, 4.421 linhas): (1) linha PRINCIPAL — uma operação real,
    // identificada por ter "Cli - Nome" E "Op - Código" preenchidos; todos os
    // campos (modalidade, situação, banco, valor financiado) vêm diretamente
    // dela, sem forward-fill; (2) linha SPF EXTRA — continuação da operação
    // principal imediatamente anterior, sem "Cli - Nome" próprio, carregando só
    // "Opcional - Nome"/"Opcional - Valor (R$)"; herda cliente e data da
    // operação-pai (forward-fill), mas NÃO herda modalidade/situação/banco/valor
    // financiado — esses campos permanecem em branco nela, pois pertencem à
    // linha principal; (3) linha DESCARTÁVEL — sobra de pivot table do Excel
    // (ex.: "17/06/2026 Total"), sem Cli-Nome nem Opcional-Nome reconhecível;
    // ignorada por completo.
    //
    // ANTES desta correção, só as linhas SPF Extra eram enviadas ao backend —
    // portal_spf_operations ficava sem nenhuma linha principal (sem modalidade/
    // situação/banco/valor financiado), o que zerava Análise F&I do Grupo e
    // Coparticipados (ambos dependem dessas linhas). Agora TODAS as linhas
    // operacionais (principais + SPF Extra) são enviadas juntas.
    const allRows = [];
    const spfRows = []; // subconjunto (mesmas referências) usado no diagnóstico de sincronismo abaixo
    let discardedTotalRows = 0;
    let lastClientName = '';
    let lastOperationDateParsed = '';
    rawRows.forEach(r => {
      const rawName = gbGetCol(r, ['Cli - Nome']);
      if (rawName) lastClientName = rawName;
      const parsedDate = gbParseExcelDate(gbGetCol(r, ['Op - Data Inclusão', 'Op - Data Contrato']));
      if (parsedDate) lastOperationDateParsed = parsedDate;

      const opcode = String(gbGetCol(r, ['Op - Código'])).trim();
      const isSpfExtraFlag = gbContainsSpfExtra(gbGetCol(r, ['Opcional - Nome'])) && gbAsNumber(gbGetCol(r, ['Opcional - Valor (R$)'])) > 0;

      if (rawName && opcode) {
        allRows.push(gbBuildBase03OperationalRow(r, allRows.length + 1, false));
      } else if (isSpfExtraFlag) {
        const row = gbBuildBase03OperationalRow(r, allRows.length + 1, true);
        if (!row.client_match_key) row.client_match_key = gbNormalize(lastClientName);
        if (!row.operation_date) row.operation_date = lastOperationDateParsed;
        allRows.push(row);
        spfRows.push(row);
      } else {
        discardedTotalRows++;
      }
    });
    const principalRows = allRows.filter(r => !r.is_spf_extra);
    const allLikelyAccepted = allRows.filter(r => r.source_row_number > 0 && r.client_match_key).length;
    const allLikelyRejected = (allRows.length - allLikelyAccepted) + discardedTotalRows;
    const spfLikelyAccepted = spfRows.filter(r => r.source_row_number > 0 && r.client_match_key).length;
    const spfLikelyRejected = spfRows.length - spfLikelyAccepted;

    // ---- Diagnóstico de sincronismo SPF — Base 02 × Base 03 selecionada ----
    // Soma por cliente o valor SPF Extra já extraído do arquivo (mesmas linhas
    // acima, mesmo forward-fill) — não reprocessa nada, só agrega o que já foi
    // lido. Cruza contra os SPF EXTRA 2 reais da Base 02 oficial (nova RPC,
    // somente leitura). Não decide nada sozinho — é só um alerta para o MASTER;
    // a Receita SPF continua vindo exclusivamente da Base 03 em produção,
    // independente do resultado deste diagnóstico.
    const base03ValorPorCliente = {};
    spfRows.forEach(r => {
      if (!r.client_match_key) return;
      base03ValorPorCliente[r.client_match_key] = (base03ValorPorCliente[r.client_match_key] || 0) + (Number(r.optional_value) || 0);
    });
    let sincronismoHtml = '';
    try {
      const base02Spf = await gbRpc('master_operational_list_spf_extra_base02', {}) || [];
      const porMes = {}; // 'AAAA-MM' -> {base02:0, base03:0, valorBase02:0, valorBase03:0, ausentes:[]}
      const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
      base02Spf.forEach(r => {
        const mesKey = (r.operation_date || '').slice(0, 7);
        if (!porMes[mesKey]) porMes[mesKey] = { base02: 0, base03: 0, valorBase02: 0, valorBase03: 0, ausentes: [] };
        const m = porMes[mesKey];
        m.base02++;
        m.valorBase02 += Number(r.financed_or_service_value) || 0;
        const achado = base03ValorPorCliente[gbNormalize(r.client_match_key)];
        if (achado !== undefined) {
          m.base03++;
          m.valorBase03 += achado;
        } else {
          m.ausentes.push(r);
        }
      });
      const totalBase02 = base02Spf.length;
      const totalBase03 = base02Spf.filter(r => base03ValorPorCliente[gbNormalize(r.client_match_key)] !== undefined).length;
      const totalAusentes = totalBase02 - totalBase03;
      const totalValorBase02 = base02Spf.reduce((s, r) => s + (Number(r.financed_or_service_value) || 0), 0);
      const totalValorBase03 = base02Spf.reduce((s, r) => s + (base03ValorPorCliente[gbNormalize(r.client_match_key)] || 0), 0);
      const taxa = totalBase02 ? (totalBase03 / totalBase02 * 100) : 100;

      const linhasCompetencia = Object.keys(porMes).sort().map(mesKey => {
        const m = porMes[mesKey];
        const [ano, mesNum] = mesKey.split('-');
        const label = `${MESES[Number(mesNum) - 1] || mesKey}/${ano}`;
        const taxaMes = m.base02 ? (m.base03 / m.base02 * 100) : 100;
        return `<div class="gbRow"><span>${label}</span><b>${m.base02} Base02 · ${m.base03} Base03 · ${m.base02 - m.base03} ausente(s) · ${taxaMes.toFixed(1)}%</b></div>`;
      }).join('');

      const listaAusentesHtml = totalAusentes ? `<div class="gbMissingList">${
        Object.values(porMes).flatMap(m => m.ausentes).map(r =>
          `<div>${gbFmtDate(r.operation_date)} — ${r.store || '-'} — ${r.client_match_key} <span style="color:var(--muted)">(R$ ${gbFmtNum(r.financed_or_service_value)})</span></div>`
        ).join('')
      }</div>` : '';

      sincronismoHtml = `
        <div class="aggregateRule" style="margin-top:12px">
          <h3>Sincronismo SPF — Base 02 × Base 03 selecionada</h3>
          <div class="gbRow"><span>SPF EXTRA 2 encontrados na Base 02</span><b>${gbFmtNum(totalBase02)}</b></div>
          <div class="gbRow"><span>Correspondentes na Base 03 selecionada</span><b>${gbFmtNum(totalBase03)}</b></div>
          <div class="gbRow"><span>Sem correspondência</span><b>${gbFmtNum(totalAusentes)}</b></div>
          <div class="gbRow"><span>Taxa de correspondência</span><b>${taxa.toFixed(1)}%</b></div>
          <div class="gbRow"><span>Valor Serviço SPF EXTRA 2 — Base 02</span><b>R$ ${gbFmtNum(totalValorBase02.toFixed(2))}</b></div>
          <div class="gbRow"><span>Valor correspondente encontrado — Base 03</span><b>R$ ${gbFmtNum(totalValorBase03.toFixed(2))}</b></div>
          <div class="gbRow"><span>Diferença</span><b>R$ ${gbFmtNum((totalValorBase02 - totalValorBase03).toFixed(2))}</b></div>
          ${linhasCompetencia ? `<p class="note" style="margin-top:8px">Por competência (mês da Data Venda na Base 02):</p>${linhasCompetencia}` : ''}
          ${totalAusentes ? `<p class="note gbWarn" style="margin-top:8px">⚠️ ATENÇÃO — POSSÍVEL DEFASAGEM ENTRE AS BASES: foram identificadas ${totalAusentes} operação(ões) SPF EXTRA 2 na Base 02 que ainda não estão presentes na Base 03 selecionada. Verifique se esta é a versão mais recente da Base 03 antes de confirmar a atualização.</p>${listaAusentesHtml}` : '<p class="note" style="color:#7cd992">✅ Todas as operações SPF EXTRA 2 da Base 02 têm correspondência nesta Base 03.</p>'}
          <p class="note">Este painel é só um alerta de sincronismo — a Receita SPF oficial continua vindo exclusivamente da Base 03, sem exceção.</p>
        </div>`;
    } catch (e) {
      console.error('[Gestão de Bases] Falha ao validar sincronismo SPF:', e);
      sincronismoHtml = '<p class="note gbWarn">⚠️ Não foi possível validar o sincronismo com a Base 02.</p>';
    }

    // Enriquecimento financeiro — um registro por cliente (client_match_key),
    // já resolvido aqui no navegador (o backend casa direto contra a Base 02
    // oficial pela mesma chave, sem depender de sessão nem de source_row_number
    // da Base 02 — ver master_operational_apply_base03).
    const clientIndex = gbBuildBase03ClientIndex(rawRows);
    const financeRows = Object.entries(clientIndex)
      .map(([clientKey, sig]) => ({
        client_match_key: clientKey,
        vehicle_model: '',
        installments: sig.parcelas,
        installment_value: sig.pmt,
        balloon_value: sig.balaoValor,
        tc_devolvida: sig.tcDevolvida,
        plan_codigo_if: sig.codigoIF
      }))
      .filter(r => r.tc_devolvida !== null || r.plan_codigo_if || r.balloon_value !== null || r.installments !== null);

    // Prévia (dry_run): consulta a Base 02 oficial no banco e informa quantos
    // clientes realmente casam, sem gravar nada — a gravação real só ocorre
    // em uma única chamada atômica, ao confirmar (ver onConfirmar abaixo).
    gbSetProgress(0, 1);
    const preview = await gbRpc('master_operational_apply_base03', {
      p_original_filename: file.name,
      p_source_sha256: sha256,
      p_finance_rows: financeRows,
      p_spf_rows: allRows,
      p_dry_run: true
    });
    gbSetProgress(1, 1);

    gbMostrarDiagnostico({
      titulo: 'BASE 03 — COMPLEMENTAR / F&I',
      arquivo: file.name,
      linhasLidas: rawRows.length,
      aceitas: allLikelyAccepted,
      rejeitadas: allLikelyRejected,
      avisos: [],
      okOverride: principalRows.length > 0 || rawRows.length === 0,
      extra: `<div class="gbRow"><span>Enriquecimento financeiro (clientes que serão atualizados na Base 02 oficial)</span><b>${gbFmtNum(preview.finance_rows_matched)}</b></div>
              <div class="gbRow"><span>Linhas operacionais principais</span><b>${gbFmtNum(principalRows.length)}</b></div>
              <div class="gbRow"><span>Linhas SPF Extra (complementares)</span><b>${gbFmtNum(spfRows.length)}</b></div>
              ${discardedTotalRows ? `<div class="gbRow"><span>Linhas descartadas (subtotais/lixo de planilha)</span><b>${gbFmtNum(discardedTotalRows)}</b></div>` : ''}
              <p class="note">A confirmação aplica tudo em uma única operação no banco: ou os dados financeiros e o SPF (principais + complementares) são atualizados juntos, ou nada é alterado.</p>
              ${GB_HOMOLOGATION_MODE ? '<p class="note gbWarn">🧪 MODO HOMOLOGAÇÃO: ao confirmar, nenhuma escrita real ocorrerá — os números acima já vêm de uma consulta real (p_dry_run=true), só a gravação final é simulada.</p>' : ''}
              ${sincronismoHtml}`,
      onConfirmar: async () => {
        // Em homologação, o resultado é montado a partir dos números já
        // comprovados pelo dry_run acima — não inventa dado novo, só não grava.
        // gbRpc também bloquearia a chamada real aqui (defesa em profundidade).
        const result = GB_HOMOLOGATION_MODE
          ? {
              dry_run: false, simulated: true,
              finance_batch_id: preview.finance_batch_id, finance_rows_matched: preview.finance_rows_matched,
              spf_rows_received: allRows.length, spf_accepted: allLikelyAccepted, spf_rejected: allLikelyRejected
            }
          : await gbRpc('master_operational_apply_base03', {
              p_original_filename: file.name,
              p_source_sha256: sha256,
              p_finance_rows: financeRows,
              p_spf_rows: allRows,
              p_dry_run: false
            });
        gbMostrarSucesso('BASE 03 — COMPLEMENTAR / F&I', file.name, result.spf_accepted || 0);
      }
    });
  }

  // ---------------- fluxo COLABORADORES ----------------
  async function gbProcessarColaboradores(file, rawRows, sha256) {
    const mappedAll = rawRows.map(r => gbBuildColaboradorRow(r));
    // O mesmo CPF pode aparecer mais de uma vez no arquivo (ex.: histórico de
    // status — encontrado na validação: "VENDEDOR/REVENDA" e depois "INATIVO/
    // INATIVO" para a mesma pessoa). Um único INSERT ... ON CONFLICT não pode
    // atualizar a mesma linha duas vezes, então mantemos só a última ocorrência
    // de cada CPF válido (linha mais recente no arquivo = estado mais atual).
    const lastByCpf = new Map();
    const semCpfValido = [];
    mappedAll.forEach(r => {
      if (/^[0-9]{11}$/.test(r.cpf)) lastByCpf.set(r.cpf, r);
      else semCpfValido.push(r);
    });
    const duplicados = mappedAll.length - lastByCpf.size - semCpfValido.length;
    const mapped = [...lastByCpf.values(), ...semCpfValido];
    gbSetProgress(0, mapped.length);

    const batchId = await gbRpc('master_operational_begin_import', {
      p_source_type: 'COLABORADORES', p_original_filename: file.name, p_source_sha256: sha256, p_rows_read: mappedAll.length
    });
    const accepted = await gbImportChunked('master_operational_import_sellers', batchId, mapped, gbSetProgress);
    const rejected = mapped.length - accepted;

    gbMostrarDiagnostico({
      titulo: 'COLABORADORES / VENDEDORES',
      arquivo: file.name,
      linhasLidas: mappedAll.length,
      aceitas: accepted,
      rejeitadas: rejected + duplicados,
      avisos: duplicados ? [`${duplicados} CPF(s) apareciam mais de uma vez no arquivo — foi mantida apenas a linha mais recente de cada um.`] : [],
      onConfirmar: async () => {
        await gbRpc('master_operational_finalize_import', {
          p_batch_id: batchId, p_rows_accepted: accepted, p_rows_rejected: rejected,
          p_validation_message: `Gestão de Bases: ${accepted} aceitas, ${rejected} rejeitadas.`
        });
        await gbLoadSellersCache(true); // força recarregar o cadastro atualizado
        const reprocessados = await gbReprocessarPendentesBase02();
        gbMostrarSucesso('COLABORADORES / VENDEDORES', file.name, accepted,
          reprocessados ? `${reprocessados} linha(s) da Base 02 desta sessão foram atualizadas com o vendedor agora encontrado.` : '');
      }
    });
  }

  // Depois de atualizar Colaboradores, tenta resolver de novo (upsert no mesmo
  // batch_id/source_row_number) as linhas da Base 02 desta sessão que ficaram
  // sem loja/CPF por vendedor não cadastrado.
  async function gbReprocessarPendentesBase02() {
    const fb = GB_SESSION.financeBatch;
    if (!fb || !fb.pendentesRaw || !fb.pendentesRaw.length) return 0;
    const sellers = await gbLoadSellersCache();
    const resolvedRows = [];
    const stillMissing = [];
    fb.pendentesRaw.forEach(({ raw, rowNumber }) => {
      const row = gbBuildBase02Row(raw, rowNumber, sellers.byNbs);
      if (row.seller_cpf) {
        const { _diagOk, ...rest } = row;
        resolvedRows.push(rest);
      } else {
        stillMissing.push({ raw, rowNumber });
      }
    });
    if (resolvedRows.length) {
      await gbImportChunked('master_operational_import_finance', fb.batchId, resolvedRows, () => {});
    }
    fb.pendentesRaw = stillMissing;
    GB_SESSION.lastMissingSellers = GB_SESSION.lastMissingSellers.filter(m =>
      stillMissing.some(({ raw }) => gbNormalize(gbGetCol(raw, ['Vendedor'])) === m.nbs)
    );
    return resolvedRows.length;
  }

  function gbMostrarDiagnostico({ titulo, arquivo, linhasLidas, aceitas, rejeitadas, avisos, extra, listaPendente, onConfirmar, okOverride }) {
    const ok = okOverride !== undefined ? okOverride : (aceitas > 0 || linhasLidas === 0);
    const avisosHtml = (avisos && avisos.length)
      ? `<div class="gbWarn">${avisos.map(a => `<div>⚠️ ${a}</div>`).join('')}</div>` : '';
    const listaHtml = (listaPendente && listaPendente.length)
      ? `<div class="gbMissingList">${listaPendente.map(m => `<div>${m.nome} <span style="color:var(--muted)">(${m.nbs})</span></div>`).join('')}</div>
         <button class="secondary" style="margin-top:8px" onclick="gbCloseModal();gbIniciarAtualizacao('COLABORADORES')">ATUALIZAR COLABORADORES</button>`
      : '';
    gbModal(`<h3>${titulo} — VALIDAÇÃO</h3>
      <div class="gbRow"><span>Arquivo</span><b>${arquivo}</b></div>
      <div class="gbRow"><span>Linhas lidas</span><b>${gbFmtNum(linhasLidas)}</b></div>
      <div class="gbRow"><span>Aceitas</span><b>${gbFmtNum(aceitas)}</b></div>
      <div class="gbRow"><span>Rejeitadas</span><b>${gbFmtNum(rejeitadas)}</b></div>
      <div class="gbRow"><span>Status</span><b class="${ok ? 'gbStatusOk' : 'gbStatusBad'}">${ok ? '🟢 PRONTO PARA ATUALIZAÇÃO' : '🔴 ARQUIVO REJEITADO'}</b></div>
      ${listaHtml}
      ${extra || ''}
      ${avisosHtml}
      <p class="note">A base oficial atual continua sendo usada pelas análises até você confirmar.</p>
      <div id="gbDiagMsg" class="adminMsg"></div>
      <div class="adminModalActions">
        <button class="secondary" onclick="gbCancelar()">CANCELAR</button>
        <button ${ok ? '' : 'disabled'} onclick="gbConfirmar()">CONFIRMAR ATUALIZAÇÃO</button>
      </div>`);
    window.__gbOnConfirmar = onConfirmar;
  }
  window.gbCancelar = function () {
    gbCloseModal();
    toastAdmin('Atualização cancelada. A base anterior continua sendo utilizada.', 'warn');
  };
  window.gbConfirmar = async function () {
    const btn = document.querySelector('#gbModalOverlay .adminModalActions button:last-child');
    if (btn) btn.disabled = true;
    const msg = document.getElementById('gbDiagMsg');
    try {
      if (typeof window.__gbOnConfirmar === 'function') await window.__gbOnConfirmar();
    } catch (e) {
      console.error('[Gestão de Bases] Erro ao confirmar:', e);
      if (msg) { msg.textContent = 'Erro ao confirmar: ' + String(e.message || e); msg.className = 'adminMsg err'; }
      if (btn) btn.disabled = false;
    }
  };
  function gbMostrarSucesso(titulo, arquivo, registros, notaExtra) {
    const tituloLinha = GB_HOMOLOGATION_MODE
      ? '<p style="color:#ffb020"><b>🧪 SIMULAÇÃO CONCLUÍDA — nenhuma alteração foi realizada no banco</b></p>'
      : '<p><b>BASE ATUALIZADA COM SUCESSO</b></p>';
    gbModal(`<h3>${GB_HOMOLOGATION_MODE ? '🧪' : '✅'} ${titulo}</h3>
      ${tituloLinha}
      <div class="gbRow"><span>Arquivo</span><b>${arquivo}</b></div>
      <div class="gbRow"><span>Registros</span><b>${gbFmtNum(registros)}</b></div>
      <div class="gbRow"><span>Data/hora</span><b>${gbFmtDateTime(new Date())}</b></div>
      ${notaExtra ? `<p class="note">${notaExtra}</p>` : ''}
      <div class="adminModalActions"><button onclick="gbCloseModal();gbAtualizarCards()">Fechar</button></div>`);
    toastAdmin(GB_HOMOLOGATION_MODE ? 'Simulação concluída — nenhuma alteração foi gravada.' : 'Base atualizada com sucesso.');
  }
  window.gbAtualizarCards = function () { if (typeof renderMasterAdmin === 'function') renderMasterAdmin(); };
})();
