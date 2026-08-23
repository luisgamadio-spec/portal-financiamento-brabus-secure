/* Acessos aos Módulos — aba do Painel Master (Fase 9.9, revisada 9.10
   e 9.12). Lê a matriz REAL via master_listar_permissoes_modulos()
   (MASTER-only, enforcement no backend).
   Fase 9.10: as 56 células são todas editáveis localmente, sem exceção
   — a antiga trava visual de Análise F&I × Vendedor foi removida por
   decisão do MASTER, agora que operational_fandi_dashboard() já sabe
   restringir VENDEDOR à própria loja/departamento no backend.
   Fase 9.12: salvamento real habilitado. Envia SOMENTE as células
   realmente alteradas (diff mínimo) para master_salvar_permissoes_modulos(),
   com controle de concorrência otimista (atualizado_em_esperado por
   célula). Após qualquer tentativa de salvar bem-sucedida, o estado
   local é sempre reconstruído a partir de uma nova leitura real do
   backend (nunca assume local=banco) — inclusive quando há conflito
   de concorrência, caso em que a UI avisa explicitamente e recarrega,
   nunca sobrescreve silenciosamente. */
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
    coparticipadoPortal: 'Coparticipados / Subsidiados',
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
    saving: false,
    modules: [],           // subset configurável, na ordem de exibição
    serverSnapshot: {},    // chave -> boolean, exatamente como veio da RPC
    serverUpdatedAt: {},   // chave -> atualizado_em (string), para concorrência otimista
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
      const updatedAt = {};
      permissoesRaw.forEach(p => {
        const k = amKey(p.modulo_id, p.perfil, p.departamento);
        snapshot[k] = !!p.permitido;
        updatedAt[k] = p.atualizado_em || null;
      });
      AM_STATE.serverSnapshot = snapshot;
      AM_STATE.serverUpdatedAt = updatedAt;
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
    if (AM_STATE.saving) return;
    const key = amKey(moduleId, perfil, departamento);
    AM_STATE.localPermissions[key] = !AM_STATE.localPermissions[key];
    amRecomputeDirty();
    amRerenderInPlace();
  };

  // Checkpoint 16 — descarta edições locais e restaura exatamente o
  // que a RPC retornou (sem nova leitura ao banco).
  window.amDiscard = function () {
    if (AM_STATE.saving) return;
    AM_STATE.localPermissions = Object.assign({}, AM_STATE.serverSnapshot);
    AM_STATE.dirty = false;
    amRerenderInPlace();
  };

  // Recarrega de verdade (nova chamada real à RPC de leitura).
  window.amReload = async function () {
    if (AM_STATE.saving) return;
    AM_STATE.loaded = false;
    await amLoad();
    if (typeof renderMasterAdmin === 'function') await renderMasterAdmin();
  };

  function amRerenderInPlace() {
    const root = document.getElementById('amRoot');
    if (root) root.innerHTML = amBuildBodyHtml();
  }

  // Checkpoint 5 — diff mínimo: só as células cujo valor local diverge
  // do snapshot carregado do backend.
  function amDiffChanges() {
    const changes = [];
    Object.keys(AM_STATE.localPermissions).forEach(key => {
      if (AM_STATE.localPermissions[key] !== AM_STATE.serverSnapshot[key]) {
        const parts = key.split('|');
        changes.push({
          modulo_id: parts[0],
          perfil: parts[1],
          departamento: parts[2],
          permitido: AM_STATE.localPermissions[key],
          atualizado_em_esperado: AM_STATE.serverUpdatedAt[key] || null
        });
      }
    });
    return changes;
  }

  function amHumanColumnLabel(perfil, departamento) {
    const col = AM_COLUMNS.find(c => c.perfil === perfil && c.departamento === departamento);
    if (!col) return perfil + ' — ' + departamento;
    return col.sub ? (col.label + ' — ' + col.sub) : col.label;
  }

  // Checkpoint 8 — resumo legível agrupado por perfil/departamento,
  // com labels amigáveis (nunca IDs técnicos).
  function amBuildConfirmSummaryHtml(changes) {
    const byColumn = {};
    const order = [];
    changes.forEach(c => {
      const gkey = c.perfil + '|' + c.departamento;
      if (!byColumn[gkey]) { byColumn[gkey] = { label: amHumanColumnLabel(c.perfil, c.departamento), items: [] }; order.push(gkey); }
      const moduloLabel = AM_MODULE_LABELS[c.modulo_id] || c.modulo_id;
      byColumn[gkey].items.push(`<div class="amConfirmItem ${c.permitido ? 'good' : 'bad'}">${c.permitido ? '+' : '−'} ${moduloLabel}</div>`);
    });
    return order.map(gkey => {
      const g = byColumn[gkey];
      return `<div class="amConfirmGroup"><b>${g.label}</b>${g.items.join('')}</div>`;
    }).join('');
  }

  // Checkpoint 7 — nada é salvo direto no clique do botão principal;
  // sempre passa por confirmação explícita com resumo das mudanças.
  window.amOpenSaveConfirm = function () {
    if (AM_STATE.saving) return;
    const changes = amDiffChanges();
    if (!changes.length) return;
    openAdminModal({
      title: 'Salvar permissões de acesso?',
      text: `${changes.length} alteração(ões) de acesso ${changes.length === 1 ? 'será aplicada' : 'serão aplicadas'}. As novas permissões são refletidas para os usuários afetados no próximo carregamento do Portal (F5 ou login).`,
      fieldHtml: `<div class="amConfirmSummary">${amBuildConfirmSummaryHtml(changes)}</div>`,
      confirmText: 'Salvar permissões',
      onConfirm: amExecuteSave
    });
  };

  // Checkpoint 9-15 — execução real: contrato exato da RPC, MASTER-only
  // reforçado no backend, nunca UPDATE direto na tabela, guarda contra
  // duplo clique/chamada concorrente, trata erro e conflito de forma
  // explícita, sempre reconsulta o backend real ao final.
  async function amExecuteSave() {
    if (AM_STATE.saving) return;
    const changes = amDiffChanges();
    if (!changes.length) return;

    AM_STATE.saving = true;
    amRerenderInPlace();
    setAdminModalMsg('Salvando permissões...');

    try {
      if (typeof supabaseClient === 'undefined' || !supabaseClient) throw new Error('Cliente Supabase indisponível.');
      const payload = changes.map(c => ({
        modulo_id: c.modulo_id,
        perfil: c.perfil,
        departamento: c.departamento,
        permitido: c.permitido,
        atualizado_em_esperado: c.atualizado_em_esperado
      }));
      const { data, error } = await supabaseClient.rpc('master_salvar_permissoes_modulos', { p_mudancas: payload });
      if (error) throw error;

      const aplicadas = Array.isArray(data && data.aplicadas) ? data.aplicadas : [];
      const conflitos = Array.isArray(data && data.conflitos) ? data.conflitos : [];

      // Checkpoint 11: nunca assume local=banco — sempre reconstrói a
      // partir de uma leitura real, com ou sem conflito.
      await amLoad();
      AM_STATE.saving = false;
      closeAdminModal();
      amRerenderInPlace();

      if (conflitos.length > 0) {
        // Checkpoint 4/14: não esconder o conflito nem sobrescrever
        // silenciosamente — avisar explicitamente; a matriz já foi
        // recarregada com os valores reais acima.
        alert('Estas permissões foram alteradas em outra sessão. A matriz foi recarregada com os valores mais recentes — revise e tente novamente se necessário.');
      } else if (typeof toastAdmin === 'function') {
        toastAdmin(aplicadas.length + ' permissão(ões) salva(s) com sucesso.');
      }
    } catch (e) {
      // Checkpoint 13: não finge sucesso, mantém edições locais para
      // nova tentativa, não expõe SQL/stack trace.
      AM_STATE.saving = false;
      setAdminModalMsg('Não foi possível salvar as permissões.', true);
      amRerenderInPlace();
    }
  }

  // Checkpoint 17 — sair da aba com alterações não salvas pede
  // confirmação antes de descartar (preferência do usuário: não
  // bloquear navegação indefinidamente, só confirmar uma vez).
  const amPreviousSetMasterTab = window.setMasterTab;
  if (typeof amPreviousSetMasterTab === 'function') {
    window.setMasterTab = function (tab) {
      if (typeof MASTER_TAB !== 'undefined' && MASTER_TAB === 'acessosModulos' && tab !== 'acessosModulos' && AM_STATE.dirty && !AM_STATE.saving) {
        if (!confirm('Existem alterações de acesso não salvas. Deseja descartá-las?')) return;
        AM_STATE.localPermissions = Object.assign({}, AM_STATE.serverSnapshot);
        AM_STATE.dirty = false;
      }
      return amPreviousSetMasterTab.apply(this, arguments);
    };
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
        <button class="adminActionBtn" onclick="amDiscard()" ${(AM_STATE.dirty && !AM_STATE.saving) ? '' : 'disabled'}>Descartar alterações</button>
        <button class="adminActionBtn" onclick="amReload()" ${AM_STATE.saving ? 'disabled' : ''}>Recarregar da base</button>
        <button class="adminActionBtn good" onclick="amOpenSaveConfirm()" ${(AM_STATE.dirty && !AM_STATE.saving) ? '' : 'disabled'}>${AM_STATE.saving ? 'Salvando...' : 'Salvar permissões'}</button>
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
