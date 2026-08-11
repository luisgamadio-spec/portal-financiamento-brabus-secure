/* Carregador compartilhado das bases ACTIVE dos simuladores (Checkpoint 3).
   Usado dentro dos iframes modules/simulador-novos.html e
   modules/simulador-seminovos.html, que não têm supabaseClient próprio —
   por isso chamam window.parent.simuladorGetBase(rpcName) (ponte definida em
   assets/js/portal-app.js, mesmo padrão já usado por portalCallAnalystFi).
   Cache só em memória (nunca localStorage/sessionStorage/IndexedDB) — some ao
   recarregar a página, forçando nova busca da ACTIVE. Em qualquer falha
   (sem parent, RPC indisponível, sem ACTIVE, resposta vazia), cai em
   silêncio para o hardcode local do próprio simulador — nunca mostra erro
   técnico ao usuário. */
(function(){
  'use strict';
  const cache = {};
  // Promessa em andamento por tipoBase — evita duas chamadas simultâneas se
  // o usuário reabrir a aba rapidamente antes da primeira resolver (ainda
  // assim só dispara UMA RPC; a segunda chamada apenas aguarda a primeira).
  const emAndamento = {};
  async function carregar(tipoBase, rpcName){
    if(cache[tipoBase]) return cache[tipoBase];
    if(emAndamento[tipoBase]) return emAndamento[tipoBase];
    const inicio = (typeof performance!=='undefined' && performance.now) ? performance.now() : Date.now();
    const promessa = (async () => {
      try{
        if(window.parent===window || typeof window.parent.simuladorGetBase!=='function'){
          throw new Error('Sem acesso ao Portal autenticado.');
        }
        const resp = await window.parent.simuladorGetBase(rpcName);
        // "linhas" normalmente é um array (A-H: uma única coleção). O
        // Coparticipado tem DUAS estruturas (matriz_modelos + tx_coef), então
        // "linhas" vem como objeto {matriz_modelos:[...], tx_coef:[...]} —
        // aceito aqui como não-vazio também. O formato interno de cada
        // estrutura é validado depois, por quem chama (linhasValidas()).
        const linhasPresentes = resp && resp.linhas && (Array.isArray(resp.linhas) ? resp.linhas.length>0 : Object.keys(resp.linhas).length>0);
        if(!resp || resp.ok!==true || !linhasPresentes){
          throw new Error('Base ACTIVE indisponível ou vazia.');
        }
        const registro = {origem:'ACTIVE', linhas:resp.linhas, batchId:resp.batch_id, arquivoNome:resp.arquivo_nome};
        cache[tipoBase] = registro;
        const ms = Math.round(((typeof performance!=='undefined' && performance.now) ? performance.now() : Date.now()) - inicio);
        console.log(`[SIMULADOR BASE] tipo=${tipoBase} origem=ACTIVE tempo_ms=${ms}`);
        return registro;
      }catch(e){
        const registro = {origem:'FALLBACK', linhas:null};
        cache[tipoBase] = registro;
        const ms = Math.round(((typeof performance!=='undefined' && performance.now) ? performance.now() : Date.now()) - inicio);
        console.warn(`[SIMULADOR BASE] tipo=${tipoBase} origem=FALLBACK tempo_ms=${ms} motivo=${(e && e.message) || e}`);
        return registro;
      }finally{
        delete emAndamento[tipoBase];
      }
    })();
    emAndamento[tipoBase] = promessa;
    return promessa;
  }
  // Bloqueia/libera os controles de UM submódulo (não o Portal inteiro)
  // enquanto a base carrega — impede qualquer interação (calcular, copiar,
  // selecionar) antes de ACTIVE/FALLBACK estar decidido. Botões de "voltar
  // ao menu" ficam de fora do bloqueio (id começando com "back" ou classe
  // "back-menu"), pois navegação não depende da base.
  function travarSubmodulo(containerEl, travando, opts){
    if(!containerEl) return;
    const o = opts || {};
    containerEl.querySelectorAll('input,select,button,textarea').forEach(el=>{
      if(el.id && /^back/i.test(el.id)) return;
      if(el.classList && el.classList.contains('back-menu')) return;
      el.disabled = travando;
    });
    if(o.msgElId){
      const el = (containerEl.ownerDocument || document).getElementById(o.msgElId);
      if(el){
        if(travando){
          el.className = (o.msgClass || 'msg') + ' ok';
          el.textContent = o.mensagem || 'Carregando condições atuais...';
        } else if(el.textContent === (o.mensagem || 'Carregando condições atuais...')){
          el.textContent = '';
          el.className = o.msgClass || 'msg';
        }
      }
    }
  }
  // Validação de forma: usada pelos carregarBaseX() de cada simulador DEPOIS
  // de mapear resp.linhas para o formato interno — cobre o caso em que a RPC
  // responde 200 com "ok:true" e um array não-vazio, mas os campos numéricos
  // esperados vêm ausentes/renomeados (silenciosamente viraria NaN, sem
  // lançar exceção, e escaparia do try/catch). Só valida os campos NUMÉRICOS
  // indicados; campos de texto (modelo/bloco/faixa) não entram aqui.
  function linhasValidas(linhas, campos){
    return Array.isArray(linhas) && linhas.length>0 && linhas.every(r =>
      r && campos.every(c => typeof r[c]==='number' && isFinite(r[c]))
    );
  }
  window.SB_LOADER = { carregar, linhasValidas, travarSubmodulo };
})();
