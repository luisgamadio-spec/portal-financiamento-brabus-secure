(function(){
  'use strict';
  const runtime=window.PORTAL_RUNTIME_CONFIG||{};
  const client=(window.supabase&&runtime.supabaseUrl&&runtime.supabasePublishableKey)
    ? window.supabase.createClient(runtime.supabaseUrl,runtime.supabasePublishableKey):null;
  function family(model){const m=String(model||'').toUpperCase();if(m.includes('OUTLANDER'))return 'Outlander';if(m.includes('TRITON')||m.includes('L200'))return 'Triton';if(m.includes('ECLIPSE'))return 'Eclipse Cross';return 'Outros'}
  function department(v){return String(v||'').toUpperCase()==='SEMINOVOS'?'Seminovos':'Novos'}
  function date(v){if(!v)return null;const p=String(v).split('-');return p.length===3?new Date(+p[0],+p[1]-1,+p[2]):new Date(v)}
  function rate(v){const n=Number(v)||0;return n>1?n/100:n}
  // FASE 3.I -- Coparticipação (Modelo x Rebate Total x Parte Brabus) passa
  // a vir da MESMA autoridade governada/versionada (Supabase, batch
  // COPARTICIPADO ACTIVE) já usada pelo Simulador de Novos e pela Gestão
  // de Coparticipados (Fase 3), em vez de "rates" de
  // operational_score_coparticipated_data (fonte real:
  // coparticipado_modelos_fi, tabela desatualizada desde 2026-06-30 --
  // causa raiz provada na Fase 3.H4). Reaproveita o bridge já existente
  // window.parent.simuladorGetBase(), sem RPC nova, sem service-role no
  // browser. FAIL-CLOSED só para a Coparticipação: se a authority
  // governada falhar, DATA.taxasCopart fica vazio (Coparticipação
  // bloqueada, sem cair para "rates") -- mas sales/finance (base do
  // Score) continuam publicados normalmente, pois não dependem de taxa.
  async function loadManagedCoparticipadoRates(){
    if(window.parent===window || typeof window.parent.simuladorGetBase!=='function'){
      throw new Error('Base governada de taxas indisponível (Portal pai não encontrado — sessão inválida).');
    }
    const r=await window.parent.simuladorGetBase('simulador_get_coparticipado');
    if(!r || r.ok!==true){
      throw new Error('Base governada de taxas Coparticipado indisponível no momento (sem base ACTIVE).');
    }
    const modelos=r.linhas && r.linhas.matriz_modelos;
    if(!Array.isArray(modelos) || !modelos.length){
      throw new Error('Base governada de taxas Coparticipado retornou uma matriz de modelos vazia.');
    }
    const taxas={};
    for(const m of modelos){
      const modelo=((m&&m.modelo)||'').toString().trim();
      const rebateTotal=Number(m&&m.rebate_total);
      const parteBrabus=Number(m&&m.rebate_brabus);
      if(!modelo||!isFinite(rebateTotal)||!isFinite(parteBrabus)||rebateTotal<=0)continue;
      const key=taxaKey(modelo);
      if(key&&!taxas[key]){taxas[key]={modeloTabela:modelo,rebateTotal,parteBrabus}}
    }
    if(!Object.keys(taxas).length){
      throw new Error('Base governada de taxas Coparticipado retornou formato inesperado (nenhum modelo válido).');
    }
    return {taxas, meta:{batchId:r.batch_id||'', arquivoNome:r.arquivo_nome||'', origem:'ACTIVE'}};
  }
  async function secureProcess(){
    const status=document.getElementById('status');
    try{
      if(!client)throw new Error('Configuração segura do Supabase não disponível.');
      if(status)status.textContent='Carregando indicadores pela API segura...';
      const end=new Date(),start=new Date(end);start.setDate(start.getDate()-731);
      const ymd=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      const session=await client.auth.getSession();
      if(session.error||!session.data.session)throw new Error('Sessão expirada. Entre novamente pelo Portal F&I.');
      const result=await client.rpc('operational_score_coparticipated_data',{p_start:ymd(start),p_end:ymd(end)});
      if(result.error)throw result.error;
      const payload=result.data||{};
      // Taxas (governadas) e dados operacionais (sales/finance) são
      // authorities INDEPENDENTES -- uma falhar não deve derrubar a
      // outra. payload.rates permanece disponível no payload (contrato
      // backend inalterado, Gate 35) mas NUNCA é usado para popular
      // DATA.taxasCopart a partir de agora.
      let rateAuthority=null, rateAuthorityError=null;
      try{ rateAuthority=await loadManagedCoparticipadoRates(); }
      catch(e){ rateAuthorityError=e; console.warn('[COPARTICIPADO] taxa governada indisponível -- Coparticipação bloqueada nesta sessão:', e&&e.message||e); }
      DATA.sales=(payload.sales||[]).map(r=>({data:date(r.date),vendedor:r.seller||'',loja:r.store||'',dept:department(r.department),modelo:r.model||'NÃO INFORMADO',familia:family(r.model),valorVenda:Number(r.sale_value)||0,operationReference:r.operation_reference||''}));
      DATA.fins=(payload.finance||[]).map(r=>({data:date(r.date),vendedor:r.seller||'',loja:r.store||'',dept:department(r.department),modelo:r.model||'NÃO INFORMADO',familia:family(r.model),valorVenda:Number(r.sale_value)||0,valorFinanciado:Number(r.financed_value)||0,retorno:Number(r.return_value)||0,receitaSPF:Number(r.spf_value)||0,spfQtd:Number(r.spf_count)||0,parcelas:Number(r.installments)||0,pmt:Number(r.installment_value)||0,balaoValor:r.plan==='BALÃO'?Number(r.balloon_value)||0:0,plano:r.plan||'LINEAR',situacaoB3:r.status||'',matchedB3:true,cliente:'Operação protegida',chassi:r.operation_reference||'',chassiResumido:r.operation_reference||'',operationReference:r.operation_reference||''}));
      const secureVendors={byNbs:{},byName:{},allByName:{}};
      [...DATA.sales,...DATA.fins].forEach(r=>{
        const name=normalizeText(r.vendedor);
        if(!name)return;
        const vendor={nbs:'',nome:name,loja:r.loja||'',tipo:'VENDEDOR',status:normalizeText(r.dept)};
        secureVendors.byName[name]=vendor;
        secureVendors.allByName[name]=vendor;
      });
      DATA.vendors=secureVendors;
      DATA.taxasCopart=rateAuthority?rateAuthority.taxas:{};
      DATA.taxasCopartMeta=rateAuthority?rateAuthority.meta:null;
      DATA.diagnostics={sales:DATA.sales.length,fins:DATA.fins.length,b1Rows:DATA.sales.length,b2Rows:DATA.fins.length,b3Rows:DATA.fins.length,b3Fandi:DATA.fins.length,vendors:new Set(DATA.sales.map(x=>x.vendedor)).size,taxasCopart:Object.keys(DATA.taxasCopart).length,taxasCopartBatch:(DATA.taxasCopartMeta&&DATA.taxasCopartMeta.batchId)||'',taxasCopartArquivo:(DATA.taxasCopartMeta&&DATA.taxasCopartMeta.arquivoNome)||'',matchedB3:DATA.fins.length,cop:DATA.fins.filter(x=>x.plano==='COPARTICIPADO').length,copSemTaxa:DATA.fins.filter(x=>x.plano==='COPARTICIPADO'&&!calcCoparticipacaoDetalhe(x).ok).length,vendedoresNaoCadastrados:0,vendedoresNaoCadastradosLista:[]};
      populateStores();
      const filters=document.getElementById('filters'),tabs=document.getElementById('tabs');if(filters)filters.style.display='flex';if(tabs)tabs.style.display='flex';
      const rateNote=rateAuthority?'Condições comerciais (Coparticipado): base governada ativa.':'<span class="bad">Condições comerciais (Coparticipado) indisponíveis nesta sessão -- Coparticipação bloqueada até nova tentativa.</span>';
      if(status)status.innerHTML=`<span class="ok">API segura carregada:</span> ${DATA.sales.length} vendas e ${DATA.fins.length} financiamentos. Nenhuma base operacional foi baixada pelo navegador. ${rateNote}`;
      bindFilterEvents();renderVendorAlerts();render();
    }catch(e){console.error(e);if(status)status.innerHTML=`<span class="bad">Erro no carregamento seguro:</span> ${e.message||e}`}
  }
  processar=secureProcess;
})();
