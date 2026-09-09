/* IA-UAT-VOICE-03, Parte C/M/N — Voice Studio: laboratório de voz.
   LAB ONLY — existe só em uat-serve, nunca na UI final/produção.
   Nunca chama consultar_portal_intelligence, nunca vê pergunta
   financeira real: cada sessão aqui só lê em voz alta um dos 3 textos
   padrão, com a voz/perfil/velocidade escolhidos, e encerra. Nenhuma
   decisão de voz definitiva é tomada por código — só o usuário escolhe. */
(function () {
  'use strict';

  var VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];
  var RECOMMENDED_FIRST = ['marin', 'cedar', 'sage', 'coral']; // achado oficial: "recomendamos marin ou cedar para melhor qualidade" — mostrados primeiro, resto acessível

  // Parte C4/C5 — 3 perfis, cada um seguindo o formato oficial
  // recomendado (específico, estável, sem IPA, sem referência a pessoa
  // real, sem caricatura regional) — ver developers.openai.com/api/docs/guides/realtime-models-prompting.
  var PROFILES = {
    pt_br_neutral: {
      label: 'PT-BR Neutral',
      text: 'Fale português do Brasil como idioma padrão da resposta — nunca infira outro idioma a partir de sotaque ou palavras isoladas do usuário. Use pronúncia e prosódia nativas do Brasil, estáveis do início ao fim da fala. Evite entonação e ritmo típicos de um falante nativo de inglês americano falando português como segunda língua. Não exagere nenhuma marca regional — mantenha um português brasileiro neutro, sem sotaque regional específico (não paulista, não carioca, não mineiro, não gaúcho). Pronuncie números, valores em reais, percentuais e siglas técnicas da forma como um profissional brasileiro pronunciaria naturalmente numa conversa de negócios.'
    },
    pt_br_executive: {
      label: 'PT-BR Executive',
      text: 'Fale português do Brasil nativo e neutro, com ritmo confiante e direto, como um executivo brasileiro experiente conduzindo uma reunião de negócios. Cadência ligeiramente mais rápida que uma conversa casual, mas sem soar apressado — cada frase permanece clara. Prosódia e pronúncia estáveis do início ao fim, nativas do Brasil, sem marca de sotaque estrangeiro nem de nenhuma região específica do Brasil. Números, valores em reais, percentuais e termos técnicos financeiros pronunciados com naturalidade e precisão.'
    },
    pt_br_warm: {
      label: 'PT-BR Warm Professional (atual — Current/A)',
      text: 'Fale português do Brasil nativo, neutro e caloroso — como um consultor brasileiro experiente e simpático conversando com um colega de confiança. Ritmo conversacional, natural, com pausas humanas onde fariam sentido, nunca mecânico. Prosódia e pronúncia estáveis do início ao fim, nativas do Brasil, sem sotaque estrangeiro nem marca regional específica. Evite soar como locutor de propaganda ou como um script lido — mantenha a naturalidade de uma conversa real. Números, valores em reais e termos técnicos financeiros pronunciados com clareza e naturalidade.'
    },
    // UAT-VOICE-ACCENT-01, Gates B5/B6 — Candidatos B e C para A/B contra o
    // perfil atual (pt_br_warm, acima). Seguem o mesmo formato oficial
    // recomendado pela OpenAI (accent alvo + o que deve ficar estável +
    // pacing/stress/prosody — developers.openai.com/api/docs/guides/
    // realtime-models-prompting) — nunca IPA, nunca instrução fonética
    // inventada. Nenhum dos dois é default — só aparecem aqui para
    // comparação humana no Voice Studio.
    accent_candidate_b: {
      label: 'Candidato B — Pronúncia PT-BR Reforçada',
      text: 'Fale português do Brasil nativo, com pronúncia e prosódia 100% brasileiras do início ao fim da resposta — nunca revertendo para entonação de inglês americano em nenhum momento, mesmo em números, siglas ou termos técnicos. Mantenha estáveis as vogais e consoantes do português brasileiro. Pronuncie reais, mil, milhões, por cento, ao mês, ao ano, parcelas, entrada, financiamento, balão, rebate, CET e NET exatamente como um brasileiro nativo pronunciaria numa conversa de negócios — nunca como siglas soletradas em inglês. Ritmo caloroso e natural, como um consultor brasileiro experiente conversando com um colega de confiança — nunca mecânico, nunca com cadência de segunda língua.'
    },
    accent_candidate_c: {
      label: 'Candidato C — Prosódia/Ritmo PT-BR',
      text: 'Fale português do Brasil nativo com o ritmo e a musicalidade natural do português brasileiro falado — duração e ênfase de sílaba brasileiras do início ao fim, nunca o padrão de acentuação do inglês americano. Evite qualquer entonação ascendente ao final de frases afirmativas. Use pausas e conectivos naturais do português falado (\"então\", \"ou seja\", \"olha\") em vez de pausas mecânicas. Mantenha a mesma prosódia brasileira estável do primeiro ao último som da resposta, inclusive em números e valores em reais — nunca varie o sotaque durante a fala. Tom de consultor brasileiro caloroso e confiável, do início ao fim.'
    }
  };

  // Parte C3 — textos padrão, idênticos para toda comparação.
  var TEXTS = {
    comercial: 'Para esse Eclipse Cross HPE-S quatro por quatro, com setenta mil reais de entrada, eu começaria pelo Balão de quarenta e oito meses. A parcela fica em quatro mil e sete reais e cinquenta centavos, com balão final de oitenta e sete mil trezentos e noventa reais e trinta e oito centavos.',
    conversacional: 'Entendi. Se o objetivo é baixar a parcela, eu tentaria primeiro o Balão. Se você quiser evitar uma parcela final alta, eu comparo com o Linear e te mostro a diferença.',
    termos: 'Brabus F&I Intelligence. Mitsubishi Eclipse Cross HPE-S, Triton, Outlander, Coparticipado, Subsidiado, Reversão, SPF e CDI.',
    // Parte D — matriz compacta de pronúncia (moeda, percentuais, prazos,
    // siglas, HPE-S com qualificador de tração) — não é um dicionário
    // gigante, é uma amostra representativa de cada categoria D1-D5 num
    // texto só, para julgamento humano no próprio Voice Studio.
    pronuncia: 'A parcela é de setecentos reais em doze vezes, ou quatro mil e sete reais e cinquenta centavos em quarenta e oito meses. O carro custa cento e quarenta e nove mil, novecentos e noventa reais. A taxa é de zero vírgula quarenta e nove por cento, chegando a trinta e um vírgula oitenta e dois por cento de entrada. HPE-S quatro por dois e HPE-S quatro por quatro são versões diferentes. SPF e CDI são termos do dia a dia do F&I.'
  };

  // UAT-VOICE-ACCENT-01, Gate B8/B9 — frases padrão da UAT humana de
  // sotaque, adicionadas às já existentes acima sem remover nenhuma.
  // contrato_taxa é a frase primária pedida pelo usuário (Gate B8);
  // tradeoff cobre prosódia conversacional; longa cobre estabilidade ao
  // longo de uma resposta mais extensa (Gate B8 final, ~80-120 palavras).
  TEXTS.contrato_taxa = 'Tenho um cliente financiando noventa mil reais em quarenta e oito parcelas de dois mil novecentos e um reais. A taxa NET é de um vírgula setenta e três por cento ao mês, e a taxa CET é de um vírgula noventa e quatro por cento ao mês.';
  TEXTS.tradeoff = 'Para este cliente, eu compararia as duas condições. A primeira tem uma parcela mensal menor, mas exige um pagamento final maior. Se a prioridade for previsibilidade, eu apresentaria também a alternativa sem balão.';
  TEXTS.longa = 'Bom dia, como posso ajudar? Este veículo custa duzentos e dezenove mil novecentos e noventa reais, e a entrada é de setenta mil reais. Com essas condições, o financiamento linear em trinta e seis meses fica com parcela mensal de seis mil quatrocentos e noventa e oito reais e quarenta e quatro centavos. Já no plano Balão, a parcela cai bastante, mas existe um pagamento especial no final do contrato — nesse caso, o balão final ficaria em oitenta e sete mil trezentos e noventa reais. Posso comparar as duas condições para você, mostrando a parcela mensal de cada uma e também o valor total pago ao longo do contrato, incluindo entrada, parcelas e o pagamento final quando houver balão. O plano possui quarenta e oito parcelas nessa segunda opção, e o rebate é o custo comercial da taxa para a loja, nunca uma comissão do vendedor.';

  var pc = null, dc = null, micStream = null, audioEl = null;
  var slots = { A: null, B: null }; // {voice, profileKey, customText, speed, textKey}

  function el(tag, props) {
    var e = document.createElement(tag);
    if (props) Object.keys(props).forEach(function (k) { e[k] = props[k]; });
    return e;
  }

  function buildPanel() {
    var overlay = el('div', { id: 'brabusVoiceStudioOverlay', className: 'brabusVoiceStudioOverlay' });
    var panel = el('div', { className: 'brabusVoiceStudioPanel' });

    var header = el('div', { className: 'brabusVoiceStudioHeader' });
    header.appendChild(el('span', { textContent: '🧪 Voice Studio — LAB ONLY, não é a UI final' }));
    var closeBtn = el('button', { type: 'button', textContent: '✕', className: 'brabusVoiceStudioCloseBtn' });
    closeBtn.onclick = function () { window.baiVoiceStudioClose(); };
    header.appendChild(closeBtn);
    panel.appendChild(header);

    var body = el('div', { className: 'brabusVoiceStudioBody' });

    function row(labelText, control) {
      var r = el('div', { className: 'brabusVsRow' });
      r.appendChild(el('label', { textContent: labelText }));
      r.appendChild(control);
      body.appendChild(r);
      return r;
    }

    var voiceSel = el('select', { id: 'vsVoice' });
    RECOMMENDED_FIRST.concat(VOICES.filter(function (v) { return RECOMMENDED_FIRST.indexOf(v) < 0; })).forEach(function (v, i) {
      var opt = el('option', { value: v, textContent: v + (RECOMMENDED_FIRST.indexOf(v) >= 0 ? ' (recomendada)' : '') });
      voiceSel.appendChild(opt);
    });
    row('Voz', voiceSel);

    var profileSel = el('select', { id: 'vsProfile' });
    Object.keys(PROFILES).forEach(function (k) { profileSel.appendChild(el('option', { value: k, textContent: PROFILES[k].label })); });
    profileSel.appendChild(el('option', { value: 'custom', textContent: 'Custom (editar abaixo)' }));
    profileSel.value = 'pt_br_warm'; // UAT-VOICE-ACCENT-01 — abre já no perfil atual/Current, o baseline real da conversa
    row('Perfil de instrução', profileSel);

    var customText = el('textarea', { id: 'vsCustomProfile', rows: 3, hidden: true, placeholder: 'Descreva sotaque/prosódia — formato específico, nunca vago (ver Parte C5).' });
    body.appendChild(customText);
    profileSel.onchange = function () { customText.hidden = profileSel.value !== 'custom'; };

    // UAT-VOICE-ACCENT-01 — abre em 1.25 (a velocidade escolhida pelo
    // usuário para a conversa real, Gate B5: mantê-la fixa durante o A/B
    // de perfil); o slider continua livre para o diagnóstico separado de
    // velocidade (Gate B7).
    var speedInput = el('input', { id: 'vsSpeed', type: 'range', min: '0.25', max: '1.5', step: '0.05', value: '1.25' });
    var speedLabel = el('span', { id: 'vsSpeedLabel', textContent: '1.25x' });
    speedInput.oninput = function () { speedLabel.textContent = parseFloat(speedInput.value).toFixed(2) + 'x'; };
    var speedRow = row('Velocidade (audio.output.speed)', speedInput);
    speedRow.appendChild(speedLabel);

    var textSel = el('select', { id: 'vsText' });
    Object.keys(TEXTS).forEach(function (k) { textSel.appendChild(el('option', { value: k, textContent: k })); });
    textSel.value = 'contrato_taxa'; // UAT-VOICE-ACCENT-01, Gate B8 — frase primária sugerida para o A/B
    row('Texto padrão', textSel);

    var preview = el('div', { id: 'vsTextPreview', className: 'brabusVsPreview' });
    function updatePreview() { preview.textContent = TEXTS[textSel.value]; }
    textSel.onchange = updatePreview;
    updatePreview();
    body.appendChild(preview);

    var status = el('div', { id: 'vsStatus', className: 'brabusVsStatus' });
    body.appendChild(status);

    var playRow = el('div', { className: 'brabusVsButtonRow' });
    var playBtn = el('button', { type: 'button', className: 'brabusVsBtn brabusVsBtnPrimary', textContent: '▶ Reproduzir' });
    playBtn.onclick = function () { playCurrent(playBtn, status); };
    playRow.appendChild(playBtn);
    body.appendChild(playRow);

    var abRow = el('div', { className: 'brabusVsButtonRow' });
    ['A', 'B'].forEach(function (slot) {
      var saveBtn = el('button', { type: 'button', className: 'brabusVsBtn', textContent: 'Salvar como ' + slot });
      saveBtn.onclick = function () { saveSlot(slot, status); };
      var playSlotBtn = el('button', { type: 'button', className: 'brabusVsBtn', id: 'vsPlay' + slot, textContent: '▶ ' + slot, disabled: true });
      playSlotBtn.onclick = function () { playSlot(slot, playSlotBtn, status); };
      abRow.appendChild(saveBtn);
      abRow.appendChild(playSlotBtn);
    });
    body.appendChild(abRow);

    var copyBtn = el('button', { type: 'button', className: 'brabusVsBtn', textContent: '📋 Copiar configuração (JSON)' });
    copyBtn.onclick = function () { copyConfig(status); };
    body.appendChild(copyBtn);

    panel.appendChild(body);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
    return overlay;
  }

  function currentConfig() {
    var voice = document.getElementById('vsVoice').value;
    var profileKey = document.getElementById('vsProfile').value;
    var profileText = profileKey === 'custom' ? document.getElementById('vsCustomProfile').value : PROFILES[profileKey].text;
    var speed = parseFloat(document.getElementById('vsSpeed').value);
    var textKey = document.getElementById('vsText').value;
    return { voice: voice, profileKey: profileKey, profileText: profileText, speed: speed, textKey: textKey };
  }

  function setStatus(el2, text) { if (el2) el2.textContent = text; }

  function teardown() {
    if (dc) { try { dc.close(); } catch (e) { /* ignora */ } dc = null; }
    if (pc) { try { pc.close(); } catch (e) { /* ignora */ } pc = null; }
    if (micStream) { micStream.getTracks().forEach(function (t) { t.stop(); }); micStream = null; }
    if (audioEl) { try { audioEl.srcObject = null; } catch (e) { /* ignora */ } if (audioEl.parentNode) audioEl.parentNode.removeChild(audioEl); audioEl = null; }
  }

  function speakOnce(cfg, statusEl, onDone) {
    teardown(); // Etapa 5/10 do brief — nunca dois áudios simultâneos, mesmo no laboratório
    setStatus(statusEl, 'Conectando...');
    supabaseClient.auth.getSession().then(function (sessionResult) {
      var session = sessionResult && sessionResult.data ? sessionResult.data.session : null;
      if (!session) throw new Error('no-session');
      return fetch(SUPABASE_URL + '/functions/v1/portal-realtime-homolog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + session.access_token },
        body: JSON.stringify({ mode: 'studio', voice: cfg.voice, profile_text: cfg.profileText, speed: cfg.speed })
      });
    }).then(function (resp) {
      if (!resp.ok) throw new Error('mint-failed-' + resp.status);
      return resp.json();
    }).then(function (mint) {
      return navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) { return { mint: mint, stream: stream }; });
    }).then(function (pair) {
      micStream = pair.stream;
      micStream.getTracks().forEach(function (t) { t.enabled = false; }); // Voice Studio nunca ouve o usuário — só fala o texto padrão
      pc = new RTCPeerConnection();
      audioEl = document.createElement('audio');
      audioEl.autoplay = true;
      audioEl.style.position = 'absolute'; audioEl.style.width = '0'; audioEl.style.height = '0'; audioEl.style.opacity = '0';
      document.body.appendChild(audioEl);
      pc.ontrack = function (ev) { audioEl.srcObject = ev.streams[0]; };
      micStream.getTracks().forEach(function (t) { pc.addTrack(t, micStream); });

      dc = pc.createDataChannel('oai-events');
      dc.onopen = function () {
        setStatus(statusEl, 'Falando...');
        dc.send(JSON.stringify({
          type: 'conversation.item.create',
          item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Leia: ' + TEXTS[cfg.textKey] }] }
        }));
        dc.send(JSON.stringify({ type: 'response.create' }));
      };
      dc.onmessage = function (ev) {
        try {
          var evt = JSON.parse(ev.data);
          if (evt.type === 'response.done') {
            setStatus(statusEl, 'Concluído — ' + cfg.voice + ' / ' + (cfg.profileKey === 'custom' ? 'custom' : PROFILES[cfg.profileKey].label));
            setTimeout(function () { teardown(); if (onDone) onDone(); }, 1500); // deixa o áudio final terminar de tocar antes de fechar
          }
        } catch (e) { /* evento não-JSON, ignora */ }
      };

      return pc.createOffer().then(function (offer) {
        return pc.setLocalDescription(offer).then(function () {
          return fetch('https://api.openai.com/v1/realtime/calls', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + pair.mint.value, 'Content-Type': 'application/sdp' },
            body: offer.sdp
          });
        });
      }).then(function (sdpResp) {
        if (!sdpResp.ok) throw new Error('sdp-failed-' + sdpResp.status);
        return sdpResp.text();
      }).then(function (answerSdp) { return pc.setRemoteDescription({ type: 'answer', sdp: answerSdp }); });
    }).catch(function (err) {
      console.error('[Voice Studio] falha:', err);
      setStatus(statusEl, 'Erro ao reproduzir — tente novamente.');
      teardown();
    });
  }

  function playCurrent(btn, statusEl) {
    var cfg = currentConfig();
    btn.disabled = true;
    speakOnce(cfg, statusEl, function () { btn.disabled = false; });
  }

  function saveSlot(slot, statusEl) {
    slots[slot] = currentConfig();
    document.getElementById('vsPlay' + slot).disabled = false;
    setStatus(statusEl, 'Configuração ' + slot + ' salva: ' + slots[slot].voice + ' / ' + (slots[slot].profileKey === 'custom' ? 'custom' : PROFILES[slots[slot].profileKey].label));
  }

  function playSlot(slot, btn, statusEl) {
    if (!slots[slot]) return;
    // Parte N — A/B sempre usa o MESMO texto selecionado no momento, nunca o texto que estava ativo quando A/B foi salvo, para nunca comparar frases diferentes.
    var cfg = Object.assign({}, slots[slot], { textKey: document.getElementById('vsText').value });
    btn.disabled = true;
    speakOnce(cfg, statusEl, function () { btn.disabled = false; });
  }

  function copyConfig(statusEl) {
    var cfg = currentConfig();
    var payload = { voice: cfg.voice, instructionProfile: cfg.profileKey, profileText: cfg.profileText, speed: cfg.speed, notes: '' };
    var json = JSON.stringify(payload, null, 2);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(json).then(function () { setStatus(statusEl, 'Configuração copiada.'); }).catch(function () { setStatus(statusEl, json); });
    } else {
      setStatus(statusEl, json);
    }
    // Parte C8 — localStorage é aceitável na UAT (nunca em produção); só um rascunho de conveniência local a este navegador.
    try { localStorage.setItem('bai_voice_studio_last_config', json); } catch (e) { /* ignora */ }
  }

  window.baiVoiceStudioOpen = function () {
    var overlay = document.getElementById('brabusVoiceStudioOverlay') || buildPanel();
    overlay.classList.add('show');
  };

  window.baiVoiceStudioClose = function () {
    teardown();
    var overlay = document.getElementById('brabusVoiceStudioOverlay');
    if (overlay) overlay.classList.remove('show');
  };
})();
