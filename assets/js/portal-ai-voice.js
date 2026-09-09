/* IA-UAT-VOICE-01 — voz turn-based / push-to-talk para a UAT isolada.
   Existe SOMENTE nesta cópia (uat-serve), nunca no frontend de produção
   (ia-prod-1-local não carrega este arquivo).

   Princípio absoluto: voz não tem cérebro próprio. Este arquivo só faz
   três coisas: (1) grava áudio e manda para portal-voice-homolog
   transcrever; (2) coloca o texto transcrito no MESMO campo de texto que
   o usuário digitaria, revisável antes do envio; (3) pega a resposta
   textual que já veio pelo caminho normal (baiSend/portal-ai-homolog,
   intocado) e manda ler em voz alta via portal-voice-homolog. Nenhuma
   regra de negócio, nenhum SYSTEM_PROMPT, nenhuma tool, nenhum cálculo
   financeiro existe aqui.

   Nada é persistido: nem áudio gravado, nem MP3 sintetizado, nem
   transcrição — tudo vive em memória do browser (Blob/ObjectURL) e é
   descartado ao trocar de gravação/reprodução ou ao fechar a página. */
(function () {
  'use strict';

  // ---------- Estado ----------
  var STATE = { IDLE: 'PRONTO', LISTENING: 'OUVINDO', PROCESSING: 'PROCESSANDO', SPEAKING: 'RESPONDENDO', ERROR: 'ERRO' };
  var voiceState = STATE.IDLE;
  var mediaRecorder = null;
  var recordedChunks = [];
  var mediaStream = null;
  var autoplay = true; // só em memória — nunca localStorage (mesmo princípio de AI_CONVERSATION)
  var ttsAudioEl = new Audio();
  var ttsPlayingBtn = null; // botão da bolha atualmente falando, para alternar ícone
  var lastRenderedSpeakBtn = null; // IA-UAT-VOICE-01.3 — referência direta ao botão de fala mais recentemente criado por baiAttachVoiceControls (ver Bug 2)

  function setStatus(text, isError) {
    var el = document.getElementById('brabusAiVoiceStatus');
    if (!el) return;
    if (!text) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    el.textContent = text;
    el.classList.toggle('brabusAiVoiceStatusError', !!isError);
  }

  function setMicVisual(state) {
    var mic = document.getElementById('brabusAiMicBtn');
    var cancel = document.getElementById('brabusAiMicCancelBtn');
    if (!mic) return;
    mic.classList.remove('baiMicListening', 'baiMicProcessing', 'baiMicError');
    mic.disabled = false;
    if (cancel) cancel.hidden = true;
    if (state === STATE.LISTENING) {
      mic.classList.add('baiMicListening');
      mic.textContent = '⏹';
      mic.title = 'Parar gravação';
      if (cancel) cancel.hidden = false;
    } else if (state === STATE.PROCESSING) {
      mic.classList.add('baiMicProcessing');
      mic.textContent = '⏳';
      mic.disabled = true;
      mic.title = 'Transcrevendo...';
    } else if (state === STATE.ERROR) {
      mic.classList.add('baiMicError');
      mic.textContent = '🎤';
      mic.title = 'Falar (clique para começar, clique novamente para terminar)';
    } else {
      mic.textContent = '🎤';
      mic.title = 'Falar (clique para começar, clique novamente para terminar)';
    }
  }

  function pickMimeType() {
    var candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
    for (var i = 0; i < candidates.length; i++) {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(candidates[i])) {
        return candidates[i];
      }
    }
    return '';
  }

  // ---------- Gravação (push-to-talk: clique para começar, clique de novo para terminar) ----------
  // Escolhida em vez de "pressionar e segurar" — mais confiável em
  // desktop (clique acidental solto cedo não corta a fala) e em mobile
  // (sem exigir manter o dedo parado sobre um alvo pequeno).

  window.baiToggleRecording = function () {
    // IA-UAT-VOICE-01.3 (Bug 1) — SPEAKING agora é um estado válido para
    // começar a gravar: startRecording() já chama stopSpeaking() antes de
    // pedir o microfone, então clicar durante a fala interrompe o áudio e
    // entra em OUVINDO num único clique, reaproveitando o fluxo existente.
    if (voiceState === STATE.IDLE || voiceState === STATE.ERROR || voiceState === STATE.SPEAKING) {
      startRecording();
    } else if (voiceState === STATE.LISTENING) {
      stopRecordingAndSend();
    }
    // PROCESSING: clique continua ignorado (mic fica disabled nesse estado) — Etapa 21, sem duplicidade.
  };

  window.baiCancelRecording = function () {
    if (voiceState !== STATE.LISTENING) return;
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.onstop = null; // descarta sem enviar
      mediaRecorder.stop();
    }
    stopStreamTracks();
    recordedChunks = [];
    voiceState = STATE.IDLE;
    setMicVisual(voiceState);
    setStatus('Gravação cancelada.');
    setTimeout(function () { setStatus(''); }, 2000);
  };

  function stopStreamTracks() {
    if (mediaStream) {
      mediaStream.getTracks().forEach(function (t) { t.stop(); });
      mediaStream = null;
    }
  }

  function startRecording() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      voiceState = STATE.ERROR;
      setMicVisual(voiceState);
      setStatus('Este navegador não suporta gravação de áudio.', true);
      return;
    }
    // Iniciar gravação interrompe qualquer TTS em reprodução — forma
    // simples de "interrupção" sem full-duplex (Etapa 24 do brief).
    stopSpeaking();

    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      mediaStream = stream;
      recordedChunks = [];
      var mimeType = pickMimeType();
      try {
        mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType: mimeType }) : new MediaRecorder(stream);
      } catch (e) {
        stopStreamTracks();
        voiceState = STATE.ERROR;
        setMicVisual(voiceState);
        setStatus('Não foi possível iniciar a gravação neste navegador.', true);
        return;
      }
      mediaRecorder.ondataavailable = function (e) { if (e.data && e.data.size > 0) recordedChunks.push(e.data); };
      mediaRecorder.onstop = function () { handleRecordingStopped(mediaRecorder.mimeType || mimeType || 'audio/webm'); };
      mediaRecorder.start();
      voiceState = STATE.LISTENING;
      setMicVisual(voiceState);
      setStatus('Ouvindo... clique no microfone para terminar.');
    }).catch(function (err) {
      voiceState = STATE.ERROR;
      setMicVisual(voiceState);
      if (err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')) {
        setStatus('Permissão de microfone negada. Autorize o microfone nas configurações do navegador.', true);
      } else if (err && (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError')) {
        setStatus('Nenhum microfone encontrado neste dispositivo.', true);
      } else {
        setStatus('Não foi possível acessar o microfone.', true);
      }
    });
  }

  function stopRecordingAndSend() {
    if (!mediaRecorder || mediaRecorder.state === 'inactive') return;
    voiceState = STATE.PROCESSING;
    setMicVisual(voiceState);
    setStatus('Transcrevendo...');
    mediaRecorder.stop();
  }

  function handleRecordingStopped(mimeType) {
    stopStreamTracks();
    var chunks = recordedChunks;
    recordedChunks = [];
    if (!chunks.length) {
      voiceState = STATE.ERROR;
      setMicVisual(voiceState);
      setStatus('Áudio vazio — grave novamente.', true);
      setTimeout(function () { if (voiceState === STATE.ERROR) { voiceState = STATE.IDLE; setMicVisual(voiceState); setStatus(''); } }, 3000);
      return;
    }
    var blob = new Blob(chunks, { type: mimeType });
    transcribeBlob(blob, mimeType);
  }

  function transcribeBlob(blob, mimeType) {
    supabaseClient.auth.getSession().then(function (sessionResult) {
      var session = sessionResult && sessionResult.data ? sessionResult.data.session : null;
      if (!session) {
        voiceState = STATE.ERROR;
        setMicVisual(voiceState);
        setStatus('Sessão expirada — entre novamente.', true);
        return;
      }
      return fetch(SUPABASE_URL + '/functions/v1/portal-voice-homolog?action=transcribe', {
        method: 'POST',
        headers: {
          'Content-Type': mimeType,
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': 'Bearer ' + session.access_token
        },
        body: blob
      }).then(function (resp) {
        return resp.json().catch(function () { return {}; }).then(function (result) { return { resp: resp, result: result }; });
      }).then(function (pair) {
        if (pair.resp.ok && typeof pair.result.text === 'string' && pair.result.text) {
          // Transcrição visível: cai no MESMO campo de texto do envio
          // digitado — usuário revisa/corrige antes de mandar (Etapas 7-8).
          // NUNCA envia sozinho.
          var input = document.getElementById('brabusAiInput');
          if (input) {
            input.value = pair.result.text;
            window.brabusAiOnInput();
            input.focus();
          }
          voiceState = STATE.IDLE;
          setMicVisual(voiceState);
          setStatus('');
        } else {
          voiceState = STATE.ERROR;
          setMicVisual(voiceState);
          setStatus((pair.result && pair.result.error) || 'Não consegui transcrever o áudio agora.', true);
          setTimeout(function () { if (voiceState === STATE.ERROR) { voiceState = STATE.IDLE; setMicVisual(voiceState); setStatus(''); } }, 4000);
        }
      });
    }).catch(function () {
      voiceState = STATE.ERROR;
      setMicVisual(voiceState);
      setStatus('Não foi possível concluir a transcrição agora.', true);
      setTimeout(function () { if (voiceState === STATE.ERROR) { voiceState = STATE.IDLE; setMicVisual(voiceState); setStatus(''); } }, 4000);
    });
  }

  // ---------- Fala (TTS) ----------

  // Transformação puramente mecânica (nunca uma nova chamada ao modelo)
  // — só torna o texto mais natural de ouvir, nunca muda um fato.
  function stripMarkdownForSpeech(text) {
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

  function stopSpeaking() {
    try { ttsAudioEl.pause(); ttsAudioEl.currentTime = 0; } catch (e) { /* ignora */ }
    if (ttsAudioEl.src) { try { URL.revokeObjectURL(ttsAudioEl.src); } catch (e) { /* ignora */ } ttsAudioEl.removeAttribute('src'); }
    if (ttsPlayingBtn) { ttsPlayingBtn.textContent = '🔊 Ouvir'; ttsPlayingBtn.classList.remove('baiSpeakingBtn'); ttsPlayingBtn = null; }
    if (voiceState === STATE.SPEAKING) { voiceState = STATE.IDLE; setMicVisual(voiceState); }
  }

  function speak(text, btn) {
    // Nova reprodução sempre interrompe a anterior — nunca dois áudios
    // simultâneos (Etapa 23 do brief). IA-UAT-VOICE-01.3 — guarda de null
    // explícita: sem uma referência de botão válida, isto NUNCA pode ser
    // interpretado como "mesmo botão que já está tocando" (era a segunda
    // causa raiz do Bug 2 — null === null coincidia com uma reprodução
    // recém-iniciada e abortava antes do fetch).
    var wasSameBtn = !!btn && (ttsPlayingBtn === btn);
    stopSpeaking();
    if (wasSameBtn) return; // clique no mesmo botão enquanto tocava = só parar

    var spoken = stripMarkdownForSpeech(text);
    if (!spoken) return;

    if (btn) { btn.textContent = '⏳ Preparando áudio...'; btn.disabled = true; }

    supabaseClient.auth.getSession().then(function (sessionResult) {
      var session = sessionResult && sessionResult.data ? sessionResult.data.session : null;
      if (!session) throw new Error('no-session');
      return fetch(SUPABASE_URL + '/functions/v1/portal-voice-homolog?action=speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + session.access_token },
        body: JSON.stringify({ text: spoken })
      });
    }).then(function (resp) {
      if (!resp.ok) throw new Error('tts-failed');
      return resp.blob();
    }).then(function (audioBlob) {
      var url = URL.createObjectURL(audioBlob);
      ttsAudioEl.src = url;
      voiceState = STATE.SPEAKING;
      setMicVisual(voiceState);
      if (btn) { btn.disabled = false; btn.textContent = '⏹ Parar'; btn.classList.add('baiSpeakingBtn'); ttsPlayingBtn = btn; }
      ttsAudioEl.onended = function () { stopSpeaking(); };
      // IA-UAT-VOICE-01.2 — play() pode rejeitar depois do fetch já ter
      // dado certo (ex.: navegador recusou tocar o blob) — isso NÃO é um
      // STOP manual (que passa por wasSameBtn acima, sem chegar aqui) e
      // precisa do mesmo estado de erro do catch de fetch, não do texto
      // neutro "Ouvir" que stopSpeaking() deixaria por padrão.
      ttsAudioEl.play().catch(function () {
        stopSpeaking();
        if (btn) { btn.textContent = '🔇 Áudio indisponível'; btn.title = 'Não foi possível reproduzir o áudio desta resposta agora.'; }
      });
    }).catch(function () {
      // Falha de TTS NUNCA apaga a resposta em texto (Etapa 20) — o texto
      // já está na tela desde antes desta chamada. Só o controle de
      // áudio deste balão fica indisponível.
      if (btn) { btn.disabled = false; btn.textContent = '🔇 Áudio indisponível'; btn.title = 'Não foi possível gerar áudio para esta resposta agora.'; }
      if (voiceState === STATE.SPEAKING) { voiceState = STATE.IDLE; setMicVisual(voiceState); }
    });
  }

  // ---------- Ganchos chamados por portal-ai-ui.js (opcionais, no-op se ausentes lá) ----------

  window.baiAttachVoiceControls = function (bubbleEl, content) {
    if (!bubbleEl || typeof content !== 'string' || !content) return;
    var row = document.createElement('div');
    row.className = 'brabusAiVoiceControls';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'brabusAiSpeakBtn';
    btn.textContent = '🔊 Ouvir';
    btn.onclick = function () { speak(content, btn); };
    row.appendChild(btn);
    bubbleEl.appendChild(row);
    // IA-UAT-VOICE-01.3 (Bug 2) — guarda a referência direta do botão
    // recém-criado. baiRenderBody() reconstrói TODAS as mensagens em
    // ordem a cada envio, então este é sempre o último botão criado na
    // passada de render mais recente == o botão da resposta nova, sem
    // depender de :last-of-type (baseado em TAG, quebra quando a
    // resposta tem blocos estruturados — causa raiz original do Bug 2).
    lastRenderedSpeakBtn = btn;
  };

  window.baiOnAssistantReply = function (replyText) {
    // IA-UAT-VOICE-02 — enquanto a conversa contínua (Realtime) está
    // ativa, ela já fala a resposta nativamente; ler de novo aqui via
    // TTS por requisição tocaria duas vozes ao mesmo tempo.
    if (window.baiRealtimeActive) return;
    if (autoplay && typeof replyText === 'string' && replyText) {
      // Referência direta capturada de forma síncrona durante o render
      // que já aconteceu antes deste gancho ser chamado (ver baiSend em
      // portal-ai-ui.js) — nenhum seletor, nenhum timeout necessário.
      speak(replyText, lastRenderedSpeakBtn || null);
    }
  };

  window.baiOnNewConversation = function () {
    stopSpeaking();
    if (voiceState === STATE.LISTENING) window.baiCancelRecording();
    // IA-UAT-VOICE-02 — "Nova conversa" também encerra uma sessão de
    // conversa contínua ativa, pelo mesmo motivo que já cancela uma
    // gravação em andamento: o contexto que ela referenciava acabou de
    // ser limpo.
    if (typeof window.baiRealtimeEnd === 'function') window.baiRealtimeEnd();
  };

  window.baiToggleAutoplay = function () {
    autoplay = !autoplay;
    var btn = document.getElementById('brabusAiAutoplayBtn');
    if (btn) {
      btn.setAttribute('aria-pressed', autoplay ? 'true' : 'false');
      btn.textContent = autoplay ? '🔊' : '🔇';
      btn.title = autoplay ? 'Leitura automática ativada (clique para desativar)' : 'Leitura automática desativada (clique para ativar)';
    }
    if (!autoplay) stopSpeaking();
  };
})();
