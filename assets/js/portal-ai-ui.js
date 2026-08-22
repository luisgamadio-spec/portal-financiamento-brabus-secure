/* Fase IA-2B — Brabus F&I Intelligence: interface do chat (botão MASTER-only
   no header + drawer lateral). Consome exclusivamente a Edge Function
   portal-ai já homologada (IA-2A/IA-2A.4) pelo contrato HTTP existente
   (POST {message, conversation}, resposta {reply, request_id}). Nenhuma
   tool nova, nenhuma alteração de backend, nenhuma chave (OpenAI ou
   service_role) toca este arquivo — só o JWT da sessão atual do usuário.

   Conversa existe somente em memória desta página (AI_CONVERSATION) —
   nunca em localStorage/sessionStorage/cookies/URL. Refresh ou logout
   apagam o histórico.

   Segurança de renderização (crítico): o texto retornado pelo modelo
   NUNCA é inserido via innerHTML — baiRenderMarkdown constrói a árvore de
   nós DOM diretamente (createElement/createTextNode), então mesmo um
   prompt-injection bem-sucedido não teria como injetar HTML/JS real. O
   chrome estático do drawer (título, placeholder, rótulos) é 100% texto
   fixo desta função e não contém conteúdo do modelo. */
(function () {
  'use strict';

  var AI_SENDING = false;
  var AI_CONVERSATION = []; // [{role:'user'|'assistant', content:string}], só em memória

  var BAI_SUGGESTIONS = [
    'Como estamos nesta competência?',
    'Qual loja tem maior share?',
    'Top 5 vendedores por retorno',
    'Compare Alphaville com Bandeirantes'
  ];

  var BAI_GREETING = 'Olá. Posso analisar os resultados do Portal e responder perguntas sobre vendas, financiamentos, share, produção, retorno e SPF.';
  var BAI_FOOTER = 'As respostas são baseadas nos dados disponíveis no Portal. Para decisões financeiras formais, confira os relatórios oficiais.';

  var BAI_REQUEST_TIMEOUT_MS = 60000; // acima do orçamento de 55s da Edge Function

  // ---------- Renderização segura do texto do modelo (nunca innerHTML) ----------

  function baiRenderInline(parent, text) {
    var boldParts = String(text).split(/(\*\*[^*]+\*\*)/g);
    boldParts.forEach(function (part) {
      if (!part) return;
      var boldMatch = /^\*\*([^*]+)\*\*$/.exec(part);
      if (boldMatch) {
        var strong = document.createElement('strong');
        baiRenderLinks(strong, boldMatch[1]);
        parent.appendChild(strong);
      } else {
        baiRenderLinks(parent, part);
      }
    });
  }

  function baiRenderLinks(parent, text) {
    var linkRe = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
    var lastIndex = 0, m, any = false;
    while ((m = linkRe.exec(text))) {
      any = true;
      if (m.index > lastIndex) parent.appendChild(document.createTextNode(text.slice(lastIndex, m.index)));
      var a = document.createElement('a');
      a.textContent = m[1];
      a.href = m[2];
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      parent.appendChild(a);
      lastIndex = linkRe.lastIndex;
    }
    if (!any) { parent.appendChild(document.createTextNode(text)); return; }
    if (lastIndex < text.length) parent.appendChild(document.createTextNode(text.slice(lastIndex)));
  }

  function baiBuildTable(lines) {
    var wrap = document.createElement('div');
    wrap.className = 'brabusAiTableWrap';
    var table = document.createElement('table');
    table.className = 'brabusAiTable';
    var rows = lines.map(function (l) {
      return l.replace(/^\||\|$/g, '').split('|').map(function (c) { return c.trim(); });
    });
    var bodyRows = rows, headerRow = null;
    if (rows.length > 1 && rows[1].every(function (c) { return /^:?-{2,}:?$/.test(c); })) {
      headerRow = rows[0];
      bodyRows = rows.slice(2);
    }
    if (headerRow) {
      var thead = document.createElement('thead');
      var trh = document.createElement('tr');
      headerRow.forEach(function (c) {
        var th = document.createElement('th');
        baiRenderInline(th, c);
        trh.appendChild(th);
      });
      thead.appendChild(trh);
      table.appendChild(thead);
    }
    var tbody = document.createElement('tbody');
    bodyRows.forEach(function (r) {
      var tr = document.createElement('tr');
      r.forEach(function (c) {
        var td = document.createElement('td');
        baiRenderInline(td, c);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  function baiRenderMarkdown(container, text) {
    var blocks = String(text).replace(/\r\n/g, '\n').split(/\n{2,}/);
    blocks.forEach(function (block) {
      block = block.trim();
      if (!block) return;
      var lines = block.split('\n').map(function (l) { return l.trim(); }).filter(function (l) { return l.length; });
      if (!lines.length) return;

      if (lines.length >= 2 && lines.every(function (l) { return /^\|.*\|$/.test(l); })) {
        container.appendChild(baiBuildTable(lines));
        return;
      }
      if (lines.every(function (l) { return /^[-*]\s+/.test(l); })) {
        var ul = document.createElement('ul');
        ul.className = 'brabusAiList';
        lines.forEach(function (l) {
          var li = document.createElement('li');
          baiRenderInline(li, l.replace(/^[-*]\s+/, ''));
          ul.appendChild(li);
        });
        container.appendChild(ul);
        return;
      }
      if (lines.every(function (l) { return /^\d+\.\s+/.test(l); })) {
        var ol = document.createElement('ol');
        ol.className = 'brabusAiList';
        lines.forEach(function (l) {
          var li2 = document.createElement('li');
          baiRenderInline(li2, l.replace(/^\d+\.\s+/, ''));
          ol.appendChild(li2);
        });
        container.appendChild(ol);
        return;
      }
      var p = document.createElement('p');
      lines.forEach(function (l, i) {
        if (i > 0) p.appendChild(document.createElement('br'));
        baiRenderInline(p, l);
      });
      container.appendChild(p);
    });
  }

  function baiBuildBubble(role, content) {
    var bubble = document.createElement('div');
    bubble.className = 'brabusAiBubble ' + (role === 'user' ? 'brabusAiBubbleUser' : 'brabusAiBubbleAi');
    if (role === 'user') {
      bubble.textContent = content;
    } else {
      baiRenderMarkdown(bubble, content);
    }
    return bubble;
  }

  function baiBuildErrorBubble(message) {
    var bubble = document.createElement('div');
    bubble.className = 'brabusAiBubble brabusAiBubbleError';
    bubble.textContent = message;
    return bubble;
  }

  function baiBuildLoadingBubble() {
    var bubble = document.createElement('div');
    bubble.className = 'brabusAiBubble brabusAiBubbleLoading';
    bubble.textContent = 'Analisando os dados do Portal...';
    return bubble;
  }

  // ---------- Chrome do drawer (strings próprias — innerHTML seguro aqui) ----------

  function baiChromeHTML() {
    return '' +
      '<div class="brabusAiHeader">' +
      '<div><div class="brabusAiTitle">Brabus F&amp;I Intelligence <span class="brabusAiBadge">BETA</span></div>' +
      '<div class="brabusAiSubtitle">Inteligência operacional conectada aos dados do Portal.</div></div>' +
      '<div class="brabusAiHeaderActions">' +
      '<button type="button" class="brabusAiNewChatBtn" onclick="novaConversaBrabusAI()">Nova conversa</button>' +
      '<button type="button" class="brabusAiCloseBtn" aria-label="Fechar" onclick="fecharBrabusAI()">✕</button>' +
      '</div></div>' +
      '<div class="brabusAiBody" id="brabusAiBody"></div>' +
      '<div class="brabusAiInputBar">' +
      '<textarea id="brabusAiInput" class="brabusAiInput" placeholder="Pergunte sobre os resultados do Portal..." rows="1" onkeydown="brabusAiKeydown(event)" oninput="brabusAiOnInput()"></textarea>' +
      '<button type="button" id="brabusAiSendBtn" class="brabusAiSendBtn" onclick="enviarBrabusAI()" disabled>Enviar</button>' +
      '</div>' +
      '<div class="brabusAiFooter">' + BAI_FOOTER + '</div>';
  }

  function baiMountIfNeeded() {
    var drawer = document.getElementById('brabusAiDrawer');
    if (drawer && !drawer.dataset.mounted) {
      drawer.innerHTML = baiChromeHTML();
      drawer.dataset.mounted = '1';
    }
  }

  function baiRenderBody() {
    var body = document.getElementById('brabusAiBody');
    if (!body) return;
    body.innerHTML = '';
    if (AI_CONVERSATION.length === 0) {
      var greet = document.createElement('div');
      greet.className = 'brabusAiGreeting';
      greet.textContent = BAI_GREETING;
      body.appendChild(greet);

      var sugWrap = document.createElement('div');
      sugWrap.className = 'brabusAiSuggestions';
      BAI_SUGGESTIONS.forEach(function (s) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'brabusAiSuggestionChip';
        btn.textContent = s;
        btn.onclick = function () { window.enviarSugestaoBrabusAI(s); };
        sugWrap.appendChild(btn);
      });
      body.appendChild(sugWrap);
    } else {
      AI_CONVERSATION.forEach(function (msg) {
        body.appendChild(baiBuildBubble(msg.role, msg.content));
      });
      if (AI_SENDING) body.appendChild(baiBuildLoadingBubble());
    }
    body.scrollTop = body.scrollHeight;
  }

  function baiRenderBodyWithError(message) {
    baiRenderBody();
    var body = document.getElementById('brabusAiBody');
    if (body) {
      body.appendChild(baiBuildErrorBubble(message));
      body.scrollTop = body.scrollHeight;
    }
    window.brabusAiOnInput();
  }

  // ---------- Envio ----------

  async function baiSend(text) {
    if (AI_SENDING || !text) return;
    AI_SENDING = true;
    AI_CONVERSATION.push({ role: 'user', content: text });
    baiRenderBody();
    window.brabusAiOnInput();

    var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timeoutId = controller ? setTimeout(function () { controller.abort(); }, BAI_REQUEST_TIMEOUT_MS) : null;

    try {
      var sessionResult = await supabaseClient.auth.getSession();
      var session = sessionResult && sessionResult.data ? sessionResult.data.session : null;
      if (!session) {
        AI_SENDING = false;
        if (timeoutId) clearTimeout(timeoutId);
        baiRenderBodyWithError('Sessão expirada — entre novamente.');
        return;
      }

      var priorTurns = AI_CONVERSATION.slice(0, -1).slice(-8);
      var resp;
      try {
        resp = await fetch(SUPABASE_URL + '/functions/v1/portal-ai', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_ANON_KEY,
            'Authorization': 'Bearer ' + session.access_token
          },
          body: JSON.stringify({ message: text, conversation: priorTurns }),
          signal: controller ? controller.signal : undefined
        });
      } catch (networkErr) {
        AI_SENDING = false;
        if (networkErr && networkErr.name === 'AbortError') {
          baiRenderBodyWithError('A análise demorou mais do que o esperado. Tente novamente.');
        } else {
          baiRenderBodyWithError('Não foi possível concluir a análise agora. Tente novamente.');
        }
        return;
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }

      var result = await resp.json().catch(function () { return {}; });
      AI_SENDING = false;

      if (resp.ok && typeof result.reply === 'string') {
        AI_CONVERSATION.push({ role: 'assistant', content: result.reply });
        baiRenderBody();
        window.brabusAiOnInput();
        return;
      }

      var friendly;
      if (resp.status === 401) {
        friendly = 'Sessão expirada — entre novamente.';
      } else if (resp.status === 403) {
        friendly = 'Este recurso não está disponível para o seu perfil.';
      } else if (resp.status === 429) {
        friendly = 'A inteligência está temporariamente indisponível por limite de uso. Tente novamente em alguns instantes.';
      } else {
        friendly = 'Não foi possível concluir a análise agora. Tente novamente.';
      }
      baiRenderBodyWithError(friendly);
    } catch (e) {
      AI_SENDING = false;
      if (timeoutId) clearTimeout(timeoutId);
      baiRenderBodyWithError('Não foi possível concluir a análise agora. Tente novamente.');
    }
  }

  // ---------- API pública (chamada via onclick inline / portal-app.js) ----------

  window.abrirBrabusAI = function () {
    baiMountIfNeeded();
    var overlay = document.getElementById('brabusAiOverlay');
    if (!overlay) return;
    overlay.classList.add('show');
    baiRenderBody();
    setTimeout(function () {
      var input = document.getElementById('brabusAiInput');
      if (input) input.focus();
    }, 50);
  };

  window.fecharBrabusAI = function () {
    var overlay = document.getElementById('brabusAiOverlay');
    if (overlay) overlay.classList.remove('show');
  };

  window.novaConversaBrabusAI = function () {
    if (AI_SENDING) return;
    AI_CONVERSATION = [];
    baiRenderBody();
    var input = document.getElementById('brabusAiInput');
    if (input) { input.value = ''; window.brabusAiOnInput(); }
  };

  window.enviarSugestaoBrabusAI = function (text) {
    baiSend(text);
  };

  window.enviarBrabusAI = function () {
    var input = document.getElementById('brabusAiInput');
    if (!input) return;
    var text = input.value.trim();
    if (!text || AI_SENDING) return;
    input.value = '';
    input.style.height = 'auto';
    window.brabusAiOnInput();
    baiSend(text);
  };

  window.brabusAiKeydown = function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      window.enviarBrabusAI();
    }
  };

  window.brabusAiOnInput = function () {
    var input = document.getElementById('brabusAiInput');
    var btn = document.getElementById('brabusAiSendBtn');
    if (input) {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 140) + 'px';
    }
    if (btn && input) btn.disabled = AI_SENDING || !input.value.trim();
    else if (btn) btn.disabled = true;
  };

  // Botão do header — MASTER-only, gate real (não apenas cosmético: o
  // backend nega qualquer não-MASTER de qualquer forma — Parte AR).
  window.renderBrabusAIButton = function () {
    try {
      var isMaster = (typeof REAL_USER !== 'undefined') && REAL_USER &&
        String(REAL_USER.tipo || '').trim().toUpperCase() === 'MASTER';
      if (!isMaster) {
        window.removeBrabusAIButton();
        return;
      }
      var host = document.getElementById('topHeaderRight');
      if (!host || document.getElementById('brabusAiBtn')) return;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.id = 'brabusAiBtn';
      btn.className = 'brabusAiBtn';
      var icon = document.createElement('span');
      icon.className = 'brabusAiBtnIcon';
      icon.textContent = '✦';
      var badge = document.createElement('span');
      badge.className = 'brabusAiBtnBadge';
      badge.textContent = 'BETA';
      btn.appendChild(icon);
      btn.appendChild(document.createTextNode(' Brabus Intelligence '));
      btn.appendChild(badge);
      btn.onclick = function () { window.abrirBrabusAI(); };
      host.insertBefore(btn, host.firstChild);
    } catch (e) {
      // A IA nunca deve derrubar o Portal — falha aqui é silenciosa.
    }
  };

  window.removeBrabusAIButton = function () {
    var btn = document.getElementById('brabusAiBtn');
    if (btn) btn.remove();
    var overlay = document.getElementById('brabusAiOverlay');
    if (overlay) overlay.classList.remove('show');
    AI_CONVERSATION = [];
    AI_SENDING = false;
  };

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      var overlay = document.getElementById('brabusAiOverlay');
      if (overlay && overlay.classList.contains('show')) window.fecharBrabusAI();
    }
  });
})();
