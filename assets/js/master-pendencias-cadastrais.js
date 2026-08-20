(function(){
'use strict';
// Fase 21.5 — Painel Master: Pendências Cadastrais.
// UI de governança sobre portal_cadastro_alertas/portal_cadastro_excecoes
// (Fase 21.2), populados pela reconciliação automática dos importadores
// (Fase 21.3). Fonte de dados EXCLUSIVA: as 7 RPCs MASTER-only já
// homologadas na Fase 21.2 — nunca SELECT direto nas tabelas. Nenhuma RPC
// nova nesta fase; nenhuma alteração nos importadores, em seller_user_id,
// nas funções analíticas (Fase 21.4) ou em portal_sellers.
//
// "Resolver manualmente" só marca o alerta como tratado — NUNCA cria/
// corrige cadastro; essa distinção está no próprio rótulo (Fase 22.5A.1,
// Parte E), nunca deixada implícita. Quando existe uma correção real
// conhecida (hoje: Login NBS), a ação PRINCIPAL do drawer é corrigir o
// cadastro de verdade — "Resolver manualmente" vira secundária.

const PC_TIPOS = {
  NOVO_CADASTRO_NECESSARIO: 'Novo cadastro necessário',
  ATUALIZACAO_CADASTRAL_NECESSARIA: 'Atualização cadastral necessária',
  CORRESPONDENCIA_INDETERMINADA: 'Correspondência indeterminada',
  NBS_DIVERGENTE: 'Login NBS divergente',
  LOJA_DIVERGENTE: 'Loja divergente',
  DEPARTAMENTO_DIVERGENTE: 'Departamento divergente',
  IDENTIFICADOR_DUPLICADO: 'Identificador duplicado',
  USUARIO_INATIVO_COM_PRODUCAO: 'Usuário inativo com produção',
  FATO_SEM_VENDEDOR_ATRIBUIDO: 'Fato sem vendedor atribuído',
  OUTRO: 'Outro'
};
// Explicação padrão de POR QUE o alerta existe, por tipo — a RPC de
// listagem (Fase 21.2) não devolve um texto de motivo pronto para a
// maioria dos tipos (só preenche `motivo` para FATO_SEM_VENDEDOR_ATRIBUIDO);
// este texto é só descritivo do próprio código `tipo` já autorizado a
// aparecer na tela, nunca uma inferência sobre dados não devolvidos.
const PC_TIPO_EXPLICACAO = {
  NOVO_CADASTRO_NECESSARIO: 'Nenhum usuário ativo foi encontrado para este identificador — pode ser necessário criar um novo cadastro.',
  ATUALIZACAO_CADASTRAL_NECESSARIA: 'O identificador corresponde a um usuário cadastrado, mas os dados encontrados na base divergem do cadastro atual.',
  CORRESPONDENCIA_INDETERMINADA: 'Não foi possível determinar com segurança a qual usuário cadastrado este registro pertence.',
  NBS_DIVERGENTE: 'O CPF da operação corresponde a este usuário, mas o Login NBS da base diverge do cadastro atual.',
  LOJA_DIVERGENTE: 'O identificador corresponde a este usuário, mas a loja encontrada na base diverge da loja cadastrada atualmente.',
  DEPARTAMENTO_DIVERGENTE: 'O identificador corresponde a este usuário, mas o departamento encontrado na base diverge do departamento cadastrado atualmente.',
  IDENTIFICADOR_DUPLICADO: 'Este identificador foi encontrado associado a mais de um usuário cadastrado.',
  USUARIO_INATIVO_COM_PRODUCAO: 'O identificador corresponde a um usuário atualmente inativo, mas há produção registrada em seu nome.',
  FATO_SEM_VENDEDOR_ATRIBUIDO: null, // usa f.motivo, já vem pronto do backend (Fase 21.3)
  OUTRO: null
};
const PC_ORIGENS = {
  SALES_CURRENT: 'Base 01 (Atual)',
  SALES_HISTORY: 'Base 01 (Histórico)',
  FINANCE_CURRENT: 'Base 02 (Atual)',
  FINANCE_HISTORY: 'Base 02 (Histórico)'
};
const PC_SEVERIDADES = {
  URGENTE: { emoji: '🔴', label: 'Urgente', status: 'bad' },
  ATENCAO: { emoji: '🟡', label: 'Atenção', status: 'warn' },
  INFORMATIVO: { emoji: '⚪', label: 'Informativo', status: 'neutral' }
};
const PC_STATUS_LABEL = { PENDENTE: 'Pendente', RESOLVIDO: 'Resolvido', IGNORADO: 'Ignorado', EXCLUIDO: 'Excluído' };
const PC_STATUS_CLASSE = { PENDENTE: 'warn', RESOLVIDO: 'ok', IGNORADO: 'neutral', EXCLUIDO: 'bad' };
const PC_MOTIVOS_IGNORAR = [
  ['FROTA', 'Frota'], ['REVENDA', 'Revenda'], ['ATACADO', 'Atacado'],
  ['COLABORADOR_DESLIGADO', 'Colaborador desligado'], ['FORA_DO_ESCOPO', 'Fora do escopo'],
  ['TESTE', 'Teste'], ['OUTRO', 'Outro']
];
const PC_TABS = [
  ['TODOS', 'Todos', {}],
  ['PENDENTES', 'Pendentes', { status: 'PENDENTE' }],
  ['URGENTES', 'Urgentes', { status: 'PENDENTE', severidade: 'URGENTE' }],
  ['IGNORADOS', 'Ignorados', { status: 'IGNORADO' }],
  ['RESOLVIDOS', 'Resolvidos', { status: 'RESOLVIDO' }],
  ['EXCLUIDOS', 'Excluídos', { status: 'EXCLUIDO' }]
];

function pcIsLocalHost(){
  const h=((typeof location!=='undefined'&&location.hostname)||'').toLowerCase();
  return h==='localhost'||h==='127.0.0.1';
}
const PC_LOCAL = pcIsLocalHost();

let PC_STATE = {
  aba: 'alertas',            // 'alertas' | 'excecoes'
  tab: 'PENDENTES',
  filtros: { tipo: '', origem: '', busca: '' },
  linhas: [], total: 0, loading: false, erro: null, _carregouUmaVez: false,
  usuariosCache: null,
  mockAtivo: false, mockPerf: false,
  excecoes: { linhas: [], loading: false, erro: null, filtroTipo: '', filtroAtivo: true, _carregouUmaVez: false }
};

// ---------------- datas ----------------
function pcFmtDataHoraBR(iso){
  if(!iso) return '—';
  try{ return new Date(iso).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'}); }catch(e){ return '—'; }
}

// ---------------- mock local (SOMENTE localhost — mesmo padrão da Fase 18.4) ----------------
// Nunca persistido, nunca via query string de produção. Serve só para
// homologar layout/filtros/drawer/ações enquanto não há alertas reais
// (Parte AM: nenhuma ação real é testada em alerta real durante homologação).
function pcGerarMockLinha(idx, overrides){
  const tipos = Object.keys(PC_TIPOS);
  const tipo = overrides.tipo || tipos[idx % tipos.length];
  const sev = overrides.severidade || (idx % 5 === 0 ? 'URGENTE' : idx % 3 === 0 ? 'ATENCAO' : 'INFORMATIVO');
  const origem = overrides.origem_base || (idx % 2 === 0 ? 'SALES_CURRENT' : 'FINANCE_CURRENT');
  const status = overrides.status || 'PENDENTE';
  const hoje = new Date();
  const ultima = new Date(hoje.getTime() - (idx % 20) * 3600 * 1000);
  const primeira = new Date(ultima.getTime() - (1 + idx % 15) * 24 * 3600 * 1000);
  return Object.assign({
    id: `MOCK-${idx}`,
    tipo, severidade: sev, status, origem_base: origem,
    import_batch_id: null,
    identificador_tipo: idx % 4 === 0 ? null : (idx % 2 === 0 ? 'CPF' : 'NBS'),
    identificador_mascarado: idx % 4 === 0 ? null : (idx % 2 === 0 ? '***.***-' + String(1000 + idx).slice(-4) : '****' + String(100000 + idx).slice(-2)),
    nome_encontrado: `TESTE MOCK ${idx}`,
    login_nbs_encontrado: idx % 2 !== 0 ? String(100000 + idx) : null,
    loja_encontrada: ['ABC', 'ALPHAVILLE', 'ANALIA FRANCO', 'BARRA FUNDA'][idx % 4],
    departamento_encontrado: idx % 2 === 0 ? 'NOVOS' : 'SEMINOVOS',
    usuario_candidato_id: idx % 3 === 0 ? null : `MOCK-USER-${idx % 7}`,
    nome_usuario_candidato: idx % 3 === 0 ? null : `USUÁRIO CANDIDATO ${idx % 7}`,
    motivo: tipo === 'FATO_SEM_VENDEDOR_ATRIBUIDO' ? `${1 + idx % 9} linha(s) sem identificador de vendedor no arquivo importado.` : null,
    primeira_ocorrencia_em: primeira.toISOString(),
    ultima_ocorrencia_em: ultima.toISOString(),
    quantidade_ocorrencias: 1 + (idx % 12),
    motivo_acao: status !== 'PENDENTE' ? 'OUTRO: tratado durante testes de homologação' : null,
    resolvido_em: status === 'RESOLVIDO' ? ultima.toISOString() : null,
    ignorado_em: status === 'IGNORADO' ? ultima.toISOString() : null,
    excluido_em: status === 'EXCLUIDO' ? ultima.toISOString() : null,
    criado_em: primeira.toISOString()
  }, overrides);
}
function pcGerarMock(){
  // 7 cenários nomeados explicitamente pedidos, sempre presentes:
  const curados = [
    pcGerarMockLinha(0, { tipo: 'NOVO_CADASTRO_NECESSARIO', severidade: 'URGENTE', status: 'PENDENTE', nome_encontrado: 'FULANO TESTE NOVO', usuario_candidato_id: null, nome_usuario_candidato: null }),
    pcGerarMockLinha(1, { tipo: 'NBS_DIVERGENTE', severidade: 'ATENCAO', status: 'PENDENTE', nome_encontrado: 'CICLANO TESTE NBS' }),
    pcGerarMockLinha(2, { tipo: 'USUARIO_INATIVO_COM_PRODUCAO', severidade: 'URGENTE', status: 'PENDENTE', nome_encontrado: 'BELTRANO TESTE INATIVO' }),
    pcGerarMockLinha(3, { tipo: 'OUTRO', severidade: 'INFORMATIVO', status: 'IGNORADO', nome_encontrado: 'FROTA TESTE IGNORADA', motivo_acao: 'FROTA: veículo de frota interna' }),
    pcGerarMockLinha(4, { tipo: 'ATUALIZACAO_CADASTRAL_NECESSARIA', severidade: 'ATENCAO', status: 'RESOLVIDO', nome_encontrado: 'SICRANO TESTE RESOLVIDO' }),
    pcGerarMockLinha(5, { tipo: 'CORRESPONDENCIA_INDETERMINADA', severidade: 'INFORMATIVO', status: 'EXCLUIDO', nome_encontrado: 'REGISTRO TESTE EXCLUIDO' }),
    pcGerarMockLinha(6, { tipo: 'FATO_SEM_VENDEDOR_ATRIBUIDO', severidade: 'INFORMATIVO', status: 'PENDENTE', identificador_tipo: null, identificador_mascarado: null, nome_encontrado: null, login_nbs_encontrado: null })
  ];
  if(!PC_STATE.mockPerf) return curados;
  const extra = [];
  for(let i = 7; i < 1000; i++) extra.push(pcGerarMockLinha(i, {}));
  return curados.concat(extra);
}
function pcGerarMockExcecoes(){
  return [
    { id: 'MOCK-EXC-1', identificador_tipo: 'CPF', identificador_mascarado: '***.***-1234', motivo: 'FROTA', ativo: true, observacao: 'Veículos de frota interna', ocorrencias_suprimidas: 12, ultima_ocorrencia_suprimida_em: new Date().toISOString(), criado_por_nome: 'MASTER TESTE', criado_em: new Date(Date.now() - 5 * 86400000).toISOString(), revogado_por_nome: null, revogado_em: null },
    { id: 'MOCK-EXC-2', identificador_tipo: 'NBS', identificador_mascarado: '****56', motivo: 'REVENDA', ativo: false, observacao: null, ocorrencias_suprimidas: 3, ultima_ocorrencia_suprimida_em: new Date(Date.now() - 20 * 86400000).toISOString(), criado_por_nome: 'MASTER TESTE', criado_em: new Date(Date.now() - 40 * 86400000).toISOString(), revogado_por_nome: 'MASTER TESTE', revogado_em: new Date(Date.now() - 2 * 86400000).toISOString() }
  ];
}
// Store mock PERSISTENTE em memória (nunca localStorage/cookie) — as ações
// (resolver/ignorar/excluir/revogar/criar) mutam estes mesmos objetos, para
// que a lista recarregada após uma ação reflita o novo estado. Sem isso, uma
// ação simulada mostraria um toast de sucesso mas a linha continuaria
// PENDENTE no próximo carregamento (dado sintético regenerado do zero).
let PC_MOCK_ALERTAS = null;
let PC_MOCK_EXCECOES = null;
function pcMockAlertasStore(){
  if(!PC_MOCK_ALERTAS) PC_MOCK_ALERTAS = pcGerarMock();
  return PC_MOCK_ALERTAS;
}
function pcMockExcecoesStore(){
  if(!PC_MOCK_EXCECOES) PC_MOCK_EXCECOES = pcGerarMockExcecoes();
  return PC_MOCK_EXCECOES;
}
function pcMockResetStores(){ PC_MOCK_ALERTAS = null; PC_MOCK_EXCECOES = null; }
function pcMockMascarar(v){
  const s = String(v || '').replace(/\D/g, '') || String(v || '');
  if(s.length <= 4) return '*'.repeat(s.length);
  return '*'.repeat(s.length - 4) + s.slice(-4);
}
// Simula o comportamento das 4 RPCs de ação (Fase 21.2) sobre o store mock —
// mesma máquina de estados (só PENDENTE->outro; nunca reabre), só para
// homologar a UI sem qualquer chamada real ao Supabase.
function pcMockAplicarAcao(nome, args){
  const agora = new Date().toISOString();
  if(nome === 'master_cadastro_alerta_resolver'){
    const l = pcMockAlertasStore().find(x => x.id === args.p_alerta_id);
    if(!l) return { ok: false, codigo: 'ALERTA_NAO_ENCONTRADO' };
    if(l.status === 'RESOLVIDO') return { ok: true, codigo: 'JA_RESOLVIDO', alerta_id: l.id };
    if(l.status === 'EXCLUIDO') return { ok: false, codigo: 'STATUS_INCOMPATIVEL', status_atual: l.status };
    l.status = 'RESOLVIDO'; l.resolvido_em = agora; l.motivo_acao = args.p_motivo || null;
    return { ok: true, codigo: 'RESOLVIDO', alerta_id: l.id };
  }
  if(nome === 'master_cadastro_alerta_ignorar'){
    const l = pcMockAlertasStore().find(x => x.id === args.p_alerta_id);
    if(!l) return { ok: false, codigo: 'ALERTA_NAO_ENCONTRADO' };
    if(l.status === 'IGNORADO') return { ok: true, codigo: 'JA_IGNORADO', alerta_id: l.id };
    if(l.status !== 'PENDENTE') return { ok: false, codigo: 'STATUS_INCOMPATIVEL', status_atual: l.status };
    l.status = 'IGNORADO'; l.ignorado_em = agora;
    l.motivo_acao = String(args.p_motivo || '').toUpperCase() + (args.p_observacao ? ': ' + args.p_observacao : '');
    if(args.p_criar_excecao){
      if(!l.identificador_tipo || !l.identificador_mascarado){
        return { ok: true, codigo: 'IGNORADO_SEM_EXCECAO', alerta_id: l.id, excecao_erro: 'IDENTIFICADOR_NAO_ELEGIVEL_PARA_EXCECAO' };
      }
      const exc = { id: 'MOCK-EXC-' + Math.random().toString(36).slice(2, 8), identificador_tipo: l.identificador_tipo, identificador_mascarado: l.identificador_mascarado, motivo: String(args.p_motivo || '').toUpperCase(), ativo: true, observacao: args.p_observacao || null, ocorrencias_suprimidas: 0, ultima_ocorrencia_suprimida_em: null, criado_por_nome: 'MASTER TESTE', criado_em: agora, revogado_por_nome: null, revogado_em: null };
      pcMockExcecoesStore().unshift(exc);
      return { ok: true, codigo: 'IGNORADO_COM_EXCECAO', alerta_id: l.id, excecao_id: exc.id };
    }
    return { ok: true, codigo: 'IGNORADO', alerta_id: l.id };
  }
  if(nome === 'master_cadastro_alerta_excluir'){
    const l = pcMockAlertasStore().find(x => x.id === args.p_alerta_id);
    if(!l) return { ok: false, codigo: 'ALERTA_NAO_ENCONTRADO' };
    if(l.status === 'EXCLUIDO') return { ok: true, codigo: 'JA_EXCLUIDO', alerta_id: l.id };
    l.status = 'EXCLUIDO'; l.excluido_em = agora; l.motivo_acao = args.p_motivo || null;
    return { ok: true, codigo: 'EXCLUIDO', alerta_id: l.id };
  }
  if(nome === 'master_cadastro_alerta_corrigir_login_nbs'){
    const l = pcMockAlertasStore().find(x => x.id === args.p_alerta_id);
    if(!l) return { ok: false, codigo: 'ALERTA_NAO_ENCONTRADO' };
    if(l.tipo !== 'NBS_DIVERGENTE') return { ok: false, codigo: 'TIPO_INCOMPATIVEL' };
    if(l.status !== 'PENDENTE') return { ok: false, codigo: 'STATUS_INCOMPATIVEL', status_atual: l.status };
    if(!l.usuario_candidato_id) return { ok: false, codigo: 'SEM_CANDIDATO' };
    const novo = String(args.p_novo_login_nbs || '').toUpperCase().trim();
    if(!novo) return { ok: false, codigo: 'VALOR_OBRIGATORIO' };
    // fixture de conflito determinística pro TESTE AG (Parte AG): digitar
    // exatamente CONFLITO simula um segundo usuário já dono deste NBS.
    if(novo === 'CONFLITO') return { ok: false, codigo: 'NBS_VINCULADO_OUTRO_USUARIO' };
    const candidato = (PC_STATE.usuariosCache || []).find(u => u.id === l.usuario_candidato_id);
    if(candidato) candidato.login_nbs = novo;
    let resolvidos = 0;
    if(String(l.login_nbs_encontrado || '').toUpperCase().trim() === novo){
      l.status = 'RESOLVIDO'; l.resolvido_em = agora; l.motivo_acao = 'Login NBS corrigido automaticamente para ' + novo;
      resolvidos++;
    }
    pcMockAlertasStore().filter(x => x.id !== l.id && x.status === 'PENDENTE' && x.tipo === 'NBS_DIVERGENTE' && x.usuario_candidato_id === l.usuario_candidato_id && String(x.login_nbs_encontrado || '').toUpperCase().trim() === novo)
      .forEach(x => { x.status = 'RESOLVIDO'; x.resolvido_em = agora; x.motivo_acao = 'Login NBS corrigido automaticamente para ' + novo; resolvidos++; });
    return { ok: true, codigo: 'CORRIGIDO', usuario_id: l.usuario_candidato_id, novo_login_nbs: novo, alertas_resolvidos: resolvidos };
  }
  if(nome === 'master_cadastro_excecao_revogar'){
    const e = pcMockExcecoesStore().find(x => x.id === args.p_excecao_id);
    if(!e) return { ok: false, codigo: 'EXCECAO_NAO_ENCONTRADA' };
    if(!e.ativo) return { ok: true, codigo: 'JA_REVOGADA', excecao_id: e.id };
    e.ativo = false; e.revogado_em = agora; e.revogado_por_nome = 'MASTER TESTE';
    return { ok: true, codigo: 'REVOGADA', excecao_id: e.id };
  }
  if(nome === 'master_cadastro_excecao_criar'){
    const tipo = String(args.p_identificador_tipo || '').toUpperCase();
    if(!['CPF', 'NBS'].includes(tipo)) return { ok: false, codigo: 'IDENTIFICADOR_TIPO_INVALIDO' };
    if(!String(args.p_identificador_valor || '').trim()) return { ok: false, codigo: 'IDENTIFICADOR_VALOR_INVALIDO' };
    const exc = { id: 'MOCK-EXC-' + Math.random().toString(36).slice(2, 8), identificador_tipo: tipo, identificador_mascarado: pcMockMascarar(args.p_identificador_valor), motivo: String(args.p_motivo || '').toUpperCase(), ativo: true, observacao: args.p_observacao || null, ocorrencias_suprimidas: 0, ultima_ocorrencia_suprimida_em: null, criado_por_nome: 'MASTER TESTE', criado_em: agora, revogado_por_nome: null, revogado_em: null };
    pcMockExcecoesStore().unshift(exc);
    return { ok: true, codigo: 'CRIADA', excecao_id: exc.id };
  }
  return { ok: true, codigo: 'MOCK_OK' };
}

// ---------------- chamadas (RPC real ou mock local) ----------------
async function pcFetchAlertas(params){
  if(PC_LOCAL && PC_STATE.mockAtivo){
    let linhas = pcMockAlertasStore();
    if(params.status) linhas = linhas.filter(l => l.status === params.status);
    if(params.severidade) linhas = linhas.filter(l => l.severidade === params.severidade);
    if(params.tipo) linhas = linhas.filter(l => l.tipo === params.tipo);
    if(params.origem) linhas = linhas.filter(l => l.origem_base === params.origem);
    return { rows: linhas, total: linhas.length };
  }
  if(typeof supabaseClient === 'undefined' || !supabaseClient) throw new Error('Supabase não inicializado.');
  const { data, error } = await supabaseClient.rpc('master_cadastro_alertas_listar', {
    p_status: params.status || null, p_severidade: params.severidade || null,
    p_tipo: params.tipo || null, p_origem_base: params.origem || null,
    p_limit: 500, p_offset: 0
  });
  if(error) throw error;
  return { rows: data?.rows || [], total: data?.total || 0 };
}
async function pcFetchExcecoes(){
  const f = PC_STATE.excecoes;
  if(PC_LOCAL && PC_STATE.mockAtivo){
    let linhas = pcMockExcecoesStore();
    if(f.filtroTipo) linhas = linhas.filter(l => l.identificador_tipo === f.filtroTipo);
    if(f.filtroAtivo !== null) linhas = linhas.filter(l => l.ativo === f.filtroAtivo);
    return linhas;
  }
  if(typeof supabaseClient === 'undefined' || !supabaseClient) throw new Error('Supabase não inicializado.');
  const { data, error } = await supabaseClient.rpc('master_cadastro_excecoes_listar', {
    p_ativo: f.filtroAtivo, p_identificador_tipo: f.filtroTipo || null, p_limit: 500, p_offset: 0
  });
  if(error) throw error;
  return data?.rows || [];
}
async function pcChamarAcao(nome, args){
  if(PC_LOCAL && PC_STATE.mockAtivo){
    console.warn(`[Pendências Cadastrais] MOCK LOCAL — ação simulada: ${nome}`, args);
    return pcMockAplicarAcao(nome, args);
  }
  const { data, error } = await supabaseClient.rpc(nome, args);
  if(error) throw error;
  return data;
}

// ---------------- carregamento ----------------
function pcParamsAtuais(){
  const tabDef = (PC_TABS.find(t => t[0] === PC_STATE.tab) || PC_TABS[0])[2];
  return {
    status: tabDef.status || null,
    severidade: tabDef.severidade || null,
    tipo: PC_STATE.filtros.tipo || null,
    origem: PC_STATE.filtros.origem || null
  };
}
async function pcCarregar(){
  PC_STATE.loading = true;
  PC_STATE.erro = null;
  try{
    const resp = await pcFetchAlertas(pcParamsAtuais());
    PC_STATE.linhas = resp.rows;
    PC_STATE.total = resp.total;
  }catch(e){
    console.error('[Pendências Cadastrais] Falha ao carregar:', e);
    PC_STATE.erro = e;
  }finally{
    PC_STATE.loading = false;
  }
}
async function pcCarregarUsuariosCache(){
  if(PC_STATE.usuariosCache) return PC_STATE.usuariosCache;
  if(PC_LOCAL && PC_STATE.mockAtivo){
    PC_STATE.usuariosCache = [0,1,2,3,4,5,6].map(i => ({ id: `MOCK-USER-${i}`, nome: `USUÁRIO CANDIDATO ${i}`, perfil: 'VENDEDOR', loja: ['ABC','ALPHAVILLE','ANALIA FRANCO','BARRA FUNDA'][i % 4], login_nbs: i === 1 ? 'TESTEOLD' : null }));
    return PC_STATE.usuariosCache;
  }
  PC_STATE.usuariosCache = (typeof carregarUsuariosSupabase === 'function') ? await carregarUsuariosSupabase() : [];
  return PC_STATE.usuariosCache;
}

// ---------------- filtro client-side de busca (Parte F — nunca requery por tecla) ----------------
function pcFiltrarBusca(linhas){
  const q = (PC_STATE.filtros.busca || '').trim();
  if(!q) return linhas;
  const norm = typeof window.norm === 'function' ? window.norm : (s => String(s || '').toUpperCase());
  const qn = norm(q);
  return linhas.filter(l => {
    const hay = norm([l.nome_encontrado, l.login_nbs_encontrado, l.loja_encontrada, l.departamento_encontrado, l.nome_usuario_candidato, l.identificador_mascarado].filter(Boolean).join(' '));
    return hay.includes(qn);
  });
}

// ---------------- render: lista de alertas ----------------
function pcSevBadgeHtml(sev){
  const info = PC_SEVERIDADES[sev] || PC_SEVERIDADES.INFORMATIVO;
  return `<span class="adminStatus ${info.status}">${info.emoji} ${info.label.toUpperCase()}</span>`;
}
function pcStatusBadgeHtml(status){
  return `<span class="adminStatus ${PC_STATUS_CLASSE[status] || 'neutral'}">${PC_STATUS_LABEL[status] || status || '—'}</span>`;
}
function pcOrigemLabel(origem){ return PC_ORIGENS[origem] || origem || '—'; }
function pcTipoLabel(tipo){ return PC_TIPOS[tipo] || tipo || '—'; }

function pcAcaoBtnsHtml(l){
  if(l.status !== 'PENDENTE') return '';
  // Fase 22.5A.2 (Incidente: ação assistida só existia dentro do drawer —
  // a lista/card, que é o que o Master vê primeiro, mostrava só "Resolver
  // manualmente"). pcAcaoRecomendadaHtml é pura (só lê `l`), então dá pra
  // reusar aqui sem duplicar a lógica por tipo — envolvida num <div> com
  // stopPropagation próprio porque essas strings de botão foram escritas
  // pro contexto do drawer (sem parar propagação), e a LINHA inteira tem
  // onclick="pcAbrirDrawer(...)" por baixo.
  const recomendacao = pcAcaoRecomendadaHtml(l);
  const primariaHtml = recomendacao.botoes
    ? `<div style="display:flex;gap:6px;flex-wrap:wrap" onclick="event.stopPropagation()">${recomendacao.botoes}</div>`
    : '';
  return `<div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;align-items:center">
    ${primariaHtml}
    <button class="adminActionBtn" onclick="event.stopPropagation();pcAbrirModalResolver('${l.id}')">Resolver manualmente</button>
    <button class="adminActionBtn warn" onclick="event.stopPropagation();pcAbrirModalIgnorar('${l.id}')">Ignorar</button>
    <button class="adminActionBtn danger" onclick="event.stopPropagation();pcAbrirModalExcluir('${l.id}')">Excluir</button>
  </div>`;
}
function pcRowHtml(l){
  const pessoa = l.nome_encontrado || l.identificador_mascarado || '(sem identificação)';
  return `<div class="pcRow" onclick="pcAbrirDrawer('${l.id}')">
    <div data-label="Severidade">${pcSevBadgeHtml(l.severidade)}</div>
    <div data-label="Pessoa / Identificador">
      <b>${escapeOperationalHtml(pessoa)}</b>
      ${l.login_nbs_encontrado ? `<div class="adminListSub">NBS: ${escapeOperationalHtml(l.login_nbs_encontrado)}</div>` : ''}
    </div>
    <div data-label="Origem">${pcOrigemLabel(l.origem_base)}</div>
    <div data-label="Motivo">${escapeOperationalHtml(pcTipoLabel(l.tipo))}</div>
    <div data-label="Ocorrências" class="pcNum">${l.quantidade_ocorrencias}</div>
    <div data-label="Última ocorrência">${pcFmtDataHoraBR(l.ultima_ocorrencia_em)}</div>
    <div data-label="Status">${pcStatusBadgeHtml(l.status)}</div>
    <div data-label="Ação" class="pcColAcao">
      ${l.status === 'PENDENTE' ? pcAcaoBtnsHtml(l) : `<button class="adminActionBtn wine" onclick="event.stopPropagation();pcAbrirDrawer('${l.id}')">Ver detalhes</button>`}
    </div>
  </div>`;
}
function pcResultadosAlertasHtml(){
  const filtradas = pcFiltrarBusca(PC_STATE.linhas);
  const header = `<div class="pcRow pcRowHead">
    <div>Severidade</div><div>Pessoa / Identificador</div><div>Origem</div><div>Motivo</div>
    <div class="pcNum">Ocorr.</div><div>Última ocorrência</div><div>Status</div><div></div>
  </div>`;
  const rows = filtradas.map(pcRowHtml).join('');
  return `<div class="pcList">${header}${rows || '<p class="note" style="padding:16px">Nenhuma pendência cadastral encontrada para os filtros selecionados.</p>'}</div>`;
}
function pcRenderResultados(){
  const area = document.getElementById('pcResultsArea');
  if(!area) return;
  area.innerHTML = pcResultadosAlertasHtml();
}
// Cards de resumo (Parte AK): calculados sobre o dataset já carregado do
// filtro/aba atual — não é um resumo global independente de filtro,
// documentado na própria UI para não parecer um KPI absoluto. Extraído
// numa função própria (Fase 22.5A-UX) pra poder ser repintado sozinho,
// sem re-renderizar o painel inteiro, depois de Resolver/Ignorar/Excluir.
function pcSummaryCardsHtml(){
  const totaisPorStatus = { PENDENTE: 0, URGENTE_PENDENTE: 0, IGNORADO: 0, RESOLVIDO: 0 };
  PC_STATE.linhas.forEach(l => {
    if(l.status === 'PENDENTE'){ totaisPorStatus.PENDENTE++; if(l.severidade === 'URGENTE') totaisPorStatus.URGENTE_PENDENTE++; }
    if(l.status === 'IGNORADO') totaisPorStatus.IGNORADO++;
    if(l.status === 'RESOLVIDO') totaisPorStatus.RESOLVIDO++;
  });
  return `<div class="adminCard"><div class="k">Pendentes</div><div class="v">${totaisPorStatus.PENDENTE}</div></div>
    <div class="adminCard"><div class="k">Urgentes (pendentes)</div><div class="v">${totaisPorStatus.URGENTE_PENDENTE}</div></div>
    <div class="adminCard"><div class="k">Ignorados</div><div class="v">${totaisPorStatus.IGNORADO}</div></div>
    <div class="adminCard"><div class="k">Resolvidos</div><div class="v">${totaisPorStatus.RESOLVIDO}</div></div>`;
}

// ---------------- resolução assistida (Fase 22.5A-UX, Problema 3) ----------------
// Parte AH — quantas outras ocorrências PENDENTE (dentro do que já está
// carregado na tela) compartilham o mesmo identificador. Só informativo —
// a propagação real ao ignorar roda no backend sobre o valor normalizado,
// não sobre esta contagem client-side (que usa o mascarado, disponível
// aqui). Nunca conta por nome.
function pcOcorrenciasRelacionadas(l){
  if(!l.identificador_tipo || !l.identificador_mascarado) return 0;
  return PC_STATE.linhas.filter(x =>
    x.id !== l.id && x.status === 'PENDENTE' &&
    x.identificador_tipo === l.identificador_tipo &&
    x.identificador_mascarado === l.identificador_mascarado
  ).length;
}
// Partes O-W — cada tipo tem uma orientação e uma ação recomendada
// diferentes. Nunca decide sozinho (LOJA/DEPARTAMENTO temporal — Parte
// R/S), nunca escolhe entre candidatos (Parte U), nunca finge uma solução
// determinística quando não há uma (Parte V).
function pcAcaoRecomendadaHtml(l){
  const usuarioId = l.usuario_candidato_id;
  const verFichaBtn = (foco) => `<button class="adminActionBtn good" onclick="pcFecharDrawer();abrirMasterUsuarioDeep('${usuarioId}',{foco:${foco ? `'${foco}'` : 'null'}})">${foco ? 'Abrir ficha e ir ao campo' : 'Ver usuário'}</button>`;
  const semCandidato = { texto: 'Não há um cadastro candidato determinado para esta pendência. Revise manualmente em Painel Master → Usuários.', botoes: '' };
  switch(l.tipo){
    case 'NOVO_CADASTRO_NECESSARIO': {
      const prefill = { nome: l.nome_encontrado || '', loja: l.loja_encontrada || '', nbs: l.login_nbs_encontrado || '' };
      return {
        texto: 'Nenhum usuário ativo corresponde a este identificador. Cadastre ou convide o usuário — nome, loja e Login NBS encontrados na base já vêm preenchidos, mas confira antes de enviar o convite.',
        botoes: `<button class="adminActionBtn good" onclick='pcAcionarConvite(this)' data-prefill="${escapeOperationalHtml(JSON.stringify(prefill))}">Cadastrar / convidar usuário</button>`
      };
    }
    case 'NBS_DIVERGENTE':
      // Fase 22.5A.1 (Parte G) — correção real, não só navegação: abre um
      // modal dedicado que altera usuarios.login_nbs pela RPC MASTER-only,
      // com o valor da base como sugestão pré-preenchida (Parte I) e
      // revalidação antes de marcar resolvido (Parte N).
      return usuarioId ? {
        texto: 'O CPF corresponde a este usuário, mas o Login NBS do cadastro diverge do encontrado na base. Confirme o valor correto para corrigir o cadastro — a resolução do alerta só acontece depois que a correção for aplicada com sucesso.',
        botoes: `<button class="adminActionBtn good" onclick="pcAbrirModalCorrigirNbs('${l.id}')">Corrigir Login NBS</button>`
      } : semCandidato;
    case 'LOJA_DIVERGENTE':
      return usuarioId ? {
        texto: 'Existe uma arquitetura temporal de loja (Mudança de Loja — Vendedores). Se a divergência é sobre a loja ATUAL do vendedor, edite o cadastro. Se é sobre uma venda de um período em que ele estava alocado em outra loja, registre/corrija a mudança de loja daquele período — nunca sobrescreva o histórico pelo status atual.',
        botoes: `${verFichaBtn('loja')}<button class="adminActionBtn wine" onclick="pcFecharDrawer();setMasterTab('mudancas_loja')">Mudança de Loja — Vendedores</button>`
      } : semCandidato;
    case 'DEPARTAMENTO_DIVERGENTE':
      return usuarioId ? {
        texto: 'Mesma lógica temporal do departamento: se o departamento ATUAL do vendedor mudou, edite o STATUS do cadastro. Se a divergência é sobre um período específico, registre/corrija em Mudança de Loja — Vendedores → Editar departamentos — nunca sobrescreva o histórico pelo status atual.',
        botoes: `${verFichaBtn('departamento_status')}<button class="adminActionBtn wine" onclick="pcFecharDrawer();setMasterTab('mudancas_loja')">Mudança de Loja — Vendedores</button>`
      } : semCandidato;
    case 'USUARIO_INATIVO_COM_PRODUCAO':
      return usuarioId ? { texto: 'Existe produção registrada em nome deste cadastro, porém o usuário está inativo. Avalie o histórico antes de decidir — reativação não é automática.', botoes: verFichaBtn(null) } : semCandidato;
    case 'IDENTIFICADOR_DUPLICADO':
      // Parte W — rótulo explícito "Revisar cadastros", nunca escolhe entre candidatos.
      return {
        texto: 'Este identificador foi encontrado associado a mais de um cadastro. Esta tela não escolhe automaticamente qual está certo — revise os cadastros correspondentes manualmente.',
        botoes: usuarioId ? `<button class="adminActionBtn wine" onclick="pcFecharDrawer();abrirMasterUsuarioDeep('${usuarioId}',{foco:null})">Revisar cadastros</button>` : `<button class="adminActionBtn wine" onclick="pcFecharDrawer();setMasterTab('usuarios')">Revisar cadastros</button>`
      };
    case 'CORRESPONDENCIA_INDETERMINADA':
      // Parte X — rótulo explícito "Revisar", sem alteração automática.
      return {
        texto: 'Não foi possível determinar com segurança a qual cadastro este registro pertence. Revise as evidências acima manualmente — esta tela não tenta adivinhar.',
        botoes: usuarioId ? `<button class="adminActionBtn wine" onclick="pcFecharDrawer();abrirMasterUsuarioDeep('${usuarioId}',{foco:null})">Revisar</button>` : `<button class="adminActionBtn wine" onclick="pcFecharDrawer();setMasterTab('usuarios')">Revisar em Usuários</button>`
      };
    case 'ATUALIZACAO_CADASTRAL_NECESSARIA':
      return usuarioId ? { texto: 'O identificador corresponde a este cadastro, mas algum dado encontrado na base diverge do cadastro atual — compare os valores acima com a ficha do usuário para identificar qual campo mudou.', botoes: verFichaBtn(null) } : semCandidato;
    case 'FATO_SEM_VENDEDOR_ATRIBUIDO':
      return { texto: l.motivo || 'Um ou mais registros importados não trouxeram identificador de vendedor. Não há cadastro para direcionar — este alerta é só informativo.', botoes: '' };
    default:
      return { texto: 'Revise manualmente — este tipo de alerta não tem uma ação automática associada.', botoes: '' };
  }
}
window.pcAcionarConvite = function(btnEl){
  let prefill = {};
  try{ prefill = JSON.parse(btnEl.getAttribute('data-prefill') || '{}'); }catch(e){}
  pcFecharDrawer();
  if(typeof abrirConvidarUsuarioModal === 'function') abrirConvidarUsuarioModal(prefill);
};

// ---------------- drawer de detalhes ----------------
async function pcMontarDrawerHtml(l){
  let candidato = null;
  let candidatoHtml = '';
  if(l.usuario_candidato_id){
    const usuarios = await pcCarregarUsuariosCache();
    candidato = (usuarios || []).find(x => x.id === l.usuario_candidato_id) || null;
    candidatoHtml = `
      <h4>O que o cadastro possui hoje</h4>
      <dl class="fichaList">
        <dt>Nome</dt><dd>${escapeOperationalHtml(candidato?.nome || l.nome_usuario_candidato || '—')}</dd>
        <dt>Perfil</dt><dd>${escapeOperationalHtml(candidato?.perfil || '—')}</dd>
        <dt>Loja</dt><dd>${escapeOperationalHtml(candidato?.loja || '—')}</dd>
        <dt>Login NBS</dt><dd>${escapeOperationalHtml(candidato?.login_nbs || '(vazio)')}</dd>
      </dl>`;
  }
  const explicacao = PC_TIPO_EXPLICACAO[l.tipo] || l.motivo || 'Situação cadastral que requer atenção do Master.';
  const historico = [];
  if(l.status === 'IGNORADO') historico.push(`<dt>Ignorado em</dt><dd>${pcFmtDataHoraBR(l.ignorado_em)}</dd>`);
  if(l.status === 'RESOLVIDO') historico.push(`<dt>Resolvido em</dt><dd>${pcFmtDataHoraBR(l.resolvido_em)}</dd>`);
  if(l.status === 'EXCLUIDO') historico.push(`<dt>Excluído em</dt><dd>${pcFmtDataHoraBR(l.excluido_em)}</dd>`);
  if(l.motivo_acao) historico.push(`<dt>Motivo da ação</dt><dd>${escapeOperationalHtml(l.motivo_acao)}</dd>`);
  const historicoHtml = historico.length ? `<h4>Histórico da decisão</h4><dl class="fichaList">${historico.join('')}</dl>` : '';
  const ocorrenciasRelacionadas = pcOcorrenciasRelacionadas(l);
  const ocorrenciasHtml = ocorrenciasRelacionadas > 0
    ? `<p class="note gbWarn">${ocorrenciasRelacionadas} outro(s) alerta(s) pendente(s) carregado(s) nesta lista está(ão) relacionado(s) a este mesmo identificador. Ignorar com "não alertar novamente" trata todos de uma vez.</p>` : '';
  const recomendacao = l.status === 'PENDENTE' ? pcAcaoRecomendadaHtml(l) : null;

  return `
    <div class="userDrawerHeader">
      <button class="userDrawerClose" type="button" onclick="pcFecharDrawer()" aria-label="Fechar">×</button>
      <div class="userDrawerNome">${escapeOperationalHtml(l.nome_encontrado || l.identificador_mascarado || '(sem identificação)')}</div>
      <div class="userMeta">${pcSevBadgeHtml(l.severidade)} · ${escapeOperationalHtml(pcTipoLabel(l.tipo))} · ${pcStatusBadgeHtml(l.status)}</div>
    </div>
    <div class="userDrawerBody">
      <h4>Problema</h4>
      <p class="note">${escapeOperationalHtml(explicacao)}</p>
      ${ocorrenciasHtml}

      <h4>O que a base informou</h4>
      <dl class="fichaList">
        <dt>Nome</dt><dd>${escapeOperationalHtml(l.nome_encontrado || '—')}</dd>
        <dt>Login NBS</dt><dd>${escapeOperationalHtml(l.login_nbs_encontrado || '—')}</dd>
        <dt>Identificador</dt><dd>${escapeOperationalHtml((l.identificador_tipo ? l.identificador_tipo + ': ' : '') + (l.identificador_mascarado || '—'))}</dd>
        <dt>Loja</dt><dd>${escapeOperationalHtml(l.loja_encontrada || '—')}</dd>
        <dt>Departamento</dt><dd>${escapeOperationalHtml(l.departamento_encontrado || '—')}</dd>
        <dt>Origem</dt><dd>${escapeOperationalHtml(pcOrigemLabel(l.origem_base))}</dd>
        <dt>Primeira ocorrência</dt><dd>${pcFmtDataHoraBR(l.primeira_ocorrencia_em)}</dd>
        <dt>Última ocorrência</dt><dd>${pcFmtDataHoraBR(l.ultima_ocorrencia_em)}</dd>
        <dt>Quantidade de ocorrências</dt><dd>${l.quantidade_ocorrencias}</dd>
      </dl>
      ${candidatoHtml}
      ${recomendacao ? `<h4>O que precisa ser feito</h4><p class="note">${escapeOperationalHtml(recomendacao.texto)}</p>${recomendacao.botoes ? `<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">${recomendacao.botoes}</div>` : ''}` : ''}
      ${historicoHtml}
      ${l.status === 'PENDENTE' ? `<div style="margin-top:20px;display:flex;gap:8px;flex-wrap:wrap">
        <button class="adminActionBtn warn" onclick="pcAbrirModalIgnorar('${l.id}')">Ignorar</button>
        <button class="adminActionBtn danger" onclick="pcAbrirModalExcluir('${l.id}')">Excluir</button>
        <button class="adminActionBtn" onclick="pcAbrirModalResolver('${l.id}')">Marcar como resolvido manualmente</button>
      </div>` : ''}
    </div>`;
}
window.pcAbrirDrawer = async function(alertaId){
  const l = PC_STATE.linhas.find(x => x.id === alertaId);
  if(!l || typeof abrirDrawerGenerico !== 'function') return;
  abrirDrawerGenerico('<p class="note">Carregando...</p>');
  abrirDrawerGenerico(await pcMontarDrawerHtml(l));
};
window.pcFecharDrawer = function(){
  if(typeof fecharDrawerGenerico === 'function') fecharDrawerGenerico();
};

// ---------------- ações destrutivas — SEMPRE via modal de confirmação (Parte X) ----------------
// Fase 22.5A-UX (Problema 2) — chamar renderMasterAdmin() aqui reconstruía
// o #masterAdmin inteiro; o innerHTML intermediário ("Carregando...") que
// renderMasterAdminContent usa encolhe o documento por um instante, e o
// navegador ajusta (clampa) o scroll pra essa altura menor — quando o
// conteúdo real volta, o scroll não é restaurado sozinho, e o Master
// "volta ao topo" mesmo tratando um item no meio de uma lista longa.
// Correção: nunca mais re-renderiza o painel inteiro por causa de uma
// ação em um alerta — só recarrega os dados e repinta os cards + a lista
// de resultados (pcRenderResultados já só toca #pcResultsArea), com
// window.scrollY como rede de segurança (Parte L) caso alguma reflow
// residual ainda desloque a página.
async function pcRecarregarEAtualizar(){
  const scrollY = window.scrollY;
  await pcCarregar();
  const cardsEl = document.getElementById('pcSummaryCards');
  if(cardsEl) cardsEl.innerHTML = pcSummaryCardsHtml();
  pcRenderResultados();
  requestAnimationFrame(() => window.scrollTo(0, scrollY));
}
// Fase 22.5A.1 (Problema/PARTE G-N) — correção assistida real para
// NBS_DIVERGENTE: mostra atual × encontrado na base, sugere o valor da
// base (Parte I) mas exige confirmação explícita do Master (Parte J),
// chama a RPC MASTER-only que valida unicidade/conflito no backend
// (Parte AM — nunca UPDATE client-side) e só marca o alerta RESOLVIDO
// depois que a correção realmente aconteceu (Parte N).
window.pcAbrirModalCorrigirNbs = async function(alertaId){
  const l = PC_STATE.linhas.find(x => x.id === alertaId);
  if(!l) return;
  const usuarios = await pcCarregarUsuariosCache();
  const candidato = (usuarios || []).find(x => x.id === l.usuario_candidato_id);
  const nomeUsuario = candidato?.nome || l.nome_usuario_candidato || '—';
  const atual = candidato?.login_nbs || '(vazio)';
  const encontrado = l.login_nbs_encontrado || '';
  openAdminModal({
    title: 'Corrigir Login NBS',
    text: `Usuário: <b>${escapeOperationalHtml(nomeUsuario)}</b><br>
      Login NBS no cadastro: <b>${escapeOperationalHtml(atual)}</b><br>
      Login NBS encontrado na base: <b>${escapeOperationalHtml(encontrado || '—')}</b>`,
    fieldHtml: `
      <div><label>Novo Login NBS</label><input id="pcNovoNbs" value="${escapeOperationalHtml(encontrado)}" placeholder="Confirme ou ajuste o valor"></div>
      <div style="margin-top:8px"><label>Observação (opcional)</label><input id="pcNovoNbsObs" placeholder="Detalhe adicional"></div>`,
    confirmText: 'Confirmar alteração do Login NBS',
    onConfirm: async () => {
      const novo = document.getElementById('pcNovoNbs')?.value?.trim();
      if(!novo){ setAdminModalMsg('Informe um valor válido.', true); return; }
      const observacao = document.getElementById('pcNovoNbsObs')?.value || null;
      try{
        const resp = await pcChamarAcao('master_cadastro_alerta_corrigir_login_nbs', {
          p_alerta_id: alertaId, p_novo_login_nbs: novo, p_observacao: observacao
        });
        if(resp?.ok === false){
          // Parte Q — falha de conflito: cadastro inalterado, alerta continua PENDENTE.
          const mensagens = {
            NBS_VINCULADO_OUTRO_USUARIO: 'Este Login NBS já está vinculado a outro usuário ativo.',
            NBS_CPF_DIVERGENTE: 'Este Login NBS está vinculado, na base de vendedores, a um CPF diferente do deste usuário.',
            VALOR_OBRIGATORIO: 'Informe um valor válido.',
            SEM_CANDIDATO: 'Não há um cadastro candidato para corrigir.',
            TIPO_INCOMPATIVEL: 'Este alerta não é do tipo Login NBS divergente.',
            STATUS_INCOMPATIVEL: 'Este alerta não está mais pendente.'
          };
          setAdminModalMsg(mensagens[resp.codigo] || ('Não foi possível corrigir: ' + (resp.codigo || 'erro desconhecido')), true);
          return;
        }
        closeAdminModal();
        pcFecharDrawer();
        const extras = Number(resp?.alertas_resolvidos) || 0;
        let msg = 'Login NBS corrigido.';
        if(extras === 1) msg += ' Alerta resolvido.';
        else if(extras > 1) msg += ` ${extras} alertas relacionados resolvidos automaticamente.`;
        toastAdmin(msg);
        await pcRecarregarEAtualizar();
      }catch(e){ setAdminModalMsg('Erro ao corrigir: ' + (e.message || e), true); }
    }
  });
};
window.pcAbrirModalResolver = function(alertaId){
  openAdminModal({
    title: 'Marcar como resolvido manualmente',
    text: 'Esta ação <b>não altera o cadastro</b>. Use somente se o problema já tiver sido corrigido por outro meio — confirme apenas se a situação já foi tratada fora deste alerta.',
    fieldHtml: `<div><label>Observação (opcional)</label><input id="pcResolverMotivo" placeholder="Ex.: cadastro corrigido manualmente em DD/MM"></div>`,
    confirmText: 'Confirmar resolução',
    onConfirm: async () => {
      try{
        const motivo = document.getElementById('pcResolverMotivo')?.value || null;
        const resp = await pcChamarAcao('master_cadastro_alerta_resolver', { p_alerta_id: alertaId, p_motivo: motivo });
        if(resp?.ok === false){ setAdminModalMsg('Não foi possível resolver: ' + (resp.codigo || 'erro desconhecido'), true); return; }
        closeAdminModal();
        pcFecharDrawer();
        toastAdmin('Pendência marcada como resolvida.');
        await pcRecarregarEAtualizar();
      }catch(e){ setAdminModalMsg('Erro ao resolver: ' + (e.message || e), true); }
    }
  });
};
window.pcAbrirModalIgnorar = function(alertaId){
  const l = PC_STATE.linhas.find(x => x.id === alertaId);
  const elegivelExcecao = !!(l && l.identificador_tipo && l.identificador_mascarado);
  const motivoOpts = PC_MOTIVOS_IGNORAR.map(([v, lbl]) => `<option value="${v}">${lbl}</option>`).join('');
  openAdminModal({
    title: 'Ignorar pendência',
    text: 'O alerta deixará de aparecer na fila de pendentes.',
    fieldHtml: `
      <div><label>Motivo</label><br><select id="pcIgnorarMotivo"><option value="">Selecione...</option>${motivoOpts}</select></div>
      <div style="margin-top:8px"><label>Observação (opcional)</label><input id="pcIgnorarObs" placeholder="Detalhe adicional"></div>
      ${elegivelExcecao ? `
      <div style="margin-top:10px"><label style="display:flex;gap:8px;align-items:center;color:#fff;font-size:13px;text-transform:none;letter-spacing:0">
        <input id="pcIgnorarExcecao" type="checkbox" style="min-width:0;width:auto"> Não alertar novamente para este identificador
      </label></div>
      <p class="note" style="margin-top:6px">Novas ocorrências com este CPF/Login NBS serão suprimidas enquanto a exceção estiver ativa.</p>` : ''}
    `,
    confirmText: 'Ignorar',
    onConfirm: async () => {
      const motivo = document.getElementById('pcIgnorarMotivo')?.value || '';
      if(!motivo){ setAdminModalMsg('Selecione um motivo.', true); return; }
      const observacao = document.getElementById('pcIgnorarObs')?.value || null;
      const criarExcecao = !!document.getElementById('pcIgnorarExcecao')?.checked;
      try{
        const resp = await pcChamarAcao('master_cadastro_alerta_ignorar', {
          p_alerta_id: alertaId, p_motivo: motivo, p_observacao: observacao, p_criar_excecao: criarExcecao
        });
        if(resp?.ok === false){ setAdminModalMsg('Não foi possível ignorar: ' + (resp.codigo || 'erro desconhecido'), true); return; }
        closeAdminModal();
        pcFecharDrawer();
        // Fase 22.5A-UX (Parte F) — o Master precisa ver de imediato quantas
        // outras pendências do mesmo identificador também foram tratadas.
        const propagados = Number(resp?.propagados) || 0;
        let msg = 'Pendência ignorada.';
        if(resp?.codigo === 'IGNORADO_COM_EXCECAO') msg += ' Exceção criada.';
        if(propagados > 0) msg += ` Mais ${propagados} pendência(s) do mesmo identificador também ${propagados === 1 ? 'foi ignorada' : 'foram ignoradas'}.`;
        toastAdmin(msg);
        await pcRecarregarEAtualizar();
      }catch(e){ setAdminModalMsg('Erro ao ignorar: ' + (e.message || e), true); }
    }
  });
};
window.pcAbrirModalExcluir = function(alertaId){
  openAdminModal({
    title: 'Excluir pendência',
    text: 'Este alerta será removido da fila operacional, mas permanecerá registrado no histórico administrativo.',
    fieldHtml: `<div><label>Motivo</label><input id="pcExcluirMotivo" placeholder="Ex.: registro duplicado"></div>`,
    confirmText: 'Excluir', danger: true,
    onConfirm: async () => {
      const motivo = document.getElementById('pcExcluirMotivo')?.value || '';
      if(!motivo.trim()){ setAdminModalMsg('Informe o motivo.', true); return; }
      try{
        const resp = await pcChamarAcao('master_cadastro_alerta_excluir', { p_alerta_id: alertaId, p_motivo: motivo });
        if(resp?.ok === false){ setAdminModalMsg('Não foi possível excluir: ' + (resp.codigo || 'erro desconhecido'), true); return; }
        closeAdminModal();
        pcFecharDrawer();
        toastAdmin('Pendência excluída.');
        await pcRecarregarEAtualizar();
      }catch(e){ setAdminModalMsg('Erro ao excluir: ' + (e.message || e), true); }
    }
  });
};

// ---------------- ações de filtro/UI ----------------
window.pcSetTab = function(tab){
  PC_STATE.tab = tab;
  pcCarregar().then(() => { if(typeof renderMasterAdmin === 'function') renderMasterAdmin(); });
};
window.pcSetFiltroSelect = function(campo, valor){
  PC_STATE.filtros[campo] = valor;
  pcCarregar().then(() => { if(typeof renderMasterAdmin === 'function') renderMasterAdmin(); });
};
let PC_BUSCA_DEBOUNCE = null;
window.pcSetBusca = function(valor){
  PC_STATE.filtros.busca = valor;
  clearTimeout(PC_BUSCA_DEBOUNCE);
  PC_BUSCA_DEBOUNCE = setTimeout(pcRenderResultados, 200);
};
window.pcSetAba = function(aba){
  PC_STATE.aba = aba;
  if(typeof renderMasterAdmin === 'function') renderMasterAdmin();
};
window.pcToggleMock = function(){
  if(!PC_LOCAL) return;
  PC_STATE.mockAtivo = !PC_STATE.mockAtivo;
  PC_STATE.usuariosCache = null;
  PC_STATE.excecoes._carregouUmaVez = false;
  pcMockResetStores();
  pcCarregar().then(() => { if(typeof renderMasterAdmin === 'function') renderMasterAdmin(); });
};
window.pcTogglePerf = function(){
  if(!PC_LOCAL) return;
  PC_STATE.mockPerf = !PC_STATE.mockPerf;
  PC_MOCK_ALERTAS = null; // recalcula o store com/sem os 993 registros extras
  pcCarregar().then(() => { if(typeof renderMasterAdmin === 'function') renderMasterAdmin(); });
};
window.pcRetry = function(){
  PC_STATE._carregouUmaVez = false;
  PC_STATE.erro = null;
  if(typeof renderMasterAdmin === 'function') renderMasterAdmin();
};

// ---------------- exceções ----------------
window.pcAbrirModalRevogarExcecao = function(excecaoId){
  openAdminModal({
    title: 'Revogar exceção',
    text: 'Novas ocorrências voltarão a gerar alertas.',
    confirmText: 'Revogar', danger: true,
    onConfirm: async () => {
      try{
        const resp = await pcChamarAcao('master_cadastro_excecao_revogar', { p_excecao_id: excecaoId });
        if(resp?.ok === false){ setAdminModalMsg('Não foi possível revogar: ' + (resp.codigo || 'erro desconhecido'), true); return; }
        closeAdminModal();
        toastAdmin('Exceção revogada.');
        PC_STATE.excecoes._carregouUmaVez = false;
        if(typeof renderMasterAdmin === 'function') renderMasterAdmin();
      }catch(e){ setAdminModalMsg('Erro ao revogar: ' + (e.message || e), true); }
    }
  });
};
window.pcSetExcecoesFiltro = function(campo, valor){
  PC_STATE.excecoes[campo] = valor;
  PC_STATE.excecoes._carregouUmaVez = false;
  if(typeof renderMasterAdmin === 'function') renderMasterAdmin();
};
window.pcSalvarExcecaoManual = async function(){
  const tipo = document.getElementById('pcExcTipo')?.value || '';
  const valor = document.getElementById('pcExcValor')?.value || '';
  const motivo = document.getElementById('pcExcMotivo')?.value || '';
  const observacao = document.getElementById('pcExcObs')?.value || null;
  if(!tipo || !valor.trim() || !motivo){ adminMsg('Preencha tipo, identificador e motivo.', true); return; }
  try{
    const resp = await pcChamarAcao('master_cadastro_excecao_criar', {
      p_identificador_tipo: tipo, p_identificador_valor: valor, p_motivo: motivo, p_observacao: observacao
    });
    if(resp?.ok === false){ adminMsg('Não foi possível criar a exceção: ' + (resp.codigo || 'erro desconhecido'), true); return; }
    const propagados = Number(resp?.propagados) || 0;
    toastAdmin('Exceção criada.' + (propagados > 0 ? ` ${propagados} pendência(s) do mesmo identificador ${propagados === 1 ? 'foi ignorada' : 'foram ignoradas'}.` : ''));
    ['pcExcValor', 'pcExcObs'].forEach(id => { const el = document.getElementById(id); if(el) el.value = ''; });
    PC_STATE.excecoes._carregouUmaVez = false;
    if(typeof renderMasterAdmin === 'function') renderMasterAdmin();
  }catch(e){ adminMsg('Erro ao criar exceção: ' + (e.message || e), true); }
};
function pcExcecaoRowHtml(e){
  const statusBadge = e.ativo ? '<span class="adminStatus ok">ATIVA</span>' : '<span class="adminStatus neutral">REVOGADA</span>';
  return `<div class="adminListRow pcExcRow">
    <div class="adminListMain"><b>${escapeOperationalHtml(e.identificador_tipo)}: ${escapeOperationalHtml(e.identificador_mascarado || '—')}</b>
      <span class="adminListSub">${escapeOperationalHtml(e.motivo || '')}${e.observacao ? ' — ' + escapeOperationalHtml(e.observacao) : ''}</span></div>
    <div class="adminListCol">Criada por: <b>${escapeOperationalHtml(e.criado_por_nome || '—')}</b><span class="adminListSub">${pcFmtDataHoraBR(e.criado_em)}</span></div>
    <div class="adminListCol">Ocorrências suprimidas: <b>${e.ocorrencias_suprimidas || 0}</b><span class="adminListSub">Última: ${pcFmtDataHoraBR(e.ultima_ocorrencia_suprimida_em)}</span></div>
    <div class="adminListCol">${statusBadge}</div>
    <div class="adminListActions">${e.ativo ? `<button class="adminActionBtn danger" onclick="pcAbrirModalRevogarExcecao('${e.id}')">Revogar exceção</button>` : ''}</div>
  </div>`;
}
async function pcRenderExcecoesTab(){
  const st = PC_STATE.excecoes;
  if(!st._carregouUmaVez){
    st.loading = true; st.erro = null;
    try{ st.linhas = await pcFetchExcecoes(); }
    catch(e){ st.erro = e; }
    finally{ st.loading = false; st._carregouUmaVez = true; }
  }
  const filtroTipoSel = `<select onchange="pcSetExcecoesFiltro('filtroTipo',this.value)">
    <option value="">TODOS</option>
    <option value="CPF" ${st.filtroTipo === 'CPF' ? 'selected' : ''}>CPF</option>
    <option value="NBS" ${st.filtroTipo === 'NBS' ? 'selected' : ''}>NBS</option>
  </select>`;
  const filtroAtivoSel = `<select onchange="pcSetExcecoesFiltro('filtroAtivo', this.value==='true')">
    <option value="true" ${st.filtroAtivo === true ? 'selected' : ''}>Ativas</option>
    <option value="false" ${st.filtroAtivo === false ? 'selected' : ''}>Revogadas</option>
  </select>`;
  let listaHtml;
  if(st.loading) listaHtml = '<p class="note">Carregando exceções...</p>';
  else if(st.erro) listaHtml = `<p class="note" style="color:#ff6b61">Não foi possível carregar as exceções.</p>`;
  else listaHtml = `<div class="adminListWrap">${st.linhas.map(pcExcecaoRowHtml).join('') || '<p class="note" style="padding:16px">Nenhuma exceção cadastrada.</p>'}</div>`;

  return `
    <p class="note">Exceções suprimem novas ocorrências de alertas para um CPF ou Login NBS específico (ex.: frota, revenda). Identificador forte apenas — nunca por nome.</p>
    <div class="adminToolbar">
      <div><label>Tipo</label><br>${filtroTipoSel}</div>
      <div><label>Status</label><br>${filtroAtivoSel}</div>
    </div>
    ${listaHtml}
    <h3 style="margin-top:24px">Criar exceção manual</h3>
    <p class="note">Use para cadastrar previamente identificadores que nunca devem gerar alerta (ex.: frota, revenda), antes mesmo de uma nova importação.</p>
    <div id="adminMsg" class="adminMsg"></div>
    <div class="ausenciaAdminGrid">
      <div><label>Tipo</label><br><select id="pcExcTipo"><option value="">Selecione...</option><option value="CPF">CPF</option><option value="NBS">NBS</option></select></div>
      <div><label>Identificador</label><input id="pcExcValor" placeholder="CPF ou Login NBS"></div>
      <div><label>Motivo</label><br><select id="pcExcMotivo"><option value="">Selecione...</option>${PC_MOTIVOS_IGNORAR.map(([v, lbl]) => `<option value="${v}">${lbl}</option>`).join('')}</select></div>
      <div style="grid-column:span 2"><label>Observação (opcional)</label><input id="pcExcObs" placeholder="Detalhe adicional"></div>
    </div>
    <button onclick="pcSalvarExcecaoManual()">Criar exceção</button>`;
}

// ---------------- render principal da aba ----------------
async function pcRenderTab(){
  if(PC_STATE.aba === 'excecoes'){
    const abasHtml = `<div class="revisaoFiltros">
      <button class="${PC_STATE.aba === 'alertas' ? '' : ''}" onclick="pcSetAba('alertas')">Alertas</button>
      <button class="active" onclick="pcSetAba('excecoes')">Exceções</button>
    </div>`;
    return `<h2>Pendências Cadastrais</h2>${abasHtml}${await pcRenderExcecoesTab()}`;
  }

  if(!PC_STATE._carregouUmaVez){
    PC_STATE._carregouUmaVez = true;
    await pcCarregar();
  }
  const abasHtml = `<div class="revisaoFiltros">
    <button class="active" onclick="pcSetAba('alertas')">Alertas</button>
    <button onclick="pcSetAba('excecoes')">Exceções</button>
  </div>`;

  if(PC_STATE.loading){
    return `<h2>Pendências Cadastrais</h2>${abasHtml}<p class="note">Carregando pendências...</p>`;
  }
  if(PC_STATE.erro){
    return `<h2>Pendências Cadastrais</h2>${abasHtml}
      <p class="note" style="color:#ff6b61">Não foi possível carregar as pendências cadastrais.</p>
      <button onclick="pcRetry()">Tentar novamente</button>`;
  }

  const mockBanner = (PC_LOCAL && PC_STATE.mockAtivo)
    ? `<p class="note gbWarn">🧪 MOCK LOCAL ATIVO — dados sintéticos, nada foi gravado no Supabase. Ações simulam apenas o estado local.</p>` : '';
  const mockBtn = PC_LOCAL
    ? `<button class="secondary" onclick="pcToggleMock()">${PC_STATE.mockAtivo ? 'Desligar dados de teste' : '🧪 Usar dados de teste (somente localhost)'}</button>` : '';
  const perfBtn = (PC_LOCAL && PC_STATE.mockAtivo)
    ? `<button class="secondary" onclick="pcTogglePerf()">${PC_STATE.mockPerf ? 'Voltar a 7 exemplos' : 'Gerar 1000 alertas (teste de performance)'}</button>` : '';

  const tabsHtml = PC_TABS.map(([id, label]) => `<button class="${PC_STATE.tab === id ? 'active' : ''}" onclick="pcSetTab('${id}')">${label}</button>`).join('');
  const tipoOpts = Object.entries(PC_TIPOS).map(([v, lbl]) => `<option value="${v}" ${PC_STATE.filtros.tipo === v ? 'selected' : ''}>${lbl}</option>`).join('');
  const origemOpts = Object.entries(PC_ORIGENS).map(([v, lbl]) => `<option value="${v}" ${PC_STATE.filtros.origem === v ? 'selected' : ''}>${lbl}</option>`).join('');

  return `<h2>Pendências Cadastrais</h2>
    <p class="note">Governança dos alertas gerados automaticamente pela reconciliação de vendedores das Bases 01/02. Nenhum dado financeiro ou de cliente é exibido aqui.</p>
    ${abasHtml}
    ${mockBanner}
    <div class="adminGrid" id="pcSummaryCards">${pcSummaryCardsHtml()}</div>
    <div class="adminToolbar" style="align-items:center">
      <div style="display:flex;gap:8px;flex-wrap:wrap">${mockBtn}${perfBtn}</div>
    </div>
    <div class="revisaoFiltros">${tabsHtml}</div>
    <div class="adminToolbar">
      <div><label>Tipo</label><br><select onchange="pcSetFiltroSelect('tipo',this.value)"><option value="">TODOS</option>${tipoOpts}</select></div>
      <div><label>Origem</label><br><select onchange="pcSetFiltroSelect('origem',this.value)"><option value="">TODOS</option>${origemOpts}</select></div>
      <div><label>Pesquisar...</label><br><input class="adminSearch" oninput="pcSetBusca(this.value)" value="${escapeOperationalHtml(PC_STATE.filtros.busca)}" placeholder="Nome, NBS, loja, departamento ou candidato"></div>
    </div>
    <div id="pcResultsArea">${pcResultadosAlertasHtml()}</div>`;
}
window.renderPendenciasCadastraisTab = pcRenderTab;

// Contagem para o badge da aba no menu do Painel Master — só
// PENDENTE + URGENTE (nunca ignorado/excluído/resolvido). Chamada pelo
// próprio portal-app.js a cada render do painel, independente da aba ativa.
window.pcContarUrgentesPendentes = async function(){
  try{
    if(PC_LOCAL && PC_STATE.mockAtivo){
      return pcMockAlertasStore().filter(l => l.status === 'PENDENTE' && l.severidade === 'URGENTE').length;
    }
    if(typeof supabaseClient === 'undefined' || !supabaseClient) return 0;
    const { data, error } = await supabaseClient.rpc('master_cadastro_alertas_listar', {
      p_status: 'PENDENTE', p_severidade: 'URGENTE', p_limit: 1, p_offset: 0
    });
    if(error) throw error;
    return data?.total || 0;
  }catch(e){ return 0; }
};
})();
