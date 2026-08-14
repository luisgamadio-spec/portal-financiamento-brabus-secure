/* Acessos aos Módulos — aba do Painel Master (Fase 9.9, revisada 9.10).
   Lê a matriz REAL via master_listar_permissoes_modulos() (MASTER-only,
   enforcement no backend). Esta fase é SOMENTE LEITURA: nenhuma célula
   é gravada — master_salvar_permissoes_modulos() não é chamada em
   nenhum caminho deste arquivo. Edição é só estado local (em memória),
   para homologar a experiência antes de autorizar escrita real.
   Fase 9.10: as 56 células são todas editáveis localmente, sem exceção
   — a antiga trava visual de Análise F&I × Vendedor foi removida por
   decisão do MASTER, agora que operational_fandi_dashboard() já sabe
   restringir VENDEDOR à própria loja/departamento no backend. */
(function () {
  'use strict';

  const AM_MODULE_ORDER = [
    'simuladorCompleto', 'simuladorSeminovos', 'dashbi', 'gestao',
    'coparticipadoPortal', 'analiseScoreVendedores', 'comissoes'
  ];
  const AM_MODULE_LABELS = {
    simuladorCompleto: 'Simulador de Novos',
    simuladorSeminovos: 'Simulador de Seminovos',
    dashbi: 'Análise Geral do Grupo',
    gestao: 'Análise F&I do Grupo',
    coparticipadoPortal: 'Coparticipados',
    analiseScoreVendedores: 'Análise de Score',
    comissoes: 'Acompanhamento de Salário'
  };
  // Checkpoint 6/11 — colunas editáveis, com rótulos amigáveis (sem
  // expor os códigos técnicos VENDEDOR_NOVOS/DIRETOR_NOVOS/TODOS).
  const AM_COLUMNS = [
    { perfil: 'VENDEDOR', departamento: 'NOVOS', label: 'Vendedor', sub: 'Novos' },
    { perfil: 'VENDEDOR', departamento: 'SEMINOVOS', label: 'Vendedor', sub: 'Seminovos' },
    { perfil: 'GERENTE', departamento: 'NOVOS', label: 'Gerente', sub: 'Novos' },
    { perfil: 'GERENTE', departamento: 'SEMINOVOS', label: 'Gerente', sub: 'Seminovos' },
    { perfil: 'ANALISTA', departamento: 'TODOS', label: 'Analista', sub: '' },
    { perfil: 'RH', departamento: 'TODOS', label: 'RH', sub: '' },
    { perfil: 'DIRETOR_NOVOS', departamento: 'TODOS', label: 'Diretor', sub: 'Novos' },
    { perfil: 'DIRETOR_SEMINOVOS', departamento: 'TODOS', label: 'Diretor', sub: 'Seminovos' }
  ];

  const AM_STATE = {
    loading: false,
    error: null,
    loaded: false,
    modules: [],           // subset configurável, na ordem de exibição
    serverSnapshot: {},    // chave -> boolean, exatamente como veio da RPC
    localPermissions: {},  // chave -> boolean, editável só em memória
    dirty: false
  };

  function amKey(moduleId, perfil, departamento) {
    return moduleId + '|' + perfil + '|' + departamento;
  }

  async function amLoad() {
    AM_STATE.loading = true;
    AM_STATE.error = null;
    try {
      if (typeof supabaseClient === 'undefined' || !supabaseClient) throw new Error('Cliente Supabase indisponível.');
      const { data, error } = await supabaseClient.rpc('master_listar_permissoes_modulos');
      if (error) throw error;
      const modulosRaw = Array.isArray(data && data.modulos) ? data.modulos : [];
      AM_STATE.modules = AM_MODULE_ORDER
        .map(id => modulosRaw.find(m => m.id === id))
        .filter(Boolean);
      const permissoesRaw = Array.isArray(data && data.permissoes) ? data.permissoes : [];
      const snapshot = {};
      permissoesRaw.forEach(p => {
        snapshot[amKey(p.modulo_id, p.perfil, p.departamento)] = !!p.permitido;
      });
      AM_STATE.serverSnapshot = snapshot;
      AM_STATE.localPermissions = Object.assign({}, snapshot);
      AM_STATE.dirty = false;
      AM_STATE.loaded = true;
    } catch (e) {
      AM_STATE.error = e;
      AM_STATE.loaded = false;
      console.error('[AcessosModulos] falha ao carregar master_listar_permissoes_modulos()', e);
    } finally {
      AM_STATE.loading = false;
    }
  }

  function amRecomputeDirty() {
    const keys = Object.keys(AM_STATE.localPermissions);
    AM_STATE.dirty = keys.some(k => AM_STATE.localPermissions[k] !== AM_STATE.serverSnapshot[k]);
  }

  window.amToggle = function (moduleId, perfil, departamento) {
    const key = amKey(moduleId, perfil, departamento);
    AM_STATE.localPermissions[key] = !AM_STATE.localPermissions[key];
    amRecomputeDirty();
    amRerenderInPlace();
  };

  // Checkpoint 18/29 — descarta edições locais e restaura exatamente o
  // que a RPC retornou (sem nova leitura ao banco).
  window.amDiscard = function () {
    AM_STATE.localPermissions = Object.assign({}, AM_STATE.serverSnapshot);
    AM_STATE.dirty = false;
    amRerenderInPlace();
  };

  // Checkpoint 5 — recarrega de verdade (nova chamada real à RPC).
  window.amReload = async function () {
    AM_STATE.loaded = false;
    await amLoad();
    if (typeof renderMasterAdmin === 'function') await renderMasterAdmin();
  };

  function amRerenderInPlace() {
    const root = document.getElementById('amRoot');
    if (root) root.innerHTML = amBuildBodyHtml();
  }

  function amCellHtml(moduleId, col) {
    const checked = AM_STATE.localPermissions[amKey(moduleId, col.perfil, col.departamento)] ? 'checked' : '';
    return `<td class="amCell"><input type="checkbox" ${checked} onchange="amToggle('${moduleId}','${col.perfil}','${col.departamento}')"></td>`;
  }

  function amBuildBodyHtml() {
    const headCols = AM_COLUMNS.map(c =>
      `<th>${c.label}${c.sub ? `<br><span class="amColSub">${c.sub}</span>` : ''}</th>`
    ).join('');
    const rows = AM_STATE.modules.map(m => {
      const cells = AM_COLUMNS.map(c => amCellHtml(m.id, c)).join('');
      return `<tr><td class="amRowLabel">${AM_MODULE_LABELS[m.id] || m.nome}</td>${cells}</tr>`;
    }).join('');

    const dirtyBanner = AM_STATE.dirty
      ? `<div class="amDirtyBanner">Alterações não salvas — o banco de dados continua com os valores originais.</div>`
      : '';

    return `
      <div id="amMasterBanner" class="amMasterBanner">
        🔒 <b>MASTER</b> possui acesso permanente a todos os módulos e não pode ser restringido por esta configuração.
      </div>
      ${dirtyBanner}
      <div class="amTableWrap">
        <table class="amTable">
          <thead><tr><th class="amRowLabel">Módulo</th>${headCols}</tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="amActions">
        <button class="adminActionBtn" onclick="amDiscard()" ${AM_STATE.dirty ? '' : 'disabled'}>Descartar alterações</button>
        <button class="adminActionBtn" onclick="amReload()">Recarregar da base</button>
        <button class="adminActionBtn good" disabled title="Disponível após homologação visual pelo MASTER.">Salvar permissões</button>
      </div>
    `;
  }

  async function amRenderTab() {
    if (!AM_STATE.loaded && !AM_STATE.loading) {
      await amLoad();
    }
    if (AM_STATE.loading) {
      return `<h2>Acessos aos Módulos</h2><p class="note">Carregando permissões dos módulos...</p>`;
    }
    if (AM_STATE.error || !AM_STATE.loaded) {
      return `<h2>Acessos aos Módulos</h2>
        <p class="note" style="color:#ff6b61">Não foi possível carregar as permissões dos módulos.</p>
        <button class="adminActionBtn" onclick="amReload()">Tentar novamente</button>`;
    }
    return `
      <h2>Acessos aos Módulos</h2>
      <p class="note">Defina quais módulos ficam disponíveis para cada perfil. Alterações de acesso não modificam o escopo de dados permitido dentro de cada módulo.</p>
      <div id="amRoot">${amBuildBodyHtml()}</div>
    `;
  }

  window.renderAcessosModulosTab = amRenderTab;
})();
