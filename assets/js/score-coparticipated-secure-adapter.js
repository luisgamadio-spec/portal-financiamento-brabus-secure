(function(){
  'use strict';
  const runtime=window.PORTAL_RUNTIME_CONFIG||{};
  const client=(window.supabase&&runtime.supabaseUrl&&runtime.supabasePublishableKey)
    ? window.supabase.createClient(runtime.supabaseUrl,runtime.supabasePublishableKey):null;
  function family(model){const m=String(model||'').toUpperCase();if(m.includes('OUTLANDER'))return 'Outlander';if(m.includes('TRITON')||m.includes('L200'))return 'Triton';if(m.includes('ECLIPSE'))return 'Eclipse Cross';return 'Outros'}
  function department(v){return String(v||'').toUpperCase()==='SEMINOVOS'?'Seminovos':'Novos'}
  function date(v){if(!v)return null;const p=String(v).split('-');return p.length===3?new Date(+p[0],+p[1]-1,+p[2]):new Date(v)}
  function rate(v){const n=Number(v)||0;return n>1?n/100:n}
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
      DATA.sales=(payload.sales||[]).map(r=>({data:date(r.date),vendedor:r.seller||'',loja:r.store||'',dept:department(r.department),modelo:r.model||'NÃO INFORMADO',familia:family(r.model),valorVenda:Number(r.sale_value)||0}));
      DATA.fins=(payload.finance||[]).map(r=>({data:date(r.date),vendedor:r.seller||'',loja:r.store||'',dept:department(r.department),modelo:r.model||'NÃO INFORMADO',familia:family(r.model),valorVenda:Number(r.sale_value)||0,valorFinanciado:Number(r.financed_value)||0,retorno:Number(r.return_value)||0,receitaSPF:Number(r.spf_value)||0,spfQtd:Number(r.spf_count)||0,parcelas:Number(r.installments)||0,pmt:Number(r.installment_value)||0,balaoValor:r.plan==='BALÃO'?Number(r.balloon_value)||0:0,plano:r.plan||'LINEAR',situacaoB3:r.status||'',matchedB3:true,cliente:'Operação protegida',chassi:r.operation_reference||'',chassiResumido:r.operation_reference||''}));
      const secureVendors={byNbs:{},byName:{},allByName:{}};
      [...DATA.sales,...DATA.fins].forEach(r=>{
        const name=normalizeText(r.vendedor);
        if(!name)return;
        const vendor={nbs:'',nome:name,loja:r.loja||'',tipo:'VENDEDOR',status:normalizeText(r.dept)};
        secureVendors.byName[name]=vendor;
        secureVendors.allByName[name]=vendor;
      });
      DATA.vendors=secureVendors;
      DATA.taxasCopart={};
      (payload.rates||[]).forEach(r=>{const key=taxaKey(r.model);if(key)DATA.taxasCopart[key]={modeloTabela:r.model,rebateTotal:rate(r.total_rebate),parteBrabus:rate(r.brabus_percent),linha:0}});
      DATA.diagnostics={sales:DATA.sales.length,fins:DATA.fins.length,b1Rows:DATA.sales.length,b2Rows:DATA.fins.length,b3Rows:DATA.fins.length,b3Fandi:DATA.fins.length,vendors:new Set(DATA.sales.map(x=>x.vendedor)).size,taxasCopart:Object.keys(DATA.taxasCopart).length,matchedB3:DATA.fins.length,cop:DATA.fins.filter(x=>x.plano==='COPARTICIPADO').length,copSemTaxa:DATA.fins.filter(x=>x.plano==='COPARTICIPADO'&&!calcCoparticipacaoDetalhe(x).ok).length,vendedoresNaoCadastrados:0,vendedoresNaoCadastradosLista:[]};
      populateStores();
      const filters=document.getElementById('filters'),tabs=document.getElementById('tabs');if(filters)filters.style.display='flex';if(tabs)tabs.style.display='flex';
      if(status)status.innerHTML=`<span class="ok">API segura carregada:</span> ${DATA.sales.length} vendas e ${DATA.fins.length} financiamentos. Nenhuma base operacional foi baixada pelo navegador.`;
      bindFilterEvents();renderVendorAlerts();render();
    }catch(e){console.error(e);if(status)status.innerHTML=`<span class="bad">Erro no carregamento seguro:</span> ${e.message||e}`}
  }
  processar=secureProcess;
})();
