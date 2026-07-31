// Integração segura dos simuladores com a sessão autenticada do Portal F&I.
(function(){
  function limparTelefone(valor){
    return valor ? String(valor).replace(/\D/g,'') : '';
  }

  function mostrarStatusAnalista(mensagem){
    let box=document.getElementById('statusAnalistaFI');
    if(!box){
      box=document.createElement('div');
      box.id='statusAnalistaFI';
      box.style.cssText='position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:99999;background:rgba(10,14,25,.96);color:#fff;padding:14px 18px;border-radius:14px;font-family:Arial,sans-serif;font-size:14px;font-weight:700;box-shadow:0 12px 30px rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.16);';
      document.body.appendChild(box);
    }
    box.textContent=mensagem;
    box.style.display='block';
    clearTimeout(box._timer);
    box._timer=setTimeout(function(){box.style.display='none';},5000);
  }

  window.falarComAnalista=async function(){
    try{
      mostrarStatusAnalista('Procurando analista disponível...');
      if(window.parent===window || typeof window.parent.portalCallAnalystFi!=='function'){
        throw new Error('Abra o simulador pelo Portal F&I autenticado.');
      }
      const data=await window.parent.portalCallAnalystFi();
      if(!data.length){
        mostrarStatusAnalista('Nenhum analista disponível no momento.');
        return;
      }
      const analista=data[0];
      const telefone=limparTelefone(analista.whatsapp);
      if(!telefone){
        mostrarStatusAnalista('Analista encontrado, mas WhatsApp não cadastrado.');
        return;
      }
      mostrarStatusAnalista('Analista encontrado: '+String(analista.nome||'')+'. Abrindo WhatsApp...');
      const mensagem=encodeURIComponent('Olá, preciso de apoio em uma simulação F&I.');
      setTimeout(function(){
        window.open('https://wa.me/'+telefone+'?text='+mensagem,'_blank','noopener');
      },800);
    }catch(error){
      console.error('Falha ao solicitar atendimento F&I:',error);
      mostrarStatusAnalista(error?.message==='Abra o simulador pelo Portal F&I autenticado.'
        ? error.message
        : 'Não foi possível localizar um analista agora.');
    }
  };
})();
