(function(){
'use strict';
// Fase 18.4 — Painel Master: Utilização dos Simuladores.
// Dashboard de ADOÇÃO/USO (sessões, tempo ativo, simulações realizadas) —
// nunca conteúdo de simulação (sem cliente, chassi, placa, valores financeiros).
// Fonte única: RPC master_simulator_usage_data() (Fase 18.1), MASTER-only
// também no servidor (a função levanta 42501 para qualquer outro perfil —
// a aba não é a única barreira). Nenhuma RPC nova nesta fase.
//
// Fase 18.5 — a RPC passou a devolver telemetry_enabled/telemetry_started_at
// (estado oficial da coleta). O banner e o atalho "Desde o início" usam
// esse estado diretamente — nunca mais inferem "coleta não iniciada" pela
// ausência de linhas (zero sessões no período não é o mesmo que telemetria
// desligada).

const UDS_MODULOS = [
  { id: 'simuladorCompleto', label: 'Simulador de Novos' },
  { id: 'simuladorSeminovos', label: 'Simulador de Seminovos' }
];
const UDS_LOJAS = ['ABC', 'ALPHAVILLE', 'ANALIA FRANCO', 'BARRA FUNDA', 'BANDEIRANTES', 'EUROPA', 'GASTAO', 'NACOES'];
const UDS_DEPARTAMENTOS = ['NOVOS', 'SEMINOVOS', 'NOVOS/SEMINOVOS'];
const UDS_PERFIS = ['VENDEDOR', 'GERENTE', 'ANALISTA', 'DIRETOR NOVOS', 'DIRETOR SEMINOVOS', 'MASTER'];

// Marco "desde o início" — usado SOMENTE como limite inferior de fallback
// antes da primeira resposta da RPC nesta sessão do navegador (que sempre
// devolve telemetry_started_at, a data zero oficial real — Fase 18.5).
// Depois da primeira resposta, UDS_STATE.telemetryStartedAt é a fonte de
// verdade; esta constante nunca mais é usada na mesma sessão.
const UDS_INICIO_TUDO_ISO = '2020-01-01T00:00:00-03:00';

function udsIsLocalHost() {
  const h = ((typeof location !== 'undefined' && location.hostname) || '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1';
}
const UDS_LOCAL = udsIsLocalHost();

// ---------------- estado ----------------
let UDS_STATE = {
  linhas: [],            // dataset do período filtrado atualmente (já vindo da RPC)
  linhasLifetime: null,  // dataset "desde o início" — carregado sob demanda (banner + Nunca Utilizou)
  usuariosCache: null,   // reaproveita master_admin_security_data() já usado em Usuários (sem RPC nova)
  telemetryEnabled: null,     // null = ainda não sabemos (nenhuma resposta da RPC ainda); Fase 18.5
  telemetryStartedAt: null,   // ISO string ou null — data zero oficial, vinda da RPC (Fase 18.5)
  loading: false,
  erro: null,
  filtros: { preset: '30d', dtIni: '', dtFim: '', loja: '', departamento: '', modulo: '', perfil: '', busca: '' },
  ordenacao: 'last_use_desc',
  mockAtivo: false,
  nuncaUtilizouAberto: false,
  nuncaUtilizouCache: null
};

// ---------------- utilidades de data/hora (banco UTC, UI America/Sao_Paulo) ----------------
function udsHojeSP() {
  // America/Sao_Paulo é UTC-3 o ano todo desde 2019 (sem horário de verão).
  const now = new Date();
  const spMs = now.getTime() - 3 * 3600 * 1000;
  return new Date(spMs).toISOString().slice(0, 10);
}
function udsSomarDias(dataYmd, dias) {
  const d = new Date(dataYmd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}
function udsInicioMes(dataYmd) { return dataYmd.slice(0, 7) + '-01'; }
function udsMesAnterior(dataYmd) {
  const [y, m] = dataYmd.split('-').map(Number);
  const ym = m === 1 ? [y - 1, 12] : [y, m - 1];
  return `${ym[0]}-${String(ym[1]).padStart(2, '0')}-01`;
}
function udsFimMesAnterior(dataYmd) {
  const inicioEsteMes = udsInicioMes(dataYmd);
  return udsSomarDias(inicioEsteMes, -1);
}
function udsIsoInicioDia(ymd) { return `${ymd}T00:00:00-03:00`; }
function udsIsoFimDia(ymd) { return `${ymd}T23:59:59.999-03:00`; }
function udsFmtDataHoraBR(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }); } catch (e) { return '—'; }
}
function udsFmtDataBR(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }); } catch (e) { return '—'; }
}

// Data zero efetiva para "desde o início" (Parte L): usa o instante oficial
// já conhecido (telemetryStartedAt, vindo da RPC) sempre que disponível; só
// recorre ao placeholder amplo antes da primeira resposta desta sessão.
function udsDataZeroEfetivaIso() {
  return UDS_STATE.telemetryStartedAt || UDS_INICIO_TUDO_ISO;
}
function udsDataZeroEfetivaYmd() {
  return udsDataZeroEfetivaIso().slice(0, 10);
}

// ---------------- presets de período (Parte F) ----------------
function udsAplicarPreset(preset) {
  const hoje = udsHojeSP();
  let dtIni = hoje, dtFim = hoje;
  if (preset === 'hoje') { dtIni = hoje; dtFim = hoje; }
  else if (preset === '7d') { dtIni = udsSomarDias(hoje, -6); dtFim = hoje; }
  else if (preset === '30d') { dtIni = udsSomarDias(hoje, -29); dtFim = hoje; }
  else if (preset === 'mesAtual') { dtIni = udsInicioMes(hoje); dtFim = hoje; }
  else if (preset === 'mesAnterior') { dtIni = udsMesAnterior(hoje); dtFim = udsFimMesAnterior(hoje); }
  else if (preset === 'desdeInicio') { dtIni = udsDataZeroEfetivaYmd(); dtFim = hoje; }
  UDS_STATE.filtros.preset = preset;
  UDS_STATE.filtros.dtIni = dtIni;
  UDS_STATE.filtros.dtFim = dtFim;
}

// ---------------- formatação de tempo (Parte Q/R — nunca segundos crus, nunca NaN) ----------------
function udsFmtDuracao(totalSegundos) {
  const s = Math.max(0, Math.round(Number(totalSegundos) || 0));
  if (s === 0) return '0min';
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  if (h > 0) return m > 0 ? `${h}h ${String(m).padStart(2, '0')}min` : `${h}h`;
  return `${m}min`;
}
function udsFmtDuracaoMedia(totalSegundos, sessoes) {
  if (!sessoes) return '—';
  return udsFmtDuracao(Number(totalSegundos || 0) / sessoes);
}

// ---------------- dados sintéticos (SOMENTE localhost — Parte AL/AN) ----------------
// Mock em memória, nunca persistido (sem localStorage/cookie), guard estrito
// de hostname. Serve só para homologar layout/filtros/drawer enquanto a
// flag real permanece FALSE. Nomes fictícios, nunca nomes reais.
function udsGerarMock() {
  const nomes = [
    'ANA TESTE SILVA', 'BRUNO TESTE COSTA', 'CARLA TESTE LIMA', 'DIEGO TESTE ROCHA', 'ELIS TESTE MOURA',
    'FABIO TESTE ALVES', 'GABRIELA TESTE DIAS', 'HUGO TESTE PINTO', 'IARA TESTE NUNES', 'JOAO TESTE BRITO',
    'KARINA TESTE SOUZA', 'LEO TESTE MARTINS', 'MARA TESTE FREITAS', 'NICO TESTE RAMOS', 'OLGA TESTE VIEIRA'
  ];
  const rows = [];
  let seed = 42;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const hoje = udsHojeSP();
  nomes.forEach((nome, idx) => {
    const loja = UDS_LOJAS[idx % UDS_LOJAS.length];
    const departamento = idx % 3 === 2 ? 'NOVOS/SEMINOVOS' : (idx % 2 === 0 ? 'NOVOS' : 'SEMINOVOS');
    const perfil = idx % 7 === 0 ? 'GERENTE' : (idx % 11 === 0 ? 'ANALISTA' : 'VENDEDOR');
    const modulosUsados = departamento === 'NOVOS/SEMINOVOS' ? UDS_MODULOS : UDS_MODULOS.filter(m =>
      (departamento === 'NOVOS' && m.id === 'simuladorCompleto') || (departamento === 'SEMINOVOS' && m.id === 'simuladorSeminovos'));
    modulosUsados.forEach(m => {
      const sessions = 2 + Math.floor(rnd() * 18);
      const simulationCount = Math.floor(sessions * (0.3 + rnd() * 0.9));
      const activeSeconds = sessions * (180 + Math.floor(rnd() * 900));
      const diasAtivos = Math.min(sessions, 1 + Math.floor(rnd() * 12));
      const lastOffset = Math.floor(rnd() * 25);
      const firstOffset = lastOffset + Math.floor(rnd() * 40) + 1;
      rows.push({
        usuario_id: `MOCK-${idx}`,
        nome,
        module_id: m.id,
        loja_relatorio: loja,
        perfil_relatorio: perfil,
        departamento_relatorio: departamento,
        sessions, simulation_count: simulationCount, active_seconds: activeSeconds, active_days: diasAtivos,
        first_use: udsIsoInicioDia(udsSomarDias(hoje, -firstOffset)),
        last_use: udsIsoDataHoraFake(udsSomarDias(hoje, -lastOffset))
      });
    });
  });
  return {
    periodo_inicio: UDS_INICIO_TUDO_ISO, periodo_fim: new Date().toISOString(),
    limitacao: 'MOCK LOCAL — dados sintéticos, nunca gravados no Supabase.',
    linhas: rows
  };
}
function udsIsoDataHoraFake(ymd) { return `${ymd}T${String(9 + (ymd.length % 8)).padStart(2, '0')}:${String((ymd.charCodeAt(9) || 30) % 60).padStart(2, '0')}:00-03:00`; }

// ---------------- chamada RPC (real ou mock local) ----------------
async function udsFetchPeriodo(startIso, endIso) {
  if (UDS_LOCAL && UDS_STATE.mockAtivo) {
    return udsGerarMock();
  }
  if (typeof supabaseClient === 'undefined' || !supabaseClient) throw new Error('Supabase não inicializado.');
  const { data, error } = await supabaseClient.rpc('master_simulator_usage_data', {
    p_start_date: startIso, p_end_date: endIso
  });
  if (error) throw error;
  return data || { linhas: [] };
}

// ---------------- filtro client-side (Parte AY — nunca requery por tecla) ----------------
function udsFiltrarClientSide(linhas) {
  const f = UDS_STATE.filtros;
  const buscaNorm = typeof norm === 'function' ? norm(f.busca || '') : String(f.busca || '').toUpperCase();
  return (linhas || []).filter(l => {
    if (f.loja && String(l.loja_relatorio || '').toUpperCase() !== f.loja) return false;
    if (f.departamento && String(l.departamento_relatorio || '').toUpperCase() !== f.departamento) return false;
    if (f.modulo && l.module_id !== f.modulo) return false;
    if (f.perfil && String(l.perfil_relatorio || '').toUpperCase() !== f.perfil) return false;
    if (f.busca) {
      const hay = typeof norm === 'function'
        ? norm([l.nome, l.loja_relatorio, l.perfil_relatorio].join(' '))
        : String([l.nome, l.loja_relatorio, l.perfil_relatorio].join(' ')).toUpperCase();
      if (!hay.includes(buscaNorm)) return false;
    }
    return true;
  });
}

// ---------------- agregações ----------------
function udsKpisGlobais(linhas) {
  const usuarios = new Set(linhas.map(l => l.usuario_id));
  const sessions = linhas.reduce((a, l) => a + (Number(l.sessions) || 0), 0);
  const simulations = linhas.reduce((a, l) => a + (Number(l.simulation_count) || 0), 0);
  const activeSeconds = linhas.reduce((a, l) => a + (Number(l.active_seconds) || 0), 0);
  return { usuarios: usuarios.size, sessions, simulations, activeSeconds };
}
// "Dias de uso" só é uma métrica válida no grão (usuário × módulo) devolvido
// pela RPC — somar active_days entre usuários OU entre módulos duplicaria
// datas coincidentes (dois vendedores usando o mesmo simulador no mesmo dia,
// ou um vendedor usando os dois simuladores no mesmo dia). Por isso este
// indicador só aparece no drawer, por usuário × módulo (Parte S/AC), nunca
// como KPI global nem no comparativo Novos×Seminovos.
function udsPorModulo(linhas) {
  return UDS_MODULOS.map(m => {
    const rows = linhas.filter(l => l.module_id === m.id);
    const usuarios = new Set(rows.map(l => l.usuario_id));
    return {
      id: m.id, label: m.label,
      usuarios: usuarios.size,
      sessions: rows.reduce((a, l) => a + (Number(l.sessions) || 0), 0),
      simulations: rows.reduce((a, l) => a + (Number(l.simulation_count) || 0), 0),
      activeSeconds: rows.reduce((a, l) => a + (Number(l.active_seconds) || 0), 0)
    };
  });
}
function udsAgruparPorUsuario(linhas) {
  const map = new Map();
  linhas.forEach(l => {
    if (!map.has(l.usuario_id)) map.set(l.usuario_id, { usuario_id: l.usuario_id, nome: l.nome, porModulo: {} });
    map.get(l.usuario_id).porModulo[l.module_id] = l;
  });
  return [...map.values()].map(u => {
    const rows = Object.values(u.porModulo);
    const snapshot = rows.reduce((a, b) => (!a || String(b.last_use || '') > String(a.last_use || '')) ? b : a, null);
    return {
      usuario_id: u.usuario_id,
      nome: u.nome,
      loja: snapshot ? snapshot.loja_relatorio : '',
      perfil: snapshot ? snapshot.perfil_relatorio : '',
      departamento: snapshot ? snapshot.departamento_relatorio : '',
      acessosNovos: (u.porModulo.simuladorCompleto && u.porModulo.simuladorCompleto.sessions) || 0,
      acessosSeminovos: (u.porModulo.simuladorSeminovos && u.porModulo.simuladorSeminovos.sessions) || 0,
      simulacoes: rows.reduce((a, r) => a + (Number(r.simulation_count) || 0), 0),
      tempoAtivo: rows.reduce((a, r) => a + (Number(r.active_seconds) || 0), 0),
      primeiroUso: rows.reduce((a, r) => (!a || String(r.first_use || '') < String(a)) ? r.first_use : a, null),
      ultimoUso: rows.reduce((a, r) => (!a || String(r.last_use || '') > String(a)) ? r.last_use : a, null),
      porModulo: u.porModulo
    };
  });
}
// Ordenação padrão: ÚLTIMO USO mais recente primeiro — mesma ordem já
// devolvida pela própria RPC (order by last_use desc) e a mais útil para uma
// visão gerencial de "quem está usando agora", em vez de ranking histórico
// acumulado. Documentado por exigência da Parte W.
function udsOrdenar(lista, criterio) {
  const arr = [...lista];
  if (criterio === 'simulacoes') return arr.sort((a, b) => b.simulacoes - a.simulacoes);
  if (criterio === 'sessoes') return arr.sort((a, b) => (b.acessosNovos + b.acessosSeminovos) - (a.acessosNovos + a.acessosSeminovos));
  if (criterio === 'tempo') return arr.sort((a, b) => b.tempoAtivo - a.tempoAtivo);
  if (criterio === 'nome') return arr.sort((a, b) => String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR'));
  return arr.sort((a, b) => String(b.ultimoUso || '').localeCompare(String(a.ultimoUso || '')));
}

// ---------------- Nunca Utilizou (Parte X/Y/Z) ----------------
// Elegibilidade calculada 100% no frontend com portalAllowedModules() — a
// MESMA função já usada para liberar os módulos no Portal (fonte única,
// sem regra duplicada). Nenhuma RPC por usuário (N+1 proibido): 1 chamada
// para a lista de usuários (já reaproveitada de Usuários/master_admin_security_data)
// + 1 chamada de telemetria "desde o início", já necessárias por outros
// motivos nesta mesma aba.
async function udsCarregarNuncaUtilizou() {
  if (!UDS_STATE.usuariosCache) {
    UDS_STATE.usuariosCache = (typeof carregarUsuariosSupabase === 'function') ? await carregarUsuariosSupabase() : [];
  }
  if (!UDS_STATE.linhasLifetime) {
    const resp = await udsFetchPeriodo(udsDataZeroEfetivaIso(), new Date().toISOString());
    UDS_STATE.linhasLifetime = resp.linhas || [];
  }
  const usados = new Set(UDS_STATE.linhasLifetime.map(l => `${l.usuario_id}|${l.module_id}`));
  const out = [];
  (UDS_STATE.usuariosCache || []).filter(u => u.ativo).forEach(u => {
    let modulosPermitidos = [];
    try {
      modulosPermitidos = (typeof portalAllowedModules === 'function')
        ? portalAllowedModules({ tipo: u.perfil, status: u.status, statusGroups: u.statusGroups })
        : [];
    } catch (e) { modulosPermitidos = []; }
    modulosPermitidos.filter(m => m === 'simuladorCompleto' || m === 'simuladorSeminovos').forEach(m => {
      if (!usados.has(`${u.id}|${m}`)) {
        out.push({ usuario_id: u.id, nome: u.nome, loja: u.loja, perfil: u.perfil, status: u.status, module_id: m });
      }
    });
  });
  return out;
}

// ---------------- carregamento principal ----------------
async function udsCarregar() {
  UDS_STATE.loading = true;
  UDS_STATE.erro = null;
  try {
    const f = UDS_STATE.filtros;
    const startIso = f.dtIni ? udsIsoInicioDia(f.dtIni) : udsIsoInicioDia(udsSomarDias(udsHojeSP(), -29));
    const endIso = f.dtFim ? udsIsoFimDia(f.dtFim) : udsIsoFimDia(udsHojeSP());
    const resp = await udsFetchPeriodo(startIso, endIso);
    UDS_STATE.linhas = resp.linhas || [];
    // Fase 18.5: estado oficial (ligada/desligada + data zero) agora vem
    // diretamente da RPC — nunca mais inferido pela ausência de linhas
    // (Parte K: zero sessões no período não significa telemetria desligada).
    if (typeof resp.telemetry_enabled === 'boolean') UDS_STATE.telemetryEnabled = resp.telemetry_enabled;
    if (resp.telemetry_started_at) UDS_STATE.telemetryStartedAt = resp.telemetry_started_at;
  } catch (e) {
    console.error('[Utilização dos Simuladores] Falha ao carregar:', e);
    UDS_STATE.erro = e;
  } finally {
    UDS_STATE.loading = false;
  }
}

// ---------------- render ----------------
function udsFiltroSelectHtml(id, label, opcoes, valorAtual, onchange) {
  const options = ['<option value="">TODOS</option>'].concat(
    opcoes.map(o => `<option value="${o}" ${valorAtual === o ? 'selected' : ''}>${o}</option>`)
  ).join('');
  return `<div><label>${label}</label><br><select id="${id}" onchange="${onchange}">${options}</select></div>`;
}

// Fase 18.5 — estado do banner decidido pelo estado OFICIAL (telemetryEnabled
// + telemetryStartedAt, vindos da RPC a cada carga), nunca mais pela
// ausência de linhas (Parte K). Três variações, nesta ordem de prioridade:
// desligada > período totalmente anterior à data zero (Parte M) > período
// parcialmente anterior (Parte N, nota discreta) > período normal (Parte H).
function udsBannerEstado() {
  if (UDS_STATE.mockAtivo) return '';
  if (UDS_STATE.telemetryEnabled === false) {
    return `<div class="panel" style="border-color:rgba(246,196,83,.35);background:rgba(246,196,83,.06)">
      <b>Telemetria ainda não ativada em produção.</b>
      <p class="note" style="margin-top:6px">A coleta real de utilização dos simuladores está desligada (flag <code>telemetria_simuladores_ativa = FALSE</code>). Os indicadores abaixo ficarão zerados até a coleta ser iniciada oficialmente.</p>
    </div>`;
  }
  if (UDS_STATE.telemetryEnabled !== true || !UDS_STATE.telemetryStartedAt) return '';

  const f = UDS_STATE.filtros;
  const inicioOficial = udsFmtDataHoraBR(UDS_STATE.telemetryStartedAt);
  // Comparação por instante real (Date.getTime()), nunca por string ISO —
  // o filtro usa offset fixo -03:00 e a RPC devolve timestamptz do Postgres
  // (tipicamente +00:00); comparar como texto compararia formatos
  // diferentes de fuso, não o instante.
  const startedAtMs = new Date(UDS_STATE.telemetryStartedAt).getTime();
  const fimFiltroMs = f.dtFim ? new Date(udsIsoFimDia(f.dtFim)).getTime() : null;
  const inicioFiltroMs = f.dtIni ? new Date(udsIsoInicioDia(f.dtIni)).getTime() : null;
  const totalmenteAntes = fimFiltroMs !== null && fimFiltroMs < startedAtMs;
  const parcialmenteAntes = !totalmenteAntes && inicioFiltroMs !== null && inicioFiltroMs < startedAtMs;

  if (totalmenteAntes) {
    return `<div class="panel" style="border-color:rgba(246,196,83,.35);background:rgba(246,196,83,.06)">
      <b>A coleta de utilização ainda não estava ativa neste período.</b>
      <p class="note" style="margin-top:6px">Coleta oficial iniciada em ${inicioOficial}. O período selecionado é anterior a essa data — os indicadores abaixo não representam ausência de uso, e sim ausência de coleta.</p>
    </div>`;
  }
  const notaParcial = parcialmenteAntes
    ? `<p class="note" style="margin-top:6px">Dados disponíveis a partir de ${inicioOficial}.</p>` : '';
  return `<div class="panel" style="border-color:rgba(54,211,153,.28);background:rgba(54,211,153,.05)">
    <b>Coleta iniciada em ${inicioOficial}.</b>
    ${notaParcial}
  </div>`;
}

function udsKpiCardsHtml(kpis) {
  return `<div class="adminGrid">
    <div class="adminCard"><div class="k">Usuários que utilizaram</div><div class="v">${kpis.usuarios}</div></div>
    <div class="adminCard"><div class="k">Sessões</div><div class="v">${kpis.sessions}</div></div>
    <div class="adminCard"><div class="k">Simulações realizadas</div><div class="v">${kpis.simulations}</div></div>
    <div class="adminCard"><div class="k">Tempo ativo</div><div class="v">${udsFmtDuracao(kpis.activeSeconds)}</div></div>
    <div class="adminCard"><div class="k">Tempo médio por sessão</div><div class="v">${udsFmtDuracaoMedia(kpis.activeSeconds, kpis.sessions)}</div></div>
  </div>`;
}

function udsComparativoHtml(porModulo) {
  return `<h3>Uso por Simulador</h3><div class="udsCompareGrid">${porModulo.map(m => `
    <div class="udsCompareCard">
      <div class="udsCompareTitle">${m.label}</div>
      <div class="udsCompareRow"><span>Usuários</span><b>${m.usuarios}</b></div>
      <div class="udsCompareRow"><span>Sessões</span><b>${m.sessions}</b></div>
      <div class="udsCompareRow"><span>Simulações</span><b>${m.simulations}</b></div>
      <div class="udsCompareRow"><span>Tempo ativo</span><b>${udsFmtDuracao(m.activeSeconds)}</b></div>
    </div>`).join('')}</div>`;
}

function udsRowHtml(u) {
  return `<div class="udsRow">
    <div class="udsMain">
      <div class="udsName">${escapeOperationalHtml(u.nome || '')}</div>
      <div class="udsMetaMobile">${escapeOperationalHtml(u.loja || '—')} • ${escapeOperationalHtml(u.departamento || u.perfil || '—')}</div>
    </div>
    <div class="udsCol udsColLoja">${escapeOperationalHtml(u.loja || '—')}</div>
    <div class="udsCol udsColDep">${escapeOperationalHtml(u.departamento || '—')}</div>
    <div class="udsCol udsColNum" data-label="Novos">${u.acessosNovos}</div>
    <div class="udsCol udsColNum" data-label="Seminovos">${u.acessosSeminovos}</div>
    <div class="udsCol udsColNum" data-label="Simulações">${u.simulacoes}</div>
    <div class="udsCol udsColNum" data-label="Tempo ativo">${udsFmtDuracao(u.tempoAtivo)}</div>
    <div class="udsCol udsColUltimo" data-label="Último uso">${udsFmtDataHoraBR(u.ultimoUso)}</div>
    <div class="udsCol udsColAcao"><button class="adminActionBtn wine" onclick="udsAbrirDrawer('${u.usuario_id}')">Ver detalhes</button></div>
  </div>`;
}

function udsNuncaUtilizouHtml() {
  if (!UDS_STATE.nuncaUtilizouAberto) {
    return `<div class="udsNuncaBox"><button class="secondary" onclick="udsToggleNuncaUtilizou()">Ver quem nunca utilizou os simuladores</button></div>`;
  }
  if (UDS_STATE.nuncaUtilizouLoading) {
    return `<div class="udsNuncaBox"><p class="note">Carregando...</p></div>`;
  }
  const lista = UDS_STATE.nuncaUtilizouCache || [];
  const porUsuario = new Map();
  lista.forEach(r => {
    if (!porUsuario.has(r.usuario_id)) porUsuario.set(r.usuario_id, { nome: r.nome, loja: r.loja, perfil: r.perfil, modulos: [] });
    porUsuario.get(r.usuario_id).modulos.push(UDS_MODULOS.find(m => m.id === r.module_id)?.label || r.module_id);
  });
  const linhas = [...porUsuario.values()].sort((a, b) => String(a.nome || '').localeCompare(String(b.nome || ''), 'pt-BR'));
  const rows = linhas.map(u => `<div class="udsNuncaRow">
      <div><b>${escapeOperationalHtml(u.nome || '')}</b></div>
      <div class="note">${escapeOperationalHtml(u.loja || '—')} • ${escapeOperationalHtml(u.perfil || '—')}</div>
      <div class="note">Elegível: ${u.modulos.map(escapeOperationalHtml).join(', ')}</div>
    </div>`).join('');
  return `<div class="udsNuncaBox">
    <div class="udsNuncaHead">
      <h3 style="margin:0">Nunca utilizaram (${linhas.length})</h3>
      <button class="secondary" onclick="udsToggleNuncaUtilizou()">Ocultar</button>
    </div>
    <p class="note">Considera todo o histórico de telemetria disponível (independente do filtro de período acima) — vendedores/gerentes/analistas com permissão para pelo menos um simulador e nenhuma sessão registrada.</p>
    ${rows || '<p class="note">Nenhum usuário elegível está sem uso — ou a coleta ainda não iniciou (ver banner acima).</p>'}
  </div>`;
}

function udsDrawerHtml(u) {
  const modNovos = u.porModulo.simuladorCompleto;
  const modSemi = u.porModulo.simuladorSeminovos;
  const moduloBlocoHtml = (label, m) => m ? `
      <h4>${label}</h4>
      <dl class="fichaList">
        <dt>Sessões</dt><dd>${m.sessions}</dd>
        <dt>Simulações</dt><dd>${m.simulation_count}</dd>
        <dt>Tempo ativo</dt><dd>${udsFmtDuracao(m.active_seconds)}</dd>
        <dt>Dias ativos</dt><dd>${m.active_days}</dd>
        <dt>Primeiro uso</dt><dd>${udsFmtDataHoraBR(m.first_use)}</dd>
        <dt>Último uso</dt><dd>${udsFmtDataHoraBR(m.last_use)}</dd>
      </dl>` : `<h4>${label}</h4><p class="note">Sem uso registrado no período filtrado.</p>`;
  return `
    <div class="userDrawerHeader">
      <button class="userDrawerClose" type="button" onclick="udsFecharDrawer()" aria-label="Fechar">×</button>
      <div class="userDrawerNome">${escapeOperationalHtml(u.nome || '')}</div>
      <div class="userMeta">${escapeOperationalHtml(u.perfil || '—')} • ${escapeOperationalHtml(u.loja || '—')} • ${escapeOperationalHtml(u.departamento || '—')}</div>
    </div>
    <div class="userDrawerBody">
      <h4>Resumo</h4>
      <dl class="fichaList">
        <dt>Sessões totais</dt><dd>${u.acessosNovos + u.acessosSeminovos}</dd>
        <dt>Simulações</dt><dd>${u.simulacoes}</dd>
        <dt>Tempo ativo</dt><dd>${udsFmtDuracao(u.tempoAtivo)}</dd>
        <dt>Tempo médio por sessão</dt><dd>${udsFmtDuracaoMedia(u.tempoAtivo, u.acessosNovos + u.acessosSeminovos)}</dd>
        <dt>Primeiro uso</dt><dd>${udsFmtDataHoraBR(u.primeiroUso)}</dd>
        <dt>Último uso</dt><dd>${udsFmtDataHoraBR(u.ultimoUso)}</dd>
      </dl>
      <p class="note">"Dias ativos" é mostrado por simulador abaixo — somar entre os dois módulos poderia contar o mesmo dia duas vezes se o usuário usou ambos no mesmo dia.</p>
      ${moduloBlocoHtml('Simulador de Novos', modNovos)}
      ${moduloBlocoHtml('Simulador de Seminovos', modSemi)}
    </div>`;
}

window.udsAbrirDrawer = function (usuarioId) {
  const lista = udsAgruparPorUsuario(udsFiltrarClientSide(UDS_STATE.linhas));
  const u = lista.find(x => x.usuario_id === usuarioId);
  if (!u || typeof abrirDrawerGenerico !== 'function') return;
  abrirDrawerGenerico(udsDrawerHtml(u));
};
window.udsFecharDrawer = function () {
  if (typeof fecharDrawerGenerico === 'function') fecharDrawerGenerico();
};

// ---------------- ações de filtro/UI ----------------
// Mudança de PERÍODO exige nova chamada à RPC (filtro server-side) — só ela
// justifica re-render completo da aba (com estado de "carregando"). Todo o
// resto (loja/departamento/módulo/perfil/busca/ordenação/nunca-utilizou) é
// filtro client-side sobre o dataset já carregado (Parte AY): atualiza
// somente #udsResultsArea, sem tocar nos campos de filtro/busca acima —
// preserva foco e cursor da busca a cada tecla.
function udsRenderResultados() {
  const area = document.getElementById('udsResultsArea');
  if (!area) return;
  area.innerHTML = udsResultadosHtml();
}
window.udsSetPreset = function (preset) {
  udsAplicarPreset(preset);
  udsCarregar().then(() => { if (typeof renderMasterAdmin === 'function') renderMasterAdmin(); });
};
window.udsSetData = function (campo, valor) {
  UDS_STATE.filtros.preset = 'custom';
  UDS_STATE.filtros[campo] = valor;
  udsCarregar().then(() => { if (typeof renderMasterAdmin === 'function') renderMasterAdmin(); });
};
window.udsSetFiltroSelect = function (campo, valor) {
  UDS_STATE.filtros[campo] = valor;
  udsRenderResultados();
};
let UDS_BUSCA_DEBOUNCE = null;
window.udsSetBusca = function (valor) {
  UDS_STATE.filtros.busca = valor;
  clearTimeout(UDS_BUSCA_DEBOUNCE);
  UDS_BUSCA_DEBOUNCE = setTimeout(udsRenderResultados, 200);
};
window.udsSetOrdenacao = function (valor) {
  UDS_STATE.ordenacao = valor;
  udsRenderResultados();
};
window.udsToggleNuncaUtilizou = async function () {
  UDS_STATE.nuncaUtilizouAberto = !UDS_STATE.nuncaUtilizouAberto;
  if (UDS_STATE.nuncaUtilizouAberto && !UDS_STATE.nuncaUtilizouCache) {
    UDS_STATE.nuncaUtilizouLoading = true;
    udsRenderResultados();
    UDS_STATE.nuncaUtilizouCache = await udsCarregarNuncaUtilizou();
    UDS_STATE.nuncaUtilizouLoading = false;
  }
  udsRenderResultados();
};
window.udsToggleMock = function () {
  if (!UDS_LOCAL) return;
  UDS_STATE.mockAtivo = !UDS_STATE.mockAtivo;
  UDS_STATE.linhasLifetime = null;
  UDS_STATE.nuncaUtilizouCache = null;
  udsCarregar().then(() => { if (typeof renderMasterAdmin === 'function') renderMasterAdmin(); });
};
window.udsExportarXlsx = function () {
  if (typeof XLSX === 'undefined') { if (typeof toastAdmin === 'function') toastAdmin('Biblioteca de exportação não carregada.', 'err'); return; }
  const lista = udsOrdenar(udsAgruparPorUsuario(udsFiltrarClientSide(UDS_STATE.linhas)), UDS_STATE.ordenacao);
  const linhasXlsx = lista.map(u => ({
    'Nome': u.nome, 'Loja': u.loja, 'Departamento': u.departamento, 'Perfil': u.perfil,
    'Sessões Novos': u.acessosNovos, 'Sessões Seminovos': u.acessosSeminovos,
    'Simulações': u.simulacoes, 'Tempo ativo (min)': Math.round((u.tempoAtivo || 0) / 60),
    'Primeiro uso': udsFmtDataBR(u.primeiroUso), 'Último uso': udsFmtDataHoraBR(u.ultimoUso)
  }));
  const ws = XLSX.utils.json_to_sheet(linhasXlsx);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Utilizacao');
  XLSX.writeFile(wb, `utilizacao_simuladores_${UDS_STATE.filtros.dtIni}_a_${UDS_STATE.filtros.dtFim}.xlsx`);
};

// ---------------- render principal da aba ----------------
async function udsRenderTab() {
  if (!UDS_STATE.linhas.length && !UDS_STATE.erro && !UDS_STATE.filtros.dtIni) {
    udsAplicarPreset('30d');
  }
  if (!UDS_STATE.filtros.dtIni) udsAplicarPreset(UDS_STATE.filtros.preset || '30d');
  if (!UDS_STATE._carregouUmaVez) {
    UDS_STATE._carregouUmaVez = true;
    await udsCarregar();
  }
  if (UDS_STATE.loading) {
    return '<h2>Utilização dos Simuladores</h2><p class="note">Carregando utilização...</p>';
  }
  if (UDS_STATE.erro) {
    return `<h2>Utilização dos Simuladores</h2>
      <p class="note" style="color:#ff6b61">Não foi possível carregar os dados de utilização.</p>
      <button onclick="udsRetry()">Tentar novamente</button>`;
  }

  const f = UDS_STATE.filtros;
  const mockBanner = (UDS_LOCAL && UDS_STATE.mockAtivo)
    ? '<p class="note gbWarn">🧪 MOCK LOCAL ATIVO — dados sintéticos, nada foi gravado no Supabase. Disponível somente em localhost.</p>' : '';
  const mockBtn = UDS_LOCAL
    ? `<button class="secondary" onclick="udsToggleMock()">${UDS_STATE.mockAtivo ? 'Desligar dados de teste' : '🧪 Usar dados de teste (somente localhost)'}</button>` : '';

  const presets = [['hoje', 'Hoje'], ['7d', 'Últimos 7 dias'], ['30d', 'Últimos 30 dias'], ['mesAtual', 'Mês atual'], ['mesAnterior', 'Mês anterior'], ['desdeInicio', 'Desde o início']];
  const presetBtns = presets.map(([id, label]) => `<button class="${f.preset === id ? '' : 'secondary'}" onclick="udsSetPreset('${id}')">${label}</button>`).join('');

  const filtrosGrid = `<div class="udsFiltersGrid">
      <div><label>Data inicial</label><br><input type="date" value="${f.dtIni}" onchange="udsSetData('dtIni',this.value)"></div>
      <div><label>Data final</label><br><input type="date" value="${f.dtFim}" onchange="udsSetData('dtFim',this.value)"></div>
      ${udsFiltroSelectHtml('udsLoja', 'Loja', UDS_LOJAS, f.loja, "udsSetFiltroSelect('loja',this.value)")}
      ${udsFiltroSelectHtml('udsDep', 'Departamento', UDS_DEPARTAMENTOS, f.departamento, "udsSetFiltroSelect('departamento',this.value)")}
      <div><label>Módulo</label><br><select onchange="udsSetFiltroSelect('modulo',this.value)">
        <option value="">TODOS</option>
        ${UDS_MODULOS.map(m => `<option value="${m.id}" ${f.modulo === m.id ? 'selected' : ''}>${m.label}</option>`).join('')}
      </select></div>
      ${udsFiltroSelectHtml('udsPerfil', 'Perfil', UDS_PERFIS, f.perfil, "udsSetFiltroSelect('perfil',this.value)")}
    </div>`;

  const ordenacaoSel = `<select onchange="udsSetOrdenacao(this.value)">
      <option value="last_use_desc" ${UDS_STATE.ordenacao === 'last_use_desc' ? 'selected' : ''}>Último uso (mais recente)</option>
      <option value="simulacoes" ${UDS_STATE.ordenacao === 'simulacoes' ? 'selected' : ''}>Mais simulações</option>
      <option value="sessoes" ${UDS_STATE.ordenacao === 'sessoes' ? 'selected' : ''}>Mais sessões</option>
      <option value="tempo" ${UDS_STATE.ordenacao === 'tempo' ? 'selected' : ''}>Mais tempo ativo</option>
      <option value="nome" ${UDS_STATE.ordenacao === 'nome' ? 'selected' : ''}>Nome (A-Z)</option>
    </select>`;

  return `<h2>Utilização dos Simuladores</h2>
    <p class="note">Dados de USO (acessos, sessões, tempo ativo, simulações realizadas) — nunca conteúdo de simulação. Sem CPF, cliente, chassi ou valores financeiros.</p>
    ${udsBannerEstado()}
    ${mockBanner}
    <div class="adminToolbar" style="align-items:center">
      <div style="display:flex;gap:8px;flex-wrap:wrap">${presetBtns}</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">${mockBtn}<button class="secondary" onclick="udsExportarXlsx()">Exportar XLSX</button></div>
    </div>
    ${filtrosGrid}
    <div class="adminToolbar">
      <div><label>Pesquisar usuário...</label><br><input class="adminSearch" oninput="udsSetBusca(this.value)" value="${escapeOperationalHtml(f.busca)}" placeholder="Nome, loja ou perfil"></div>
      <div><label>Ordenar por</label><br>${ordenacaoSel}</div>
    </div>
    <div id="udsResultsArea">${udsResultadosHtml()}</div>`;
}
// Recalculado a cada filtro client-side (busca/loja/departamento/módulo/
// perfil/ordenação/nunca-utilizou), injetado só em #udsResultsArea — nunca
// reconstrói os campos de filtro/busca acima (preserva foco/cursor).
function udsResultadosHtml() {
  const filtradas = udsFiltrarClientSide(UDS_STATE.linhas);
  const kpis = udsKpisGlobais(filtradas);
  const porModulo = udsPorModulo(filtradas);
  const usuarios = udsOrdenar(udsAgruparPorUsuario(filtradas), UDS_STATE.ordenacao);
  const tabelaRows = usuarios.map(udsRowHtml).join('');
  const tabelaHeader = `<div class="udsRow udsRowHead">
      <div class="udsMain">Usuário</div>
      <div class="udsCol udsColLoja">Loja</div>
      <div class="udsCol udsColDep">Departamento</div>
      <div class="udsCol udsColNum">Novos</div>
      <div class="udsCol udsColNum">Seminovos</div>
      <div class="udsCol udsColNum">Simulações</div>
      <div class="udsCol udsColNum">Tempo ativo</div>
      <div class="udsCol udsColUltimo">Último uso</div>
      <div class="udsCol udsColAcao"></div>
    </div>`;
  return `${udsKpiCardsHtml(kpis)}
    ${udsComparativoHtml(porModulo)}
    <div class="udsList">${tabelaHeader}${tabelaRows || '<p class="note" style="padding:16px">Nenhum acesso registrado para os filtros selecionados.</p>'}</div>
    ${udsNuncaUtilizouHtml()}`;
}
window.udsRetry = function () {
  UDS_STATE._carregouUmaVez = false;
  UDS_STATE.erro = null;
  if (typeof renderMasterAdmin === 'function') renderMasterAdmin();
};
window.renderUtilizacaoSimuladoresTab = udsRenderTab;
})();
