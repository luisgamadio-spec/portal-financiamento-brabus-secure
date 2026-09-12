/* IA-UAT-VOICE-02 — conversa contínua por voz (Realtime), UAT isolada.
   Existe SOMENTE nesta cópia (uat-serve), nunca no frontend de produção.

   Princípio absoluto: Realtime não ganha um segundo cérebro. Este
   arquivo só gerencia a CAMADA CONVERSACIONAL — conexão WebRTC, detecção
   de turno (VAD do servidor da OpenAI), interrupção (barge-in), estado
   da sessão. Toda vez que o usuário pergunta algo que envolve dado ou
   cálculo, a sessão Realtime chama a tool consultar_portal_intelligence
   (configurada no servidor, portal-realtime-homolog) — e esta ponte
   (dc.onmessage abaixo) manda a pergunta para o MESMO portal-ai-homolog
   de sempre, via window.baiSendFromRealtime (que é literalmente a
   função baiSend de portal-ai-ui.js, reaproveitada, não duplicada) — e
   devolve a resposta dela, exatamente como veio, para a sessão Realtime
   falar. Nenhum cálculo, nenhuma tabela de taxas, nenhuma regra
   financeira existe neste arquivo.

   Nada é persistido: a sessão WebRTC vive só nesta aba; a transcrição
   cai na mesma AI_CONVERSATION em memória que o chat de texto/VOICE-01
   já usam (nunca localStorage). Encerrar a conversa ou fechar a página
   derruba tudo. */
(function () {
  'use strict';

  var STATE = {
    CONNECTING: 'CONECTANDO', LISTENING: 'OUVINDO', THINKING: 'PENSANDO',
    SPEAKING: 'FALANDO', INTERRUPTED: 'INTERROMPIDO', ERROR: 'ERRO', ENDED: 'ENCERRADO'
  };
  var STATE_CLASS = {
    OUVINDO: 'baiRtListening', PENSANDO: 'baiRtThinking', FALANDO: 'baiRtSpeaking',
    INTERROMPIDO: 'baiRtListening', ERRO: 'baiRtError'
  };

  var pc = null;
  var dc = null;
  var micStream = null;
  var remoteAudioEl = null;
  var micMuted = false;
  var aiSilenced = false;
  var latestCallId = null;
  var processedCallIds = Object.create(null);
  var currentState = null;

  window.baiRealtimeActive = false; // lido por portal-ai-voice.js para não duplicar TTS

  // ---------- IA-UAT-VOICE-03, Parte A — instrumentação de latência ----------
  // Só MEDE — nenhuma linha aqui muda o comportamento da conversa. Cada
  // marca é o instante em que ESTE cliente recebeu/emitiu o evento
  // correspondente (Date.now(), relógio do browser) — não o instante
  // real no servidor. T0 (fim real da fala) não é medível com precisão
  // absoluta no cliente; o proxy usado é a chegada do próprio
  // input_audio_buffer.speech_stopped, documentado explicitamente como
  // tal (mesmo instante group que T1 seria "a decisão de fim de
  // turno" — os dois só divergem pelo atraso de rede até este cliente,
  // que é o mesmo atraso presente em toda a medição, então as somas
  // internas continuam válidas).
  var turnTimer = null;
  window.baiLatencyLog = [];

  // IA-3H, Section 40 -- IA-3G's own lesson: console-only diagnostics
  // are operationally impractical for Human UAT (nobody is asked to
  // open DevTools, by this engagement's own standing convention, so a
  // console.log-only signal is never actually retrievable in practice).
  // Persists a SANITIZED summary to localStorage (this origin/browser
  // only, never sent anywhere) after every turn and on session end/
  // error -- retrievable without DevTools by loading a tiny diagnostic
  // view, or simply read back via a one-line prompt() a Human can be
  // asked to run without any technical explanation. Contains ONLY:
  // numbers (timings), state names, tool booleans/categories, and the
  // error TYPE string if any -- never audio, never transcript, never a
  // prompt/reply, never a token/credential.
  var DIAG_KEY = 'baiVoiceDiag';
  var DIAG_MAX_TURNS = 10;
  function persistDiagnostics(extra) {
    try {
      var snapshot = {
        updated_at: new Date().toISOString(),
        state: currentState,
        recent_turns: window.baiLatencyLog.slice(-DIAG_MAX_TURNS)
      };
      if (extra) for (var k in extra) snapshot[k] = extra[k];
      localStorage.setItem(DIAG_KEY, JSON.stringify(snapshot));
    } catch (e) { /* storage unavailable/full -- diagnostics are best-effort, never block the real session */ }
  }
  window.baiVoiceDiagnostics = function () {
    try { return JSON.parse(localStorage.getItem(DIAG_KEY) || 'null'); } catch (e) { return null; }
  };

  function ltStart() {
    // window.baiNextTurnCategory: rótulo opcional definido pelo chamador
    // (harness de teste) ANTES do turno começar, só para segmentar o
    // relatório por categoria — não influencia nenhum comportamento.
    turnTimer = { t0: null, t1: null, t2: null, t3: null, t4: null, t5: null, t6: null, t7: null, t8: null, hadTool: false, category: window.baiNextTurnCategory || null };
  }
  function ltMark(key) {
    if (turnTimer && turnTimer[key] === null) turnTimer[key] = Date.now();
  }
  function ltFinish() {
    if (!turnTimer) return;
    var t = turnTimer;
    var rec = {
      hadTool: t.hadTool,
      category: t.category,
      vad_ms: (t.t1 && t.t0) ? t.t1 - t.t0 : null,
      realtime_routing_ms: (t.t2 && t.t1) ? t.t2 - t.t1 : null,
      bridge_overhead_ms: (t.t3 && t.t2) ? t.t3 - t.t2 : null,
      portal_intelligence_ms: (t.t4 && t.t3) ? t.t4 - t.t3 : null,
      tool_return_overhead_ms: (t.t5 && t.t4) ? t.t5 - t.t4 : null,
      realtime_response_ms: (t.t7 && t.t5) ? t.t7 - t.t5 : (t.t7 && t.t1 ? t.t7 - t.t1 : null),
      playback_start_ms: (t.t8 && t.t7) ? t.t8 - t.t7 : null,
      total_perceived_ms: (t.t8 && t.t0) ? t.t8 - t.t0 : null
    };
    window.baiLatencyLog.push(rec);
    console.log('[VOICE-03 latency]', JSON.stringify(rec));
    persistDiagnostics();
    turnTimer = null;
  }

  function setState(state, label) {
    currentState = state;
    var el = document.getElementById('brabusAiRealtimeState');
    if (!el) return;
    el.textContent = label || state;
    el.className = 'brabusAiRealtimeState' + (STATE_CLASS[state] ? ' ' + STATE_CLASS[state] : '');
  }

  function showBar(show) {
    var bar = document.getElementById('brabusAiRealtimeBar');
    var inputBar = document.getElementById('brabusAiInputBar');
    var startBtn = document.getElementById('brabusAiRealtimeStartBtn');
    if (bar) bar.hidden = !show;
    if (inputBar) inputBar.hidden = !!show; // VOICE-01 (push-to-talk/digitado) some enquanto a conversa contínua está ativa — continua disponível assim que ela encerra (Etapa 19)
    if (startBtn) startBtn.setAttribute('aria-pressed', show ? 'true' : 'false');
  }

  // Mesma transformação mecânica de portal-ai-voice.js (nunca uma
  // chamada nova ao modelo) — só deixa o texto mais natural para o
  // modelo de voz falar; nunca muda um fato.
  function stripMarkdown(text) {
    return String(text || '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^[-•]\s+/gm, '')
      .replace(/\[([^\]]+)\]\(https?:\/\/[^\s)]+\)/g, '$1')
      .replace(/\n{2,}/g, '. ')
      .replace(/\n/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  function sendEvent(obj) {
    if (dc && dc.readyState === 'open') dc.send(JSON.stringify(obj));
  }

  // ---------- Ponte tool -> portal-ai-homolog (o único lugar onde este
  // arquivo toca em "inteligência financeira" — e mesmo aqui, só repassa) ----------

  function handleFunctionCall(item) {
    if (window.BAI_RT_DEBUG) console.log('[VOICE-02] handleFunctionCall entrou', JSON.stringify(item));
    var callId = item.call_id;
    if (!callId || processedCallIds[callId]) return; // Etapa 21 — nunca processar o mesmo call_id duas vezes
    processedCallIds[callId] = true;
    latestCallId = callId; // qualquer resposta de uma chamada mais antiga que ainda esteja em voo será descartada abaixo

    var args = {};
    try { args = JSON.parse(item.arguments || '{}'); } catch (e) { /* ignora, args fica {} */ }
    var message = typeof args.message === 'string' ? args.message.trim() : '';
    if (window.BAI_RT_DEBUG) console.log('[VOICE-02] mensagem extraida:', JSON.stringify(message));
    if (!message) {
      sendEvent({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify({ erro: 'Pergunta vazia.' }) } });
      sendEvent({ type: 'response.create' });
      return;
    }

    // IA-UAT-VOICE-03, Parte B5 — feedback progressivo: a partir daqui o
    // maior tempo de espera do turno começa (medido na Parte A —
    // portal_intelligence_ms domina o total percebido). Mostrar "PENSANDO"
    // genérico até 7-8s sem nenhum sinal extra parece sistema travado;
    // este rótulo não inventa progresso nem fala nada — só nomeia o que
    // já é verdade neste instante.
    setState(STATE.THINKING, 'CONSULTANDO O PORTAL...');
    // IA-UAT-VOICE-03 — este É um turno com tool: o response.created(1)
    // que já passou não conta como T6/T7 do que o usuário efetivamente
    // ouve; reseta para o response.created(2), pós-tool, marcar de novo.
    if (turnTimer) { turnTimer.hadTool = true; turnTimer.t6 = null; turnTimer.t7 = null; turnTimer.t8 = null; }
    if (window.BAI_RT_DEBUG) console.log('[VOICE-02] chamando baiSendFromRealtime...');
    ltMark('t3');
    window.baiSendFromRealtime(message).then(function (result) {
      ltMark('t4');
      if (window.BAI_RT_DEBUG) console.log('[VOICE-02] baiSendFromRealtime resolveu:', JSON.stringify(result && { ok: result.ok, error: result.error, replyLen: result.reply && result.reply.length }));
      // Interrompido/superado por um turno mais novo enquanto a chamada
      // financeira estava em voo — descarta em silêncio, nunca injeta
      // uma resposta obsoleta na conversa (Etapa "interrupção durante
      // tool call": espera concluir e descarta resposta obsoleta).
      if (callId !== latestCallId) return;

      var output;
      if (result && result.ok) {
        output = JSON.stringify({ resposta: stripMarkdown(result.reply) });
      } else {
        output = JSON.stringify({ erro: 'Não consegui consultar os dados do Portal agora — informe ao usuário e ofereça tentar de novo.' });
      }
      sendEvent({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: output } });
      sendEvent({ type: 'response.create' });
      ltMark('t5');
    });
  }

  function extractAssistantTranscript(responseObj) {
    var out = responseObj && responseObj.output;
    if (!Array.isArray(out)) return '';
    var parts = [];
    out.forEach(function (item) {
      if (item.type === 'message' && item.role === 'assistant' && Array.isArray(item.content)) {
        item.content.forEach(function (c) {
          if (typeof c.transcript === 'string' && c.transcript) parts.push(c.transcript);
        });
      }
    });
    return parts.join(' ').trim();
  }

  function handleServerEvent(evt) {
    if (!evt || typeof evt.type !== 'string') return;
    if (window.BAI_RT_DEBUG && evt.type.indexOf('.delta') < 0) console.log('[VOICE-02 evt]', evt.type); // diagnóstico opcional, nunca ativado por padrão; deltas (muito frequentes) ficam de fora

    if (evt.type === 'session.created' || evt.type === 'session.updated') {
      if (currentState === STATE.CONNECTING) setState(STATE.LISTENING);
      return;
    }
    if (evt.type === 'input_audio_buffer.speech_started') {
      setState(currentState === STATE.SPEAKING ? STATE.INTERRUPTED : STATE.LISTENING);
      return;
    }
    if (evt.type === 'input_audio_buffer.speech_stopped') {
      setState(STATE.THINKING);
      ltStart();
      ltMark('t0'); // proxy de "fim real da fala" — ver nota na Parte A
      return;
    }
    if (evt.type === 'input_audio_buffer.committed') {
      ltMark('t1'); // decisão confirmada de fim de turno
      return;
    }
    if (evt.type === 'response.function_call_arguments.done') {
      ltMark('t2'); // tool call pronta
      return;
    }
    // Transcrição final do turno do usuário (nome de evento pode variar
    // por versão da API — tratado de forma tolerante: qualquer evento de
    // transcrição de entrada concluída).
    if (evt.type.indexOf('input_audio_transcription') >= 0 && evt.type.indexOf('completed') >= 0) {
      var userText = typeof evt.transcript === 'string' ? evt.transcript.trim() : '';
      // VOICE-UAT-01 — this used to also check `!evt._consumedByToolCall`,
      // a guard that was NEVER actually set anywhere in this file (a
      // dead check, always true) -- it was never what prevented double-
      // rendering for a tool-using turn; the real fix is baiSend's own
      // new `silent` option (portal-ai-ui.js), which stops the tool-
      // bridge call from pushing its own user+assistant bubbles at all.
      // This single real transcript IS the only user-turn render for
      // EVERY turn now (tool-using or social) -- stored here regardless
      // of outcome, consumed exactly once below in response.done.
      if (userText) window._baiPendingUserTranscript = userText;
      return;
    }
    if (evt.type === 'response.created') {
      setState(STATE.THINKING);
      ltMark('t6'); // primeiro response.created relevante para este turno (ver reset em handleFunctionCall para turnos com tool)
      return;
    }
    // IA-UAT-VOICE-03 — output_audio_buffer.started é o sinal correto de
    // T7 em WebRTC: aqui o áudio chega pela media track nativa (pc.ontrack),
    // não por eventos .delta no canal de dados (isso é comportamento de
    // WebSocket, sem media track separada) — confirmado ao vivo: nenhum
    // response.output_audio.delta jamais apareceu nesta sessão WebRTC.
    if (evt.type === 'output_audio_buffer.started') {
      if (currentState !== STATE.SPEAKING) setState(STATE.SPEAKING);
      ltMark('t7');
      ltMark('t8'); // T8 = T7 nesta transport (WebRTC) — ver nota em baiRealtimeStart sobre onplaying
      return;
    }
    if (evt.type.indexOf('response') === 0 && evt.type.indexOf('audio') >= 0 && evt.type.indexOf('delta') >= 0) {
      if (currentState !== STATE.SPEAKING) setState(STATE.SPEAKING);
      ltMark('t7'); // guarda defensiva — mantida caso algum ambiente emita deltas de áudio mesmo em WebRTC
      ltMark('t8');
      return;
    }
    if (evt.type === 'response.done') {
      var resp = evt.response || {};
      var output = Array.isArray(resp.output) ? resp.output : [];
      if (window.BAI_RT_DEBUG) console.log('[VOICE-02] response.done output types:', JSON.stringify(output.map(function (o) { return { type: o.type, name: o.name, call_id: o.call_id }; })));
      var hadFunctionCall = false;
      output.forEach(function (item) {
        if (item.type === 'function_call' && item.name === 'consultar_portal_intelligence') {
          hadFunctionCall = true;
          handleFunctionCall(item);
        }
      });
      if (!hadFunctionCall) {
        // Turno social (sem tool) — registra os dois lados na mesma
        // transcrição, sem tocar em portal-ai-homolog.
        if (window._baiPendingUserTranscript) {
          window.baiAppendRealtimeTurn('user', window._baiPendingUserTranscript);
          window._baiPendingUserTranscript = null;
        }
        var assistantText = extractAssistantTranscript(resp);
        if (assistantText) window.baiAppendRealtimeTurn('assistant', assistantText);
        setState(STATE.LISTENING);
        // IA-UAT-VOICE-03 — este é, de fato, o response.done FINAL falado
        // deste turno (sem function_call) — só aqui é seguro fechar e
        // registrar o cronômetro. Um response.done ANTERIOR do mesmo
        // turno pode conter um trecho de áudio próprio junto com a
        // function_call (achado real, não presumido) — por isso o
        // fechamento nunca ficou amarrado a output_audio_buffer.stopped.
        ltFinish();
      }
      return;
    }
    if (evt.type === 'error') {
      console.error('[VOICE-02] realtime error event:', evt.error || evt);
      return;
    }
  }

  // ---------- Ciclo de vida da sessão ----------

  window.baiRealtimeStart = function () {
    if (window.baiRealtimeActive) return;
    if (typeof window.baiCancelRecording === 'function') window.baiCancelRecording(); // nunca dois modos de voz ativos ao mesmo tempo
    if (typeof window.stopSpeaking === 'function') { /* no-op: função privada de portal-ai-voice.js, ver baiRealtimeActive guard lá */ }

    showBar(true);
    setState(STATE.CONNECTING);

    supabaseClient.auth.getSession().then(function (sessionResult) {
      var session = sessionResult && sessionResult.data ? sessionResult.data.session : null;
      if (!session) throw new Error('no-session');
      // IA-UAT-VOICE-03, Parte B — window.baiRealtimeExperimentOverrides:
      // gancho opcional só para os experimentos controlados de latência
      // (eagerness/reasoning_effort, ver Parte B1/B2) — undefined em uso
      // normal, corpo vazio, comportamento idêntico ao VOICE-02.
      return fetch(SUPABASE_URL + '/functions/v1/portal-realtime-homolog', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + session.access_token },
        body: JSON.stringify(window.baiRealtimeExperimentOverrides || {})
      });
    }).then(function (resp) {
      if (!resp.ok) throw new Error('mint-failed-' + resp.status);
      return resp.json();
    }).then(function (mint) {
      return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
        .then(function (stream) { return { mint: mint, stream: stream }; });
    }).then(function (pair) {
      micStream = pair.stream;
      pc = new RTCPeerConnection();

      remoteAudioEl = document.createElement('audio');
      remoteAudioEl.autoplay = true;
      // IA-UAT-VOICE-03 — anexar ao documento (fora da tela, sem alterar
      // layout): o áudio já tocava sem isto (confirmado no VOICE-02),
      // mas um elemento nunca inserido no DOM não dispara 'onplaying' de
      // forma confiável no Chromium — e sem esse evento, T8 nunca era
      // medido. Não é redesenho de UI, é a mesma tag <audio> só visível
      // ao próprio navegador para fins de ciclo de vida de eventos.
      remoteAudioEl.style.position = 'absolute';
      remoteAudioEl.style.width = '0';
      remoteAudioEl.style.height = '0';
      remoteAudioEl.style.opacity = '0';
      remoteAudioEl.style.pointerEvents = 'none';
      document.body.appendChild(remoteAudioEl);
      // IA-UAT-VOICE-03 — T8: início real de reprodução audível (não só
      // "áudio recebido", que é T7). onplaying dispara toda vez que a
      // reprodução recomeça (inclusive após barge-in), então só fecha o
      // cronômetro do turno atual quando ele ainda estiver em aberto.
      // IA-UAT-VOICE-03 — achado real, não presumido: testado ao vivo,
      // onplaying dispara UMA vez por sessão (quando a media track chega
      // via pc.ontrack, no início da conexão) — não uma vez por turno.
      // Em WebRTC o áudio chega pela track nativa, fora da visibilidade
      // de eventos JS por turno; o pipeline de hardware/SO até o
      // alto-falante não é medível separadamente a partir daqui. T8 usa
      // T7 (output_audio_buffer.started) como o proxy mais preciso
      // tecnicamente defensável disponível — documentado, não inventado.
      pc.ontrack = function (ev) {
        remoteAudioEl.srcObject = ev.streams[0];
        remoteAudioEl.muted = aiSilenced;
      };

      micStream.getTracks().forEach(function (track) {
        track.enabled = !micMuted;
        pc.addTrack(track, micStream);
      });

      dc = pc.createDataChannel('oai-events');
      dc.onmessage = function (ev) {
        var parsed;
        try { parsed = JSON.parse(ev.data); } catch (e) { return; /* payload não-JSON, ignora */ }
        try { handleServerEvent(parsed); } catch (e) { console.error('[VOICE-03] erro ao processar evento', parsed && parsed.type, e); }
      };
      dc.onopen = function () { window.baiRealtimeActive = true; };
      dc.onclose = function () { if (window.baiRealtimeActive) endInternally(STATE.ENDED); };

      pc.onconnectionstatechange = function () {
        if (pc && (pc.connectionState === 'failed' || pc.connectionState === 'disconnected')) {
          endInternally(STATE.ERROR);
        }
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
      }).then(function (answerSdp) {
        return pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
      });
    }).catch(function (err) {
      console.error('[VOICE-02] falha ao iniciar conversa por voz:', err);
      // err.message here is always one of a small set of internal
      // markers ('no-session', 'mint-failed-<status>', 'sdp-failed-
      // <status>') or a standard DOM exception name from
      // getUserMedia (e.g. NotAllowedError/NotFoundError) -- never
      // request/response content.
      persistDiagnostics({ last_error: err && err.message ? String(err.message).slice(0, 200) : 'unknown_error' });
      endInternally(STATE.ERROR);
      var status = document.getElementById('brabusAiVoiceStatus');
      if (status) {
        status.hidden = false;
        status.textContent = 'Não foi possível iniciar a conversa contínua agora. O modo push-to-talk (🎤) continua disponível.';
        status.classList.add('brabusAiVoiceStatusError');
      }
    });
  };

  function endInternally(finalState) {
    window.baiRealtimeActive = false;
    if (dc) { try { dc.close(); } catch (e) { /* ignora */ } dc = null; }
    if (pc) { try { pc.close(); } catch (e) { /* ignora */ } pc = null; }
    if (micStream) { micStream.getTracks().forEach(function (t) { t.stop(); }); micStream = null; }
    if (remoteAudioEl) {
      try { remoteAudioEl.srcObject = null; } catch (e) { /* ignora */ }
      try { if (remoteAudioEl.parentNode) remoteAudioEl.parentNode.removeChild(remoteAudioEl); } catch (e) { /* ignora */ }
      remoteAudioEl = null;
    }
    processedCallIds = Object.create(null);
    latestCallId = null;
    micMuted = false;
    aiSilenced = false;
    setState(finalState || STATE.ENDED);
    showBar(false);
    persistDiagnostics({ ended_state: finalState || STATE.ENDED });
    // Transcrição permanece visível — AI_CONVERSATION nunca é tocada aqui.
  }

  window.baiRealtimeEnd = function () {
    if (!window.baiRealtimeActive && !pc) return;
    endInternally(STATE.ENDED);
  };

  window.baiRealtimeToggleMute = function () {
    micMuted = !micMuted;
    if (micStream) micStream.getTracks().forEach(function (t) { t.enabled = !micMuted; });
    var btn = document.getElementById('brabusAiRealtimeMuteBtn');
    if (btn) { btn.setAttribute('aria-pressed', micMuted ? 'true' : 'false'); btn.textContent = micMuted ? 'Microfone mutado' : 'Mutar microfone'; }
  };

  window.baiRealtimeToggleSilence = function () {
    aiSilenced = !aiSilenced;
    if (remoteAudioEl) remoteAudioEl.muted = aiSilenced;
    var btn = document.getElementById('brabusAiRealtimeSilenceBtn');
    if (btn) { btn.setAttribute('aria-pressed', aiSilenced ? 'true' : 'false'); btn.textContent = aiSilenced ? 'IA silenciada' : 'Silenciar IA'; }
  };
})();
