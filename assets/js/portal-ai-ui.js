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

  // Fase IA-2C.1, Parte D/L/K — fallback de segurança para Markdown table
  // livre do modelo (não um block estruturado — este parser continua
  // existindo para qualquer tabela que o modelo ainda produza por conta
  // própria, apesar da instrução no system prompt para preferir blocks).
  // Tabelas de até 3 colunas cabem bem como <table> de verdade — mantidas
  // como estavam. Tabelas de 4+ colunas SEMPRE viravam scroll horizontal
  // interno na largura do drawer (medido: 615px de conteúdo em 340px
  // disponíveis) — convertidas em cartões empilhados (rótulo: valor),
  // mesmo princípio já usado no Ranking/Share do Portal: nunca tabela
  // apertada, cartão executivo.
  var BAI_TABLE_CARD_THRESHOLD = 3;

  function baiBuildTableAsCards(headerRow, bodyRows) {
    var wrap = document.createElement('div');
    wrap.className = 'brabusAiBlockPanel brabusAiTableCards';
    var list = document.createElement('div');
    list.className = 'brabusAiRankingList';
    bodyRows.forEach(function (r) {
      var card = document.createElement('div');
      card.className = 'brabusAiRankingItem';
      // Primeira coluna vira o título do cartão (mesmo padrão do
      // Ranking: identidade primeiro, métricas depois).
      var head = document.createElement('div');
      head.className = 'brabusAiRankingHead';
      var name = document.createElement('span');
      name.className = 'brabusAiRankingName';
      baiRenderInline(name, r[0] || '');
      head.appendChild(name);
      card.appendChild(head);
      if (headerRow) {
        var metricsWrap = document.createElement('div');
        metricsWrap.className = 'brabusAiRankingMetrics';
        for (var i = 1; i < r.length; i++) {
          var m = document.createElement('span');
          m.className = 'brabusAiRankingMetric';
          m.appendChild(document.createTextNode((headerRow[i] || '') + ': '));
          var b = document.createElement('b');
          baiRenderInline(b, r[i] || '');
          m.appendChild(b);
          metricsWrap.appendChild(m);
        }
        card.appendChild(metricsWrap);
      }
      list.appendChild(card);
    });
    wrap.appendChild(list);
    return wrap;
  }

  function baiBuildTable(lines) {
    var rows = lines.map(function (l) {
      return l.replace(/^\||\|$/g, '').split('|').map(function (c) { return c.trim(); });
    });
    var bodyRows = rows, headerRow = null;
    if (rows.length > 1 && rows[1].every(function (c) { return /^:?-{2,}:?$/.test(c); })) {
      headerRow = rows[0];
      bodyRows = rows.slice(2);
    }

    if (headerRow && headerRow.length > BAI_TABLE_CARD_THRESHOLD) {
      return baiBuildTableAsCards(headerRow, bodyRows);
    }

    var wrap = document.createElement('div');
    wrap.className = 'brabusAiTableWrap';
    var table = document.createElement('table');
    table.className = 'brabusAiTable';
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

  function baiBuildCallout(lines) {
    var box = document.createElement('div');
    box.className = 'brabusAiCallout';
    var icon = document.createElement('span');
    icon.className = 'brabusAiCalloutIcon';
    icon.textContent = '⚠'; // ⚠ — texto fixo, nunca vindo do modelo
    var textWrap = document.createElement('div');
    textWrap.className = 'brabusAiCalloutText';
    lines.forEach(function (l, i) {
      if (i > 0) textWrap.appendChild(document.createElement('br'));
      baiRenderInline(textWrap, l.replace(/^>\s?/, ''));
    });
    box.appendChild(icon);
    box.appendChild(textWrap);
    return box;
  }

  function baiRenderMarkdown(container, text) {
    var blocks = String(text).replace(/\r\n/g, '\n').split(/\n{2,}/);
    blocks.forEach(function (block) {
      block = block.trim();
      if (!block) return;
      var lines = block.split('\n').map(function (l) { return l.trim(); }).filter(function (l) { return l.length; });
      if (!lines.length) return;

      // Fase IA-2C.1 — bloco de citação Markdown ("> texto") vira destaque
      // visual (Parte N). Igual às demais construções, sempre via árvore
      // DOM — nunca innerHTML com conteúdo do modelo.
      if (lines.every(function (l) { return /^>\s?/.test(l); })) {
        container.appendChild(baiBuildCallout(lines));
        return;
      }
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

  // ---------- Fase IA-2C.1 — blocos visuais estruturados ----------
  // Princípio (Parte G): estes blocos vêm PRONTOS do backend, calculados
  // pelas tools — nunca recalculados aqui. O frontend só formata e
  // apresenta. Toda montagem via createElement/textContent (nunca
  // innerHTML), mesma disciplina de segurança do restante deste arquivo,
  // mesmo os campos vindo de dados (nome de vendedor/loja), não do texto
  // livre do modelo.

  function baiFormatValue(value, format) {
    if (value === null || value === undefined || typeof value !== 'number' || !isFinite(value)) {
      return { text: '—', title: null };
    }
    if (format === 'currency') {
      var full = value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 2, maximumFractionDigits: 2 });
      if (Math.abs(value) >= 1000000) {
        var compact = 'R$ ' + (value / 1000000).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' mi';
        return { text: compact, title: full };
      }
      return { text: full, title: null };
    }
    if (format === 'percent') {
      return { text: value.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + '%', title: null };
    }
    return { text: value.toLocaleString('pt-BR'), title: null };
  }

  function baiApplyValue(el, formatted) {
    el.textContent = formatted.text;
    if (formatted.title) el.title = formatted.title;
  }

  function baiBuildMetricsBlock(block) {
    var panel = document.createElement('div');
    panel.className = 'brabusAiBlockPanel';
    var title = document.createElement('div');
    title.className = 'brabusAiBlockTitle';
    title.textContent = block.title || 'Resultado';
    panel.appendChild(title);
    var grid = document.createElement('div');
    grid.className = 'brabusAiMetricsGrid';
    (block.items || []).forEach(function (item) {
      var card = document.createElement('div');
      card.className = 'brabusAiMetricCard';
      var label = document.createElement('span');
      label.className = 'brabusAiMetricLabel';
      label.textContent = item.label != null ? String(item.label) : '';
      var val = document.createElement('span');
      val.className = 'brabusAiMetricValue';
      baiApplyValue(val, baiFormatValue(item.value, item.format));
      card.appendChild(label);
      card.appendChild(val);
      grid.appendChild(card);
    });
    panel.appendChild(grid);
    return panel;
  }

  var BAI_RANKING_METRIC_LABELS = { sales: 'Vendas', financed: 'Financiamentos', share_percent: 'Share', production: 'Produção', return: 'Retorno', return_avg_percent: 'Retorno Médio', spf: 'SPF', profitability: 'Rentabilidade' };
  var BAI_RANKING_METRIC_FORMATS = { sales: 'int', financed: 'int', share_percent: 'percent', production: 'currency', return: 'currency', return_avg_percent: 'percent', spf: 'currency', profitability: 'currency' };
  // Fase IA-2C.2 — o nome da métrica que originou o ranking (block.metric,
  // ex.: "share", "return_avg") nem sempre é igual à chave do item que a
  // contém (ex.: "share_percent", "return_avg_percent"). Sem este mapa, a
  // métrica escolhida pelo usuário nunca aparecia em destaque no card —
  // bug pré-existente da IA-2C.1 (afetava "share"), agora corrigido junto
  // com as métricas novas desta fase.
  var BAI_RANKING_METRIC_KEY = { sales: 'sales', financed: 'financed', share: 'share_percent', production: 'production', return: 'return', return_avg: 'return_avg_percent', spf: 'spf', profitability: 'profitability' };
  var BAI_MEDALS = { 1: '\u{1F947}', 2: '\u{1F948}', 3: '\u{1F949}' };

  function baiBuildRankingBlock(block) {
    var panel = document.createElement('div');
    panel.className = 'brabusAiBlockPanel';
    var title = document.createElement('div');
    title.className = 'brabusAiBlockTitle';
    title.textContent = block.title || 'Ranking';
    panel.appendChild(title);
    var list = document.createElement('div');
    list.className = 'brabusAiRankingList';
    (block.items || []).forEach(function (item) {
      var row = document.createElement('div');
      row.className = 'brabusAiRankingItem' + (item.position <= 3 ? ' brabusAiTop3' : '');
      var head = document.createElement('div');
      head.className = 'brabusAiRankingHead';
      var pos = document.createElement('span');
      pos.className = 'brabusAiRankingPos';
      pos.textContent = (BAI_MEDALS[item.position] ? BAI_MEDALS[item.position] + ' ' : '') + item.position + 'º';
      var name = document.createElement('span');
      name.className = 'brabusAiRankingName';
      name.textContent = item.name != null ? String(item.name) : '';
      head.appendChild(pos);
      head.appendChild(name);
      row.appendChild(head);

      var metricsWrap = document.createElement('div');
      metricsWrap.className = 'brabusAiRankingMetrics';
      // Métrica que originou o ranking sempre aparece primeiro, em
      // destaque — as demais completam o contexto (Parte I: "adaptar
      // campos conforme a pergunta", sem presumir sempre as mesmas).
      var orderedKeys = ['sales', 'financed', 'share_percent', 'production', 'return', 'return_avg_percent', 'spf', 'profitability'];
      var priorityKey = block.metric ? BAI_RANKING_METRIC_KEY[block.metric] : null;
      if (priorityKey && orderedKeys.indexOf(priorityKey) !== -1) {
        orderedKeys = [priorityKey].concat(orderedKeys.filter(function (k) { return k !== priorityKey; }));
      }
      orderedKeys.forEach(function (key) {
        // Fase IA-2C.2 — null (não só ausente) também não vira card: campos
        // que não existem no grão da consulta (ex.: SPF/Rentabilidade num
        // ranking por modelo) vêm explicitamente null da tool, nunca "—"
        // fantasma sugerindo um dado que a fonte não tem (Parte Y).
        if (!(key in item) || item[key] === null || item[key] === undefined) return;
        var m = document.createElement('span');
        m.className = 'brabusAiRankingMetric';
        var label = BAI_RANKING_METRIC_LABELS[key] || key;
        var formatted = baiFormatValue(item[key], BAI_RANKING_METRIC_FORMATS[key]);
        var b = document.createElement('b');
        baiApplyValue(b, formatted);
        m.appendChild(document.createTextNode(label + ': '));
        m.appendChild(b);
        metricsWrap.appendChild(m);
      });
      row.appendChild(metricsWrap);
      list.appendChild(row);
    });
    panel.appendChild(list);
    return panel;
  }

  function baiFormatDelta(delta) {
    if (!delta || delta.percent === null || delta.percent === undefined || !isFinite(delta.percent)) {
      return { text: '— sem base anterior', cls: 'na' };
    }
    var cls = delta.percent > 0 ? 'up' : (delta.percent < 0 ? 'down' : 'flat');
    var icon = delta.percent > 0 ? '▲' : (delta.percent < 0 ? '▼' : '▬');
    var val = Math.abs(delta.percent).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    return { text: icon + ' ' + (delta.percent >= 0 ? '+' : '') + val + '%', cls: cls };
  }

  function baiBuildComparisonSide(side) {
    var card = document.createElement('div');
    card.className = 'brabusAiComparisonCard';
    var name = document.createElement('div');
    name.className = 'brabusAiComparisonName';
    name.textContent = side.label != null ? String(side.label) : '';
    card.appendChild(name);
    (side.items || []).forEach(function (item) {
      var row = document.createElement('div');
      row.className = 'brabusAiComparisonRow';
      var label = document.createElement('span');
      label.className = 'brabusAiRankingMetric';
      label.textContent = item.label != null ? String(item.label) : '';
      var val = document.createElement('b');
      baiApplyValue(val, baiFormatValue(item.value, item.format));
      row.appendChild(label);
      row.appendChild(val);
      card.appendChild(row);
    });
    return card;
  }

  var BAI_DELTA_LABELS = { sales: 'Vendas', financed: 'Financiamentos', share_points: 'Share (p.p.)', production: 'Produção', return: 'Retorno', spf: 'SPF' };

  function baiBuildComparisonBlock(block) {
    var panel = document.createElement('div');
    panel.className = 'brabusAiBlockPanel';
    var title = document.createElement('div');
    title.className = 'brabusAiBlockTitle';
    title.textContent = block.title || 'Comparação';
    panel.appendChild(title);
    var grid = document.createElement('div');
    grid.className = 'brabusAiComparisonGrid';
    if (block.a) grid.appendChild(baiBuildComparisonSide(block.a));
    if (block.b) grid.appendChild(baiBuildComparisonSide(block.b));
    panel.appendChild(grid);

    if (block.deltas) {
      var deltasWrap = document.createElement('div');
      deltasWrap.className = 'brabusAiComparisonDeltas';
      Object.keys(block.deltas).forEach(function (key) {
        var raw = block.deltas[key];
        var row = document.createElement('div');
        row.className = 'brabusAiDeltaRow';
        var label = document.createElement('span');
        label.className = 'brabusAiDeltaLabel';
        label.textContent = BAI_DELTA_LABELS[key] || key;
        var val = document.createElement('span');
        val.className = 'brabusAiDeltaVal';
        if (key === 'share_points') {
          // share_points é diferença simples em pontos percentuais, não
          // um delta relativo — sem ícone/cor de "variação percentual".
          val.textContent = (typeof raw === 'number' && isFinite(raw)) ? ((raw >= 0 ? '+' : '') + raw.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' p.p.') : '—';
        } else {
          var f = baiFormatDelta(raw);
          val.textContent = f.text;
          val.className += ' ' + f.cls;
        }
        row.appendChild(label);
        row.appendChild(val);
        deltasWrap.appendChild(row);
      });
      panel.appendChild(deltasWrap);
    }
    return panel;
  }

  // Fase IA-2C.3, Parte U/V — bloco "operations": lista de operações
  // individuais (Coparticipado/Subsidiado), sempre cards (nunca tabela
  // horizontal, mesmo no desktop — Parte V é explícita: cada operação é
  // uma linha de negócio, não uma célula de planilha). Cada campo já
  // chega seguro do backend (referência mascarada, nunca cliente/chassi
  // completo) — aqui só formata, textContent em tudo, igual ao resto
  // deste arquivo.
  function baiBuildOperationsBlock(block) {
    var panel = document.createElement('div');
    panel.className = 'brabusAiBlockPanel';
    var title = document.createElement('div');
    title.className = 'brabusAiBlockTitle';
    title.textContent = block.title || 'Operações';
    panel.appendChild(title);

    var summary = document.createElement('div');
    summary.className = 'brabusAiOperationsSummary';
    var summaryText = (block.total_count != null ? block.total_count : (block.items || []).length) + ' operação(ões)';
    if (block.total_financed_value != null) {
      summaryText += ' · Financiado: ' + baiFormatValue(block.total_financed_value, 'currency').text;
    }
    summary.textContent = summaryText;
    panel.appendChild(summary);

    var list = document.createElement('div');
    list.className = 'brabusAiOperationsList';
    (block.items || []).forEach(function (op) {
      var card = document.createElement('div');
      card.className = 'brabusAiOperationCard';

      var head = document.createElement('div');
      head.className = 'brabusAiOperationHead';
      var ref = document.createElement('span');
      ref.className = 'brabusAiOperationRef';
      ref.textContent = op.reference != null ? String(op.reference) : '—';
      head.appendChild(ref);
      if (op.date) {
        var dateEl = document.createElement('span');
        dateEl.className = 'brabusAiOperationDate';
        dateEl.textContent = String(op.date);
        head.appendChild(dateEl);
      }
      card.appendChild(head);

      var loc = document.createElement('div');
      loc.className = 'brabusAiOperationLine';
      loc.textContent = [op.store, op.department].filter(Boolean).join(' · ');
      card.appendChild(loc);

      if (op.model) {
        var modelEl = document.createElement('div');
        modelEl.className = 'brabusAiOperationLine';
        modelEl.textContent = String(op.model);
        card.appendChild(modelEl);
      }
      if (op.seller) {
        var sellerEl = document.createElement('div');
        sellerEl.className = 'brabusAiOperationLine brabusAiOperationSeller';
        sellerEl.textContent = String(op.seller);
        card.appendChild(sellerEl);
      }

      var metricsWrap = document.createElement('div');
      metricsWrap.className = 'brabusAiRankingMetrics';
      [['financed_value', 'Financiado', 'currency'], ['return_value', 'Retorno', 'currency']].forEach(function (m) {
        if (op[m[0]] === null || op[m[0]] === undefined) return;
        var span = document.createElement('span');
        span.className = 'brabusAiRankingMetric';
        var b = document.createElement('b');
        baiApplyValue(b, baiFormatValue(op[m[0]], m[2]));
        span.appendChild(document.createTextNode(m[1] + ': '));
        span.appendChild(b);
        metricsWrap.appendChild(span);
      });
      card.appendChild(metricsWrap);

      list.appendChild(card);
    });
    panel.appendChild(list);

    if (block.truncated) {
      var note = document.createElement('div');
      note.className = 'brabusAiOperationsNote';
      note.textContent = 'Mostrando ' + (block.shown_count != null ? block.shown_count : (block.items || []).length) + ' de ' + block.total_count + ' operações no total.';
      panel.appendChild(note);
    }
    return panel;
  }

  function baiBuildBlock(block) {
    if (!block || typeof block !== 'object') return null;
    try {
      if (block.type === 'metrics' && Array.isArray(block.items)) return baiBuildMetricsBlock(block);
      if (block.type === 'ranking' && Array.isArray(block.items)) return baiBuildRankingBlock(block);
      if (block.type === 'comparison' && block.a && block.b) return baiBuildComparisonBlock(block);
      if (block.type === 'operations' && Array.isArray(block.items)) return baiBuildOperationsBlock(block);
    } catch (e) {
      // Parte AK — bloco inválido nunca derruba o chat: ignora silenciosamente,
      // a resposta em texto (sempre presente) continua chegando normal.
      return null;
    }
    return null;
  }

  function baiBuildBlocksWrap(blocks) {
    if (!Array.isArray(blocks) || !blocks.length) return null;
    var wrap = document.createElement('div');
    wrap.className = 'brabusAiBlocks';
    var any = false;
    blocks.forEach(function (b) {
      var el = baiBuildBlock(b);
      if (el) { wrap.appendChild(el); any = true; }
    });
    return any ? wrap : null;
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

  // Fase IA-2C.1, Parte U/AL — mensagens do usuário continuam bolha pura
  // (comportamento intocado). Mensagens da IA sem blocks (histórico
  // antigo, ou resposta puramente textual) também continuam só a bolha —
  // 100% compatível com o formato anterior. Só quando blocks existe e
  // produz pelo menos 1 elemento válido é que a mensagem vira um wrapper
  // com a bolha (texto curto) + blocos soltos, largura cheia do body.
  function baiBuildMessage(msg) {
    var bubble = baiBuildBubble(msg.role, msg.content);
    if (msg.role === 'user') return bubble;
    var blocksWrap = baiBuildBlocksWrap(msg.blocks);
    if (!blocksWrap) return bubble;
    var wrap = document.createElement('div');
    wrap.className = 'brabusAiMessage';
    wrap.appendChild(bubble);
    wrap.appendChild(blocksWrap);
    return wrap;
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
      '<button type="button" id="brabusAiExpandBtn" class="brabusAiExpandBtn" aria-label="Expandir" aria-pressed="false" onclick="toggleBrabusAIExpand()">⤢</button>' +
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
        body.appendChild(baiBuildMessage(msg));
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

      // Envia só {role, content} — blocks é dado já servido ao cliente,
      // reenviá-lo no histórico não ajuda o modelo e só infla o payload
      // (Parte AC).
      var priorTurns = AI_CONVERSATION.slice(0, -1).slice(-8).map(function (m) {
        return { role: m.role, content: m.content };
      });
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
        // blocks é opcional (Parte AL) — undefined/null aqui produz o
        // mesmo comportamento de sempre (só a bolha de texto).
        AI_CONVERSATION.push({ role: 'assistant', content: result.reply, blocks: Array.isArray(result.blocks) ? result.blocks : null });
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

  // Parte Q/R — alternância manual, nunca automática. Sem persistência
  // entre sessões (mesmo princípio de "conversa só em memória") — reabrir
  // o drawer volta ao estado normal.
  window.toggleBrabusAIExpand = function () {
    var drawer = document.getElementById('brabusAiDrawer');
    var btn = document.getElementById('brabusAiExpandBtn');
    if (!drawer) return;
    var expanded = drawer.classList.toggle('brabusAiExpanded');
    if (btn) {
      btn.setAttribute('aria-pressed', expanded ? 'true' : 'false');
      btn.setAttribute('aria-label', expanded ? 'Recolher' : 'Expandir');
    }
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
    var drawer = document.getElementById('brabusAiDrawer');
    if (drawer) drawer.classList.remove('brabusAiExpanded');
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
