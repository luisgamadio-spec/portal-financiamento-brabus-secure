let USER=null;
// Nunca inicializar o portal com bases operacionais incorporadas ao JavaScript.
// No modo legado, DATA é preenchido somente pelo carregador de planilhas; no
// modo seguro, será preenchido pelas RPCs autorizadas do Supabase.
let DATA={
  auth:[],
  master:[],
  excluded:[],
  sales:[],
  finance:[],
  b03:[],
  b03SpfByCliente:{},
  b03SpfUnmatched:[],
  meta:{
    authCommon:0,
    master:0,
    excluded:0,
    sales:0,
    financeRows:0,
    financeReal:0,
    retornoPosterior:0,
    spfRows:0,
    spfTotal:0,
    spfUnmatched:0
  }
};
let PERIODOS_COMISSAO=[];
let PERIODO_SELECIONADO=null;
let AUSENCIAS_ANALISTAS=[];
let MUDANCAS_LOJA_VENDEDORES=[];
let FECHAMENTOS_COMISSAO=[];
let FECHAMENTOS_COMISSAO_CARREGADOS_EM=0;
let SNAPSHOT_VIEW=[];
let PERIOD_OVERRIDE=null;
let REAL_USER=null;
let HOMOLOGATION_USER=null;
let APP_VIEW='login';
let OPERATIONAL_METRICS_STATE={
  key:'',
  data:null,
  loading:false,
  error:''
};
let OPERATIONAL_ANALYST_METRICS_STATE={key:'',rows:[],error:''};
let OPERATIONAL_MANAGER_DIRECTORY_STATE={key:'',rows:[],error:''};
let OPERATIONAL_METRICS_PENDING=null;
let OPERATIONAL_METRICS_PENDING_KEY='';
let OPERATIONAL_SALARY_DETAIL_STATE=null;
let OPERATIONAL_AGGREGATE_DETAIL_STATE=[];
let MASTER_ADMIN_REFERENCE_STATE={data:null,loading:null};
let MASTER_SECURITY_STATE={data:null,loading:null};
let LOGIN_IN_PROGRESS=false;
const fmtMoney=v=>(v||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});
const pct=(a,b)=>b?((a/b)*100).toFixed(1).replace('.',',')+'%':'0,0%';
const shareNum=(a,b)=>b?((a/b)*100):0;
const shareBadge=(a,b)=>{const n=shareNum(a,b); return `<span class="shareBadge ${n>=40?'shareGood':'shareBad'}">${n.toFixed(1).replace('.',',')}%</span>`};
const faixaBadge=(faixa,cls='')=>{const f=+(faixa||0);let klass='faixaYellow';if(cls==='manager'){klass=(Math.round(f*10000)===400)?'faixaGreen':'faixaYellow';}else if(cls==='analyst'){klass=(Math.round(f*10000)===450)?'faixaGreen':'faixaYellow';}else{const p=Math.round(f*100);klass=p>=20?'faixaGreen':(p>=15?'faixaYellow':'faixaRed');}return `<span class="faixaBadge ${klass}">${fmtPct2(f)}</span>`};

const DEFAULT_PORTAL_CONFIG={
  share_minimo:40,
  spf_liquido_percentual:70,
  bonus_spf_analista:150,
  limite_retorno_novos:12000,
  limite_retorno_seminovos:8000,
  vendedor_faixa_baixo_share_baixo:10,
  vendedor_faixa_baixo_share_alto:15,
  vendedor_faixa_alto_share_baixo:15,
  vendedor_faixa_alto_share_alto:20,
  gerente_faixa_share_baixo:3,
  gerente_faixa_share_alto:4,
  analista_faixa_share_baixo:3.5,
  analista_faixa_share_alto:4.5
};
let PORTAL_CONFIG={...DEFAULT_PORTAL_CONFIG};
function cfgNum(chave){
  const v=PORTAL_CONFIG[chave];
  const n=Number(String(v).replace(',','.'));
  return Number.isFinite(n)?n:DEFAULT_PORTAL_CONFIG[chave];
}
async function carregarParametrosPortal(){
  try{
    if(!supabaseClient) return;
    const {data,error}=await supabaseClient.rpc('operational_portal_config');
    if(error){console.warn('Configurações não carregadas:',error.message);return}
    const cfg={...DEFAULT_PORTAL_CONFIG};
    (Array.isArray(data?.rows)?data.rows:[]).forEach(r=>{
      if(Object.prototype.hasOwnProperty.call(cfg,r.chave)){
        const n=Number(String(r.valor).replace(',','.'));
        if(Number.isFinite(n)) cfg[r.chave]=n;
      }
    });
    PORTAL_CONFIG=cfg;
  }catch(e){console.warn('Falha ao carregar parâmetros:',e)}
}
async function salvarConfigPortal(chave,valor,descricao){
  const numero=Number(String(valor).replace(',','.'));
  if(!Number.isFinite(numero)) throw new Error('Informe um valor numérico válido.');
  const {error}=await supabaseClient.rpc('master_update_portal_config',{
    p_key:chave,p_value:numero,p_description:descricao||''
  });
  if(error) throw error;
  MASTER_SECURITY_STATE.data=null;
  await carregarParametrosPortal();
}

function commissionCalc(status,m,cls=''){
  const share=shareNum(m.financiadas,m.vendidas);
  const shareMin=cfgNum('share_minimo');
  const spfLiquido=(+m.spf||0)*(cfgNum('spf_liquido_percentual')/100);
  const rentTotal=(+m.retorno||0)+spfLiquido;
  let faixa=0, comissaoPrincipal=0, comissaoSpf=0, comissaoTotal=0;
  if(cls==='manager'){
    faixa=share>=shareMin?(cfgNum('gerente_faixa_share_alto')/100):(cfgNum('gerente_faixa_share_baixo')/100);
  }else if(cls==='analyst'){
    faixa=share>=shareMin?(cfgNum('analista_faixa_share_alto')/100):(cfgNum('analista_faixa_share_baixo')/100);
    comissaoSpf=(+m.spfQty||0)*cfgNum('bonus_spf_analista');
  }else{
    const isSemi=(status||'').toString().toUpperCase().includes('SEMINOVOS') && !(status||'').toString().toUpperCase().includes('NOVOS/SEMINOVOS');
    const limite=isSemi?cfgNum('limite_retorno_seminovos'):cfgNum('limite_retorno_novos');
    if((+rentTotal||0) < limite){ faixa=share>=shareMin?(cfgNum('vendedor_faixa_baixo_share_alto')/100):(cfgNum('vendedor_faixa_baixo_share_baixo')/100); }
    else{ faixa=share>=shareMin?(cfgNum('vendedor_faixa_alto_share_alto')/100):(cfgNum('vendedor_faixa_alto_share_baixo')/100); }
  }
  comissaoPrincipal=rentTotal*faixa;
  comissaoTotal=comissaoPrincipal+comissaoSpf;
  return {share, spfLiquido, rentTotal, faixa, comissaoPrincipal, comissaoSpf, comissaoTotal};
}

function commissionSummaryFromBlocks(blocks,cls,statusResolver){
  const valid=(blocks||[]).filter(b=>b&&b.m);
  const t=sumRowsWithItems(valid.map(b=>({m:b.m})));
  const calculated=valid.map((b,index)=>{
    const status=typeof statusResolver==='function'?statusResolver(b,index):(b.status||'');
    return {...b,status,c:commissionCalc(status,b.m,cls)};
  });
  const c=calculated.reduce((acc,b)=>{
    acc.spfLiquido+=(+b.c.spfLiquido||0);
    acc.rentTotal+=(+b.c.rentTotal||0);
    acc.comissaoPrincipal+=(+b.c.comissaoPrincipal||0);
    acc.comissaoSpf+=(+b.c.comissaoSpf||0);
    acc.comissaoTotal+=(+b.c.comissaoTotal||0);
    return acc;
  },{spfLiquido:0,rentTotal:0,comissaoPrincipal:0,comissaoSpf:0,comissaoTotal:0});
  c.share=shareNum(t.financiadas,t.vendidas);
  c.faixas=[...new Set(calculated.map(b=>+b.c.faixa||0))];
  c.multiplasFaixas=c.faixas.length>1;
  c.faixa=c.faixas.length===1?c.faixas[0]:null;
  c.faixaHtml=c.multiplasFaixas
    ?c.faixas.map(f=>faixaBadge(f,cls)).join('<span style="padding:0 3px;color:#aaa">+</span>')
    :faixaBadge(c.faixa||0,cls);
  c.blocks=calculated;
  return {t,c,blocks:calculated};
}
function managerCommissionSummary(rows){
  const novos=(rows||[]).filter(x=>statusHas(x.a,'NOVOS'));
  const semis=(rows||[]).filter(x=>statusHas(x.a,'SEMINOVOS'));
  const blocks=[];
  if(novos.length) blocks.push({departamento:'NOVOS',status:'GERENTE NOVOS',m:sumRowsWithItems(novos)});
  if(semis.length) blocks.push({departamento:'SEMINOVOS',status:'GERENTE SEMINOVOS',m:sumRowsWithItems(semis)});
  return commissionSummaryFromBlocks(blocks,'manager',b=>b.status);
}
function commissionBlockLabel(b,index=0){
  const parts=[];
  if(b?.loja) parts.push(String(b.loja));
  if(b?.departamento) parts.push(String(b.departamento));
  if(!parts.length && b?.status) parts.push(String(b.status));
  return parts.join(' · ')||`BLOCO ${index+1}`;
}
function commissionBlockLines(c,field,formatter){
  const blocks=(c?.blocks||[]).filter(b=>b&&b.c);
  return blocks.map((b,index)=>{
    const value=field==='vendidas'||field==='financiadas'||field==='producao'||field==='retorno'||field==='spf'||field==='spfQty'
      ?(+b.m?.[field]||0)
      :(+b.c?.[field]||0);
    const rendered=formatter?formatter(value,b):value;
    return `<div class="commissionBlockLine"><small>${commissionBlockLabel(b,index)}</small><b>${rendered}</b></div>`;
  }).join('');
}
function commissionBlocksTable(c,includeTotal=true){
  const blocks=(c?.blocks||[]).filter(b=>b&&b.c);
  if(!blocks.length) return '';
  let rows=blocks.map((b,index)=>{
    const bm=b.m||{}, bc=b.c||{};
    return `<tr>
      <td>${commissionBlockLabel(b,index)}</td>
      <td>${bm.vendidas||0}</td>
      <td>${bm.financiadas||0}</td>
      <td>${fmtSharePct(bc.share||0)}</td>
      <td>${fmtMoney(bm.retorno||0)}</td>
      <td>${fmtMoney(bc.spfLiquido||0)}</td>
      <td>${fmtMoney(bc.rentTotal||0)}</td>
      <td>${fmtPct2(bc.faixa||0)}</td>
      <td>${fmtMoney(bc.comissaoPrincipal||0)}</td>
      <td>${fmtMoney(bc.comissaoSpf||0)}</td>
      <td>${fmtMoney(bc.comissaoTotal||0)}</td>
    </tr>`;
  }).join('');
  if(includeTotal){
    rows+=`<tr class="commissionBlocksTotal">
      <td colspan="8"><b>TOTAL FINAL — soma das comissões dos blocos</b></td>
      <td><b>${fmtMoney(c.comissaoPrincipal||0)}</b></td>
      <td><b>${fmtMoney(c.comissaoSpf||0)}</b></td>
      <td><b>${fmtMoney(c.comissaoTotal||0)}</b></td>
    </tr>`;
  }
  return `<div class="tableWrap commissionBlocksWrap"><table class="commissionBlocksTable">
    <thead><tr><th>Bloco</th><th>Vend.</th><th>Fin.</th><th>Share</th><th>Retorno</th><th>70% SPF</th><th>Rentabilidade</th><th>Faixa</th><th>Comissão principal</th><th>Comissão SPF</th><th>Comissão total</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}
function buildMultiBlockCommissionCards(c,opts={}){
  const blocks=(c?.blocks||[]).filter(b=>b&&b.c);
  const cls=opts.className||'cards vendorKpis';
  const commissionLabel=opts.commissionLabel||'Comissão Total';
  const commissionValue=opts.commissionValue ?? c.comissaoTotal ?? c.comissaoPrincipal ?? 0;
  const extraCards=opts.extraCards||'';
  const blockCards=blocks.map((b,index)=>{
    const bm=b.m||{}, bc=b.c||{};
    return `<div class="card commissionBlockCard">
      <div class="k">${commissionBlockLabel(b,index)}</div>
      <div class="commissionBlockCardGrid">
        <span>Vendidas <b>${bm.vendidas||0}</b></span>
        <span>Financiadas <b>${bm.financiadas||0}</b></span>
        <span>Share <b>${fmtSharePct(bc.share||0)}</b></span>
        <span>Retorno <b>${fmtMoney(bm.retorno||0)}</b></span>
        <span>70% SPF <b>${fmtMoney(bc.spfLiquido||0)}</b></span>
        <span>Rentabilidade <b>${fmtMoney(bc.rentTotal||0)}</b></span>
        <span>Faixa <b>${fmtPct2(bc.faixa||0)}</b></span>
        <span>Comissão <b>${fmtMoney(bc.comissaoTotal||bc.comissaoPrincipal||0)}</b></span>
      </div>
    </div>`;
  }).join('');
  return {cls:`${cls} multiBlockKpis`,html:`
    ${blockCards}
    <div class="card comissaoCard commissionGrandTotal">
      <div class="k">${commissionLabel}</div>
      <div class="v">${fmtMoney(commissionValue)}</div>
      <div class="note">Soma das comissões calculadas separadamente por bloco</div>
    </div>
    ${extraCards}`};
}

function analystCommissionRowsForStore(store,novos,semis){
  const out=[];
  if((novos||[]).length){
    getAnalystRowsForStore(store,novos).forEach(r=>out.push({...r,departamento:'NOVOS'}));
  }
  if((semis||[]).length){
    getAnalystRowsForStore(store,semis).forEach(r=>out.push({...r,departamento:'SEMINOVOS'}));
  }
  return out;
}
function combineAnalystRowsForDisplay(rows){
  const grouped=new Map();
  (rows||[]).forEach(r=>{
    const key=[r.cpf||norm(r.nome||''),r.loja||'',r.transferencia?'1':'0',r.periodoTransferencia||''].join('|');
    if(!grouped.has(key)){
      grouped.set(key,{...r,m:zeroMetrics(),auditBlocks:[],departamentos:[]});
    }
    const g=grouped.get(key);
    g.m=addMetrics(g.m,r.m||zeroMetrics());
    g.auditBlocks.push({m:r.m||zeroMetrics(),status:'ANALISTA',departamento:r.departamento||'',loja:r.loja||''});
    if(r.departamento&&!g.departamentos.includes(r.departamento)) g.departamentos.push(r.departamento);
  });
  return [...grouped.values()].map(g=>{
    const c=commissionCalc('ANALISTA',g.m,'analyst');
    c.auditBlocks=g.auditBlocks;
    c.departamentos=g.departamentos;
    c.faixaHtml=faixaBadge(c.faixa||0,'analyst');
    return {...g,c,faixaHtml:c.faixaHtml};
  });
}

const fmtPct2=v=>((+v||0)*100).toFixed(2).replace('.',',')+'%';
const fmtSharePct=v=>(+v||0).toFixed(2).replace('.',',')+'%';
const norm=s=>(s||'').toString().normalize('NFD').replace(/[̀-ͯ]/g,'').toUpperCase().replace(/[^A-Z0-9 ]+/g,' ').replace(/\s+/g,' ').trim();
const cpf=s=>(s||'').toString().replace(/\D/g,'').padStart(11,'0').slice(-11);

const inPeriod=(d)=>{let a=PERIOD_OVERRIDE?.ini||document.getElementById('dtIni').value,b=PERIOD_OVERRIDE?.fim||document.getElementById('dtFim').value;return (!a||d>=a)&&(!b||d<=b);};
function dataBR(d){ if(!d) return ''; const [y,m,day]=(d||'').split('-'); return `${day}/${m}/${y}`; }
function periodoLabel(p){ return p ? `${p.nome_periodo||p.nome||'Período'} · ${dataBR(p.data_inicio)} a ${dataBR(p.data_fim)}` : 'Datas manuais'; }
function periodoComissaoLabelAtual(){ return PERIODO_SELECIONADO ? periodoLabel(PERIODO_SELECIONADO) : `${dataBR(document.getElementById('dtIni')?.value||'')} a ${dataBR(document.getElementById('dtFim')?.value||'')}`; }
function desvincularPeriodoManual(){
  PERIODO_SELECIONADO=null;
  const sel=document.getElementById('periodoComissaoSel');
  if(sel) sel.value='';
}
function preencherSelectPeriodos(){
  const sel=document.getElementById('periodoComissaoSel');
  if(!sel) return;
  const ativos=(PERIODOS_COMISSAO||[]).filter(p=>p.ativo!==false).sort((a,b)=>(b.data_inicio||'').localeCompare(a.data_inicio||''));
  sel.innerHTML='<option value="">Datas manuais</option>'+ativos.map(p=>`<option value="${p.id}">${p.periodo_atual?'★ ':''}${p.nome_periodo} · ${dataBR(p.data_inicio)} a ${dataBR(p.data_fim)}</option>`).join('');
  if(PERIODO_SELECIONADO) sel.value=String(PERIODO_SELECIONADO.id);
}
function selecionarPeriodoComissao(id){
  if(!id){
    PERIODO_SELECIONADO=null;
    refreshOperationalMetricsAndRender();
    return;
  }
  const p=(PERIODOS_COMISSAO||[]).find(x=>String(x.id)===String(id));
  if(!p) return;
  PERIODO_SELECIONADO=p;
  const ini=document.getElementById('dtIni'), fim=document.getElementById('dtFim');
  if(ini) ini.value=p.data_inicio||'';
  if(fim) fim.value=p.data_fim||'';
  preencherSelectPeriodos();
  refreshOperationalMetricsAndRender();
}
function aplicarPeriodoAtualSeExistir(){
  preencherSelectPeriodos();
  const atual=(PERIODOS_COMISSAO||[]).find(p=>p.ativo!==false && p.periodo_atual===true);
  if(atual) selecionarPeriodoComissao(atual.id);
}


function periodoAtualDatas(){
  return {ini:document.getElementById('dtIni')?.value||'',fim:document.getElementById('dtFim')?.value||''};
}
function overlapRange(aIni,aFim,bIni,bFim){
  const ini=[aIni,bIni].filter(Boolean).sort().pop();
  const fim=[aFim,bFim].filter(Boolean).sort()[0];
  if(!ini||!fim||fim<ini) return null;
  return {ini,fim};
}
function withPeriodOverride(ini,fim,fn){
  const prev=PERIOD_OVERRIDE;
  PERIOD_OVERRIDE={ini,fim};
  try{return fn();}finally{PERIOD_OVERRIDE=prev;}
}
function zeroMetrics(){
  return {vendidas:0,financiadas:0,producao:0,retorno:0,spf:0,spfQty:0,items:[]};
}
function cloneMetrics(m){
  return {vendidas:+(m?.vendidas||0),financiadas:+(m?.financiadas||0),producao:+(m?.producao||0),retorno:+(m?.retorno||0),spf:+(m?.spf||0),spfQty:+(m?.spfQty||0),items:Array.isArray(m?.items)?[...m.items]:[]};
}
function addMetrics(a,b){
  a.vendidas+=(+b.vendidas||0); a.financiadas+=(+b.financiadas||0); a.producao+=(+b.producao||0); a.retorno+=(+b.retorno||0); a.spf+=(+b.spf||0); a.spfQty+=(+b.spfQty||0);
  if(Array.isArray(b.items)) a.items.push(...b.items);
  return a;
}
function subtractMetrics(a,b){
  a.vendidas=Math.max(0,a.vendidas-(+b.vendidas||0)); a.financiadas=Math.max(0,a.financiadas-(+b.financiadas||0)); a.producao=Math.max(0,a.producao-(+b.producao||0)); a.retorno=Math.max(0,a.retorno-(+b.retorno||0)); a.spf=Math.max(0,a.spf-(+b.spf||0)); a.spfQty=Math.max(0,a.spfQty-(+b.spfQty||0));
  return a;
}
function sumRowsWithItems(rows){
  return (rows||[]).reduce((a,r)=>addMetrics(a,r.m||zeroMetrics()),zeroMetrics());
}
function metricRowsInRange(rows,ini,fim,store=''){
  return withPeriodOverride(ini,fim,()=>sumRowsWithItems((rows||[]).map(r=>({a:r.a,m:calcSeller(r.a,store)})).filter(r=>r.m.vendidas>0||r.m.financiadas>0||r.m.retorno>0||r.m.spf>0)));
}
function ausenciaAtivaParaLoja(store){
  const {ini,fim}=periodoAtualDatas();
  return (AUSENCIAS_ANALISTAS||[])
    .filter(a=>a.ativo!==false)
    .filter(a=>norm(a.loja_coberta||'')===norm(store||''))
    .map(a=>({a,range:overlapRange(a.data_inicio,a.data_fim,ini,fim)}))
    .filter(x=>x.range);
}
function getAnalystRowsForStore(store,allRows){
  const analystsInStore=DATA.auth.filter(a=>a.tipo==='ANALISTA'&&norm(a.loja||'')===norm(store||''));
  const userOwnStore=USER?.tipo==='ANALISTA'&&norm(USER.loja||'')===norm(store||'');
  const original=userOwnStore
    ?(analystsInStore.find(a=>cpfNorm(a.cpf)===cpfNorm(USER.cpf))||USER)
    :(analystsInStore[0]||null);
  const full=sumRowsWithItems(allRows||[]);
  const aus=ausenciaAtivaParaLoja(store);
  let rows=[];
  if(!aus.length){
    rows=[{nome:original?original.nome:'ANALISTA NÃO LOCALIZADO',cpf:original?.cpf||'',loja:store,status:'ANALISTA',m:full,transferencia:false}];
  }else{
    const residual=cloneMetrics(full);
    aus.forEach(({a,range})=>{
      const mTransfer=metricRowsInRange(allRows,range.ini,range.fim,store);
      subtractMetrics(residual,mTransfer);
      rows.push({
        nome:a.nome_analista_substituto||'ANALISTA SUBSTITUTO NÃO INFORMADO',
        cpf:a.cpf_analista_substituto||'',
        loja:store,
        status:'ANALISTA',
        m:mTransfer,
        transferencia:true,
        periodoTransferencia:`${dataBR(range.ini)} a ${dataBR(range.fim)}`,
        observacao:`FÉRIAS/AUSÊNCIA - período ${dataBR(range.ini)} a ${dataBR(range.fim)} · Ausente: ${a.nome_analista_ausente||''}`
      });
    });
    residual.items=(full.items||[]).filter(it=>!aus.some(({range})=>it.date&&it.date>=range.ini&&it.date<=range.fim));
    if(residual.vendidas>0||residual.financiadas>0||residual.retorno>0||residual.spf>0){
      rows.unshift({nome:original?original.nome:'ANALISTA NÃO LOCALIZADO',cpf:original?.cpf||'',loja:store,status:'ANALISTA',m:residual,transferencia:false,observacao:'Período fora da ausência'});
    }
  }
  if(USER?.tipo==='ANALISTA'){
    const userCpf=cpfNorm(USER.cpf);
    rows=rows.filter(r=>cpfNorm(r.cpf)===userCpf);
  }
  return rows;
}

function statusHas(a,st){return (a.statusGroups||[]).includes(st);}

let DATA_READY=false;
const PORTAL_DATA_PATH='data/';
const GITHUB_FILES={
  auth:'BASE CORRETA VENDAS ATUALIZADA.xlsx',
  salesNew:'Base 01.xlsx',
  financeNew:'Base 02.xlsx',
  base03:'Base 03.xlsx'
};
// Bases históricas são opcionais. Se não existirem no GitHub, o Portal deve carregar normalmente com as bases atuais.
const GITHUB_OPTIONAL_FILES={
  salesHist:'Base 01_historica_ate_2026-05-31.xlsx',
  financeHist:'Base 02_historica_ate_2026-05-31.xlsx'
};
const EXCLUDED_OPERATION_SELLERS=new Set([
  'LUIS FERNANDO BUENO DE SOUZA','RICARDO SILVA COSTA','SANDRO SEVERO LEROIS','JOAO FONTOLAN',
  'FELIPE ALEXANDRE VITORINO','JEFFERSON CLEMENTE','MARIO ALBERTO DE SOUZA VAZ','FABIANO OKUBO','SERGIO AUGUSTO SEGURA'
]);
function setAutoLoadStatus(msg,isError=false){
  const el=document.getElementById('autoLoadStatus');
  if(el){el.innerHTML=msg; el.className='note '+(isError?'bad':'ok');}
}
function basenameForFetch(name){return encodeURI(name);}
async function fetchWorkbook(name){
  const paths=[PORTAL_DATA_PATH + name, PORTAL_DATA_PATH + basenameForFetch(name), name, basenameForFetch(name)];
  let lastStatus='';
  for(const path of paths){
    try{
      const res=await fetch(path, {cache:'no-store'});
      lastStatus=`HTTP ${res.status} em ${path}`;
      if(res.ok){
        const buf=await res.arrayBuffer();
        return XLSX.read(buf,{type:'array',cellDates:true});
      }
    }catch(e){
      lastStatus=e.message||String(e);
    }
  }
  throw new Error(`Base não localizada: ${name}. Caminho esperado: ${PORTAL_DATA_PATH}${name}. Última tentativa: ${lastStatus}`);
}
function sheetRows(wb,range=0){
  if(!wb || !wb.Sheets || !wb.SheetNames || !wb.SheetNames.length) return [];
  const ws=wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws,{defval:'',raw:true,range});
}
function getVal(row, names){
  for(const n of names){ if(Object.prototype.hasOwnProperty.call(row,n)) return row[n]; }
  const keys=Object.keys(row);
  for(const n of names){
    const nn=norm(n);
    const k=keys.find(k=>norm(k)===nn);
    if(k!==undefined) return row[k];
  }
  return '';
}
function cleanText(v){return (v===null||v===undefined)?'':String(v).trim();}
function cpfNorm(v){const s=String(v??'').replace(/\D/g,''); return s?s.padStart(11,'0').slice(-11):'';}
function toNumber(v){
  if(v===null||v===undefined||v==='') return 0;
  if(typeof v==='number' && isFinite(v)) return v;
  let s=String(v).replace('R$','').replace(/\s/g,'');
  if(s.includes(',') && s.includes('.')) s=s.replace(/\./g,'').replace(',','.');
  else if(s.includes(',')) s=s.replace(',','.');
  const n=parseFloat(s); return isFinite(n)?n:0;
}
function toIsoDate(v){
  if(!v) return null;
  if(v instanceof Date && !isNaN(v)) return v.toISOString().slice(0,10);
  if(typeof v==='number'){
    const d=XLSX.SSF.parse_date_code(v);
    if(d&&d.y) return `${String(d.y).padStart(4,'0')}-${String(d.m).padStart(2,'0')}-${String(d.d).padStart(2,'0')}`;
  }
  const s=String(v).trim();
  if(!s) return null;
  let m=s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if(m) return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
  m=s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/);
  if(m){let y=m[3].length===2?'20'+m[3]:m[3]; return `${y}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;}
  const d=new Date(s); if(!isNaN(d)) return d.toISOString().slice(0,10);
  return null;
}
function chassiKey(...vals){
  for(const v of vals){
    const s=String(v??'').toUpperCase().replace(/[^A-Z0-9]/g,'');
    if(s && s!=='NAN') return s;
  }
  return '';
}
function chassiAlt(v){const s=chassiKey(v); return s.length>6?s.slice(-6):s;}
function statusGroupsFrom(status){
  const st=norm(status).replace(/\s/g,'');
  if(st==='NOVOS') return ['NOVOS'];
  if(st==='SEMINOVOS') return ['SEMINOVOS'];
  if(st==='NOVOS/SEMINOVOS'||st==='NOVOSSEMINOVOS'||(st.startsWith('NOVOS')&&st.endsWith('SEMINOVOS')&&st!=='SEMINOVOS')) return ['NOVOS','SEMINOVOS'];
  return [];
}
function normalizeStatus(raw){
  const st=norm(raw).replace(/\s/g,'');
  if(st==='NOVOS') return 'NOVOS';
  if(st==='SEMINOVOS') return 'SEMINOVOS';
  if(st==='NOVOS/SEMINOVOS'||st==='NOVOSSEMINOVOS'||(st.startsWith('NOVOS')&&st.endsWith('SEMINOVOS')&&st!=='SEMINOVOS')) return 'NOVOS/SEMINOVOS';
  if(st==='REVENDA') return 'REVENDA';
  if(st==='MASTER') return 'MASTER';
  if(st==='INATIVO') return 'INATIVO';
  return norm(raw)||'STATUS NAO INFORMADO';
}
function buildPortalData(wbs){
  const authRows=sheetRows(wbs.auth,0);
  const auth=[]; const master=[]; const excluded=[];
  authRows.forEach((r,i)=>{
    const nome=cleanText(getVal(r,['Nome','NOME_COMPLETO','Nome Completo']));
    if(!nome) return;
    const tipo=norm(getVal(r,['TIPO','Tipo']));
    const status=normalizeStatus(getVal(r,['STATUS','Status']));
    const rec={
      id:1001+i,
      nbs:cleanText(getVal(r,['NBS','Login NBS','Login'])).toUpperCase(),
      nome,
      nomeKey:norm(nome),
      cpf:cpfNorm(getVal(r,['CPF','Cpf'])),
      loja:norm(getVal(r,['Loja','LOJA'])),
      tipo,
      status,
      statusGroups:statusGroupsFrom(status)
    };
    if(tipo==='MASTER'||status==='MASTER') master.push(rec);
    else if(tipo==='REVENDA'||status==='REVENDA'||status==='INATIVO') excluded.push(rec);
    else auth.push(rec);
  });
  const aliases={};
  auth.forEach(a=>{aliases[a.nomeKey]=a; if(a.nbs) aliases[norm(a.nbs)]=a;});
  function matchAuth(vendedorNome='', vendedorNbs=''){
    const nk=norm(vendedorNome), nb=norm(vendedorNbs);
    if(nb&&aliases[nb]) return aliases[nb];
    if(nk&&aliases[nk]) return aliases[nk];
    for(const a of auth){const key=a.nomeKey; if(nk.length>8&&(nk.includes(key)||key.includes(nk))) return a;}
    return null;
  }
  const sales=[];
  const allowed=new Set(['V21','VD','U21']);
  sheetRows(wbs.salesHist,0).forEach(r=>{
    const tx=cleanText(getVal(r,['Transação','Transacao'])).toUpperCase();
    if(!allowed.has(tx)) return;
    const vendedor=cleanText(getVal(r,['Nome Vendedor','Vendedor']));
    const a=matchAuth(vendedor,getVal(r,['Vendedor','COD_VENDEDOR']));
    const date=toIsoDate(getVal(r,['Data Venda','DATA_VENDA']));
    const ck=chassiKey(getVal(r,['Chassi','CHASSI']));
    if(!date||!ck) return;
    const dep=(tx==='V21'||tx==='VD')?'NOVOS':'SEMINOVOS';
    sales.push({date,chassi:ck,chassiAlt:chassiAlt(ck),vendedor:a?a.nome:vendedor,vendedorKey:a?a.nomeKey:norm(vendedor),vendedorNbs:cleanText(getVal(r,['Vendedor'])),loja:a?a.loja:norm(getVal(r,['Empresa','EMPRESA'])),valorVenda:toNumber(getVal(r,['Valor Venda','VALOR_VENDA'])),departamentoBase:dep,origem:'Base 01 Histórica',authFound:!!a});
  });
  sheetRows(wbs.salesNew,2).forEach(r=>{
    const vendedor=cleanText(getVal(r,['Nome Vendedor Completo','Nome Vendedor','Vendedor']));
    const nbs=cleanText(getVal(r,['Vendedor','Login NBS','NBS']));
    const a=matchAuth(vendedor,nbs);
    const date=toIsoDate(getVal(r,['Data venda','Data Venda','DATA_VENDA']));
    const ck=chassiKey(getVal(r,['Chassi Completo','Chassi Resumido Novo','Chassi Resumido','Chassi']));
    if(!date||!ck) return;
    const tipo=norm(getVal(r,['Tipo','Novo','Departamento']));
    const dep=(tipo.includes('NOVO')||cleanText(getVal(r,['Novo'])).toUpperCase()==='N')?'NOVOS':'SEMINOVOS';
    sales.push({date,chassi:ck,chassiAlt:chassiAlt(ck),vendedor:a?a.nome:vendedor,vendedorKey:a?a.nomeKey:norm(vendedor),vendedorNbs:nbs,loja:a?a.loja:norm(getVal(r,['Cód. Empresa Vendedora','Cod Empresa Vendedora','Empresa Vendedora'])),valorVenda:toNumber(getVal(r,['Valor Venda','VALOR_VENDA'])),departamentoBase:dep,origem:'Base 01 Nova',authFound:!!a});
  });
  const salesBy={};
  sales.forEach(s=>{if(!salesBy[s.chassi]||s.date>=salesBy[s.chassi].date) salesBy[s.chassi]=s;});
  const dedupSales=Object.values(salesBy);
  const finance=[];
  sheetRows(wbs.financeHist,0).forEach(r=>{
    const serv=cleanText(getVal(r,['DESCRICAO','Descrição Serviço','Descricao']));
    const sn=norm(serv);
    const isFin=sn.includes('FINANCIAMENTO')&&!sn.includes('A VISTA');
    const isRetornoPosterior=sn.includes('LANCAMENTO')&&sn.includes('RETORNO')&&(sn.includes('POSTERIOR')||sn.includes('PORTERIOR'));
    const isSpf=sn.includes('SPF');
    const vendedor=cleanText(getVal(r,['NOME_VENDEDOR','Nome Vendedor','Vendedor']));
    const a=matchAuth(vendedor,getVal(r,['COD_VENDEDOR','Vendedor']));
    const date=toIsoDate(getVal(r,['DATA_VENDA','Data Venda']));
    const ck=chassiKey(getVal(r,['CHASSI','Chassi']));
    if(!date) return;
    if(!ck && !isRetornoPosterior) return;
    finance.push({date,chassi:ck,chassiAlt:chassiAlt(ck),vendedor:a?a.nome:vendedor,vendedorKey:a?a.nomeKey:norm(vendedor),vendedorNbs:cleanText(getVal(r,['COD_VENDEDOR','Vendedor'])),cliente:cleanText(getVal(r,['CLIENTE','Cliente'])),clienteKey:norm(getVal(r,['CLIENTE','Cliente'])),loja:a?a.loja:norm(getVal(r,['EMPRESA_NOTA','Empresa Nota'])),servico:serv,isFinReal:isFin,isRetornoPosterior:isRetornoPosterior,isSpf:isSpf,retorno:toNumber(getVal(r,['RETORNO','Retorno','Retorno Bruto'])),valorServico:toNumber(getVal(r,['VALOR_FINANCIADO','Valor Financiado'])),origem:'Base 02 Histórica'});
  });
  sheetRows(wbs.financeNew,2).forEach(r=>{
    const serv=cleanText(getVal(r,['Descrição Serviço','Descricao Servico','DESCRICAO']));
    const sn=norm(serv);
    const isFin=sn.includes('POR PLANO FINANCIAMENTO');
    const isRetornoPosterior=sn.includes('LANCAMENTO')&&sn.includes('RETORNO')&&(sn.includes('POSTERIOR')||sn.includes('PORTERIOR'));
    const isSpf=sn.includes('SPF');
    const vendedor=cleanText(getVal(r,['Nome completo vendedor','Nome Vendedor Completo','Nome Vendedor','Vendedor']));
    const nbs=cleanText(getVal(r,['Vendedor','Login NBS','NBS']));
    const a=matchAuth(vendedor,nbs);
    const date=toIsoDate(getVal(r,['Data Venda','Data venda','Data Emissão Nota','Data Emissao Nota']));
    const ck=chassiKey(getVal(r,['Chassi Completo','Chassi Resumido','Chassi']));
    if(!date) return;
    if(!ck && !isRetornoPosterior) return;
    const cliente=cleanText(getVal(r,['Cliente','Nome Cliente Destino','Nome Cliente']));
    finance.push({date,chassi:ck,chassiAlt:chassiAlt(ck),vendedor:a?a.nome:vendedor,vendedorKey:a?a.nomeKey:norm(vendedor),vendedorNbs:nbs,cliente,clienteKey:norm(cliente),loja:a?a.loja:norm(getVal(r,['Cód. Empresa Vendedora','Cod Empresa Vendedora','Empresa Vendedora'])),servico:serv,isFinReal:isFin,isRetornoPosterior:isRetornoPosterior,isSpf:isSpf,retorno:toNumber(getVal(r,['Retorno Bruto','RETORNO','Retorno'])),valorServico:toNumber(getVal(r,['Valor Serviço','Valor Servico','VALOR_SERVICO'])),origem:'Base 02 Nova'});
  });
  const b03=[];
  const b03SpfByCliente={};
  const b03SpfUnmatched=[];
  const lastOp={cliente:'',cpf:'',modalidade:'',loja:'',date:null,departamento:''};
  // A Base 03 possui os cabeçalhos reais na linha física 3.
  sheetRows(wbs.base03,2).forEach(r=>{
    const rawCliente=cleanText(getVal(r,['Cli - Nome','Cliente','Nome Cliente']));
    const rawCpf=cpfNorm(getVal(r,['Cli - CPF/CNPJ','Cli - CPF','CPF','CPF/CNPJ']));
    const rawModalidade=cleanText(getVal(r,['Op - Modalidade','Modalidade']));
    const rawLoja=cleanText(getVal(r,['Inst - Ponto de Venda','Ponto de Venda','Loja']));
    const rawDate=toIsoDate(getVal(r,['Op - Data Inclusão','Op - Data Inclusao','Data Inclusão','Data Inclusao']));
    const rawDepartamento=cleanText(getVal(r,['Inst - Departamento','Departamento']));

    if(rawCliente) lastOp.cliente=rawCliente;
    if(rawCpf) lastOp.cpf=rawCpf;
    if(rawModalidade) lastOp.modalidade=rawModalidade;
    if(rawLoja) lastOp.loja=rawLoja;
    if(rawDate) lastOp.date=rawDate;
    if(rawDepartamento) lastOp.departamento=rawDepartamento;

    const cliente=lastOp.cliente;
    if(!cliente) return;

    const modalidade=lastOp.modalidade;
    if(norm(modalidade)!=='FANDI') return;

    const opcionalNome=cleanText(getVal(r,['Opcional - Nome','Opcional Nome','Nome Opcional']));
    const opcionalNomeKey=norm(opcionalNome);
    const opcionalValor=toNumber(getVal(r,['Opcional - Valor (R$)','Opcional - Valor','Opcional Valor','Valor Opcional']));

    const rec={
      date:lastOp.date,
      cliente,
      clienteKey:norm(cliente),
      cpf:lastOp.cpf,
      modalidade,
      loja:norm(lastOp.loja),
      departamento:norm(lastOp.departamento),
      opcionalNome,
      opcionalNomeKey,
      opcionalValor,
      isSpfExtra:opcionalNomeKey==='SPF EXTRA'
    };
    b03.push(rec);

    if(rec.isSpfExtra){
      if(!b03SpfByCliente[rec.clienteKey]) b03SpfByCliente[rec.clienteKey]=[];
      b03SpfByCliente[rec.clienteKey].push(rec);
    }
  });

  const b02Clientes=new Set(finance.map(f=>f.clienteKey).filter(Boolean));
  Object.values(b03SpfByCliente).flat().forEach(r=>{
    if(!b02Clientes.has(r.clienteKey)){
      b03SpfUnmatched.push({
        cliente:r.cliente,
        cpf:r.cpf,
        valor:r.opcionalValor,
        date:r.date,
        loja:r.loja,
        motivo:'SPF EXTRA encontrado na Base 03, mas não vinculado à Base 02 por cliente normalizado.'
      });
    }
  });

  return {auth,master,excluded,sales:dedupSales,finance,b03,b03SpfByCliente,b03SpfUnmatched,meta:{authCommon:auth.length,master:master.length,excluded:excluded.length,sales:dedupSales.length,financeRows:finance.length,financeReal:finance.filter(f=>f.isFinReal).length,retornoPosterior:finance.filter(f=>f.isRetornoPosterior).length,spfRows:Object.values(b03SpfByCliente).reduce((t,a)=>t+a.length,0),spfTotal:Object.values(b03SpfByCliente).flat().reduce((t,r)=>t+(+r.opcionalValor||0),0),spfUnmatched:b03SpfUnmatched.length}};
}
async function loadGithubBases(){
  if(String(PORTAL_RUNTIME_CONFIG?.authMode||'').toLowerCase()==='secure'){
    DATA_READY=true;
    setAutoLoadStatus('<b>Modo seguro ativo.</b> As bases operacionais não são baixadas pelo navegador.');
    if(typeof tentarRestaurarSessao==='function') await tentarRestaurarSessao();
    return;
  }
  try{
    if(!window.XLSX) throw new Error('Biblioteca XLSX não carregada. Verifique a conexão com a internet.');
    setAutoLoadStatus('<b>Carregando bases do GitHub...</b>');
    const wbs={};
    for(const [key,file] of Object.entries(GITHUB_FILES)){
      setAutoLoadStatus(`<b>Carregando:</b> ${file}`);
      wbs[key]=await fetchWorkbook(file);
    }
    const optionalMissing=[];
    for(const [key,file] of Object.entries(GITHUB_OPTIONAL_FILES||{})){
      try{
        setAutoLoadStatus(`<b>Carregando base opcional:</b> ${file}`);
        wbs[key]=await fetchWorkbook(file);
      }catch(e){
        optionalMissing.push(file);
        wbs[key]=null;
      }
    }
    DATA=buildPortalData(wbs);
    DATA._optionalMissing=optionalMissing;
    DATA_READY=true;
    setAutoLoadStatus(`<b>Bases carregadas com sucesso.</b> Colaboradores: ${DATA.meta.authCommon} · Vendas: ${DATA.meta.sales} · Linhas Base 02: ${DATA.meta.financeRows} · SPF Base 03: ${DATA.meta.spfRows} · Retorno posterior: ${DATA.meta.retornoPosterior||0}${(DATA._optionalMissing&&DATA._optionalMissing.length)?' · Bases históricas opcionais não encontradas: '+DATA._optionalMissing.join(', '):''}`);
    if(typeof tentarRestaurarSessao==='function') await tentarRestaurarSessao();
  }catch(err){
    DATA_READY=false;
    setAutoLoadStatus(`<b>Erro ao carregar bases:</b> ${err.message}<br>Verifique se todos os arquivos .xlsx estão na pasta data/ do repositório.`,true);
  }
}
window.addEventListener('DOMContentLoaded', loadGithubBases);


const PORTAL_RUNTIME_CONFIG = Object.freeze({
  supabaseUrl: window.PORTAL_RUNTIME_CONFIG?.supabaseUrl || "https://yacqlelpzchcotgngwbh.supabase.co",
  supabasePublishableKey: window.PORTAL_RUNTIME_CONFIG?.supabasePublishableKey || "sb_publishable__J96gDH1kOqlc4iFW24Z2Q_u_lWAg5_",
  authMode: window.PORTAL_RUNTIME_CONFIG?.authMode || "legacy",
  passwordRecoveryMode: window.PORTAL_RUNTIME_CONFIG?.passwordRecoveryMode || "admin",
  turnstileSiteKey: String(window.PORTAL_RUNTIME_CONFIG?.turnstileSiteKey || '').trim()
});
const SUPABASE_URL = PORTAL_RUNTIME_CONFIG.supabaseUrl;
const SUPABASE_ANON_KEY = PORTAL_RUNTIME_CONFIG.supabasePublishableKey;
let supabaseClient = null;
let turnstileScriptPromise = null;
function loadTurnstileScript(){
  if(window.turnstile)return Promise.resolve(window.turnstile);
  if(turnstileScriptPromise)return turnstileScriptPromise;
  turnstileScriptPromise=new Promise((resolve,reject)=>{
    const existing=document.querySelector('script[data-portal-turnstile]');
    const script=existing||document.createElement('script');
    const timeout=setTimeout(()=>reject(new Error('Tempo esgotado ao carregar a proteção antiabuso.')),20000);
    script.onload=()=>{
      clearTimeout(timeout);
      if(window.turnstile)resolve(window.turnstile);
      else reject(new Error('A proteção antiabuso não foi inicializada.'));
    };
    script.onerror=()=>{
      clearTimeout(timeout);
      turnstileScriptPromise=null;
      reject(new Error('Não foi possível carregar a proteção antiabuso.'));
    };
    if(!existing){
      script.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async=true;
      script.defer=true;
      script.dataset.portalTurnstile='true';
      document.head.appendChild(script);
    }
  });
  return turnstileScriptPromise;
}
async function obtainTurnstileToken(){
  const sitekey=PORTAL_RUNTIME_CONFIG.turnstileSiteKey;
  if(!sitekey)return '';
  const api=await loadTurnstileScript();
  return new Promise((resolve,reject)=>{
    const host=document.createElement('div');
    host.setAttribute('aria-label','Verificação de segurança');
    Object.assign(host.style,{position:'fixed',right:'18px',bottom:'18px',zIndex:'2147483647'});
    document.body.appendChild(host);
    let widgetId=null;
    let finished=false;
    const cleanup=()=>{
      if(widgetId!==null){try{api.remove(widgetId)}catch(_){}}
      host.remove();
    };
    const finish=(error,token='')=>{
      if(finished)return;
      finished=true;
      clearTimeout(timer);
      cleanup();
      if(error)reject(error);else resolve(token);
    };
    const timer=setTimeout(()=>finish(new Error('A verificação de segurança expirou. Tente novamente.')),120000);
    try{
      widgetId=api.render(host,{
        sitekey,
        theme:'dark',
        appearance:'interaction-only',
        execution:'execute',
        callback:token=>finish(null,token),
        'error-callback':()=>finish(new Error('A verificação de segurança falhou. Tente novamente.')),
        'expired-callback':()=>finish(new Error('A verificação de segurança expirou. Tente novamente.'))
      });
      api.execute(widgetId);
    }catch(error){finish(error)}
  });
}
try{
  if(window.supabase) supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}catch(e){ console.warn('Supabase não inicializado:', e); }
window.addEventListener('DOMContentLoaded',()=>{
  if(PORTAL_RUNTIME_CONFIG.authMode!=='secure')return;
  const input=document.getElementById('cpfInput');
  if(input){
    input.type='email';
    input.inputMode='email';
    input.autocomplete='username';
    input.placeholder='Digite seu e-mail';
    input.removeAttribute('maxlength');
    const label=input.parentElement?.querySelector('label');
    if(label)label.textContent='E-mail';
  }
  const firstAccess=document.querySelector('.firstAccessBtn');
  if(firstAccess){
    firstAccess.disabled=true;
    firstAccess.hidden=true;
    firstAccess.setAttribute('aria-hidden','true');
    firstAccess.style.setProperty('display','none','important');
  }
  const hint=document.querySelector('.passwordHint');
  if(hint)hint.textContent='O acesso é provisionado pelo administrador. Entre com o e-mail cadastrado e sua senha.';
});

function setAuthMsg(msg,err=false){
  const el=document.getElementById('authMsg');
  if(!el) return;
  el.textContent=msg||'';
  el.className='authMsg '+(err?'err':'ok');
}
function findUserByCpfInput(){
  const c=cpf(document.getElementById('cpfInput').value||'');
  const u=[...DATA.auth,...DATA.master].find(x=>x.cpf===c);
  return {cpf:c,user:u};
}
function portalEmailFromCpf(c){
  return `${c}@portalfi.brabus`;
}
function operationalMetricsPeriod(){
  return {
    start:document.getElementById('dtIni')?.value||'',
    end:document.getElementById('dtFim')?.value||''
  };
}
function operationalMetricsSafeError(message){
  const text=String(message||'');
  if(text.includes('Período máximo permitido')) return 'O período máximo permitido é de 732 dias.';
  if(text.includes('Período inválido')) return 'As datas informadas formam um período inválido.';
  if(text.includes('Conta sem perfil ativo')) return 'A conta não possui um perfil ativo para esta consulta.';
  if(text.includes('JWT')||text.includes('session')) return 'Sua sessão expirou. Saia e entre novamente.';
  return 'Não foi possível carregar os indicadores autorizados.';
}
function operationalMetricsKey(){
  const p=operationalMetricsPeriod();
  return `${p.start}|${p.end}|${USER?.tipo||''}|${USER?.loja||''}`;
}
async function loadOperationalCommissionMetrics(force=false){
  if(!supabaseClient||!USER) return null;
  const period=operationalMetricsPeriod();
  if(!period.start||!period.end) return null;
  const key=operationalMetricsKey();
  if(!force&&OPERATIONAL_METRICS_STATE.key===key&&OPERATIONAL_METRICS_STATE.data){
    return OPERATIONAL_METRICS_STATE.data;
  }
  if(OPERATIONAL_METRICS_STATE.loading&&OPERATIONAL_METRICS_PENDING){
    const pendingKey=OPERATIONAL_METRICS_PENDING_KEY;
    const pendingResult=await OPERATIONAL_METRICS_PENDING;
    if(pendingKey===key) return pendingResult;
    return await loadOperationalCommissionMetrics(force);
  }
  OPERATIONAL_METRICS_STATE.loading=true;
  OPERATIONAL_METRICS_STATE.error='';
  OPERATIONAL_METRICS_PENDING_KEY=key;
  OPERATIONAL_METRICS_PENDING=(async()=>{
    const {data,error}=await supabaseClient.rpc('operational_commission_metrics',{
      p_start:period.start,
      p_end:period.end
    });
    if(error) throw error;
    if(!data||!Array.isArray(data.rows)||!data.totals){
      throw new Error('Resposta operacional incompleta.');
    }
    OPERATIONAL_METRICS_STATE={key,data,loading:false,error:''};
    try{
      const analystResult=await supabaseClient.rpc(
        'operational_analyst_commission_metrics_v2',
        {p_start:period.start,p_end:period.end}
      );
      if(analystResult.error) throw analystResult.error;
      OPERATIONAL_ANALYST_METRICS_STATE={
        key,
        rows:Array.isArray(analystResult.data?.rows)?analystResult.data.rows:[],
        error:''
      };
    }catch(analystError){
      OPERATIONAL_ANALYST_METRICS_STATE={
        key:'',
        rows:[],
        error:analystError?.message||'Falha ao carregar comissoes de analistas.'
      };
      console.error(
        'Metricas de analistas indisponiveis:',
        OPERATIONAL_ANALYST_METRICS_STATE.error
      );
    }
    try{
      const managerResult=await supabaseClient.rpc(
        'operational_salary_manager_directory',
        {p_start:period.start,p_end:period.end}
      );
      if(managerResult.error) throw managerResult.error;
      OPERATIONAL_MANAGER_DIRECTORY_STATE={
        key,
        rows:Array.isArray(managerResult.data?.rows)?managerResult.data.rows:[],
        error:''
      };
    }catch(managerError){
      OPERATIONAL_MANAGER_DIRECTORY_STATE={
        key:'',
        rows:[],
        error:managerError?.message||'Falha ao carregar nomes de gerentes.'
      };
      console.error(
        'Nomes de gerentes indisponiveis:',
        OPERATIONAL_MANAGER_DIRECTORY_STATE.error
      );
    }
    return data;
  })();
  try{
    return await OPERATIONAL_METRICS_PENDING;
  }catch(error){
    OPERATIONAL_METRICS_STATE={
      key:'',
      data:null,
      loading:false,
      error:error?.message||'Falha ao carregar métricas operacionais.'
    };
    console.error('Métricas operacionais indisponíveis:',OPERATIONAL_METRICS_STATE.error);
    return null;
  }finally{
    OPERATIONAL_METRICS_PENDING=null;
    OPERATIONAL_METRICS_PENDING_KEY='';
  }
}
function operationalTotalsForCurrentStore(){
  const data=OPERATIONAL_METRICS_STATE.data;
  if(!data||OPERATIONAL_METRICS_STATE.key!==operationalMetricsKey()) return null;
  const selected=document.getElementById('lojaSel')?.value||'';
  if(!selected) return data.totals||null;
  const rows=(data.rows||[]).filter(row=>norm(row.store)===norm(selected));
  const totals=rows.reduce((acc,row)=>{
    acc.sold_count+=Number(row.sold_count)||0;
    acc.financed_count+=Number(row.financed_count)||0;
    acc.production_value+=Number(row.production_value)||0;
    acc.return_value+=Number(row.return_value)||0;
    acc.spf_count+=Number(row.spf_count)||0;
    acc.spf_value+=Number(row.spf_value)||0;
    return acc;
  },{sold_count:0,financed_count:0,production_value:0,return_value:0,spf_count:0,spf_value:0});
  const percent=Number(data.spf_net_percent)||70;
  totals.spf_net_value=Math.round(totals.spf_value*(percent/100)*100)/100;
  totals.profitability_value=Math.round(
    (totals.return_value+totals.spf_net_value)*100
  )/100;
  return totals;
}
function escapeOperationalHtml(value){
  return String(value??'').replace(/[&<>"']/g,char=>({
    '&':'&amp;',
    '<':'&lt;',
    '>':'&gt;',
    '"':'&quot;',
    "'":'&#39;'
  })[char]);
}
function operationalMetricFromRow(row){
  return {
    vendidas:Number(row.sold_count)||0,
    financiadas:Number(row.financed_count)||0,
    producao:Number(row.production_value)||0,
    retorno:Number(row.return_value)||0,
    spf:Number(row.spf_value)||0,
    spfQty:Number(row.spf_count)||0,
    items:[]
  };
}
function operationalAuthorizedRows(){
  const data=OPERATIONAL_METRICS_STATE.data;
  if(!data||OPERATIONAL_METRICS_STATE.key!==operationalMetricsKey()) return [];
  const selected=document.getElementById('lojaSel')?.value||'';
  return (data.rows||[]).filter(row=>!selected||norm(row.store)===norm(selected));
}
function operationalAuthorizedAnalystRows(){
  if(OPERATIONAL_ANALYST_METRICS_STATE.key!==operationalMetricsKey()) return [];
  const selected=document.getElementById('lojaSel')?.value||'';
  return (OPERATIONAL_ANALYST_METRICS_STATE.rows||[])
    .filter(row=>!selected||norm(row.store)===norm(selected));
}
function operationalManagerName(store,department){
  if(OPERATIONAL_MANAGER_DIRECTORY_STATE.key!==operationalMetricsKey()) return '';
  const match=(OPERATIONAL_MANAGER_DIRECTORY_STATE.rows||[]).find(row=>
    norm(row.store)===norm(store)&&norm(row.department)===norm(department)
  );
  return String(match?.manager_name||'').trim();
}
function registerOperationalAggregateDetail(detail){
  const index=OPERATIONAL_AGGREGATE_DETAIL_STATE.push(detail)-1;
  return index;
}
function operationalDetailButton(index){
  return `<button class="miniBtn detailBtn" onclick="showOperationalAggregateDetails(${index})">DETALHES</button>`;
}
function operationalAggregateRowHtml(row,kind='seller'){
  const metrics=operationalMetricFromRow(row);
  const status=String(row.department||'');
  const cls=kind==='manager'?'manager':'';
  const commission=commissionCalc(status,metrics,cls);
  const name=escapeOperationalHtml(row.seller_name||'VENDEDOR');
  const sellerId=String(row.seller_id||'');
  const detailLabel=kind==='seller'&&sellerId
    ?`<button class="miniBtn detailBtn" onclick="showOperationalSalaryDetails('${escapeOperationalHtml(sellerId)}','${encodeURIComponent(row.seller_name||'VENDEDOR')}')">DETALHES</button>`
    :'<span class="tag">AGREGADO SEGURO</span>';
  return `<tr class="${cls}">
    <td data-label="Nome">${name}</td>
    <td data-label="Vend.">${metrics.vendidas}</td>
    <td data-label="Fin.">${metrics.financiadas}</td>
    <td data-label="Share">${shareBadge(metrics.financiadas,metrics.vendidas)}</td>
    <td data-label="Retorno">${fmtMoney(metrics.retorno)}</td>
    <td data-label="70% SPF" class="spf70Value">${fmtMoney(commission.spfLiquido)}</td>
    <td data-label="Rentab.">${fmtMoney(commission.rentTotal)}</td>
    <td data-label="Faixa">${faixaBadge(commission.faixa,cls)}</td>
    <td data-label="Comissão" class="commValue">${fmtMoney(commission.comissaoPrincipal)}</td>
    <td data-label="Detalhes" style="text-align:center">${detailLabel}</td>
  </tr>`;
}
function operationalSalaryDetailRows(){
  const state=OPERATIONAL_SALARY_DETAIL_STATE;
  if(!state)return [];
  const query=norm(document.getElementById('salaryDetailSearch')?.value||'');
  const financed=document.getElementById('salaryDetailFinanced')?.value||'';
  const included=document.getElementById('salaryDetailIncluded')?.value||'';
  const store=document.getElementById('salaryDetailStore')?.value||'';
  const modality=document.getElementById('salaryDetailModality')?.value||'';
  const sort=document.getElementById('salaryDetailSort')?.value||'date_desc';
  const rows=(state.rows||[]).filter(row=>{
    const haystack=norm([row.operation_ref,row.chassis_masked,row.vehicle_model,row.store,row.modality].join(' '));
    if(query&&!haystack.includes(query))return false;
    if(financed&&String(Boolean(row.financed))!==financed)return false;
    if(included&&String(Boolean(row.included_in_commission))!==included)return false;
    if(store&&String(row.store||'')!==store)return false;
    if(modality&&String(row.modality||'')!==modality)return false;
    return true;
  });
  const numeric=(row,key)=>Number(row?.[key])||0;
  const time=row=>String(row.date||'');
  rows.sort((a,b)=>{
    if(sort==='date_asc')return time(a).localeCompare(time(b));
    if(sort==='sale_desc')return numeric(b,'sale_value')-numeric(a,'sale_value');
    if(sort==='financed_desc')return numeric(b,'financed_value')-numeric(a,'financed_value');
    if(sort==='return_desc')return numeric(b,'return_considered')-numeric(a,'return_considered');
    if(sort==='profit_desc')return numeric(b,'operation_profitability')-numeric(a,'operation_profitability');
    return time(b).localeCompare(time(a));
  });
  return rows;
}
function operationalSalaryDetailItemHtml(row){
  const returnGross=Number(row.return_gross)||0;
  const returnConsidered=Number(row.return_considered)||0;
  const spfGross=Number(row.spf_gross)||0;
  const spfConsidered=Number(row.spf_considered)||0;
  const commissionStatus=row.included_in_commission
    ?'<span class="salaryStatus salaryIncluded">INCLUIDA</span>'
    :`<span class="salaryStatus salaryExcluded">EXCLUIDA</span><small>${escapeOperationalHtml(row.exclusion_reason||'Sem motivo informado')}</small>`;
  const financeStatus=row.financed
    ?'<span class="tag ok">FINANCIADO</span>'
    :'<span class="tag">NAO FINANCIADO</span>';
  const cls=row.financed?'fin':'nofin';
  const term=row.installments
    ?`${Number(row.installments)||0}x de ${fmtMoney(Number(row.installment_value)||0)}`
    :'-';
  return `<div class="chassisItem ${cls}">
    <div><b>${escapeOperationalHtml(row.chassis_masked||row.operation_ref||'SEM IDENTIFICADOR')}</b> ${financeStatus}</div>
    <div class="note">Operacao: ${escapeOperationalHtml(row.operation_ref||'-')} · Venda: ${dataBR(row.date||'')} · Financiamento: ${row.finance_date?dataBR(row.finance_date):'-'}</div>
    <div class="note">Loja: ${escapeOperationalHtml(row.store||'-')} · Gerente: ${escapeOperationalHtml(row.manager_name||'NAO LOCALIZADO')} · Modelo: ${escapeOperationalHtml(row.vehicle_model||'-')}</div>
    <div class="detailGrid">
      <span>Valor da venda: <b>${fmtMoney(Number(row.sale_value)||0)}</b></span>
      <span>Valor financiado: <b>${fmtMoney(Number(row.financed_value)||0)}</b></span>
      <span>Modalidade: <b>${escapeOperationalHtml(row.modality||'-')}</b></span>
      <span>Prazo / parcela: <b>${term}</b></span>
      <span>Retorno considerado: <b>${fmtMoney(returnConsidered)}</b><small>Bruto: ${fmtMoney(returnGross)}</small></span>
      <span>SPF considerado: <b>${fmtMoney(spfConsidered)}</b><small>${Number(row.spf_count)||0} produto(s) · bruto ${fmtMoney(spfGross)}</small></span>
      <span>70% do SPF: <b>${fmtMoney(Number(row.spf_70)||0)}</b></span>
      <span>Rentabilidade total: <b>${fmtMoney(Number(row.operation_profitability)||0)}</b></span>
      <span>Comissao: ${commissionStatus}<small>${escapeOperationalHtml(row.applied_rule||'Faixa consolidada')}</small></span>
    </div>
  </div>`;
}
function applyOperationalSalaryDetailFilters(){
  const rows=operationalSalaryDetailRows();
  const body=document.getElementById('salaryDetailRows');
  const count=document.getElementById('salaryDetailCount');
  if(body)body.innerHTML=rows.map(operationalSalaryDetailItemHtml).join('')
    ||'<tr><td colspan="12" class="salaryEmpty">Nenhuma operacao encontrada com estes filtros.</td></tr>';
  if(count)count.textContent=`${rows.length} de ${OPERATIONAL_SALARY_DETAIL_STATE?.rows?.length||0} operacoes`;
}
function salaryDetailOptions(rows,key){
  return [...new Set(rows.map(row=>String(row[key]||'').trim()).filter(Boolean))]
    .sort((a,b)=>a.localeCompare(b))
    .map(value=>`<option value="${escapeOperationalHtml(value)}">${escapeOperationalHtml(value)}</option>`)
    .join('');
}
function renderOperationalSalaryDetailsModal(){
  const state=OPERATIONAL_SALARY_DETAIL_STATE;
  const shell=document.getElementById('chassisModal');
  if(!state||!shell)return;
  const {name,period,metrics,commission,data}=state;
  const rows=operationalSalaryDetailRows();
  shell.innerHTML=`<div class="modalBack" onclick="closeModal(event)">
    <section class="modalBox" role="dialog" aria-modal="true" aria-label="Detalhes das vendas">
      <div class="modalHead"><h2>Detalhes · ${escapeOperationalHtml(name)}</h2><button onclick="document.getElementById('chassisModal').remove()">Fechar</button></div>
      <div class="detailCard">
        <div class="detailGrid">
          <span>Periodo: <b>${dataBR(period.start)} a ${dataBR(period.end)}</b></span>
          <span>Vendidas: <b>${metrics.vendidas}</b></span>
          <span>Financiadas: <b>${metrics.financiadas}</b></span>
          <span>Share: <b>${pct(metrics.financiadas,metrics.vendidas)}</b></span>
          <span>Producao: <b>${fmtMoney(metrics.producao||0)}</b></span>
          <span>Retorno: <b>${fmtMoney(metrics.retorno)}</b></span>
          <span>SPF Extra: <b>${fmtMoney(metrics.spf)}</b></span>
          <span>SPF Liquido 70%: <b>${fmtMoney(commission.spfLiquido)}</b></span>
          <span>Rentabilidade total: <b>${fmtMoney(commission.rentTotal)}</b></span>
          <span>Faixa unica: <b>${fmtPct2(commission.faixa)}</b></span>
          <span>Comissao principal: <b>${fmtMoney(commission.comissaoPrincipal)}</b></span>
        </div>
        <div class="formulaBox"><b>Formula:</b> Rentabilidade total = Retorno bruto (${fmtMoney(metrics.retorno)}) + SPF liquido 70% (${fmtMoney(commission.spfLiquido)}) = <b>${fmtMoney(commission.rentTotal)}</b><br><b>Seguranca:</b> somente operacoes autorizadas, com chassi mascarado e sem cliente, CPF ou NBS.</div>
      </div>
      <h3>Chassis vendidos</h3>
      <div class="chassisList">${rows.map(operationalSalaryDetailItemHtml).join('')||'<p class="note">Nenhum chassi vendido no periodo.</p>'}</div>
      ${data.truncated?`<p class="note warn">Limite seguro: ${data.row_limit} de ${data.row_count} operacoes.</p>`:''}
    </section>
  </div>`;
}
async function showOperationalSalaryDetails(sellerId,nameEncoded){
  const name=decodeURIComponent(nameEncoded||'VENDEDOR');
  const period=operationalMetricsPeriod();
  if(!supabaseClient||!period.start||!period.end){
    alert('Nao foi possivel identificar a sessao ou o periodo da conferencia.');
    return;
  }
  document.getElementById('chassisModal')?.remove();
  const shell=document.createElement('div');
  shell.id='chassisModal';
  shell.innerHTML=`<div class="modalBack salaryModalBack" onclick="closeModal(event)"><div class="modalBox salaryModal salaryLoading"><div class="modalHead"><h2>Conferencia segura de vendas</h2><button class="secondary" onclick="document.getElementById('chassisModal').remove()">Fechar</button></div><p>Carregando operacoes autorizadas...</p></div></div>`;
  document.body.appendChild(shell);
  try{
    const {data,error}=await supabaseClient.rpc('operational_salary_details',{
      p_start:period.start,p_end:period.end,p_seller_id:sellerId
    });
    if(error)throw error;
    if(!data||!Array.isArray(data.rows)||data.contains_client_identity||
       data.contains_personal_documents||data.contains_full_chassis||
       data.contains_chassis||data.contains_nbs){
      throw new Error('Resposta de conferencia insegura ou incompleta.');
    }
    const aggregate=operationalAuthorizedRows().find(
      row=>String(row.seller_id||'')===String(sellerId)
    );
    const metrics=operationalMetricFromRow(aggregate||{});
    const commission=commissionCalc(String(aggregate?.department||''),metrics,'');
    const rows=data.rows.map(row=>({
      ...row,
      manager_name:operationalManagerName(row.store,row.department)
    }));
    OPERATIONAL_SALARY_DETAIL_STATE={name,period,metrics,commission,data,rows};
    renderOperationalSalaryDetailsModal();
  }catch(error){
    OPERATIONAL_SALARY_DETAIL_STATE=null;
    shell.innerHTML=`<div class="modalBack salaryModalBack" onclick="closeModal(event)"><div class="modalBox salaryModal"><div class="modalHead"><h2>Conferencia segura de vendas</h2><button class="secondary" onclick="document.getElementById('chassisModal').remove()">Fechar</button></div><div class="salaryError"><b>Nao foi possivel carregar as operacoes autorizadas.</b><span>${escapeOperationalHtml(error?.message||'Tente novamente.')}</span></div></div></div>`;
  }
}
function operationalAggregateSummaryCards(metrics,commission,kind){
  const isAnalyst=kind==='analyst';
  return `<div class="aggregateDetailCards">
    <article><span>Vendidas</span><b>${metrics.vendidas}</b></article>
    <article><span>Financiadas</span><b>${metrics.financiadas}</b></article>
    <article><span>Share</span><b>${pct(metrics.financiadas,metrics.vendidas)}</b></article>
    <article><span>Produção</span><b>${fmtMoney(metrics.producao)}</b></article>
    <article><span>Retorno</span><b>${fmtMoney(metrics.retorno)}</b></article>
    <article><span>SPF bruto</span><b>${fmtMoney(metrics.spf)}</b></article>
    <article><span>70% SPF</span><b>${fmtMoney(commission.spfLiquido)}</b></article>
    <article><span>Rentabilidade</span><b>${fmtMoney(commission.rentTotal)}</b></article>
    ${isAnalyst?`<article><span>Bônus SPF</span><b>${fmtMoney(commission.comissaoSpf)}</b><small>${metrics.spfQty} produto(s)</small></article>`:''}
    <article class="aggregateCommissionCard"><span>Comissão total</span><b>${fmtMoney(isAnalyst?commission.comissaoTotal:commission.comissaoPrincipal)}</b><small>Faixa ${fmtPct2(commission.faixa)}</small></article>
  </div>`;
}
function operationalManagerMemoryTable(rows){
  return `<div class="tableWrap aggregateMemoryWrap"><table class="aggregateMemoryTable">
    <thead><tr><th>Vendedor</th><th>Vend.</th><th>Fin.</th><th>Share</th><th>Retorno</th><th>70% SPF</th><th>Rentabilidade</th><th>Faixa</th><th>Comissão</th></tr></thead>
    <tbody>${rows.map(row=>{
      const metrics=operationalMetricFromRow(row);
      const commission=commissionCalc(String(row.department||''),metrics,'');
      return `<tr>
        <td>${escapeOperationalHtml(row.seller_name||'VENDEDOR')}</td>
        <td>${metrics.vendidas}</td><td>${metrics.financiadas}</td>
        <td>${pct(metrics.financiadas,metrics.vendidas)}</td>
        <td>${fmtMoney(metrics.retorno)}</td><td>${fmtMoney(commission.spfLiquido)}</td>
        <td>${fmtMoney(commission.rentTotal)}</td><td>${fmtPct2(commission.faixa)}</td>
        <td><b>${fmtMoney(commission.comissaoPrincipal)}</b></td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
}
function showOperationalAggregateDetails(index){
  const detail=OPERATIONAL_AGGREGATE_DETAIL_STATE[Number(index)];
  if(!detail)return;
  document.getElementById('chassisModal')?.remove();
  const period=operationalMetricsPeriod();
  const metrics=detail.metrics;
  const commission=detail.commission;
  const isAnalyst=detail.kind==='analyst';
  const shell=document.createElement('div');
  shell.id='chassisModal';
  const responsibility=isAnalyst
    ?(detail.transfer
      ?`SUBSTITUTA DURANTE FÉRIAS/AUSÊNCIA · ${dataBR(detail.coveredStart)} a ${dataBR(detail.coveredEnd)}`
      :'ANALISTA OFICIAL')
    :'RESULTADO AGREGADO DA EQUIPE AUTORIZADA';
  const memory=isAnalyst
    ?`<div class="aggregateRule">
        <h3>Memória por loja e período</h3>
        <div class="aggregateRuleGrid">
          <div><span>Loja</span><b>${escapeOperationalHtml(detail.store||'-')}</b></div>
          <div><span>Responsabilidade</span><b>${responsibility}</b></div>
          <div><span>Período considerado</span><b>${dataBR(detail.coveredStart||period.start)} a ${dataBR(detail.coveredEnd||period.end)}</b></div>
          <div><span>Regra aplicada</span><b>Rentabilidade × ${fmtPct2(commission.faixa)} + ${fmtMoney(cfgNum('bonus_spf_analista'))} por SPF</b></div>
        </div>
      </div>`
    :`<div class="aggregateRule">
        <h3>Memória por vendedor</h3>
        <p>O total gerencial usa o resultado agregado da loja/departamento. A tabela abaixo demonstra os vendedores que compõem esse resultado, todos já limitados pelo escopo autorizado no banco.</p>
        ${operationalManagerMemoryTable(detail.rows||[])}
        <div class="aggregateFormula"><b>Regra gerencial:</b> (${fmtMoney(metrics.retorno)} de retorno + ${fmtMoney(commission.spfLiquido)} de 70% SPF) × ${fmtPct2(commission.faixa)} = <b>${fmtMoney(commission.comissaoPrincipal)}</b></div>
      </div>`;
  shell.innerHTML=`<div class="modalBack aggregateModalBack" onclick="closeModal(event)">
    <section class="modalBox aggregateDetailModal" role="dialog" aria-modal="true" aria-label="Detalhes da comissão">
      <div class="modalHead aggregateModalHead">
        <div><span class="salaryEyebrow">ACOMPANHAMENTO DE SALÁRIOS</span><h2>Detalhes da comissão</h2><p>${escapeOperationalHtml(detail.name)} · ${escapeOperationalHtml(detail.store||'TODAS')} · ${dataBR(period.start)} a ${dataBR(period.end)}</p></div>
        <button class="secondary" onclick="document.getElementById('chassisModal').remove()">Fechar</button>
      </div>
      ${operationalAggregateSummaryCards(metrics,commission,detail.kind)}
      ${memory}
      <p class="salaryPrivacy"><b>Segurança:</b> memória agregada, sem cliente, CPF, chassi, NBS ou identificadores pessoais. O escopo foi validado no banco antes de chegar ao navegador.</p>
    </section>
  </div>`;
  document.body.appendChild(shell);
}
function operationalManagerRowHtml(label,rows,status,store){
  if(!rows.length) return '';
  const metrics=sumRows(rows.map(row=>({m:operationalMetricFromRow(row)})));
  const commission=commissionCalc(status,metrics,'manager');
  const detailIndex=registerOperationalAggregateDetail({
    kind:'manager',name:label,store:store||rows[0]?.store||'',status,
    metrics,commission,rows
  });
  const department=norm(status).includes('SEMINOVOS')?'SEMINOVOS':'NOVOS';
  const managerName=operationalManagerName(store||rows[0]?.store||'',department);
  return `<tr class="manager">
    <td data-label="Nome">${escapeOperationalHtml(managerName||label)}</td>
    <td data-label="Vend.">${metrics.vendidas}</td><td data-label="Fin.">${metrics.financiadas}</td>
    <td data-label="Share">${shareBadge(metrics.financiadas,metrics.vendidas)}</td>
    <td data-label="Retorno">${fmtMoney(metrics.retorno)}</td>
    <td data-label="70% SPF" class="spf70Value">${fmtMoney(commission.spfLiquido)}</td>
    <td data-label="Rentab.">${fmtMoney(commission.rentTotal)}</td>
    <td data-label="Faixa">${faixaBadge(commission.faixa,'manager')}</td>
    <td data-label="Comissão" class="commValue">${fmtMoney(commission.comissaoPrincipal)}</td>
    <td data-label="Detalhes" style="text-align:center">${operationalDetailButton(detailIndex)}</td>
  </tr>`;
}
function operationalAnalystRowHtml(row){
  const metrics=operationalMetricFromRow(row);
  const commission=commissionCalc('ANALISTA',metrics,'analyst');
  const name=escapeOperationalHtml(row.analyst_name||'ANALISTA NAO LOCALIZADO');
  const transfer=row.transfer===true;
  const coveredPeriod=transfer&&row.covered_start&&row.covered_end
    ?`${dataBR(row.covered_start)} a ${dataBR(row.covered_end)}`
    :'';
  const displayName=transfer
    ?`${name} <span class="ausenciaTransferBadge">FERIAS/AUSENCIA - periodo ${coveredPeriod}</span>`
    :name;
  const detailIndex=registerOperationalAggregateDetail({
    kind:'analyst',
    name:row.analyst_name||'ANALISTA NAO LOCALIZADO',
    store:row.store||'',
    transfer,
    coveredStart:row.covered_start||'',
    coveredEnd:row.covered_end||'',
    metrics,
    commission,
    rows:[row]
  });
  return `<tr class="analyst">
    <td data-label="Nome">${displayName}</td>
    <td data-label="Vend.">${metrics.vendidas}</td>
    <td data-label="Fin.">${metrics.financiadas}</td>
    <td data-label="Share">${shareBadge(metrics.financiadas,metrics.vendidas)}</td>
    <td data-label="Retorno">${fmtMoney(metrics.retorno)}</td>
    <td data-label="70% SPF" class="spf70Value">${fmtMoney(commission.spfLiquido)}</td>
    <td data-label="Rentab.">${fmtMoney(commission.rentTotal)}</td>
    <td data-label="Faixa">${faixaBadge(commission.faixa,'analyst')}</td>
    <td data-label="Com. Total" class="commValue">${fmtMoney(commission.comissaoTotal)}</td>
    <td data-label="Detalhes" style="text-align:center">${operationalDetailButton(detailIndex)}</td>
  </tr>`;
}
function renderOperationalSecureContent(){
  OPERATIONAL_AGGREGATE_DETAIL_STATE=[];
  const rows=operationalAuthorizedRows();
  if(!rows.length){
    return '<div class="panel"><b>API SEGURA:</b> nenhum indicador autorizado foi encontrado para este período e loja.</div>';
  }
  const analystRows=operationalAuthorizedAnalystRows();
  const stores=[...new Set(rows.map(row=>String(row.store||'SEM LOJA')))]
    .sort((a,b)=>a.localeCompare(b,'pt-BR'));
  return stores.map(store=>{
    const storeRows=rows.filter(row=>String(row.store||'SEM LOJA')===store);
    const sections=[
      {key:'NOVOS',label:'NOVOS'},
      {key:'SEMINOVOS',label:'SEMINOVOS'},
      {key:'NOVOS/SEMINOVOS',label:'NOVOS / SEMINOVOS'}
    ];
    let html=`<div class="store">${escapeOperationalHtml(store)}</div>`;
    html+='<div class="tableWrap"><table class="compactMain main10"><thead><tr><th>Nome</th><th>Vend.</th><th>Fin.</th><th>Share</th><th>Retorno</th><th>70% SPF</th><th>Rentab. Total</th><th>Faixa</th><th>Comissão</th><th>Detalhes</th></tr></thead><tbody>';
    sections.forEach(section=>{
      const sectionRows=storeRows.filter(row=>norm(row.department)===section.key);
      if(!sectionRows.length) return;
      html+=`<tr><td colspan="10" style="text-align:left;background:#151515"><b>${section.label}</b></td></tr>`;
      sectionRows
        .sort((a,b)=>String(a.seller_name||'').localeCompare(String(b.seller_name||''),'pt-BR'))
        .forEach(row=>{html+=operationalAggregateRowHtml(row)});
      if(section.key!=='NOVOS/SEMINOVOS'){
        html+=operationalManagerRowHtml(
          `GERENTE ${section.label}`,
          sectionRows,
          `GERENTE ${section.label}`,
          store
        );
      }
    });
    html+='</tbody></table></div>';
    const storeAnalysts=analystRows.filter(row=>norm(row.store)===norm(store));
    if(storeAnalysts.length&&(USER.tipo==='MASTER'||USER.tipo==='ANALISTA'||isDiretorComissao(USER))){
      html+='<h3>Analista</h3><div class="tableWrap"><table class="compactMain main10 analystMain"><thead><tr><th>Nome</th><th>Vend.</th><th>Fin.</th><th>Share</th><th>Retorno</th><th>70% SPF</th><th>Rentab. Total</th><th>Faixa</th><th>Com. Total</th><th>Detalhes</th></tr></thead><tbody>';
      storeAnalysts.forEach(row=>{html+=operationalAnalystRowHtml(row)});
      html+='</tbody></table></div>';
    }
    html+='<p class="note"><b>Fonte:</b> API segura · visão agregada, sem CPF, cliente, chassi ou NBS.</p>';
    return html;
  }).join('');
}

function renderOperationalSecureState(){
  const expectedKey=operationalMetricsKey();
  const hasCurrentData=OPERATIONAL_METRICS_STATE.key===expectedKey&&OPERATIONAL_METRICS_STATE.data;
  if(hasCurrentData)return renderOperationalSecureContent();
  const message=OPERATIONAL_METRICS_STATE.error
    ?'Não foi possível carregar os dados autorizados. Ajuste o período ou tente novamente.'
    :'Carregando dados autorizados pela API segura...';
  return `<section class="empty"><h3>API SEGURA</h3><p>${message}</p></section>`;
}

function renderOperationalSecureAudit(){
  const audit=document.getElementById('audit');
  if(!audit) return;
  audit.innerHTML='<h2>Auditoria segura</h2><p class="note">Os indicadores desta tela são calculados no banco e retornados conforme o perfil autenticado. As planilhas operacionais, identidades de clientes e chassis não são carregados pelo navegador.</p>';
}
async function refreshOperationalMetricsAndRender(force=true){
  await loadOperationalCommissionMetrics(force);
  render();
}
function portalUserFromDatabase(row){
  if(!row)return null;
  const tipo=String(row.perfil||'').toUpperCase();
  const status=String(row.status||'');
  const statusGroups=status.toUpperCase().split('/').map(x=>x.trim()).filter(Boolean);
  return {
    id:row.id,
    authUserId:row.auth_user_id,
    cpf:cpf(row.cpf_normalizado||row.cpf||''),
    nome:row.nome||'',
    nomeKey:norm(row.nome||''),
    tipo,
    loja:row.loja||'',
    status,
    statusGroups,
    ativo:row.ativo!==false,
    primeiroAcesso:row.primeiro_acesso===true
  };
}
async function carregarUsuarioAutorizado(){
  if(!supabaseClient)return null;
  const {data,error}=await supabaseClient.rpc('usuario_logado_fi');
  if(error)throw error;
  const row=Array.isArray(data)?data[0]:data;
  const user=portalUserFromDatabase(row);
  if(!user||!user.ativo)throw new Error('Usuário não provisionado ou inativo.');
  return user;
}
async function registrarMeuLoginSeguro(){
  if(!supabaseClient)return null;
  const {data,error}=await supabaseClient.rpc('registrar_meu_login');
  if(error)throw error;
  return portalUserFromDatabase(Array.isArray(data)?data[0]:data);
}
async function getUsuarioSupabaseByCpf(c){
  if(!supabaseClient || !c) return null;
  const user=await carregarUsuarioAutorizado();
  return user&&cpf(user.cpf)===cpf(c)?user:null;
}
async function syncSupabaseUsuario(u,authUser,opts={}){
  if(!supabaseClient || !u || !authUser) return;
  const {error}=await supabaseClient.rpc('registrar_meu_login');
  if(error) console.warn('Falha ao registrar login seguro:',error.message);
  await registrarLogAcesso(u,true,'Login realizado');
}
async function registrarLogAcesso(uOuCpf,sucesso=true,mensagem=''){
  try{
    if(!supabaseClient) return;
    const {data:sessionData}=await supabaseClient.auth.getSession();
    if(!sessionData?.session) return;
    await supabaseClient.rpc('operational_record_access_event',{
      p_success:!!sucesso,
      p_message:mensagem||'',
      p_user_agent:navigator.userAgent
    });
  }catch(e){ console.warn('Falha ao registrar log:', e); }
}
async function primeiroAcesso(){
  if(PORTAL_RUNTIME_CONFIG.authMode==='secure'){
    setAuthMsg('O cadastro é realizado pelo administrador. Solicite seu acesso ao responsável pelo portal.',true);
    return;
  }
  if(!DATA_READY){alert('As bases ainda não foram carregadas. Aguarde a mensagem de sucesso ou verifique o erro de carregamento.');return}
  if(!supabaseClient){setAuthMsg('Supabase não foi carregado. Verifique conexão ou configuração.',true);return}
  const {cpf:c,user:u}=findUserByCpfInput();
  const senha=(document.getElementById('senhaInput')?.value||'').trim();
  if(!u){setAuthMsg('CPF não localizado na base oficial de colaboradores.',true);return}
  if(!senha || senha.length<6){setAuthMsg('Digite uma senha com pelo menos 6 caracteres.',true);return}
  setAuthMsg('Cadastrando primeiro acesso...');
  const email=portalEmailFromCpf(c);
  const {data,error}=await supabaseClient.auth.signUp({email,password:senha});
  if(error){
    setAuthMsg('Não foi possível cadastrar. Se já fez o primeiro acesso, use Entrar. Detalhe: '+error.message,true);
    await registrarLogAcesso(c,false,error.message);
    return;
  }
  if(data?.user){
    await syncSupabaseUsuario(u,data.user);
    await carregarParametrosPortal();
    USER=u;
    REAL_USER=u;
    HOMOLOGATION_USER=null;
    setAuthMsg('');
    await initApp();
  }else{
    setAuthMsg('Cadastro iniciado. Tente entrar com CPF e senha.',true);
  }
}
async function tentarRestaurarSessao(){
  try{
    if(!supabaseClient || !DATA_READY) return;
    const {data}=await supabaseClient.auth.getSession();
    const session=data?.session;
    if(PORTAL_RUNTIME_CONFIG.authMode==='secure'){
      if(!session)return;
      const u=await carregarUsuarioAutorizado();
      await carregarParametrosPortal();
      USER=u;
      REAL_USER=u;
      HOMOLOGATION_USER=null;
      await initApp();
      return;
    }
    const email=session?.user?.email||'';
    if(!session || !email.endsWith('@portalfi.brabus')) return;
    const c=cpf(email.split('@')[0]);
    const u=[...DATA.auth,...DATA.master].find(x=>x.cpf===c);
    if(u){
      await carregarParametrosPortal();
      USER=u;
      REAL_USER=u;
      HOMOLOGATION_USER=null;
      await initApp();
    }
  }catch(e){
    console.warn('Falha ao restaurar sessão:',e);
    try{await supabaseClient?.auth?.signOut();}catch(signOutError){}
    USER=null;
    REAL_USER=null;
    document.getElementById('portalHome')?.classList.add('hidden');
    document.getElementById('app')?.classList.add('hidden');
    document.getElementById('loginBox')?.classList.remove('hidden');
    setAuthMsg('A sessão anterior expirou ou não pertence a este ambiente. Entre novamente.',true);
  }
}


async function esqueciSenha(){
  if(!supabaseClient){setAuthMsg('Supabase não foi carregado. Verifique conexão ou configuração.',true);return}
  if(PORTAL_RUNTIME_CONFIG.authMode==='secure'){
    if(PORTAL_RUNTIME_CONFIG.passwordRecoveryMode!=='email'){
      setAuthMsg('Solicite ao administrador a redefinição segura da sua senha.',false);
      return;
    }
    const email=(document.getElementById('cpfInput')?.value||'').trim().toLowerCase();
    if(!email||!email.includes('@')){
      setAuthMsg('Digite o e-mail cadastrado para solicitar a redefinição.',true);
      return;
    }
    setAuthMsg('Enviando instruções de redefinição...');
    const currentPage=window.location.href.split('#')[0].split('?')[0];
    const redirectTo=window.location.origin==='null'?currentPage:(window.location.origin+window.location.pathname);
    let captchaToken='';
    try{
      captchaToken=await obtainTurnstileToken();
    }catch(error){
      setAuthMsg(error?.message||'Não foi possível concluir a verificação de segurança.',true);
      return;
    }
    const recoveryOptions={redirectTo};
    if(captchaToken)recoveryOptions.captchaToken=captchaToken;
    const {error}=await supabaseClient.auth.resetPasswordForEmail(email,recoveryOptions);
    if(error){
      console.warn('Falha na solicitação de recuperação:',error.message);
    }
    setAuthMsg('Se o e-mail estiver cadastrado, você receberá as instruções para criar uma nova senha.',false);
    return;
  }
  if(!DATA_READY){alert('As bases ainda não foram carregadas. Aguarde a mensagem de sucesso.');return}
  const {cpf:c,user:u}=findUserByCpfInput();
  if(!u){setAuthMsg('Informe um CPF válido da base oficial para solicitar redefinição.',true);return}

  await registrarLogAcesso(u,false,'Solicitação de redefinição de senha');

  setAuthMsg('Peça ao administrador para redefinir sua senha.',false);
}


async function trocarSenhaObrigatoria(u){
  const nova=prompt('Troca de senha obrigatória. Digite uma nova senha com no mínimo 8 caracteres:');
  if(!nova || nova.length<8){
    setAuthMsg('A nova senha precisa ter no mínimo 8 caracteres.',true);
    try{await supabaseClient.auth.signOut();}catch(e){}
    return false;
  }
  const conf=prompt('Confirme a nova senha:');
  if(nova!==conf){
    setAuthMsg('As senhas não conferem.',true);
    try{await supabaseClient.auth.signOut();}catch(e){}
    return false;
  }
  const {error}=await supabaseClient.auth.updateUser({password:nova});
  if(error){
    setAuthMsg('Não foi possível atualizar a senha: '+error.message,true);
    try{await supabaseClient.auth.signOut();}catch(e){}
    return false;
  }
  const {error:profileError}=await supabaseClient.rpc('operational_complete_password_change');
  if(profileError) throw profileError;
  await registrarLogAcesso(u,true,'Senha alterada no primeiro acesso obrigatório');
  return true;
}


const PORTAL_LINKS={seminovos:'https://luisgamadio-spec.github.io/simulador_seminovos_brabus/',completo:'https://luisgamadio-spec.github.io/simulador_completo_brabus/',dashbi:'https://luisgamadio-spec.github.io/analise_fandi_brabus/',gestao:'https://luisgamadio-spec.github.io/dashboard-fi-brabus/'};
const PORTAL_MODULES=[{id:'simuladorSeminovos',grupo:'🚗 Simuladores',title:'SIMULADOR DE SEMINOVOS',desc:'Simulador dedicado à operação de seminovos.',icon:'🚘',url:PORTAL_LINKS.seminovos},{id:'simuladorCompleto',grupo:'🚗 Simuladores',title:'SIMULADOR DE NOVOS',desc:'Simulador dedicado às operações de novos e planos especiais.',icon:'🏦',url:PORTAL_LINKS.completo},{id:'dashbi',grupo:'📊 Gestão',title:'ANÁLISE GERAL DO GRUPO',desc:'Visão analítica geral do Grupo Brabus Mitsubishi.',icon:'📈',url:PORTAL_LINKS.dashbi},{id:'gestao',grupo:'📊 Gestão',title:'ANÁLISE F&I DO GRUPO',desc:'Análise operacional F&I/FANDI consolidada do Grupo.',icon:'📋',url:PORTAL_LINKS.gestao},{id:'painelAnalistaFi',grupo:'🎧 Atendimento F&I',title:'PAINEL DO ANALISTA F&I',desc:'Controle seu status na fila de atendimento: online, ocupado, almoço, férias ou offline.',icon:'🎧',internal:true},{id:'comissoes',grupo:'💰 Comissões',title:'ACOMPANHAMENTO DE SALÁRIOS',desc:'Portal interno de comissões, detalhes, regras e painel Master.',icon:'💰',internal:true}];
// Recursos de demonstração nunca devem estar ativos no artefato publicado.
// A autorização real continua sendo responsabilidade de RLS/RPC no Supabase.
const PORTAL_SECURITY = Object.freeze({
  allowDemoLogin: false,
  allowClientHomologation: false
});
function currentPortalUser(){return HOMOLOGATION_USER||USER;}
function portalStatusHas(u,grupo){
  const groups=(u?.statusGroups||[]).map(x=>String(x).toUpperCase());
  if(groups.includes(String(grupo).toUpperCase())) return true;
  const st=String(u?.status||'').toUpperCase().split('/').map(x=>x.trim());
  return st.includes(String(grupo).toUpperCase());
}
function portalAllowedModules(u=currentPortalUser()){if(!u)return[];const tipo=String(u.tipo||'').toUpperCase();if(tipo==='MASTER')return['simuladorSeminovos','simuladorCompleto','dashbi','gestao','painelAnalistaFi','comissoes'];if(tipo==='RECURSOS HUMANOS'||tipo==='RH')return['comissoes'];if(tipo==='ANALISTA')return['simuladorSeminovos','simuladorCompleto','dashbi','gestao','painelAnalistaFi','comissoes'];if(tipo==='DIRETOR NOVOS'||tipo==='DIRETOR DE NOVOS')return['simuladorSeminovos','simuladorCompleto','dashbi','comissoes'];if(tipo==='DIRETOR SEMINOVOS'||tipo==='DIRETOR DE SEMINOVOS')return['simuladorSeminovos','simuladorCompleto','dashbi','comissoes'];if(tipo==='GERENTE'&&portalStatusHas(u,'NOVOS')&&portalStatusHas(u,'SEMINOVOS'))return['simuladorSeminovos','simuladorCompleto','gestao','comissoes'];if(tipo==='GERENTE'&&portalStatusHas(u,'NOVOS'))return['simuladorCompleto','gestao','comissoes'];if(tipo==='GERENTE'&&portalStatusHas(u,'SEMINOVOS'))return['simuladorSeminovos','gestao','comissoes'];if(tipo==='VENDEDOR'&&portalStatusHas(u,'NOVOS'))return['simuladorCompleto','comissoes','gestao'];if(tipo==='VENDEDOR'&&portalStatusHas(u,'SEMINOVOS'))return['simuladorSeminovos','comissoes','gestao'];return['comissoes'];}
function allPortalUsersForHomolog(){return[...DATA.auth,...DATA.master].sort((a,b)=>(a.nome||'').localeCompare(b.nome||''));}
function fakeUserForPerfil(tipo,status,loja='HOMOLOGAÇÃO'){return{nome:`SIMULAÇÃO ${tipo} ${status}`.trim(),nomeKey:norm(`SIMULAÇÃO ${tipo} ${status}`),cpf:'00000000000',loja,tipo,status,statusGroups:status.includes('NOVOS/SEMINOVOS')?['NOVOS','SEMINOVOS']:(status.includes('SEMINOVOS')?['SEMINOVOS']:(status.includes('NOVOS')?['NOVOS']:[]))};}
function iniciarHomologacaoRapida(modelo){const map={master:fakeUserForPerfil('MASTER','MASTER','MASTER'),analista:fakeUserForPerfil('ANALISTA','NOVOS/SEMINOVOS'),gerenteNovos:fakeUserForPerfil('GERENTE','NOVOS'),gerenteSeminovos:fakeUserForPerfil('GERENTE','SEMINOVOS'),diretorNovos:fakeUserForPerfil('DIRETOR NOVOS','NOVOS/SEMINOVOS','DIRETORIA'),diretorSeminovos:fakeUserForPerfil('DIRETOR SEMINOVOS','NOVOS/SEMINOVOS','DIRETORIA'),vendedorNovos:fakeUserForPerfil('VENDEDOR','NOVOS'),vendedorSeminovos:fakeUserForPerfil('VENDEDOR','SEMINOVOS')};HOMOLOGATION_USER=map[modelo]||null;renderPortalHome();}
function iniciarHomologacaoUsuario(){const c=document.getElementById('homologUserSel')?.value||'';const u=allPortalUsersForHomolog().find(x=>x.cpf===c);if(!u)return;HOMOLOGATION_USER={...u};renderPortalHome();}
function encerrarHomologacao(){HOMOLOGATION_USER=null;USER=REAL_USER||USER;renderPortalHome();}
function renderHomologacaoCard(){if(!REAL_USER||REAL_USER.tipo!=='MASTER')return'';const opts=allPortalUsersForHomolog().map(u=>`<option value="${u.cpf}">${u.nome} · ${u.tipo} · ${u.status} · ${u.loja}</option>`).join('');return`<div class="homologCard"><div class="homologTitle">🧪 Modo de Homologação</div><div class="note" style="margin-bottom:12px">Teste visualmente os módulos por perfil sem alterar login, Supabase ou senhas.</div><div class="homologGrid"><div><div class="note" style="margin-bottom:8px"><b>Simulação rápida</b></div><div class="homologQuick"><button class="homologBtn" onclick="iniciarHomologacaoRapida('master')">MASTER</button><button class="homologBtn" onclick="iniciarHomologacaoRapida('analista')">ANALISTA</button><button class="homologBtn" onclick="iniciarHomologacaoRapida('gerenteNovos')">GERENTE NOVOS</button><button class="homologBtn" onclick="iniciarHomologacaoRapida('gerenteSeminovos')">GERENTE SEMINOVOS</button><button class="homologBtn" onclick="iniciarHomologacaoRapida('diretorNovos')">DIRETOR NOVOS</button><button class="homologBtn" onclick="iniciarHomologacaoRapida('diretorSeminovos')">DIRETOR SEMINOVOS</button><button class="homologBtn" onclick="iniciarHomologacaoRapida('vendedorNovos')">VENDEDOR NOVOS</button><button class="homologBtn" onclick="iniciarHomologacaoRapida('vendedorSeminovos')">VENDEDOR SEMINOVOS</button></div></div><div><div class="note"><b>Visualizar colaborador real</b></div><select id="homologUserSel" class="homologSelect">${opts}</select><button class="portalModuleBtn" style="margin-top:10px" onclick="iniciarHomologacaoUsuario()">Visualizar como este usuário</button>${HOMOLOGATION_USER?`<button class="portalModuleBtn secondaryPortal" style="margin-top:10px" onclick="encerrarHomologacao()">Voltar para visão MASTER</button>`:''}</div></div></div>`;}
function renderHomologacaoBanner(u){if(!HOMOLOGATION_USER)return'';return`<div class="homologBanner"><div>🧪 <b>MODO HOMOLOGAÇÃO</b><br>Visualizando como: <b>${u.nome}</b> · ${u.tipo} · ${u.status} · ${u.loja||''}</div><button class="homologBtn" onclick="encerrarHomologacao()">Voltar para visão MASTER</button></div>`;}
function renderPortalHome(){APP_VIEW='home';const home=document.getElementById('portalHome');if(!home)return;document.getElementById('app')?.classList.add('hidden');document.getElementById('painelAnalistaFi')?.classList.add('hidden');home.classList.remove('hidden');const viewUser=currentPortalUser();const allowed=portalAllowedModules(viewUser);const groups=[...new Set(PORTAL_MODULES.filter(m=>allowed.includes(m.id)).map(m=>m.grupo))];const sections=groups.map(g=>{const cards=PORTAL_MODULES.filter(m=>m.grupo===g&&allowed.includes(m.id)).map(m=>`<div class="portalModuleCard"><div><div class="portalModuleIcon">${m.icon}</div><h3>${m.title}</h3><p>${m.desc}</p></div>${m.internal?`<button class="portalModuleBtn" onclick="openPortalModule('${m.id}')">${m.id==='painelAnalistaFi'?'Abrir Painel':(m.id==='coparticipadoPortal'?'Abrir Coparticipados':(m.id==='analiseScoreVendedores'?'Abrir Score':'Abrir Minha Comissão'))}</button>`:`<a class="portalModuleBtn ${m.id==='dashbi'?'secondaryPortal':''}" href="${m.url}" target="_blank" rel="noopener">${m.id==='simuladorSeminovos'||m.id==='simuladorCompleto'?'Abrir Simulador':'Abrir Análise'}</a>`}</div>`).join('');return`<div class="portalSectionTitle">${g}</div><div class="portalModuleGrid">${cards}</div>`;}).join('');home.innerHTML=`<div class="portalHero"><div class="portalHeroTop"><div><div class="portalEyebrow">Grupo Brabus Mitsubishi</div><div class="portalTitle">Portal F&I — Grupo Brabus Mitsubishi</div><div class="portalSubtitle">Central única para simuladores, dashboards, gestão operacional e acompanhamento de comissões. Os módulos são liberados conforme perfil e STATUS.</div></div><div class="portalUserPill"><div class="k">Usuário conectado</div><div class="v">${REAL_USER?.nome||USER?.nome||''}</div><div class="note">${REAL_USER?.tipo||USER?.tipo||''} · ${REAL_USER?.status||USER?.status||''} · ${REAL_USER?.loja||USER?.loja||'Todas'}</div><button class="portalModuleBtn secondaryPortal" style="margin-top:12px" onclick="logout()">Sair</button></div></div>${renderHomologacaoBanner(viewUser)}<div class="portalMetrics"><div class="portalMetricCard"><div class="k">Bem-vindo</div><div class="v">${viewUser?.nome||''}</div></div><div class="portalMetricCard"><div class="k">Perfil visualizado</div><div class="v">${viewUser?.tipo||''}</div></div><div class="portalMetricCard"><div class="k">Loja</div><div class="v">${viewUser?.loja||'Todas'}</div></div><div class="portalMetricCard"><div class="k">Módulos liberados</div><div class="v">${allowed.length}</div></div></div>${renderHomologacaoCard()}${sections||'<div class="empty">Nenhum módulo disponível para este perfil.</div>'}</div>`;}
function openPortalModule(id){const viewUser=currentPortalUser();if(!portalAllowedModules(viewUser).includes(id)){alert('Módulo não liberado para este perfil.');return;}const m=PORTAL_MODULES.find(x=>x.id===id);if(!m)return;if(!m.internal){window.open(m.url,'_blank','noopener');return;}if(id==='painelAnalistaFi'){showPainelAnalistaFi(viewUser);return;}showComissoesModule(viewUser);}

function normalizarStatusClasseFi(status){
  return String(status||'OFFLINE').toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^A-Z]/g,'');
}
function painelAnalistaMsg(msg,err=false){
  const el=document.getElementById('painelAnalistaFiMsg');
  if(!el)return;
  el.textContent=msg||'';
  el.className='painelAnalistaMsg '+(err?'err':'ok');
}
async function carregarMeuAnalistaFi(){
  const u=REAL_USER||USER;
  if(!supabaseClient||!u?.cpf)return null;
  const {data,error}=await supabaseClient.rpc('operational_my_analyst_fi');
  if(error){console.warn('Falha ao consultar analista_fi:',error.message);return null;}
  return data?.row||null;
}

async function concluirRecuperacaoSenhaSegura(){
  const nova=prompt('Digite uma nova senha com no mínimo 8 caracteres:');
  if(!nova||nova.length<8){
    setAuthMsg('A nova senha precisa ter no mínimo 8 caracteres.',true);
    return false;
  }
  const conf=prompt('Confirme a nova senha:');
  if(nova!==conf){
    setAuthMsg('As senhas não conferem.',true);
    return false;
  }
  const {error}=await supabaseClient.auth.updateUser({password:nova});
  if(error){
    setAuthMsg('Não foi possível atualizar a senha. Solicite um novo link de recuperação.',true);
    return false;
  }
  const {error:profileError}=await supabaseClient.rpc('operational_complete_password_change');
  if(profileError){
    console.warn('Senha alterada, mas o perfil não pôde ser atualizado:',profileError.message);
  }
  await supabaseClient.auth.signOut();
  setAuthMsg('Senha atualizada com sucesso. Entre novamente com a nova senha.',false);
  return true;
}

if(supabaseClient){
  supabaseClient.auth.onAuthStateChange((event)=>{
    if(PORTAL_RUNTIME_CONFIG.authMode==='secure'&&event==='PASSWORD_RECOVERY'){
      window.setTimeout(()=>{concluirRecuperacaoSenhaSegura().catch(e=>{
        console.warn('Falha na recuperação de senha:',e);
        setAuthMsg('Não foi possível concluir a redefinição. Solicite um novo link.',true);
      });},0);
    }
  });
}
async function portalCallAnalystFi(){
  if(!supabaseClient) throw new Error('Supabase não inicializado.');
  const {data:sessionData,error:sessionError}=await supabaseClient.auth.getSession();
  if(sessionError) throw sessionError;
  if(!sessionData?.session?.user) throw new Error('Sessão autenticada não encontrada.');
  const {data,error}=await supabaseClient.rpc('chamar_analista_fi');
  if(error) throw error;
  return Array.isArray(data)?data:[];
}
window.portalCallAnalystFi=portalCallAnalystFi;
async function showPainelAnalistaFi(viewUser=currentPortalUser()){
  const tipo=String((REAL_USER||viewUser)?.tipo||'').toUpperCase();
  if(!['ANALISTA','MASTER'].includes(tipo)){alert('Painel liberado apenas para ANALISTA ou MASTER.');return;}
  APP_VIEW='painelAnalistaFi';
  document.getElementById('portalHome')?.classList.add('hidden');
  document.getElementById('app')?.classList.add('hidden');
  const box=document.getElementById('painelAnalistaFi');
  if(!box)return;
  box.classList.remove('hidden');
  const u=REAL_USER||USER;
  box.innerHTML=`<div class="painelAnalistaHero"><div class="painelAnalistaTop"><div><div class="portalEyebrow">Atendimento F&I Brabus</div><div class="painelAnalistaTitle">Painel do Analista F&I</div><div class="painelAnalistaSub">Controle sua disponibilidade na fila de atendimento. Somente status <b>ONLINE</b> recebe novos chamados do botão FALAR COM UM ANALISTA.</div></div><div class="statusAtualBox"><div class="k">Analista conectado</div><div class="v">${u?.nome||''}</div><div class="note">${u?.tipo||''} · ${u?.loja||'Todas'}</div><div id="painelAnalistaStatusPill" class="statusAtualPill">Carregando...</div></div></div><div class="painelStatusGrid"><button class="statusBtnFi" onclick="alterarMeuStatusAnalistaFi('ONLINE')"><span>🟢</span><b>ONLINE</b></button><button class="statusBtnFi" onclick="alterarMeuStatusAnalistaFi('OCUPADO')"><span>🟡</span><b>OCUPADO</b></button><button class="statusBtnFi" onclick="alterarMeuStatusAnalistaFi('ALMOÇO')"><span>🍽️</span><b>ALMOÇO</b></button><button class="statusBtnFi" onclick="alterarMeuStatusAnalistaFi('FÉRIAS')"><span>🌴</span><b>FÉRIAS</b></button><button class="statusBtnFi" onclick="alterarMeuStatusAnalistaFi('OFFLINE')"><span>⚫</span><b>OFFLINE</b></button></div><div class="painelAnalistaCards"><div class="painelAnalistaCard"><div class="k">Atendimentos hoje</div><div class="v" id="painelAtendimentosHoje">-</div></div><div class="painelAnalistaCard"><div class="k">Último atendimento</div><div class="v" id="painelUltimoAtendimento">-</div></div><div class="painelAnalistaCard"><div class="k">Última atualização de status</div><div class="v" id="painelUltimoStatus">-</div></div></div><div id="painelAnalistaFiMsg" class="painelAnalistaMsg"></div><div class="painelAnalistaBack"><button onclick="renderPortalHome()">Voltar ao Portal</button><button onclick="logout()">Sair</button></div></div>`;
  await atualizarResumoPainelAnalistaFi();
}
function fmtDataHoraFi(v){
  if(!v)return '-';
  try{return new Date(v).toLocaleString('pt-BR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'});}catch(e){return '-';}
}
async function atualizarResumoPainelAnalistaFi(){
  const a=await carregarMeuAnalistaFi();
  const pill=document.getElementById('painelAnalistaStatusPill');
  if(!a){
    if(pill){pill.textContent='Analista não vinculado';pill.className='statusAtualPill statusOFFLINE';}
    painelAnalistaMsg('Seu CPF está logado, mas não foi encontrado na tabela analistas_fi. Verifique o cpf_normalizado.',true);
    return;
  }
  const st=String(a.status||'OFFLINE').toUpperCase();
  const cls='status'+normalizarStatusClasseFi(st);
  if(pill){pill.textContent=st;pill.className='statusAtualPill '+cls;}
  const ah=document.getElementById('painelAtendimentosHoje'); if(ah)ah.textContent=a.atendimentos_hoje??0;
  const ua=document.getElementById('painelUltimoAtendimento'); if(ua)ua.textContent=fmtDataHoraFi(a.ultimo_atendimento);
  const us=document.getElementById('painelUltimoStatus'); if(us)us.textContent=fmtDataHoraFi(a.ultimo_status_em);
}
async function alterarMeuStatusAnalistaFi(status){
  if(!supabaseClient){painelAnalistaMsg('Supabase não carregado.',true);return;}
  painelAnalistaMsg('Atualizando status...');
  const {data,error}=await supabaseClient.rpc('atualizar_meu_status_analista_fi',{p_status:status});
  if(error){painelAnalistaMsg('Erro ao atualizar status: '+error.message,true);return;}
  const r=Array.isArray(data)?data[0]:data;
  if(!r?.sucesso){painelAnalistaMsg(r?.mensagem||'Não foi possível atualizar o status.',true);return;}
  painelAnalistaMsg(r.mensagem||'Status atualizado com sucesso.');
  await atualizarResumoPainelAnalistaFi();
}

async function showComissoesModule(viewUser=currentPortalUser()){
  APP_VIEW='comissoes';
  USER=viewUser;
  document.getElementById('portalHome')?.classList.add('hidden');
  document.getElementById('painelAnalistaFi')?.classList.add('hidden');
  document.getElementById('app')?.classList.remove('hidden');
  fillStores();
  await loadOperationalCommissionMetrics(true);
  fillStores();
  render();
}
function voltarPortalHome(){USER=REAL_USER||USER;document.getElementById('painelAnalistaFi')?.classList.add('hidden');renderPortalHome();}

async function login(){
  if(!DATA_READY){alert('As bases ainda não foram carregadas. Aguarde a mensagem de sucesso ou verifique o erro de carregamento.');return}
  if(!supabaseClient){setAuthMsg('Supabase não foi carregado. Verifique conexão ou configuração.',true);return}
  if(PORTAL_RUNTIME_CONFIG.authMode==='secure'){
    if(LOGIN_IN_PROGRESS){
      setAuthMsg('A validação já está em andamento. Aguarde alguns segundos.',false);
      return;
    }
    const email=(document.getElementById('cpfInput')?.value||'').trim().toLowerCase();
    const senha=(document.getElementById('senhaInput')?.value||'').trim();
    if(!email||!email.includes('@')){setAuthMsg('Digite o e-mail cadastrado pelo administrador.',true);return}
    if(!senha){setAuthMsg('Digite sua senha.',true);return}
    LOGIN_IN_PROGRESS=true;
    const submit=document.querySelector('#loginForm button[type="submit"]');
    if(submit) submit.disabled=true;
    let loginStage='autenticação';
    try{
      setAuthMsg('Validando acesso...');
      const captchaToken=await obtainTurnstileToken();
      const credentials={email,password:senha};
      if(captchaToken)credentials.options={captchaToken};
      const {error}=await supabaseClient.auth.signInWithPassword(credentials);
      if(error){
        setAuthMsg('E-mail ou senha inválidos.',true);
        return;
      }
      loginStage='perfil autorizado';
      let u=await carregarUsuarioAutorizado();
      loginStage='registro seguro de login';
      u=(await registrarMeuLoginSeguro())||u;
      if(u.primeiroAcesso===true){
        loginStage='troca obrigatória de senha';
        const ok=await trocarSenhaObrigatoria(u);
        if(!ok)return;
        u.primeiroAcesso=false;
      }
      loginStage='configurações do portal';
      await carregarParametrosPortal();
      USER=u;
      REAL_USER=u;
      HOMOLOGATION_USER=null;
      loginStage='inicialização dos módulos';
      setAuthMsg('Acesso confirmado. Carregando módulos...');
      await initApp();
    }catch(e){
      await supabaseClient.auth.signOut();
      USER=null;
      REAL_USER=null;
      const detail=String(e?.message||'falha não identificada')
        .replace(/eyJ[A-Za-z0-9._-]+/g,'[token oculto]')
        .slice(0,240);
      setAuthMsg(`Login autenticado, mas houve falha em ${loginStage}: ${detail}`,true);
    }finally{
      LOGIN_IN_PROGRESS=false;
      if(submit) submit.disabled=false;
    }
    return;
  }
  const {cpf:c,user:u}=findUserByCpfInput();
  const senha=(document.getElementById('senhaInput')?.value||'').trim();
  if(!u){setAuthMsg('CPF não localizado na base oficial.',true);await registrarLogAcesso(c,false,'CPF não localizado');return}
  if(!senha){setAuthMsg('Digite sua senha. Se for primeiro acesso, cadastre uma senha.',true);return}
  setAuthMsg('Validando acesso...');
  const email=portalEmailFromCpf(c);
  const {data,error}=await supabaseClient.auth.signInWithPassword({email,password:senha});
  if(error){setAuthMsg('CPF ou senha inválidos. Se ainda não cadastrou senha, clique em Primeiro acesso.',true);await registrarLogAcesso(c,false,error.message);return}
  const supaUser=await getUsuarioSupabaseByCpf(c);
  if(supaUser && supaUser.ativo===false){
    await supabaseClient.auth.signOut();
    setAuthMsg('Usuário bloqueado pelo Master. Acesso não liberado.',true);
    await registrarLogAcesso(u,false,'Usuário bloqueado');
    return;
  }
  if(supaUser && supaUser.primeiro_acesso===true){
    const ok=await trocarSenhaObrigatoria(u);
    if(!ok) return;
  }
  await syncSupabaseUsuario(u,data.user);
  await carregarParametrosPortal();
  USER=u;
  REAL_USER=u;
  HOMOLOGATION_USER=null;
  setAuthMsg('');
  await initApp();
}
async function loginMasterDemo(){if(!DATA_READY){alert('As bases ainda não foram carregadas. Aguarde a mensagem de sucesso ou verifique o erro de carregamento.');return} USER=DATA.master[0]||{nome:'MASTER DEMO',tipo:'MASTER',loja:'TODAS',status:'MASTER',statusGroups:['NOVOS','SEMINOVOS']}; REAL_USER=USER; HOMOLOGATION_USER=null; await initApp();}
// Endurecimento do build público: neutraliza atalhos de privilégio que eram
// invocáveis diretamente pelo console. Não substitui autorização no servidor.
if(!PORTAL_SECURITY.allowDemoLogin){
  loginMasterDemo=async function(){
    setAuthMsg('Login de demonstração desativado neste build.',true);
  };
}
if(!PORTAL_SECURITY.allowClientHomologation){
  iniciarHomologacaoRapida=function(){
    console.warn('Homologação no cliente desativada neste build.');
  };
  iniciarHomologacaoUsuario=function(){
    console.warn('Homologação no cliente desativada neste build.');
  };
  renderHomologacaoCard=function(){return '';};
}
async function logout(){
  try{ if(supabaseClient) await supabaseClient.auth.signOut(); }catch(e){}
  USER=null; REAL_USER=null; HOMOLOGATION_USER=null; APP_VIEW='login';
  document.getElementById('app').classList.add('hidden');
  document.getElementById('portalHome')?.classList.add('hidden');
  document.getElementById('painelAnalistaFi')?.classList.add('hidden');
  document.getElementById('loginBox').classList.remove('hidden');
}

function setDataFinalHoje(){
  const el=document.getElementById('dtFim');
  if(!el) return;
  const d=new Date();
  const yyyy=d.getFullYear();
  const mm=String(d.getMonth()+1).padStart(2,'0');
  const dd=String(d.getDate()).padStart(2,'0');
  el.value=`${yyyy}-${mm}-${dd}`;
}

function portalPromiseTimeout(promise,label,timeoutMs=12000){
  let timer;
  const timeout=new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(new Error(`${label} excedeu ${Math.round(timeoutMs/1000)} segundos.`)),timeoutMs);
  });
  return Promise.race([Promise.resolve(promise),timeout]).finally(()=>clearTimeout(timer));
}

async function initApp(){
  setDataFinalHoje();
  fillStores();
  const initialLoads=[];
  if(USER?.tipo==='MASTER'){
    initialLoads.push(
      portalPromiseTimeout(carregarReferenciasAdminSeguras(true),'Referências administrativas')
        .then(ref=>{
          PERIODOS_COMISSAO=ref.periods||[];
          AUSENCIAS_ANALISTAS=ref.absences||[];
          MUDANCAS_LOJA_VENDEDORES=ref.store_changes||[];
        })
    );
  }else{
    initialLoads.push(portalPromiseTimeout(carregarPeriodosComissao(),'Períodos de comissão'));
  }
  initialLoads.push(portalPromiseTimeout(carregarFechamentosComissao(),'Fechamentos de comissão'));
  const loadResults=await Promise.allSettled(initialLoads);
  loadResults.filter(r=>r.status==='rejected').forEach(r=>console.warn('Carga inicial não bloqueante:',r.reason?.message||r.reason));
  fillStores();
  aplicarPeriodoAtualSeExistir();
  document.getElementById('loginBox').classList.add('hidden');
  document.getElementById('app').classList.add('hidden');
  renderPortalHome();
}

function portalRoleKeyForComissao(u=USER){
  const n=(v)=>String(v||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toUpperCase().replace(/\s+/g,' ').trim();
  const raw=n([u&&u.tipo,u&&u.status,u&&u.perfil,u&&u.Perfil].filter(Boolean).join(' '));
  if(raw.includes('DIRETOR DE NOVOS')||raw.includes('DIRETOR NOVOS')||(raw.includes('DIRETOR')&&raw.includes('NOVOS')&&!raw.includes('SEMINOVOS'))) return 'DIRETOR NOVOS';
  if(raw.includes('DIRETOR DE SEMINOVOS')||raw.includes('DIRETOR SEMINOVOS')||(raw.includes('DIRETOR')&&raw.includes('SEMINOVOS'))) return 'DIRETOR SEMINOVOS';
  return n(u&&u.tipo);
}
function isDiretorComissao(u=USER){const r=portalRoleKeyForComissao(u);return r==='DIRETOR NOVOS'||r==='DIRETOR SEMINOVOS';}

function fillStores(){
  const sel=document.getElementById('lojaSel');
  const secureMode=String(PORTAL_RUNTIME_CONFIG.authMode||'').toLowerCase()==='secure';
  const stores=[...new Set((secureMode
    ?(OPERATIONAL_METRICS_STATE.data?.rows||[]).map(r=>r.store)
    :DATA.auth.map(a=>a.loja)
  ).filter(Boolean))].sort();
  let allowed=stores;
  if(USER?.tipo==='ANALISTA') allowed=stores.filter(s=>[USER.loja,...analystCoverageStoresForUser(USER)].some(l=>norm(l)===norm(s)));
  else if(isDiretorComissao(USER)) allowed=stores;
  else if(USER?.tipo!=='MASTER'&&USER?.loja) allowed=stores.filter(s=>s===USER.loja);
  sel.innerHTML='<option value="">Todas</option>'+allowed.map(s=>`<option value="${s}">${s}</option>`).join('');
  if(USER?.tipo!=='MASTER'&&USER?.tipo!=='ANALISTA'&&!isDiretorComissao(USER)&&USER.loja) sel.value=USER.loja;
}

function analystCoverageStoresForUser(u=USER){
  if(!u||u.tipo!=='ANALISTA') return [];
  const {ini,fim}=periodoAtualDatas();
  return (AUSENCIAS_ANALISTAS||[])
    .filter(a=>a.ativo!==false && a.cpf_analista_substituto===u.cpf)
    .filter(a=>overlapRange(a.data_inicio,a.data_fim,ini,fim))
    .map(a=>a.loja_coberta)
    .filter(Boolean);
}
function isStoreCoveredByAnalyst(store,u=USER){
  return analystCoverageStoresForUser(u).some(l=>norm(l)===norm(store));
}
function visibleStores(){
  let selected=document.getElementById('lojaSel').value;
  let stores=[...new Set([
    ...DATA.auth.map(a=>a.loja).filter(Boolean),
    ...(MUDANCAS_LOJA_VENDEDORES||[]).flatMap(m=>[m.loja_origem,m.loja_destino]).filter(Boolean)
  ])].sort();
  if(USER.tipo==='MASTER'||isDiretorComissao(USER)) return stores.filter(s=>!selected||s===selected);
  if(USER.tipo==='ANALISTA'){
    const allowed=[USER.loja,...analystCoverageStoresForUser(USER)].filter(Boolean);
    return stores.filter(s=>allowed.some(l=>norm(l)===norm(s))).filter(s=>!selected||s===selected);
  }
  if(USER.tipo==='VENDEDOR'){
    const allowed=storesForSellerInPeriod(USER);
    return stores.filter(s=>allowed.some(l=>norm(l)===norm(s))).filter(s=>!selected||s===selected);
  }
  selected=USER.loja;
  return stores.filter(s=>!selected||s===selected);
}

function allowedSeller(a){
  if(!a||a.tipo!=='VENDEDOR') return false;
  if(USER.tipo==='MASTER'||isDiretorComissao(USER)) return true;
  if(USER.tipo==='VENDEDOR') return a.nomeKey===USER.nomeKey;
  const stores=storesForSellerInPeriod(a);
  if(USER.tipo==='ANALISTA'){
    const lojaOk=stores.some(s=>norm(s)===norm(USER.loja)||isStoreCoveredByAnalyst(s,USER));
    return lojaOk && (USER.statusGroups||[]).some(st=>statusHas(a,st));
  }
  if(USER.tipo==='GERENTE') return stores.some(s=>norm(s)===norm(USER.loja)) && (USER.statusGroups||[]).some(st=>statusHas(a,st));
  return false;
}
let CHASSIS_STORE={}; let DETAIL_STORE={}; let CHASSIS_ID=0;
function calcSeller(a,storeAloc=''){
  const ss=DATA.sales.filter(s=>s.vendedorKey===a.nomeKey && inPeriod(s.date) && (!storeAloc || norm(lojaEfetivaVendedorNaData(a,s.date,s.loja))===norm(storeAloc)));
  const finAll=DATA.finance.filter(f=>f.vendedorKey===a.nomeKey && inPeriod(f.date) && (!storeAloc || norm(lojaEfetivaVendedorNaData(a,f.date,f.loja))===norm(storeAloc)));
  const fin=finAll.filter(f=>f.isFinReal);

  const retornoPosteriorRaw=finAll.filter(f=>f.isRetornoPosterior);
  const retornoPosteriorByKey={};
  const retornoPosteriorDuplicados=[];
  retornoPosteriorRaw.forEach(f=>{
    const k=f.chassi?('CHASSI_'+f.chassi):('CLIENTE_'+(f.clienteKey||norm(f.cliente||'')));
    if(!retornoPosteriorByKey[k]){
      retornoPosteriorByKey[k]=f;
    }else{
      retornoPosteriorDuplicados.push(f);
      const atual=retornoPosteriorByKey[k];
      // Regra segura: se ocorrer duplicidade para o mesmo chassi/nome, manter o maior Retorno Bruto e auditar os demais.
      if((+f.retorno||0)>(+atual.retorno||0)) retornoPosteriorByKey[k]=f;
    }
  });
  const retornoPosterior=Object.values(retornoPosteriorByKey);

  // SPF EXTRA corrigido:
  // Fonte oficial = Base 03 após preenchimento para baixo das linhas-filhas.
  // Vínculo com vendedor/operação = Base 02 por cliente normalizado, priorizando chassi quando existir.
  const clienteOps={};
  finAll.forEach(f=>{
    if(!f.clienteKey) return;
    if(!clienteOps[f.clienteKey]){
      clienteOps[f.clienteKey]={clienteKey:f.clienteKey,cliente:f.cliente||'',chassi:f.chassi||'',date:f.date||'',loja:f.loja||'',vendedor:f.vendedor||'',origem:f.origem||''};
    }
    if(f.chassi) clienteOps[f.clienteKey].chassi=f.chassi;
    if(f.date) clienteOps[f.clienteKey].date=f.date;
    if(f.loja) clienteOps[f.clienteKey].loja=f.loja;
  });

  const spfRecords=[];
  Object.values(clienteOps).forEach(op=>{
    const rows=(DATA.b03SpfByCliente&&DATA.b03SpfByCliente[op.clienteKey])?DATA.b03SpfByCliente[op.clienteKey]:[];
    rows.forEach(b=>{
      spfRecords.push({
        cliente:op.cliente||b.cliente,
        clienteKey:op.clienteKey,
        cpf:b.cpf||'',
        chassi:op.chassi||'',
        date:op.date||b.date||'',
        loja:op.loja||b.loja||'',
        origem:op.origem||'',
        opcionalNome:b.opcionalNome,
        opcionalValor:+b.opcionalValor||0,
        spfConsiderado:+b.opcionalValor||0,
        motivo:(+b.opcionalValor||0)>0?'SPF EXTRA localizado na Base 03 e vinculado à Base 02 por cliente/chassi.':'SPF EXTRA localizado na Base 03, porém com valor zerado.'
      });
    });
  });

  const retornoPosteriorAudit=[
    ...retornoPosterior.map(f=>({
      date:f.date||'',
      cliente:f.cliente||'',
      chassi:f.chassi||'',
      vendedor:f.vendedor||'',
      loja:f.loja||'',
      servico:f.servico||'',
      producao:+f.valorServico||0,
      retorno:+f.retorno||0,
      considerado:true,
      motivo:'Lançamento RETORNO posterior: Valor do Serviço incorporado à Produção, Retorno Bruto incorporado ao Retorno e operação considerada em Quantidade Financiada.'
    })),
    ...retornoPosteriorDuplicados.map(f=>({
      date:f.date||'',
      cliente:f.cliente||'',
      chassi:f.chassi||'',
      vendedor:f.vendedor||'',
      loja:f.loja||'',
      servico:f.servico||'',
      producao:+f.valorServico||0,
      retorno:+f.retorno||0,
      considerado:false,
      motivo:'Duplicidade de RETORNO posterior para a mesma chave. Não somado para evitar duplicidade.'
    }))
  ];

  const soldChassis=[...new Map(
    ss
      .filter(s=>s.chassi)
      .sort((a,b)=>(a.date||'').localeCompare(b.date||''))
      .map(s=>[s.chassi,s])
  ).values()];
  const finChassis=new Set([...fin.map(f=>f.chassi).filter(Boolean), ...retornoPosterior.map(f=>f.chassi).filter(Boolean)]);

  const opsByChassi={};
  function ensureOp(chassi, fallback={}){
    if(!chassi) return null;
    if(!opsByChassi[chassi]){
      opsByChassi[chassi]={
        chassi,
        chassiShort:chassi.slice(-6),
        cliente:fallback.cliente||'',
        date:fallback.date||'',
        origem:fallback.origem||'',
        servico:fallback.servico||'',
        hasFin:false,
        hasComplemento:false,
        producaoPrincipal:0,
        producaoPosterior:0,
        retornoPrincipal:0,
        retornoPosterior:0,
        spfValor:0
      };
    }
    const op=opsByChassi[chassi];
    if(fallback.cliente) op.cliente=fallback.cliente;
    if(fallback.date) op.date=fallback.date;
    if(fallback.origem) op.origem=fallback.origem;
    if(fallback.servico) op.servico=fallback.servico;
    return op;
  }

  soldChassis.forEach(s=>ensureOp(s.chassi,{date:s.date}));
  fin.forEach(f=>{
    const op=ensureOp(f.chassi,{cliente:f.cliente,date:f.date,origem:f.origem,servico:f.servico});
    if(!op) return;
    op.hasFin=true;
    op.producaoPrincipal+=(+f.valorServico||0);
    op.retornoPrincipal+=(+f.retorno||0);
  });
  retornoPosterior.forEach(f=>{
    const op=ensureOp(f.chassi,{cliente:f.cliente,date:f.date,origem:f.origem,servico:f.servico});
    if(!op) return;
    op.hasComplemento=true;
    op.producaoPosterior+=(+f.valorServico||0);
    op.retornoPosterior+=(+f.retorno||0);
  });
  spfRecords.forEach(f=>{
    const op=ensureOp(f.chassi,{cliente:f.cliente,date:f.date,origem:f.origem});
    if(!op) return;
    op.hasComplemento=true;
    op.spfValor+=(+f.spfConsiderado||0);
  });

  const items=soldChassis.map(s=>{
    const op=opsByChassi[s.chassi]||ensureOp(s.chassi,{date:s.date});
    const producaoTotal=(+op.producaoPrincipal||0)+(+op.producaoPosterior||0);
    const retornoTotal=(+op.retornoPrincipal||0)+(+op.retornoPosterior||0);
    const rentabTotal=retornoTotal+((+op.spfValor||0)*(cfgNum('spf_liquido_percentual')/100));
    return {
      chassi:op.chassiShort,
      chassiCompleto:op.chassi,
      cliente:op.cliente||'',
      date:op.date||s.date,
      financiado:!!(op.hasFin||op.hasComplemento),
      financiamentoPrincipal:!!op.hasFin,
      producao:producaoTotal,
      producaoPrincipal:+op.producaoPrincipal||0,
      producaoPosterior:+op.producaoPosterior||0,
      retorno:retornoTotal,
      retornoPrincipal:+op.retornoPrincipal||0,
      retornoPosterior:+op.retornoPosterior||0,
      rentabTotal,
      spf:(+op.spfValor||0)>0,
      spfValor:+op.spfValor||0,
      origem:op.origem||'',
      servico:op.servico||''
    };
  }).sort((a,b)=>(a.date||'').localeCompare(b.date||''));

  const spfTotal=spfRecords.reduce((t,f)=>t+(+f.spfConsiderado||0),0);
  const producaoTotal=fin.reduce((t,f)=>t+(+f.valorServico||0),0)+retornoPosterior.reduce((t,f)=>t+(+f.valorServico||0),0);
  const retornoTotal=fin.reduce((t,f)=>t+(+f.retorno||0),0)+retornoPosterior.reduce((t,f)=>t+(+f.retorno||0),0);
  return {vendidas:soldChassis.length, financiadas:finChassis.size, producao:producaoTotal, retorno:retornoTotal, spf:spfTotal, spfQty:spfRecords.filter(f=>(+f.spfConsiderado||0)>0).length, items, financeRows:fin.length, spfAudit:spfRecords, retornoPosteriorAudit};
}
function sumRows(rows){return rows.reduce((a,r)=>{a.vendidas+=r.m.vendidas;a.financiadas+=r.m.financiadas;a.producao+=r.m.producao;a.retorno+=r.m.retorno;a.spf+=r.m.spf;a.spfQty+=(+r.m.spfQty||0);return a},{vendidas:0,financiadas:0,producao:0,retorno:0,spf:0,spfQty:0,items:[]})}
function trPessoa(nome,loja,status,m,cls='',kind='standard',cOverride=null,faixaHtmlOverride=''){
 const id='c'+(++CHASSIS_ID); const c=cOverride||commissionCalc(status,m,cls); const isAnalyst=cls==='analyst';
 const faixaHtml=faixaHtmlOverride||c.faixaHtml||faixaBadge(c.faixa||0,cls);
 const blocks=(c.blocks||[]).filter(b=>b&&b.c);
 const multiple=blocks.length>1||c.multiplasFaixas;
 CHASSIS_STORE[id]=m.items||[]; DETAIL_STORE[id]={nome,loja,status,m,c,cls,kind,commissionBlocks:blocks};
 const enc=encodeURIComponent(nome||''); const btn=`<button class="miniBtn" onclick="showDetails('${id}','${enc}')">Detalhes</button>`;
 const comissaoLabel=isAnalyst?'Comissão total':'Comissão';
 if(multiple&&blocks.length){
   const vendHtml=commissionBlockLines(c,'vendidas',v=>v);
   const finHtml=commissionBlockLines(c,'financiadas',v=>v);
   const shareHtml=commissionBlockLines(c,'share',v=>fmtSharePct(v));
   const retornoHtml=commissionBlockLines(c,'retorno',v=>fmtMoney(v));
   const spfHtml=commissionBlockLines(c,'spfLiquido',v=>fmtMoney(v));
   const rentHtml=commissionBlockLines(c,'rentTotal',v=>fmtMoney(v));
   const faixaBlocks=commissionBlockLines(c,'faixa',v=>fmtPct2(v));
   const comissaoBlocks=commissionBlockLines(c,isAnalyst?'comissaoTotal':'comissaoPrincipal',v=>fmtMoney(v));
   return `<tr class="${cls} multiBlockRow">
     <td data-label="Nome">${nome}</td>
     <td data-label="Vend.">${vendHtml}</td>
     <td data-label="Fin.">${finHtml}</td>
     <td data-label="Share">${shareHtml}</td>
     <td data-label="Retorno">${retornoHtml}</td>
     <td data-label="70% SPF" class="spf70Value">${spfHtml}</td>
     <td data-label="Rentab.">${rentHtml}</td>
     <td data-label="Faixa">${faixaBlocks}</td>
     <td data-label="${comissaoLabel}" class="commValue">${comissaoBlocks}<div class="commissionTotalLine"><small>TOTAL</small><b>${fmtMoney(isAnalyst?c.comissaoTotal:c.comissaoPrincipal)}</b></div></td>
     <td data-label="Detalhes" style="text-align:center">${btn}</td>
   </tr>`;
 }
 return `<tr class="${cls}"><td data-label="Nome">${nome}</td><td data-label="Vend.">${m.vendidas}</td><td data-label="Fin.">${m.financiadas}</td><td data-label="Share">${shareBadge(m.financiadas,m.vendidas)}</td><td data-label="Retorno">${fmtMoney(m.retorno||0)}</td><td data-label="70% SPF" class="spf70Value">${fmtMoney(c.spfLiquido||0)}</td><td data-label="Rentab.">${fmtMoney(c.rentTotal||0)}</td><td data-label="Faixa">${faixaHtml}</td><td data-label="${comissaoLabel}" class="commValue">${fmtMoney(isAnalyst?c.comissaoTotal:c.comissaoPrincipal)}</td><td data-label="Detalhes" style="text-align:center">${btn}</td></tr>`;
}
function chassisHtml(items){
 let html='<div class="chassisList">';
 if(!items.length) html+='<p class="note">Nenhum chassi vendido no período.</p>';
 items.forEach(it=>{
   const status=it.financiado?'<span class="tag ok">FINANCIADO</span>':'<span class="tag">NÃO FINANCIADO</span>';
   const cls=it.financiado?'fin':'nofin';
   const hasDetails=it.financiado||(+it.producao||0)||(+it.retorno||0)||(+it.spfValor||0)||(+it.retornoPosterior||0);
   html+=`<div class="chassisItem ${cls}"><div><b>${it.chassi}</b> ${status}</div><div class="note">Data: ${it.date||'-'} ${it.cliente?' · Cliente: '+it.cliente:''}</div>`;
   if(hasDetails){
     html+=`<div class="detailGrid">
       <span>Produção Total: <b>${fmtMoney(it.producao||0)}</b></span>
       <span>Retorno Principal: <b>${fmtMoney(it.retornoPrincipal||0)}</b></span>
       <span>Retorno Posterior: <b>${fmtMoney(it.retornoPosterior||0)}</b></span>
       <span>Retorno Total: <b>${fmtMoney(it.retorno||0)}</b></span>
       <span>SPF Extra: <b>${it.spf?'SIM':'NÃO'}</b>${it.spf?' · '+fmtMoney(it.spfValor):''}</span>
       <span>Rentabilidade Total: <b>${fmtMoney(it.rentabTotal||0)}</b></span>
     </div>`;
   }
   html+=`</div>`;
 });
 return html+'</div>';
}
function showDetails(id,nomeEnc){
 const nome=decodeURIComponent(nomeEnc||''); const d=DETAIL_STORE[id]||{}; const m=d.m||{}; const c=d.c||commissionCalc(d.status||'',m,d.cls||''); const isAnalyst=d.cls==='analyst';
 const blocks=(d.commissionBlocks||c.blocks||[]).filter(b=>b&&b.c);
 const multiple=blocks.length>1||c.multiplasFaixas;
 let html=`<div class="modalBack" onclick="closeModal(event)"><div class="modalBox"><div class="modalHead"><h2>Detalhes · ${nome}</h2><button onclick="document.getElementById('chassisModal').remove()">Fechar</button></div>`;
 if(multiple&&blocks.length){
   html+=`<div class="detailCard multiBlockDetailHeader">
     <div class="detailGrid">
       <span>Loja/Vínculo: <b>${d.loja||'-'}</b></span>
       <span>Status: <b>${d.status||'-'}</b></span>
       <span>Produção total: <b>${fmtMoney(m.producao||0)}</b></span>
       <span>Qtd SPF total: <b>${m.spfQty||0}</b></span>
       <span>Comissão SPF total: <b>${fmtMoney(c.comissaoSpf||0)}</b></span>
       <span>Comissão principal total: <b>${fmtMoney(c.comissaoPrincipal||0)}</b></span>
       <span>Comissão total final: <b>${fmtMoney(c.comissaoTotal||c.comissaoPrincipal||0)}</b></span>
     </div>
     <div class="formulaBox">
       <b>Critério correto:</b> cada bloco mantém sua própria Rentabilidade, Share e Faixa. A Comissão Total é somente a soma das comissões finais dos blocos.<br>
       <b>Não existe faixa média ou faixa efetiva consolidada.</b>
     </div>
   </div>`;
   html+='<h3>Memória de cálculo por bloco</h3>'+commissionBlocksTable(c,true);
 }else{
   const formula=isAnalyst?'Comissão principal = Rentabilidade total consolidada × faixa única definida pelo Share consolidado de NOVOS + SEMINOVOS; Comissão total = comissão principal + (Qtd SPF × R$ 150,00)':'Comissão = Rentabilidade total × faixa';
   const spfAnalystFields=isAnalyst?`<span>Qtd SPF: <b>${m.spfQty||0}</b></span><span>Comissão SPF: <b>${fmtMoney(c.comissaoSpf||0)}</b></span><span>Comissão total: <b>${fmtMoney(c.comissaoTotal||0)}</b></span>`:'';
   const analystShareField=isAnalyst?`<span>Share consolidado: <b>${shareNum(m.financiadas||0,m.vendidas||0).toFixed(2).replace('.',',')}%</b></span>`:'';
   html+=`<div class="detailCard"><div class="detailGrid"><span>Loja: <b>${d.loja||'-'}</b></span><span>Status: <b>${d.status||'-'}</b></span><span>Produção: <b>${fmtMoney(m.producao||0)}</b></span><span>SPF Extra: <b>${fmtMoney(m.spf||0)}</b></span><span>SPF Líquido 70%: <b>${fmtMoney(c.spfLiquido||0)}</b></span>${analystShareField}<span>Faixa única: <b>${fmtPct2(c.faixa||0)}</b></span>${spfAnalystFields}<span>Comissão principal: <b>${fmtMoney(c.comissaoPrincipal||0)}</b></span></div><div class="formulaBox"><b>Fórmula:</b> Rentabilidade total = Retorno bruto (${fmtMoney(m.retorno||0)}) + SPF líquido 70% (${fmtMoney(c.spfLiquido||0)}) = <b>${fmtMoney(c.rentTotal||0)}</b><br><b>Critério:</b> ${formula}</div></div>`;
 }
 if(isAnalyst&&(c.auditBlocks||[]).length){
   const auditRows=(c.auditBlocks||[]).map(b=>{
     const bm=b.m||{};
     return `<tr><td>${b.departamento||'-'}</td><td>${bm.vendidas||0}</td><td>${bm.financiadas||0}</td><td>${shareNum(bm.financiadas||0,bm.vendidas||0).toFixed(2).replace('.',',')}%</td><td>${fmtMoney(bm.retorno||0)}</td><td>${fmtMoney((+bm.spf||0)*(cfgNum('spf_liquido_percentual')/100))}</td></tr>`;
   }).join('');
   html+=`<h3>Composição por departamento — somente auditoria</h3>
     <p class="note">NOVOS e SEMINOVOS são exibidos apenas para conferência. A faixa do Analista é única e calculada sobre o Share consolidado.</p>
     <div class="tableWrap"><table><thead><tr><th>Departamento</th><th>Vendidas</th><th>Financiadas</th><th>Share informativo</th><th>Retorno</th><th>70% SPF</th></tr></thead><tbody>${auditRows}</tbody></table></div>`;
 }
 if((m.spfAudit||[]).length){
   html+='<h3>Auditoria SPF EXTRA · Base 03</h3><div class="tableWrap"><table><thead><tr><th>Cliente</th><th>CPF</th><th>Chassi</th><th>Opcional - Nome</th><th>Opcional - Valor</th><th>SPF considerado</th><th>Motivo</th></tr></thead><tbody>';
   (m.spfAudit||[]).forEach(r=>{html+=`<tr><td>${r.cliente||'-'}</td><td>${r.cpf||'-'}</td><td>${(r.chassi||'').slice(-6)||'-'}</td><td>${r.opcionalNome||'-'}</td><td>${fmtMoney(r.opcionalValor||0)}</td><td>${fmtMoney(r.spfConsiderado||0)}</td><td>${r.motivo||''}</td></tr>`;});
   html+='</tbody></table></div>';
 }
 if((m.retornoPosteriorAudit||[]).length){
   html+='<h3>Auditoria · RETORNO POSTERIOR</h3><div class="tableWrap"><table><thead><tr><th>Status</th><th>Data</th><th>Cliente</th><th>Chassi</th><th>Vendedor</th><th>Loja</th><th>Descrição Serviço</th><th>Produção</th><th>Retorno</th><th>Motivo</th></tr></thead><tbody>';
   (m.retornoPosteriorAudit||[]).forEach(r=>{html+=`<tr><td>${r.considerado===false?'<span class="tag bad">IGNORADO</span>':'<span class="tag ok">CONSIDERADO</span>'}</td><td>${r.date||'-'}</td><td>${r.cliente||'-'}</td><td>${(r.chassi||'').slice(-6)||'-'}</td><td>${r.vendedor||'-'}</td><td>${r.loja||'-'}</td><td>${r.servico||'-'}</td><td>${fmtMoney(r.producao||0)}</td><td>${fmtMoney(r.retorno||0)}</td><td>${r.motivo||''}</td></tr>`;});
   html+='</tbody></table></div>';
 }
 html+=`<h3>Chassis vendidos</h3>${chassisHtml(CHASSIS_STORE[id]||[])}`;
 html+='</div></div>'; let old=document.getElementById('chassisModal'); if(old) old.remove(); const div=document.createElement('div'); div.id='chassisModal'; div.innerHTML=html; document.body.appendChild(div);
}

function showChassis(id,nomeEnc){ const nome=decodeURIComponent(nomeEnc||''); let html=`<div class="modalBack" onclick="closeModal(event)"><div class="modalBox"><div class="modalHead"><h2>Chassis vendidos · ${nome}</h2><button onclick="document.getElementById('chassisModal').remove()">Fechar</button></div>${chassisHtml(CHASSIS_STORE[id]||[])}</div></div>`; let old=document.getElementById('chassisModal'); if(old) old.remove(); const div=document.createElement('div'); div.id='chassisModal'; div.innerHTML=html; document.body.appendChild(div); }
function closeModal(e){ if(e.target.classList.contains('modalBack')) document.getElementById('chassisModal').remove(); }
function renderStore(store){
 const sellers=DATA.auth.filter(a=>a.tipo==='VENDEDOR'&&sellerRelevantToStore(a,store)&&allowedSellerForStore(a,store)).map(a=>({a,m:calcSeller(a,store)})).filter(x=>x.m.vendidas>0);
 const novos=sellers.filter(x=>statusHas(x.a,'NOVOS')); const seminovos=sellers.filter(x=>statusHas(x.a,'SEMINOVOS'));
 const canSeeNovos=USER.tipo==='MASTER'||USER.tipo==='ANALISTA'||isDiretorComissao(USER)||(USER.tipo==='GERENTE'&&statusHas(USER,'NOVOS'))||USER.tipo==='VENDEDOR';
 const canSeeSemis=USER.tipo==='MASTER'||USER.tipo==='ANALISTA'||isDiretorComissao(USER)||(USER.tipo==='GERENTE'&&statusHas(USER,'SEMINOVOS'))||USER.tipo==='VENDEDOR';
 let html=`<div class="store">${store}</div>`;
 html+=`<div class="tableWrap"><table class="compactMain main10"><thead><tr><th>Nome</th><th>Vend.</th><th>Fin.</th><th>Share</th><th>Retorno</th><th>70% SPF</th><th>Rentab. Total</th><th>Faixa</th><th>Comissão</th><th>Detalhes</th></tr></thead><tbody>`;
 if(canSeeNovos){ html+=`<tr><td colspan="10" style="text-align:left;background:#151515"><b>NOVOS</b></td></tr>`; novos.forEach(x=>html+=trPessoa(x.a.nome,store,x.a.status,x.m)); const mg=DATA.auth.find(a=>a.tipo==='GERENTE'&&a.loja===store&&statusHas(a,'NOVOS')); if((USER.tipo==='MASTER'||USER.tipo==='ANALISTA'||USER.tipo==='GERENTE'||isDiretorComissao(USER))&&novos.length) html+=trPessoa((mg?mg.nome:'GERENTE NOVOS NÃO LOCALIZADO'),store,'GERENTE NOVOS',sumRows(novos),'manager'); }
 if(canSeeSemis){ html+=`<tr><td colspan="10" style="text-align:left;background:#151515"><b>SEMINOVOS</b></td></tr>`; seminovos.forEach(x=>html+=trPessoa(x.a.nome,store,x.a.status,x.m)); const mg=DATA.auth.find(a=>a.tipo==='GERENTE'&&a.loja===store&&statusHas(a,'SEMINOVOS')); if((USER.tipo==='MASTER'||USER.tipo==='ANALISTA'||USER.tipo==='GERENTE'||isDiretorComissao(USER))&&seminovos.length) html+=trPessoa((mg?mg.nome:'GERENTE SEMINOVOS NÃO LOCALIZADO'),store,'GERENTE SEMINOVOS',sumRows(seminovos),'manager'); }
 html+='</tbody></table></div>';
 const novosAnalista=novos.filter(x=>canSeeNovos), semisAnalista=seminovos.filter(x=>canSeeSemis);
 const analystBlocks=analystCommissionRowsForStore(store,novosAnalista,semisAnalista);
 if((USER.tipo==='MASTER'||USER.tipo==='ANALISTA'||isDiretorComissao(USER))&&analystBlocks.length){ html+=`<h3>Analista</h3><div class="tableWrap"><table class="compactMain main10 analystMain"><thead><tr><th>Nome</th><th>Vend.</th><th>Fin.</th><th>Share</th><th>Retorno</th><th>70% SPF</th><th>Rentab. Total</th><th>Faixa</th><th>Com. Total</th><th>Detalhes</th></tr></thead><tbody>`; combineAnalystRowsForDisplay(analystBlocks).forEach(ar=>{ html+=trPessoa(ar.transferencia?`${ar.nome} <span class="ausenciaTransferBadge">FÉRIAS/AUSÊNCIA - período ${ar.periodoTransferencia||''}</span>`:ar.nome,store,ar.status,ar.m,'analyst',ar.transferencia?'analystTransfer':'analyst',ar.c,ar.faixaHtml); }); html+='</tbody></table></div>'; }
 return html;
}




let MASTER_PANEL_OPEN=false;
let MASTER_TAB='usuarios';
let MASTER_SEARCH='';
let ADMIN_MODAL_STATE=null;

function toggleMasterAdmin(){
  MASTER_PANEL_OPEN=!MASTER_PANEL_OPEN;
  renderMasterAdmin();
  if(MASTER_PANEL_OPEN){setTimeout(()=>document.getElementById('masterAdmin')?.scrollIntoView({behavior:'smooth',block:'start'}),50);}
}
function setMasterTab(tab){MASTER_TAB=tab;renderMasterAdmin();}
function setMasterSearch(v){MASTER_SEARCH=(v||'').toUpperCase();renderMasterAdmin();}
function adminMsg(msg,err=false){
  const el=document.getElementById('adminMsg');
  if(el){el.textContent=msg||'';el.className='adminMsg '+(err?'err':'ok');}
}
function toastAdmin(msg,type='ok'){
  const wrap=document.getElementById('adminToastWrap');
  if(!wrap) return;
  const div=document.createElement('div');
  div.className='adminToast '+(type==='err'?'err':type==='warn'?'warn':'');
  div.textContent=msg;
  wrap.appendChild(div);
  setTimeout(()=>{div.style.opacity='0';div.style.transform='translateY(6px)';},3200);
  setTimeout(()=>div.remove(),3900);
}
function openAdminModal({title='',text='',fieldHtml='',confirmText='Salvar',danger=false,onConfirm=null}){
  ADMIN_MODAL_STATE={onConfirm};
  const ov=document.getElementById('adminModalOverlay');
  ov.innerHTML=`<div class="adminModal">
    <h3>${title}</h3>
    ${text?`<p>${text}</p>`:''}
    ${fieldHtml||''}
    <div id="adminModalMsg" class="adminMsg"></div>
    <div class="adminModalActions">
      <button class="secondary" onclick="closeAdminModal()">Cancelar</button>
      <button class="${danger?'danger':''}" onclick="confirmAdminModal()">${confirmText}</button>
    </div>
  </div>`;
  ov.classList.add('show');
}
function closeAdminModal(){
  const ov=document.getElementById('adminModalOverlay');
  ov.classList.remove('show');
  ov.innerHTML='';
  ADMIN_MODAL_STATE=null;
}
async function confirmAdminModal(){
  const fn=ADMIN_MODAL_STATE?.onConfirm;
  if(typeof fn==='function') await fn();
}
function setAdminModalMsg(msg,err=false){
  const el=document.getElementById('adminModalMsg');
  if(el){el.textContent=msg||'';el.className='adminMsg '+(err?'err':'ok');}
}

async function carregarUsuariosSupabase(){
  const data=await carregarDadosSegurancaMaster();
  return data.users;
}
async function carregarConfiguracoesSupabase(){
  const data=await carregarDadosSegurancaMaster();
  return data.configurations;
}
async function carregarAuditoriaSupabase(){
  const data=await carregarDadosSegurancaMaster();
  return data.audit;
}
async function carregarDadosSegurancaMaster(force=false){
  if(!supabaseClient||USER?.tipo!=='MASTER'){
    return {users:[],configurations:[],audit:[]};
  }
  if(!force&&MASTER_SECURITY_STATE.data) return MASTER_SECURITY_STATE.data;
  if(MASTER_SECURITY_STATE.loading) return await MASTER_SECURITY_STATE.loading;
  MASTER_SECURITY_STATE.loading=(async()=>{
    const {data,error}=await supabaseClient.rpc('master_admin_security_data');
    if(error) throw error;
    const safe={
      users:Array.isArray(data?.users)?data.users:[],
      configurations:Array.isArray(data?.configurations)?data.configurations:[],
      audit:Array.isArray(data?.audit)?data.audit:[]
    };
    MASTER_SECURITY_STATE.data=safe;
    return safe;
  })();
  try{return await MASTER_SECURITY_STATE.loading}
  finally{MASTER_SECURITY_STATE.loading=null}
}
async function carregarPeriodosComissao(){
  if(!supabaseClient) return [];
  if(USER?.tipo==='MASTER'){
    const ref=await carregarReferenciasAdminSeguras(true);
    PERIODOS_COMISSAO=ref.periods||[];
    return PERIODOS_COMISSAO;
  }
  const {data,error}=await supabaseClient.rpc('operational_commission_periods');
  if(error){console.warn('Falha ao carregar períodos de comissão:',error.message); return []}
  PERIODOS_COMISSAO=Array.isArray(data?.rows)?data.rows:[];
  return PERIODOS_COMISSAO;
}

async function carregarAusenciasAnalistas(){
  if(!supabaseClient||USER?.tipo!=='MASTER'){AUSENCIAS_ANALISTAS=[];return []}
  const ref=await carregarReferenciasAdminSeguras(true);
  AUSENCIAS_ANALISTAS=ref.absences||[];
  return AUSENCIAS_ANALISTAS;
}

async function carregarMudancasLojaVendedores(){
  if(!supabaseClient||USER?.tipo!=='MASTER'){MUDANCAS_LOJA_VENDEDORES=[];return []}
  const ref=await carregarReferenciasAdminSeguras(true);
  MUDANCAS_LOJA_VENDEDORES=ref.store_changes||[];
  return MUDANCAS_LOJA_VENDEDORES;
}
async function carregarReferenciasAdminSeguras(force=false){
  if(!supabaseClient||USER?.tipo!=='MASTER'){
    return {periods:[],absences:[],store_changes:[]};
  }
  if(!force&&MASTER_ADMIN_REFERENCE_STATE.data) return MASTER_ADMIN_REFERENCE_STATE.data;
  if(MASTER_ADMIN_REFERENCE_STATE.loading) return await MASTER_ADMIN_REFERENCE_STATE.loading;
  MASTER_ADMIN_REFERENCE_STATE.loading=(async()=>{
    const {data,error}=await supabaseClient.rpc('master_admin_reference_data');
    if(error) throw error;
    const safe={
      periods:Array.isArray(data?.periods)?data.periods:[],
      absences:Array.isArray(data?.absences)?data.absences:[],
      store_changes:Array.isArray(data?.store_changes)?data.store_changes:[]
    };
    MASTER_ADMIN_REFERENCE_STATE.data=safe;
    return safe;
  })();
  try{return await MASTER_ADMIN_REFERENCE_STATE.loading}
  finally{MASTER_ADMIN_REFERENCE_STATE.loading=null}
}
async function executarAdminSeguro(entity,action,payload={}){
  const {data,error}=await supabaseClient.rpc('master_admin_manage',{
    p_entity:entity,p_action:action,p_payload:payload
  });
  if(error) throw error;
  if(data?.status!=='OK') throw new Error('A operação administrativa não foi confirmada.');
  MASTER_ADMIN_REFERENCE_STATE.data=null;
  return data;
}
function vendedoresOptions(selectedCpf=''){
  const list=DATA.auth.filter(a=>a.tipo==='VENDEDOR').sort((a,b)=>(a.nome||'').localeCompare(b.nome||''));
  return '<option value="">Selecione</option>'+list.map(a=>`<option value="${a.cpf||a.nomeKey}" ${String(selectedCpf)===String(a.cpf||a.nomeKey)?'selected':''}>${a.nome} · ${a.loja} · ${a.status}</option>`).join('');
}
function getVendedorById(id){
  return DATA.auth.find(a=>a.tipo==='VENDEDOR'&&(a.cpf===id||a.nomeKey===id||a.login===id||a.login_nbs===id))||null;
}
function mudancasAtivasVendedor(a){
  if(!a) return [];
  const nk=a.nomeKey||norm(a.nome||'');
  return (MUDANCAS_LOJA_VENDEDORES||[])
    .filter(m=>m&&m.ativo!==false)
    .filter(m=>{
      const cpfOk=m.cpf_vendedor&&a.cpf&&String(m.cpf_vendedor)===String(a.cpf);
      const nomeOk=norm(m.nome_vendedor||'')&&norm(m.nome_vendedor||'')===nk;
      const loginOk=m.login_vendedor&&a.login&&String(m.login_vendedor)===String(a.login);
      return cpfOk||nomeOk||loginOk;
    });
}
function lojaEfetivaVendedorNaData(a,date,lojaOriginal=''){
  const base=lojaOriginal||a?.loja||'';
  if(!a||!date) return base;
  const ds=String(date).slice(0,10);
  for(const m of mudancasAtivasVendedor(a)){
    const origem=m.loja_origem||base;
    const destino=m.loja_destino||base;
    const iniOrig=m.data_inicio_origem||'0000-01-01';
    const fimOrig=m.data_fim_origem||'9999-12-31';
    const iniDest=m.data_inicio_destino||'9999-12-31';
    if(ds>=iniOrig && ds<=fimOrig) return origem;
    if(ds>=iniDest) return destino;
  }
  return base;
}
function storesForSellerInPeriod(a){
  const {ini,fim}=periodoAtualDatas();
  const out=new Set([a?.loja].filter(Boolean));
  mudancasAtivasVendedor(a).forEach(m=>{
    if(overlapRange(m.data_inicio_origem||ini,m.data_fim_origem||fim,ini,fim)) out.add(m.loja_origem);
    if(overlapRange(m.data_inicio_destino||ini,fim,ini,fim)) out.add(m.loja_destino);
  });
  return [...out].filter(Boolean);
}
function sellerRelevantToStore(a,store){
  if(!a||!store) return false;
  return storesForSellerInPeriod(a).some(s=>norm(s)===norm(store)) || norm(a.loja||'')===norm(store);
}
function allowedSellerForStore(a,store){
  if(!a||a.tipo!=='VENDEDOR') return false;
  if(USER.tipo==='MASTER'||isDiretorComissao(USER)) return true;
  if(USER.tipo==='VENDEDOR') return a.nomeKey===USER.nomeKey;
  const statusOk=(USER.statusGroups||[]).some(st=>statusHas(a,st));
  if(USER.tipo==='ANALISTA'){
    const lojaOk=norm(store)===norm(USER.loja)||isStoreCoveredByAnalyst(store,USER);
    return lojaOk && statusOk;
  }
  if(USER.tipo==='GERENTE') return norm(store)===norm(USER.loja) && statusOk;
  return false;
}
function conflitoMudancaVendedor(payload,ignoreId=''){
  const iniO=payload.data_inicio_origem||'';
  const fimO=payload.data_fim_origem||'';
  const iniD=payload.data_inicio_destino||'';
  return (MUDANCAS_LOJA_VENDEDORES||[]).some(m=>{
    if(ignoreId&&String(m.id)===String(ignoreId)) return false;
    if(m.ativo===false) return false;
    const mesmo=(m.cpf_vendedor&&payload.cpf_vendedor&&String(m.cpf_vendedor)===String(payload.cpf_vendedor))||norm(m.nome_vendedor||'')===norm(payload.nome_vendedor||'');
    if(!mesmo) return false;
    const a1=m.data_inicio_origem||m.data_inicio_destino||'';
    const b1=m.data_fim_origem||'9999-12-31';
    return overlapRange(a1,b1,iniO,fimO)||overlapRange(m.data_inicio_destino||a1,'9999-12-31',iniD,'9999-12-31');
  });
}
async function salvarMudancaLojaVendedor(){
  const vendedorId=document.getElementById('mudVendCpf')?.value||'';
  const vendedor=getVendedorById(vendedorId);
  const origem=document.getElementById('mudLojaOrigem')?.value||'';
  const destino=document.getElementById('mudLojaDestino')?.value||'';
  const iniOrig=document.getElementById('mudDataIniOrigem')?.value||'';
  const fimOrig=document.getElementById('mudDataFimOrigem')?.value||'';
  const iniDest=document.getElementById('mudDataIniDestino')?.value||'';
  const obs=(document.getElementById('mudObs')?.value||'').trim();
  if(!vendedor){toastAdmin('Selecione o vendedor.','err');return}
  if(!origem||!destino){toastAdmin('Informe loja origem e loja destino.','err');return}
  if(!iniOrig||!fimOrig||!iniDest){toastAdmin('Informe as datas da mudança.','err');return}
  if(fimOrig<iniOrig){toastAdmin('Data final da origem não pode ser menor que a inicial.','err');return}
  const payload={
    cpf_vendedor:vendedor.cpf||'',
    login_vendedor:vendedor.login||vendedor.login_nbs||'',
    nome_vendedor:vendedor.nome||'',
    loja_origem:origem,
    loja_destino:destino,
    data_inicio_origem:iniOrig,
    data_fim_origem:fimOrig,
    data_inicio_destino:iniDest,
    observacao:obs,
    ativo:true,
    criado_por:USER?.cpf||''
  };
  if(conflitoMudancaVendedor(payload)){toastAdmin('Já existe mudança ativa conflitante para este vendedor.','err');return}
  try{
    await executarAdminSeguro('STORE_CHANGE','CREATE',{
      seller_cpf:payload.cpf_vendedor,seller_login:payload.login_vendedor,
      seller_name:payload.nome_vendedor,origin_store:payload.loja_origem,
      destination_store:payload.loja_destino,origin_start:payload.data_inicio_origem,
      origin_end:payload.data_fim_origem,destination_start:payload.data_inicio_destino,
      notes:payload.observacao
    });
    toastAdmin('Mudança de loja cadastrada com sucesso.');
    await carregarMudancasLojaVendedores();
    fillStores();render();renderMasterAdmin();
  }catch(error){toastAdmin('Erro ao salvar mudança: '+error.message,'err')}
}
async function alternarMudancaLojaVendedor(id,ativo){
  try{
    await executarAdminSeguro('STORE_CHANGE','SET_ACTIVE',{id,active:!ativo});
    await carregarMudancasLojaVendedores();render();renderMasterAdmin();
  }catch(error){toastAdmin('Erro ao alterar mudança: '+error.message,'err')}
}
async function arquivarMudancaLojaVendedor(id){
  if(!confirm('Deseja arquivar esta mudança de loja? Ela ficará inativa para histórico.')) return;
  try{
    await executarAdminSeguro('STORE_CHANGE','ARCHIVE',{id});
    await carregarMudancasLojaVendedores();render();renderMasterAdmin();
  }catch(error){toastAdmin('Erro ao arquivar mudança: '+error.message,'err')}
}
function renderMudancasLojaVendedoresHtml(){
  const rows=(MUDANCAS_LOJA_VENDEDORES||[]).map(m=>`
    <tr>
      <td><b>${m.nome_vendedor||''}</b><br><span class="note">${m.cpf_vendedor||m.login_vendedor||''}${m.fallback_local?' · LOCAL':''}</span></td>
      <td>${m.loja_origem||''}<br><span class="note">${dataBR(m.data_inicio_origem)} a ${dataBR(m.data_fim_origem)}</span></td>
      <td>${m.loja_destino||''}<br><span class="note">a partir de ${dataBR(m.data_inicio_destino)}</span></td>
      <td>${m.observacao||''}</td>
      <td>${m.ativo!==false?'<span class="periodoAtivoBadge">ATIVA</span>':'<span class="periodoInativoBadge">INATIVA</span>'}</td>
      <td class="adminActions">
        <button class="adminActionBtn warn" onclick="alternarMudancaLojaVendedor('${m.id}',${m.ativo!==false})">${m.ativo!==false?'Inativar':'Ativar'}</button>
        <button class="adminActionBtn danger" onclick="arquivarMudancaLojaVendedor('${m.id}')">Arquivar</button>
      </td>
    </tr>`).join('');
  return `<h2>Mudança de Loja — Vendedores</h2>
    <p class="note">Cadastre transferências de loja por período. A regra altera somente a alocação da loja conforme a data da venda/lançamento, preservando as regras de comissão.</p>
    <div class="ausenciaInfoBox"><b>Regra:</b> vendas/valores no período de origem ficam na loja origem; a partir da data destino ficam na loja destino. O vendedor continua consolidado no próprio acesso.</div>
    <div class="ausenciaAdminGrid">
      <div><label>Vendedor</label><select id="mudVendCpf">${vendedoresOptions()}</select></div>
      <div><label>Loja origem</label><select id="mudLojaOrigem">${lojasOptions()}</select></div>
      <div><label>Loja destino</label><select id="mudLojaDestino">${lojasOptions()}</select></div>
      <div><label>Início origem</label><input id="mudDataIniOrigem" type="date"></div>
      <div><label>Fim origem</label><input id="mudDataFimOrigem" type="date"></div>
      <div><label>Início destino</label><input id="mudDataIniDestino" type="date"></div>
      <div><label>Observação</label><input id="mudObs" placeholder="Ex.: transferência interna"></div>
      <div><button class="adminActionBtn good" onclick="salvarMudancaLojaVendedor()">Salvar mudança</button></div>
    </div>
    <div class="tableWrap"><table class="adminTable">
      <thead><tr><th>Vendedor</th><th>Origem</th><th>Destino</th><th>Observação</th><th>Status</th><th>Ações</th></tr></thead>
      <tbody>${rows||'<tr><td colspan="6">Nenhuma mudança cadastrada.</td></tr>'}</tbody>
    </table></div>`;
}

function analistasOptions(selectedCpf=''){
  const list=DATA.auth.filter(a=>a.tipo==='ANALISTA').sort((a,b)=>(a.nome||'').localeCompare(b.nome||''));
  return '<option value="">Selecione</option>'+list.map(a=>`<option value="${a.cpf}" ${String(selectedCpf)===String(a.cpf)?'selected':''}>${a.nome} · ${a.loja}</option>`).join('');
}
function lojasOptions(selected=''){
  const lojas=[...new Set(DATA.auth.map(a=>a.loja).filter(Boolean))].sort();
  return '<option value="">Selecione</option>'+lojas.map(l=>`<option value="${l}" ${String(selected)===String(l)?'selected':''}>${l}</option>`).join('');
}
function getAnalistaByCpf(cpfAlvo){return DATA.auth.find(a=>a.tipo==='ANALISTA'&&a.cpf===cpfAlvo)||null}
async function salvarAusenciaAnalista(){
  const cpfAus=document.getElementById('ausCpfAusente')?.value||'';
  const cpfSub=document.getElementById('ausCpfSubstituto')?.value||'';
  const loja=document.getElementById('ausLojaCoberta')?.value||'';
  const ini=document.getElementById('ausDataIni')?.value||'';
  const fim=document.getElementById('ausDataFim')?.value||'';
  const motivo=(document.getElementById('ausMotivo')?.value||'FÉRIAS').trim();
  const obs=(document.getElementById('ausObs')?.value||'').trim();
  const aus=getAnalistaByCpf(cpfAus), sub=getAnalistaByCpf(cpfSub);
  if(!aus){toastAdmin('Selecione o analista ausente.','err');return}
  if(!sub){toastAdmin('Selecione o analista substituto.','err');return}
  if(!loja){toastAdmin('Selecione a loja coberta.','err');return}
  if(!ini||!fim){toastAdmin('Informe data inicial e final.','err');return}
  if(fim<ini){toastAdmin('Data final não pode ser menor que a inicial.','err');return}
  const payload={
    cpf_analista_ausente:aus.cpf,
    nome_analista_ausente:aus.nome,
    loja_origem:aus.loja||'',
    cpf_analista_substituto:sub.cpf,
    nome_analista_substituto:sub.nome,
    loja_coberta:loja,
    data_inicio:ini,
    data_fim:fim,
    motivo,
    observacao:obs,
    ativo:true,
    criado_por:USER?.cpf||''
  };
  try{
    await executarAdminSeguro('ABSENCE','CREATE',{
      absent_cpf:payload.cpf_analista_ausente,absent_name:payload.nome_analista_ausente,
      origin_store:payload.loja_origem,substitute_cpf:payload.cpf_analista_substituto,
      substitute_name:payload.nome_analista_substituto,covered_store:payload.loja_coberta,
      start_date:payload.data_inicio,end_date:payload.data_fim,
      reason:payload.motivo,notes:payload.observacao
    });
    toastAdmin('Ausência cadastrada com sucesso.');
    await carregarAusenciasAnalistas();render();renderMasterAdmin();
  }catch(error){toastAdmin('Erro ao salvar ausência: '+error.message,'err')}
}
async function alternarAusenciaAnalista(id,ativo){
  try{
    await executarAdminSeguro('ABSENCE','SET_ACTIVE',{id,active:!ativo});
    await carregarAusenciasAnalistas();render();renderMasterAdmin();
  }catch(error){toastAdmin('Erro ao alterar ausência: '+error.message,'err')}
}
async function excluirAusenciaAnalista(id){
  await arquivarAusenciaAnalista(id);
}
async function arquivarAusenciaAnalista(id){
  if(!confirm('Deseja arquivar esta ausência? Ela ficará inativa e será preservada para histórico.')) return;
  try{
    await executarAdminSeguro('ABSENCE','ARCHIVE',{id});
    toastAdmin('Ausência arquivada com sucesso.');
    await carregarAusenciasAnalistas();
    if(typeof fillStores==='function') fillStores();
    render();renderMasterAdmin();
  }catch(error){toastAdmin('Erro ao arquivar ausência: '+error.message,'err')}
}



async function carregarFechamentosComissao(force=false){
  if(!supabaseClient) return [];
  if(!force&&FECHAMENTOS_COMISSAO_CARREGADOS_EM&&(Date.now()-FECHAMENTOS_COMISSAO_CARREGADOS_EM)<30000){
    return FECHAMENTOS_COMISSAO;
  }
  const {data,error}=await supabaseClient.rpc('master_commission_closings');
  if(error){console.warn('Falha ao carregar fechamentos:',error.message); FECHAMENTOS_COMISSAO=[]; return []}
  FECHAMENTOS_COMISSAO=Array.isArray(data?.rows)?data.rows:[];
  FECHAMENTOS_COMISSAO_CARREGADOS_EM=Date.now();
  return FECHAMENTOS_COMISSAO;
}
function fechamentoAtual(){
  const pid=PERIODO_SELECIONADO?.id;
  if(!pid) return null;
  return (FECHAMENTOS_COMISSAO||[]).find(f=>String(f.periodo_id||'')===String(pid) && String(f.status||'').toUpperCase()==='FECHADO' && f.ativo!==false)||null;
}
function fechamentoObsPayload(payload){
  return JSON.stringify({
    qtd_vendida:payload.qtd_vendida,
    qtd_financiada:payload.qtd_financiada,
    producao_total:payload.producao_total,
    retorno_total:payload.retorno_total,
    spf_total:payload.spf_total,
    linhas_snapshot:payload.linhas_snapshot,
    comissao_total:payload.comissao_total,
    fechado_por_nome:payload.fechado_por_nome
  });
}
function fechamentoMetricFromObs(f, key){
  try{
    const o=typeof f.observacao==='string'?JSON.parse(f.observacao||'{}'):(f.observacao||{});
    return o[key]||0;
  }catch(e){return 0}
}
function snapshotRowsPayload(preview, fechamentoId=null){
  const periodo=PERIODO_SELECIONADO||{};
  return (preview.linhas||[]).map(l=>({
    fechamento_id:fechamentoId,
    periodo_id:periodo.id||null,
    nome_periodo:periodo.nome_periodo||'Datas manuais',
    data_inicio:periodo.data_inicio||document.getElementById('dtIni')?.value||'',
    data_fim:periodo.data_fim||document.getElementById('dtFim')?.value||'',
    loja:l.loja||'',
    perfil:l.perfil||'',
    nome:l.nome||'',
    status:l.status||'',
    vendidas:+(l.m?.vendidas||0),
    financiadas:+(l.m?.financiadas||0),
    share:+(l.c?.share||shareNum(l.m?.financiadas||0,l.m?.vendidas||0)),
    producao:+(l.m?.producao||0),
    retorno:+(l.m?.retorno||0),
    spf_extra:+(l.m?.spf||0),
    spf_liquido:+(l.c?.spfLiquido||0),
    rentabilidade_total:+(l.c?.rentTotal||0),
    faixa:+(l.c?.faixa||0),
    comissao_principal:+(l.c?.comissaoPrincipal||0),
    comissao_spf:+(l.c?.comissaoSpf||0),
    comissao_total:+(l.comissao||0)
  }));
}
async function fecharCompetencia(){
  if(!PERIODO_SELECIONADO?.id){toastAdmin('Selecione um Período de Comissão oficial antes de fechar.','err');return}
  await carregarFechamentosComissao();
  if(fechamentoAtual()){toastAdmin('Este período já possui fechamento ativo. Reabra antes de fechar novamente.','err');return}
  if(!confirm('Confirmar fechamento oficial desta competência? O snapshot será gravado no Supabase.')) return;
  const preview=calcularPreviewFechamentoCompetencia();
  const executivo=calcularResumoExecutivoFechamento();
  const payload={
    periodo_id:PERIODO_SELECIONADO.id,
    nome_periodo:PERIODO_SELECIONADO.nome_periodo||'',
    data_inicio:PERIODO_SELECIONADO.data_inicio||'',
    data_fim:PERIODO_SELECIONADO.data_fim||'',
    status:'FECHADO',
    fechado_por:USER?.cpf||'',
    fechado_por_nome:USER?.nome||'',
    qtd_vendida:executivo.vendidas,
    qtd_financiada:executivo.financiadas,
    producao_total:executivo.producao,
    retorno_total:executivo.retorno,
    spf_total:executivo.spf,
    linhas_snapshot:preview.linhas.length,
    comissao_total:preview.comissaoPrevista
  };
  const rows=snapshotRowsPayload(preview);
  const {error}=await supabaseClient.rpc('master_close_commission_period',{
    p_period_id:PERIODO_SELECIONADO.id,
    p_summary:payload,
    p_rows:rows
  });
  if(error){toastAdmin('Fechamento não concluído: '+error.message,'err');return}
  toastAdmin('Competência fechada e snapshot gravado com sucesso.');
  await carregarPeriodosComissao();
  await carregarFechamentosComissao();
  renderMasterAdmin();
}
async function reabrirCompetencia(fechamentoId){
  if(!confirm('Reabrir esta competência? O fechamento será marcado como REABERTO.')) return;
  const {error}=await supabaseClient.rpc('master_reopen_commission_period',{p_closing_id:fechamentoId});
  if(error){toastAdmin('Erro ao reabrir: '+error.message,'err');return}
  toastAdmin('Competência reaberta.');
  await carregarPeriodosComissao();
  await carregarFechamentosComissao();
  renderMasterAdmin();
}
async function visualizarSnapshot(fechamentoId){
  let {data,error}=await supabaseClient.rpc('master_commission_snapshot',{p_closing_id:fechamentoId});
  if(error){toastAdmin('Erro ao carregar snapshot: '+error.message,'err');return}
  SNAPSHOT_VIEW=Array.isArray(data?.rows)?data.rows:[];
  renderMasterAdmin();
}

async function salvarPeriodoComissao(){
  const nome=(document.getElementById('periodoNome')?.value||'').trim();
  const ini=document.getElementById('periodoIni')?.value||'';
  const fim=document.getElementById('periodoFim')?.value||'';
  const atual=document.getElementById('periodoAtual')?.checked||false;
  if(!nome){toastAdmin('Informe o nome do período.','err');return}
  if(!ini||!fim){toastAdmin('Informe data inicial e final.','err');return}
  if(fim<ini){toastAdmin('Data final não pode ser menor que a inicial.','err');return}
  try{
    await executarAdminSeguro('PERIOD','CREATE',{
      name:nome,start_date:ini,end_date:fim,is_current:atual
    });
    toastAdmin('Período criado com sucesso.');
    await carregarPeriodosComissao();
    preencherSelectPeriodos();renderMasterAdmin();
  }catch(error){toastAdmin('Erro ao salvar período: '+error.message,'err')}
}
async function definirPeriodoAtual(id){
  try{
    await executarAdminSeguro('PERIOD','SET_CURRENT',{id});
    await carregarPeriodosComissao();
    const p=PERIODOS_COMISSAO.find(x=>String(x.id)===String(id));
    if(p) selecionarPeriodoComissao(p.id);
    toastAdmin('Período atual definido.');renderMasterAdmin();
  }catch(error){toastAdmin('Erro ao definir período atual: '+error.message,'err')}
}
async function alternarPeriodoAtivo(id,ativo){
  try{
    await executarAdminSeguro('PERIOD','SET_ACTIVE',{id,active:!ativo});
    await carregarPeriodosComissao();
    if(PERIODO_SELECIONADO && String(PERIODO_SELECIONADO.id)===String(id) && ativo){
      PERIODO_SELECIONADO=null;
    }
    preencherSelectPeriodos();render();renderMasterAdmin();
  }catch(error){toastAdmin('Erro ao alterar período: '+error.message,'err')}
}
async function excluirPeriodoComissao(id){
  await arquivarPeriodoComissao(id);
}
async function arquivarPeriodoComissao(id){
  if(!confirm('Deseja arquivar este período? Ele ficará inativo e não aparecerá mais no seletor principal.')) return;
  try{
    await executarAdminSeguro('PERIOD','ARCHIVE',{id});
    toastAdmin('Período arquivado com sucesso.');
    await carregarPeriodosComissao();
    if(PERIODO_SELECIONADO && String(PERIODO_SELECIONADO.id)===String(id)) PERIODO_SELECIONADO=null;
    preencherSelectPeriodos();render();renderMasterAdmin();
  }catch(error){toastAdmin('Erro ao arquivar período: '+error.message,'err')}
}

async function registrarAcaoAdmin(tipo,descricao,cpfAlvo='',extra={}){
  try{
    const {error}=await supabaseClient.rpc('master_admin_audit_event',{
      p_type:tipo,
      p_description:descricao,
      p_target:cpfAlvo,
      p_store:extra.loja||''
    });
    if(error) throw error;
    MASTER_SECURITY_STATE.data=null;
  }catch(e){console.warn('Falha ao registrar auditoria admin:',e)}
}
async function atualizarUsuarioAdmin(cpfAlvo,payload,descricao,opts={}){
  if(PORTAL_RUNTIME_CONFIG.authMode==='secure'){
    if(Object.prototype.hasOwnProperty.call(payload,'primeiro_acesso')){
      toastAdmin('Troca de senha deve ser feita pelo fluxo administrativo do Supabase Auth.','err');
      return false;
    }
    const usuarios=await carregarUsuariosSupabase();
    const alvo=usuarios.find(u=>cpf(u.cpf_normalizado||u.cpf||'')===cpf(cpfAlvo));
    if(!alvo){toastAdmin('Usuário não encontrado.','err');return false;}
    const args={
      p_usuario_id:alvo.id,
      p_perfil:payload.perfil??alvo.perfil,
      p_loja:payload.loja??alvo.loja??'',
      p_status:payload.status??alvo.status??'',
      p_ativo:payload.ativo??alvo.ativo
    };
    const {data,error}=await supabaseClient.rpc('master_atualizar_autorizacao_usuario',args);
    if(error||data!==true){toastAdmin('Erro: '+(error?.message||'Ação não concluída.'),'err');return false;}
    MASTER_SECURITY_STATE.data=null;
    toastAdmin(opts.toast||'Ação executada com sucesso.');
    await renderMasterAdmin();
    render();
    return true;
  }
  toastAdmin('Administração legada foi desativada. Use o modo seguro.','err');
  return false;
}

function editarUsuarioModal(cpfAlvo,campo,valorAtual){
  const labels={perfil:'Perfil',loja:'Loja',status:'STATUS'};
  let field='';
  if(campo==='perfil'){
    field=`<label>${labels[campo]}</label><select id="adminEditValue">
      ${['VENDEDOR','GERENTE','ANALISTA','MASTER'].map(v=>`<option value="${v}" ${v===(valorAtual||'')?'selected':''}>${v}</option>`).join('')}
    </select>`;
  }else if(campo==='status'){
    field=`<label>${labels[campo]}</label><select id="adminEditValue">
      ${['NOVOS','SEMINOVOS','NOVOS/SEMINOVOS','MASTER'].map(v=>`<option value="${v}" ${v===(valorAtual||'')?'selected':''}>${v}</option>`).join('')}
    </select>`;
  }else{
    const lojas=[...new Set((DATA?.auth||[]).map(a=>a.loja).filter(Boolean))].sort();
    field=`<label>${labels[campo]}</label><input id="adminEditValue" list="adminLojasList" value="${valorAtual||''}">
      <datalist id="adminLojasList">${lojas.map(l=>`<option value="${l}"></option>`).join('')}</datalist>`;
  }
  openAdminModal({
    title:`Editar ${labels[campo]}`,
    text:`CPF: <b>${cpfAlvo}</b><br>Valor atual: <b>${valorAtual||'-'}</b>`,
    fieldHtml:field,
    confirmText:'Salvar alteração',
    onConfirm:async()=>{
      const novo=document.getElementById('adminEditValue')?.value?.trim();
      if(!novo){setAdminModalMsg('Informe um valor válido.',true);return;}
      const payload={}; payload[campo]=novo;
      const ok=await atualizarUsuarioAdmin(cpfAlvo,payload,`Alterado ${labels[campo]} de ${valorAtual||'-'} para ${novo}`,{toast:`${labels[campo]} atualizado com sucesso.`});
      if(ok) closeAdminModal();
    }
  });
}
function confirmarAcaoUsuario({cpfAlvo,title,text,payload,descricao,danger=false,action=null}){
  openAdminModal({
    title,text,confirmText:'Confirmar',danger,
    onConfirm:async()=>{
      let ok=false;
      if(action) ok=await action();
      else ok=await atualizarUsuarioAdmin(cpfAlvo,payload,descricao);
      if(ok!==false) closeAdminModal();
    }
  });
}
function bloquearUsuario(cpfAlvo){
  confirmarAcaoUsuario({cpfAlvo,title:'Bloquear usuário',text:`Confirmar bloqueio do CPF <b>${cpfAlvo}</b>?`,payload:{ativo:false},descricao:`Bloqueado usuário ${cpfAlvo}`,danger:true});
}
function desbloquearUsuario(cpfAlvo){
  confirmarAcaoUsuario({cpfAlvo,title:'Desbloquear usuário',text:`Confirmar desbloqueio do CPF <b>${cpfAlvo}</b>?`,payload:{ativo:true},descricao:`Desbloqueado usuário ${cpfAlvo}`});
}
function forcarTrocaSenha(cpfAlvo){
  if(PORTAL_RUNTIME_CONFIG.authMode==='secure'){
    toastAdmin('Use Authentication → Users para enviar recuperação ou redefinir a senha.','err');
    return;
  }
  confirmarAcaoUsuario({cpfAlvo,title:'Forçar troca de senha',text:`O usuário <b>${cpfAlvo}</b> será obrigado a trocar a senha no próximo login.`,payload:{primeiro_acesso:true},descricao:`Forçada troca de senha para ${cpfAlvo}`});
}
function resetarSenhaUsuario(cpfAlvo){
  toastAdmin('Redefinição administrativa com senha padrão foi desativada. Use o fluxo seguro do Supabase Auth.','err');
}
async function salvarConfigPortalComAuditoria(chave,novo,descricao){
  await salvarConfigPortal(chave,novo,descricao);
  await carregarParametrosPortal();
  render();
  toastAdmin('Configuração salva e dashboard recalculado.');
  renderMasterAdmin();
}
function salvarParametroModal(chave,titulo,descricao){
  const input=document.getElementById('cfg_'+chave);
  const novo=input?.value?.trim();
  if(novo===''||novo===undefined){toastAdmin('Informe um valor válido.','err');return;}
  openAdminModal({
    title:`Salvar configuração`,
    text:`Parâmetro: <b>${titulo}</b><br>Valor atual: <b>${cfgNum(chave)}</b><br>Novo valor: <b>${novo}</b>`,
    confirmText:'Salvar e recalcular',
    onConfirm:async()=>{
      try{
        await salvarConfigPortalComAuditoria(chave,novo,descricao);
        closeAdminModal();
      }catch(e){
        setAdminModalMsg('Erro ao salvar: '+(e.message||e),true);
      }
    }
  });
}

function adminTabsHtml(){
  const tabs=[['usuarios','Usuários'],['senhas','Senhas'],['config','Configurações'],['periodos','Períodos de Comissão'],['ausencias','Férias / Ausências'],['mudancas_loja','Mudança de Loja — Vendedores'],['fechamento','Fechamento de Competência'],['historico','Histórico de Competências'],['relatorios','Relatórios RH/DP'],['metricas','Métrica Analista'],['auditoria','Auditoria'],['futuro','Futuras Funcionalidades']];
  return `<div class="masterSide">${tabs.map(t=>`<button class="${MASTER_TAB===t[0]?'active':''}" onclick="setMasterTab('${t[0]}')">${t[1]}</button>`).join('')}</div>`;
}
function filtroUsuarios(list){
  const q=MASTER_SEARCH;
  if(!q) return list;
  return list.filter(u=>`${u.nome||''} ${u.cpf||''} ${u.loja||''} ${u.perfil||''} ${u.status||''}`.toUpperCase().includes(q));
}
function parametroCard(chave,titulo,descricao,tipo='number'){
  const val=cfgNum(chave);
  return `<div class="roadCard">
    <div class="k">${titulo}</div>
    <input id="cfg_${chave}" type="${tipo}" step="0.01" value="${String(val).replace('.',',')}">
    <p class="note">${descricao}</p>
    <button class="adminActionBtn good" onclick="salvarParametroModal('${chave}','${titulo.replaceAll("'","")}','${descricao.replaceAll("'","")}')">Salvar</button>
  </div>`;
}


function countFinancedItemsForMetric(items=[]){
  return (items||[]).filter(it=>it&&it.financiado).length;
}
function renderAnalystMetricAuditHtml(){
  const stores=visibleStores();
  const rows=[];
  stores.forEach(store=>{
    const sellers=DATA.auth.filter(a=>a.tipo==='VENDEDOR'&&sellerRelevantToStore(a,store)&&allowedSellerForStore(a,store)).map(a=>({a,m:calcSeller(a,store)})).filter(x=>x.m.vendidas>0);
    const novos=sellers.filter(x=>statusHas(x.a,'NOVOS'));
    const semis=sellers.filter(x=>statusHas(x.a,'SEMINOVOS'));
    const analystBlocks=analystCommissionRowsForStore(store,novos,semis);
    combineAnalystRowsForDisplay(analystBlocks).forEach(ar=>{
      const finLista=countFinancedItemsForMetric(ar.m.items||[]);
      rows.push({loja:store,nome:ar.nome,transferencia:ar.transferencia,finCard:ar.m.financiadas||0,finLista,diff:finLista-(ar.m.financiadas||0),periodo:ar.periodoTransferencia||'',obs:ar.observacao||''});
    });
  });
  const diverg=rows.filter(r=>r.diff!==0);
  const trs=rows.map(r=>`<tr>
    <td><b>${r.loja}</b></td>
    <td>${r.nome}${r.transferencia?`<br><span class="ausenciaTransferBadge">FÉRIAS/AUSÊNCIA - período ${r.periodo}</span>`:''}</td>
    <td>${r.diff===0?'<span class="periodoAtivoBadge">OK</span>':'<span class="periodoInativoBadge">DIVERGENTE</span>'}</td>
    <td>${r.finCard}</td>
    <td>${r.finLista}</td>
    <td>${r.diff}</td>
    <td>${r.obs||'-'}</td>
  </tr>`).join('');
  return `<h2>Auditoria da Métrica do Analista</h2>
    <p class="note">Compara o FIN exibido no card do Analista com a quantidade de chassis FINANCIADOS nos detalhes, incluindo regras de Férias/Ausências.</p>
    <div class="cards"><div class="card"><div class="k">Linhas analisadas</div><div class="v">${rows.length}</div></div><div class="card"><div class="k">OK</div><div class="v">${rows.length-diverg.length}</div></div><div class="card"><div class="k">Divergências</div><div class="v">${diverg.length}</div></div></div>
    <div class="tableWrap"><table class="adminTable"><thead><tr><th>Loja</th><th>Analista</th><th>Status</th><th>FIN no Card</th><th>FIN na Lista</th><th>Diferença</th><th>Observação</th></tr></thead><tbody>${trs||'<tr><td colspan="7">Nenhum dado no período.</td></tr>'}</tbody></table></div>`;
}



function calcularResumoExecutivoFechamento(){
  const rows=[];
  visibleStores().forEach(st=>{
    DATA.auth
      .filter(a=>a.tipo==='VENDEDOR'&&a.loja===st&&allowedSeller(a))
      .forEach(a=>{
        const m=calcSeller(a);
        if(m.vendidas>0||m.financiadas>0||m.retorno>0||m.spf>0) rows.push({a,m});
      });
  });
  const t=sumRows(rows);
  return {
    vendidas:t.vendidas||0,
    financiadas:t.financiadas||0,
    producao:t.producao||0,
    retorno:t.retorno||0,
    spf:t.spf||0
  };
}
function contarPerfisSnapshot(linhas){
  return (linhas||[]).reduce((a,l)=>{
    const p=String(l.perfil||'').toUpperCase();
    if(p==='VENDEDOR') a.vendedores++;
    else if(p==='GERENTE') a.gerentes++;
    else if(p==='ANALISTA') a.analistas++;
    else if(p.includes('GESTOR')) a.gestor++;
    return a;
  },{vendedores:0,gerentes:0,analistas:0,gestor:0});
}

function calcularPreviewFechamentoCompetencia(){
  const linhas=[];
  let vendidas=0, financiadas=0, comissaoPrevista=0, retorno=0, spf=0, producao=0;
  visibleStores().forEach(store=>{
    const sellers=DATA.auth.filter(a=>a.tipo==='VENDEDOR'&&sellerRelevantToStore(a,store)&&allowedSellerForStore(a,store)).map(a=>({a,m:calcSeller(a,store)})).filter(x=>x.m.vendidas>0||x.m.financiadas>0||x.m.retorno>0||x.m.spf>0);
    const novos=sellers.filter(x=>statusHas(x.a,'NOVOS'));
    const semis=sellers.filter(x=>statusHas(x.a,'SEMINOVOS'));
    sellers.forEach(x=>{const c=commissionCalc(x.a.status,x.m,'seller');linhas.push({perfil:'VENDEDOR',loja:store,nome:x.a.nome,status:x.a.status,m:x.m,c,comissao:c.comissaoTotal});});
    if(novos.length){const gerente=DATA.auth.find(a=>a.tipo==='GERENTE'&&a.loja===store&&statusHas(a,'NOVOS'));const m=sumRows(novos);const c=commissionCalc('GERENTE NOVOS',m,'manager');linhas.push({perfil:'GERENTE',loja:store,nome:gerente?gerente.nome:'GERENTE NOVOS NÃO LOCALIZADO',status:'GERENTE NOVOS',m,c,comissao:c.comissaoPrincipal});}
    if(semis.length){const gerente=DATA.auth.find(a=>a.tipo==='GERENTE'&&a.loja===store&&statusHas(a,'SEMINOVOS'));const m=sumRows(semis);const c=commissionCalc('GERENTE SEMINOVOS',m,'manager');linhas.push({perfil:'GERENTE',loja:store,nome:gerente?gerente.nome:'GERENTE SEMINOVOS NÃO LOCALIZADO',status:'GERENTE SEMINOVOS',m,c,comissao:c.comissaoPrincipal});}
    const analystBlocks=analystCommissionRowsForStore(store,novos,semis);
    combineAnalystRowsForDisplay(analystBlocks).forEach(ar=>{
      const c=ar.c||commissionCalc('ANALISTA',ar.m,'analyst');
      linhas.push({
        perfil:'ANALISTA',
        loja:store,
        nome:ar.nome,
        status:ar.transferencia?'ANALISTA COBERTURA':'ANALISTA',
        departamento:'NOVOS/SEMINOVOS',
        m:ar.m,
        c,
        comissao:c.comissaoTotal,
        obs:[
          ar.observacao||'',
          'Share consolidado de NOVOS + SEMINOVOS',
          ar.departamentos?.length?`Departamentos: ${ar.departamentos.join(' + ')}`:''
        ].filter(Boolean).join(' · ')
      });
    });
  });
  linhas.forEach(l=>{vendidas+=+(l.m.vendidas||0);financiadas+=+(l.m.financiadas||0);producao+=+(l.m.producao||0);retorno+=+(l.m.retorno||0);spf+=+(l.m.spf||0);comissaoPrevista+=+(l.comissao||0);});
  if(!linhas.some(l=>String(l.perfil||'').toUpperCase().includes('GESTOR'))){
    const g=calcGestorFIGrupo();
    const gestorName=(DATA.master&&DATA.master[0]?.nome)||'GESTOR DE F&I';
    const gestorCpf=(DATA.master&&DATA.master[0]?.cpf)||'';
    linhas.push({perfil:'GESTOR F&I',loja:'GRUPO',nome:gestorName,cpf:gestorCpf,status:'GESTOR F&I',m:{vendidas:g.vendidas||0,financiadas:g.financiadas||0,producao:g.producao||0,retorno:g.retorno||0,spf:g.spf||0,spfQty:g.spfQty||0,items:[]},c:{share:g.share||0,spfLiquido:g.spfLiquido||0,rentTotal:g.base||0,faixa:g.faixa||0,comissaoPrincipal:g.comissaoPrincipal||0,comissaoSpf:g.bonusSpf||0,comissaoTotal:g.comissaoFinal||0},comissao:g.comissaoFinal||0,obs:'Comissão Gestor F&I'});}
  comissaoPrevista=linhas.reduce((t,l)=>t+(+l.comissao||0),0);
  return {linhas,vendidas,financiadas,producao,retorno,spf,comissaoPrevista};
}
function renderFechamentoCompetenciaPreview(){
  const preview=calcularPreviewFechamentoCompetencia();
  const executivo=calcularResumoExecutivoFechamento();
  const contagem=contarPerfisSnapshot(preview.linhas);
  const periodo=periodoComissaoLabelAtual();
  const periodoStatus=PERIODO_SELECIONADO?.status||'EM CONFERÊNCIA';
  const periodoNome=PERIODO_SELECIONADO?.nome_periodo||'Datas manuais';
  const fechamento=fechamentoAtual();

  const rows=preview.linhas.slice(0,40).map(l=>`
    <tr><td><b>${l.loja}</b></td><td>${l.perfil}</td><td>${l.nome}</td><td>${l.status}</td><td>${l.m.vendidas||0}</td><td>${l.m.financiadas||0}</td><td>${fmtMoney(l.m.retorno||0)}</td><td>${fmtMoney(l.c.spfLiquido||0)}</td><td>${fmtMoney(l.c.rentTotal||0)}</td><td><b>${fmtMoney(l.comissao||0)}</b></td></tr>`).join('');

  const hist=(FECHAMENTOS_COMISSAO||[]).slice(0,20).map(f=>`
    <tr><td>${f.nome_periodo||''}</td><td>${dataBR(f.data_inicio||'')} a ${dataBR(f.data_fim||'')}</td><td>${f.status||''}</td><td>${f.fechado_por_nome||f.fechado_por||''}</td><td>${fmtMoney(f.comissao_total||fechamentoMetricFromObs(f,'comissao_total')||0)}</td><td class="adminActions"><button class="adminActionBtn wine" onclick="visualizarSnapshot('${f.id}')">Visualizar Snapshot</button>${String(f.status||'').toUpperCase()==='FECHADO'?`<button class="adminActionBtn warn" onclick="reabrirCompetencia('${f.id}')">Reabrir</button>`:''}</td></tr>`).join('');

  const snapRows=(SNAPSHOT_VIEW||[]).slice(0,60).map(r=>{
    let d=r.dados||r; if(typeof d==='string'){try{d=JSON.parse(d)}catch(e){d=r}}
    return `<tr><td>${d.loja||r.loja||''}</td><td>${d.perfil||r.perfil||''}</td><td>${d.nome||r.nome||''}</td><td>${d.status||r.status||''}</td><td>${d.vendidas||r.vendidas||0}</td><td>${d.financiadas||r.financiadas||0}</td><td>${fmtMoney(d.comissao_total||r.comissao_total||0)}</td></tr>`;
  }).join('');

  return `<h2>Fechamento de Competência</h2>
    <p class="note">Fechamento oficial com gravação de snapshot no Supabase.</p>
    <div class="fechamentoPreviewBox">
      <h3>${periodoNome}</h3><p class="note">${periodo}</p>
      ${fechamento?'<span class="fechadoBadge">FECHADO</span>':`<span class="abertoBadge">${periodoStatus}</span>`}
      <div class="fechamentoSectionTitle">Resumo Executivo do Período</div>
      <div class="fechamentoSectionNote">Indicadores operacionais reais, equivalentes aos cards do Dashboard.</div>
      <div class="fechamentoPreviewGrid">
        <div class="fechamentoPreviewCard"><div class="k">Vendidas</div><div class="v">${executivo.vendidas}</div></div>
        <div class="fechamentoPreviewCard"><div class="k">Financiadas</div><div class="v">${executivo.financiadas}</div></div>
        <div class="fechamentoPreviewCard"><div class="k">Produção</div><div class="v">${fmtMoney(executivo.producao)}</div></div>
        <div class="fechamentoPreviewCard"><div class="k">Retorno</div><div class="v">${fmtMoney(executivo.retorno)}</div></div>
        <div class="fechamentoPreviewCard"><div class="k">SPF Extra</div><div class="v">${fmtMoney(executivo.spf)}</div></div>
        <div class="fechamentoPreviewCard"><div class="k">Período</div><div class="v" style="font-size:15px">${periodo}</div></div>
      </div>
      <div class="fechamentoSectionTitle">Resumo do Snapshot</div>
      <div class="fechamentoPreviewGrid">
        <div class="fechamentoPreviewCard"><div class="k">Linhas Snapshot</div><div class="v">${preview.linhas.length}</div></div>
        <div class="fechamentoPreviewCard"><div class="k">Vendedores</div><div class="v">${contagem.vendedores}</div></div>
        <div class="fechamentoPreviewCard"><div class="k">Gerentes</div><div class="v">${contagem.gerentes}</div></div>
        <div class="fechamentoPreviewCard"><div class="k">Analistas</div><div class="v">${contagem.analistas}</div></div>
        <div class="fechamentoPreviewCard"><div class="k">Gestor F&I</div><div class="v">${contagem.gestor}</div></div>
        <div class="fechamentoPreviewCard"><div class="k">Comissão Total Prevista</div><div class="v">${fmtMoney(preview.comissaoPrevista)}</div></div>
      </div>
      <div class="fechamentoActionBox">
        ${fechamento?`<button disabled>Competência já fechada</button><button class="secondary" onclick="reabrirCompetencia('${fechamento.id}')">Reabrir Competência</button>`:`<button onclick="fecharCompetencia()">Fechar Competência</button>`}
      </div>
      <div class="fechamentoWarning"><b>Atenção:</b> ao fechar, o Portal grava uma foto das linhas de comissão em snapshot_comissoes.</div>
    </div>
    <h3 style="margin-top:24px">Prévia das linhas do snapshot</h3>
    <div class="tableWrap"><table class="adminTable"><thead><tr><th>Loja</th><th>Perfil</th><th>Nome</th><th>Status</th><th>Vend.</th><th>Fin.</th><th>Retorno</th><th>70% SPF</th><th>Rentab.</th><th>Comissão</th></tr></thead><tbody>${rows||'<tr><td colspan="10">Nenhuma linha prevista para o período.</td></tr>'}</tbody></table></div>
    ${preview.linhas.length>40?`<p class="note">Exibindo as primeiras 40 linhas de ${preview.linhas.length} previstas.</p>`:''}
    <h3 style="margin-top:24px">Histórico de Fechamentos</h3>
    <div class="tableWrap"><table class="adminTable"><thead><tr><th>Competência</th><th>Período</th><th>Status</th><th>Fechado por</th><th>Comissão Total</th><th>Ações</th></tr></thead><tbody>${hist||'<tr><td colspan="6">Nenhum fechamento encontrado.</td></tr>'}</tbody></table></div>
    ${(SNAPSHOT_VIEW||[]).length?`<div class="snapshotBox"><h3>Snapshot Visualizado</h3><div class="tableWrap"><table class="adminTable"><thead><tr><th>Loja</th><th>Perfil</th><th>Nome</th><th>Status</th><th>Vend.</th><th>Fin.</th><th>Comissão</th></tr></thead><tbody>${snapRows}</tbody></table></div>${SNAPSHOT_VIEW.length>60?`<p class="note">Exibindo 60 de ${SNAPSHOT_VIEW.length} linhas.</p>`:''}</div>`:''}`;
}

function parseMaybeJson(v){
  if(!v) return {};
  if(typeof v==='object') return v;
  if(typeof v==='string'){try{return JSON.parse(v)}catch(e){return {}}}
  return {};
}
function pickSnap(r,d,key,alts=[]){
  const keys=[key,...alts];
  for(const k of keys){
    if(r && r[k]!==undefined && r[k]!==null && r[k]!=='' && Number(r[k])!==0) return r[k];
  }
  for(const k of keys){
    if(d && d[k]!==undefined && d[k]!==null && d[k]!=='') return d[k];
  }
  for(const k of keys){
    if(r && r[k]!==undefined && r[k]!==null && r[k]!=='') return r[k];
  }
  return 0;
}
function snapshotNormalizedRow(r){
  const d=parseMaybeJson(r.dados)||parseMaybeJson(r.observacao)||{};
  return {
    loja:pickSnap(r,d,'loja')||'',
    perfil:pickSnap(r,d,'perfil')||'',
    nome:pickSnap(r,d,'nome')||'',
    status:pickSnap(r,d,'status')||'',
    vendidas:+pickSnap(r,d,'vendidas'),
    financiadas:+pickSnap(r,d,'financiadas'),
    share:+pickSnap(r,d,'share'),
    producao:+pickSnap(r,d,'producao'),
    retorno:+pickSnap(r,d,'retorno'),
    spf_extra:+pickSnap(r,d,'spf_extra',['spf']),
    spf_liquido:+pickSnap(r,d,'spf_liquido'),
    rentabilidade_total:+pickSnap(r,d,'rentabilidade_total',['rentTotal']),
    faixa:+pickSnap(r,d,'faixa'),
    comissao_principal:+pickSnap(r,d,'comissao_principal'),
    comissao_spf:+pickSnap(r,d,'comissao_spf'),
    comissao_total:+pickSnap(r,d,'comissao_total',['comissao']),
    observacao:pickSnap(r,d,'observacao')||''
  };
}
function fechamentoMetric(f,key){
  const o=parseMaybeJson(f.observacao);
  return +(f[key]||o[key]||0);
}
async function getSnapshotFechamento(fechamentoId){
  const {data,error}=await supabaseClient.rpc('master_commission_snapshot',{p_closing_id:fechamentoId});
  if(error){toastAdmin('Erro ao carregar snapshot: '+error.message,'err'); return []}
  return (Array.isArray(data?.rows)?data.rows:[]).map(snapshotNormalizedRow);
}
function aggregateSnapshot(rows=[]){
  return rows.reduce((a,r)=>{
    a.vendidas+=+(r.vendidas||0);a.financiadas+=+(r.financiadas||0);a.producao+=+(r.producao||0);a.retorno+=+(r.retorno||0);a.spf_extra+=+(r.spf_extra||0);a.comissao_total+=+(r.comissao_total||0);
    const p=String(r.perfil||'').toUpperCase();
    if(p==='VENDEDOR') a.vendedores++; else if(p==='GERENTE') a.gerentes++; else if(p==='ANALISTA') a.analistas++; else if(p.includes('GESTOR')) a.gestor++;
    return a;
  },{vendidas:0,financiadas:0,producao:0,retorno:0,spf_extra:0,comissao_total:0,vendedores:0,gerentes:0,analistas:0,gestor:0});
}
function historicoOptions(){
  return (FECHAMENTOS_COMISSAO||[]).filter(f=>String(f.status||'').toUpperCase()==='FECHADO'||f.ativo!==false).map(f=>`<option value="${f.id}">${f.nome_periodo||'Competência'} · ${dataBR(f.data_inicio||'')} a ${dataBR(f.data_fim||'')} · ${f.status||''}</option>`).join('');
}
async function carregarHistoricoSnapshotSelecionado(id){
  SNAPSHOT_VIEW=await getSnapshotFechamento(id);
  renderMasterAdmin();
}
function renderSnapshotReportHtml(rows,title='Relatório RH/DP'){
  const agg=aggregateSnapshot(rows);
  const trs=rows.map(r=>`<tr><td>${r.loja}</td><td>${r.perfil}</td><td>${r.nome}</td><td>${r.status}</td><td>${r.vendidas}</td><td>${r.financiadas}</td><td>${fmtMoney(r.retorno)}</td><td>${fmtMoney(r.spf_liquido)}</td><td>${fmtMoney(r.rentabilidade_total)}</td><td>${fmtPct2(r.faixa)}</td><td><b>${fmtMoney(r.comissao_total)}</b></td><td>${r.observacao||''}</td></tr>`).join('');
  return `<div class="rhReportPanel"><h2>${title}</h2><div class="readonlyBanner">Modo histórico somente leitura. Os valores abaixo vêm do snapshot congelado, sem recálculo.</div><div class="rhReportGrid"><div class="rhReportCard"><div class="k">Linhas</div><div class="v">${rows.length}</div></div><div class="rhReportCard"><div class="k">Vendidas</div><div class="v">${agg.vendidas}</div></div><div class="rhReportCard"><div class="k">Financiadas</div><div class="v">${agg.financiadas}</div></div><div class="rhReportCard"><div class="k">Comissão Total</div><div class="v">${fmtMoney(agg.comissao_total)}</div></div><div class="rhReportCard"><div class="k">Retorno</div><div class="v">${fmtMoney(agg.retorno)}</div></div><div class="rhReportCard"><div class="k">SPF Extra</div><div class="v">${fmtMoney(agg.spf_extra)}</div></div><div class="rhReportCard"><div class="k">Vendedores</div><div class="v">${agg.vendedores}</div></div><div class="rhReportCard"><div class="k">Analistas</div><div class="v">${agg.analistas}</div></div></div><div class="tableWrap"><table class="adminTable"><thead><tr><th>Loja</th><th>Perfil</th><th>Nome</th><th>Status</th><th>Vend.</th><th>Fin.</th><th>Retorno</th><th>70% SPF</th><th>Rentab.</th><th>Faixa</th><th>Comissão</th><th>Obs.</th></tr></thead><tbody>${trs||'<tr><td colspan="12">Nenhum snapshot carregado.</td></tr>'}</tbody></table></div></div>`;
}

function authByName(nome){
  const key=norm(nome||'');
  return DATA.auth.find(a=>norm(a.nome||'')===key)||DATA.master.find(a=>norm(a.nome||'')===key)||null;
}
function excelDateBR(iso){return iso?dataBR(String(iso).slice(0,10)):''}
function addGestorToRowsIfMissing(rows){
  const hasGestor=(rows||[]).some(r=>String(r.perfil||'').toUpperCase().includes('GESTOR'));
  if(hasGestor) return rows;
  const g=calcGestorFIGrupo();
  const gestorName=(DATA.master&&DATA.master[0]?.nome)||'GESTOR DE F&I';
  const gestorCpf=(DATA.master&&DATA.master[0]?.cpf)||'';
  return [...(rows||[]),{
    loja:'GRUPO',
    perfil:'GESTOR F&I',
    nome:gestorName,
    cpf:gestorCpf,
    status:'GESTOR F&I',
    vendidas:g.vendidas||0,
    financiadas:g.financiadas||0,
    share:(g.share||0)/100,
    producao:g.producao||0,
    retorno:g.retorno||0,
    spf_extra:g.spf||0,
    spf_liquido:g.spfLiquido||0,
    rentabilidade_total:g.base||0,
    faixa:g.faixa||0,
    comissao_principal:g.comissaoPrincipal||0,
    comissao_spf:g.bonusSpf||0,
    comissao_total:g.comissaoFinal||0,
    observacao:'Comissão Gestor F&I incluída no relatório RH/DP.'
  }];
}
function currentSellerRowsForReport(){
  const rows=[];
  const oldOverride=PERIOD_OVERRIDE;
  visibleStores().forEach(st=>{
    DATA.auth.filter(a=>a.tipo==='VENDEDOR'&&a.loja===st&&allowedSeller(a)).forEach(a=>{
      const m=calcSeller(a);
      if(m.vendidas>0||m.financiadas>0||m.items?.length){
        rows.push({a,m});
      }
    });
  });
  PERIOD_OVERRIDE=oldOverride;
  return rows;
}
function chassisRowsReport(financedOnly=false){
  const out=[];
  currentSellerRowsForReport().forEach(({a,m})=>{
    (m.items||[]).forEach(it=>{
      if(financedOnly && !it.financiado) return;
      out.push({
        Loja:a.loja||'',
        Vendedor:a.nome||'',
        CPF:a.cpf||'',
        Cargo:a.tipo||'VENDEDOR',
        Departamento:a.status||'',
        Chassi:it.chassi||'',
        Chassi_Completo:it.chassiCompleto||'',
        Status_Financiamento:it.financiado?'FINANCIADO':'NÃO FINANCIADO',
        Data:excelDateBR(it.date||''),
        Cliente:it.cliente||'',
        Producao_Total:+(it.producao||0),
        Retorno_Principal:+(it.retornoPrincipal||0),
        Retorno_Posterior:+(it.retornoPosterior||0),
        Retorno_Total:+(it.retorno||0),
        SPF_Extra:it.spf?'SIM':'NÃO',
        Valor_SPF_Extra:+(it.spfValor||0),
        Rentabilidade_Total:+(it.rentabTotal||0),
        Origem:it.origem||'',
        Servico:it.servico||''
      });
    });
  });
  return out;
}
function sheetFromAoAWithWidths(wb,name,aoa,widths){
  const ws=XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols']=(widths||[]).map(w=>({wch:w}));
  ws['!autofilter']={ref:XLSX.utils.encode_range({s:{r:0,c:0},e:{r:Math.max(0,aoa.length-1),c:Math.max(0,(aoa[0]||[]).length-1)}})};
  XLSX.utils.book_append_sheet(wb,ws,name.slice(0,31));
  return ws;
}
function sheetFromJsonWithWidths(wb,name,json,widths){
  const ws=XLSX.utils.json_to_sheet(json);
  ws['!cols']=(widths||Object.keys(json[0]||{}).map(()=>18)).map(w=>({wch:w}));
  if(json.length){ws['!autofilter']={ref:XLSX.utils.encode_range({s:{r:0,c:0},e:{r:json.length,c:Object.keys(json[0]).length-1}})}}
  XLSX.utils.book_append_sheet(wb,ws,name.slice(0,31));
  return ws;
}

function applyExcelFormats(ws, opts={}){
  if(!ws||!ws['!ref']) return;
  const range=XLSX.utils.decode_range(ws['!ref']);
  const currencyHeaders=['COMISSAO','RETORNO','SPF','RENTABILIDADE','PRODUCAO','VALOR','BASE','BONUS'];
  const percentHeaders=['SHARE','FAIXA'];
  const headers=[];
  for(let c=range.s.c;c<=range.e.c;c++){
    const cell=ws[XLSX.utils.encode_cell({r:0,c})];
    headers[c]=String(cell?.v||'').toUpperCase();
  }
  for(let r=1;r<=range.e.r;r++){
    for(let c=range.s.c;c<=range.e.c;c++){
      const addr=XLSX.utils.encode_cell({r,c});
      const cell=ws[addr];
      if(!cell) continue;
      const h=headers[c]||'';
      if(currencyHeaders.some(k=>h.includes(k)) && typeof cell.v==='number'){
        cell.t='n'; cell.z='"R$" #,##0.00';
      }
      if(percentHeaders.some(k=>h.includes(k)) && typeof cell.v==='number'){
        cell.t='n';
        if(cell.v>1) cell.v=cell.v/100;
        cell.z='0.00%';
      }
    }
  }
}

function getSelectedFechamentoForReport(){
  const id=document.getElementById('histFechamentoSel')?.value||document.getElementById('relFechamentoSel')?.value||'';
  return (FECHAMENTOS_COMISSAO||[]).find(f=>String(f.id)===String(id))||null;
}
function resumoExecutivoOficialExcel(rowsFull){
  const f=getSelectedFechamentoForReport();
  if(f){
    const o=parseMaybeJson(f.observacao);
    if(o && (o.qtd_vendida!==undefined || o.qtd_financiada!==undefined || o.producao_total!==undefined)){
      return {
        vendidas:+(o.qtd_vendida||0),
        financiadas:+(o.qtd_financiada||0),
        producao:+(o.producao_total||0),
        retorno:+(o.retorno_total||0),
        spf_extra:+(o.spf_total||0)
      };
    }
  }
  try{
    const e=calcularResumoExecutivoFechamento();
    if(e && (e.vendidas||e.financiadas||e.producao||e.retorno||e.spf)){
      return {vendidas:+e.vendidas||0,financiadas:+e.financiadas||0,producao:+e.producao||0,retorno:+e.retorno||0,spf_extra:+e.spf||0};
    }
  }catch(err){console.warn('Resumo executivo oficial não disponível:',err)}
  // Fallback seguro: somente vendedores, para não duplicar com gerentes/analistas.
  const sellers=(rowsFull||[]).filter(r=>String(r.perfil||'').toUpperCase()==='VENDEDOR');
  return sellers.reduce((a,r)=>{a.vendidas+=+r.vendidas||0;a.financiadas+=+r.financiadas||0;a.producao+=+r.producao||0;a.retorno+=+r.retorno||0;a.spf_extra+=+r.spf_extra||0;return a;},{vendidas:0,financiadas:0,producao:0,retorno:0,spf_extra:0});
}
function styleWorksheetSafra(ws, currencyHeaders=[], percentHeaders=[]){
  if(!ws||!ws['!ref']) return;
  const range=XLSX.utils.decode_range(ws['!ref']);
  const headerStyle={font:{bold:true,color:{rgb:'000000'}},fill:{fgColor:{rgb:'FFD200'},patternType:'solid'},alignment:{horizontal:'center',vertical:'center'},border:{top:{style:'thin',color:{rgb:'B7B7B7'}},bottom:{style:'thin',color:{rgb:'B7B7B7'}},left:{style:'thin',color:{rgb:'B7B7B7'}},right:{style:'thin',color:{rgb:'B7B7B7'}}}};
  const border={top:{style:'thin',color:{rgb:'D9D9D9'}},bottom:{style:'thin',color:{rgb:'D9D9D9'}},left:{style:'thin',color:{rgb:'D9D9D9'}},right:{style:'thin',color:{rgb:'D9D9D9'}}};
  const headers=[];
  for(let c=range.s.c;c<=range.e.c;c++){
    const addr=XLSX.utils.encode_cell({r:0,c});
    if(ws[addr]) ws[addr].s=headerStyle;
    headers[c]=String(ws[addr]?.v||'').toUpperCase();
  }
  for(let r=1;r<=range.e.r;r++){
    for(let c=range.s.c;c<=range.e.c;c++){
      const addr=XLSX.utils.encode_cell({r,c});
      const cell=ws[addr]; if(!cell) continue;
      cell.s=Object.assign({},cell.s||{},{border});
      const h=headers[c]||'';
      if(currencyHeaders.some(k=>h.includes(k)) && typeof cell.v==='number'){cell.t='n';cell.z='"R$" #,##0.00';}
      if(percentHeaders.some(k=>h.includes(k)) && typeof cell.v==='number'){cell.t='n'; if(cell.v>1) cell.v=cell.v/100; cell.z='0.00%';}
    }
  }
  ws['!autofilter']={ref:XLSX.utils.encode_range({s:{r:0,c:0},e:{r:Math.max(0,range.e.r),c:Math.max(0,range.e.c)}})};
  ws['!freeze']={xSplit:0,ySplit:1,topLeftCell:'A2',activePane:'bottomLeft',state:'frozen'};
}
function fitColsFromJson(json, min=10, max=42){
  const keys=Object.keys(json[0]||{});
  return keys.map(k=>({wch:Math.min(max,Math.max(min,k.length+2,...json.slice(0,200).map(r=>String(r[k]??'').length+2)))}));
}

function exportSnapshotExcel(rows,filename='Relatorio_Comissoes_RH_DP.xlsx'){
  if(!rows||!rows.length){alert('Nenhum snapshot carregado para exportar.');return}
  let normalized=rows.map(snapshotNormalizedRow);

  // Se o snapshot antigo estiver sem valores de comissão, usa a prévia atual como fallback controlado.
  if(normalized.length && normalized.every(r=>(+r.comissao_total||0)===0)){
    try{
      const preview=calcularPreviewFechamentoCompetencia();
      normalized=preview.linhas.map(l=>snapshotNormalizedRow({
        loja:l.loja,perfil:l.perfil,nome:l.nome,status:l.status,
        vendidas:l.m?.vendidas,financiadas:l.m?.financiadas,share:l.c?.share,
        producao:l.m?.producao,retorno:l.m?.retorno,spf_extra:l.m?.spf,spf_liquido:l.c?.spfLiquido,
        rentabilidade_total:l.c?.rentTotal,faixa:l.c?.faixa,comissao_principal:l.c?.comissaoPrincipal,
        comissao_spf:l.c?.comissaoSpf,comissao_total:l.comissao,observacao:l.obs||''
      }));
    }catch(e){console.warn('Fallback de relatório não aplicado:',e)}
  }

  const rowsFull=addGestorToRowsIfMissing(normalized);
  const resumoComissao=aggregateSnapshot(rowsFull);
  const resumoExec=resumoExecutivoOficialExcel(rowsFull);
  const wb=XLSX.utils.book_new();

  // ABA 1 - Principal / Resumo Executivo oficial
  const principal=[
    ['RELATÓRIO DE COMISSÕES RH/DP'],
    ['Grupo Brabus Mitsubishi'],
    ['Período',periodoComissaoLabelAtual()],
    ['Origem','Resumo Executivo oficial do Portal + Snapshot congelado para lançamento'],
    ['Gerado em',new Date().toLocaleString('pt-BR')],
    [],
    ['RESUMO EXECUTIVO OFICIAL'],
    ['Indicador','Valor'],
    ['Linhas de Comissão',rowsFull.length],
    ['Qtd Vendida',resumoExec.vendidas],
    ['Qtd Financiada',resumoExec.financiadas],
    ['Produção Total',resumoExec.producao],
    ['Retorno Total',resumoExec.retorno],
    ['SPF Extra',resumoExec.spf_extra],
    ['Comissão Total',resumoComissao.comissao_total],
    [],
    ['COMPOSIÇÃO DO SNAPSHOT'],
    ['Vendedores',resumoComissao.vendedores],
    ['Gerentes',resumoComissao.gerentes],
    ['Analistas',resumoComissao.analistas],
    ['Gestor F&I',rowsFull.filter(r=>String(r.perfil||'').toUpperCase().includes('GESTOR')).length]
  ];
  const wsPrincipal=sheetFromAoAWithWidths(wb,'1_RESUMO_PRINCIPAL',principal,[36,28,24,24]);
  ['A1','A7','A17'].forEach(a=>{if(wsPrincipal[a])wsPrincipal[a].s={font:{bold:true,color:{rgb:'000000'}},fill:{fgColor:{rgb:'FFD200'},patternType:'solid'}}});
  ['B12','B13','B14','B15'].forEach(addr=>{if(wsPrincipal[addr]){wsPrincipal[addr].t='n';wsPrincipal[addr].z='"R$" #,##0.00';}});
  wsPrincipal['!freeze']={xSplit:0,ySplit:8,topLeftCell:'A9',activePane:'bottomLeft',state:'frozen'};

  function linhaPadrao(r){
    const auth=authByName(r.nome)||{};
    return {
      Nome:r.nome||'',
      CPF:r.cpf||auth.cpf||'',
      Loja:r.loja||auth.loja||'',
      Departamento:r.status||auth.status||'',
      Vendas:+(r.vendidas||0),
      Financiamentos:+(r.financiadas||0),
      Share:+(r.share||0),
      Retorno:+(r.retorno||0),
      '70% SPF':+(r.spf_liquido||0),
      'Retorno + 70% SPF':+(r.rentabilidade_total||0),
      'Faixa de Comissão':+(r.faixa||0),
      Comissao_Total:+(r.comissao_total||0)
    };
  }

  // ABA 2 - Vendedores
  const vendedores=rowsFull
    .filter(r=>String(r.perfil||'').toUpperCase()==='VENDEDOR')
    .map(linhaPadrao)
    .sort((a,b)=>(a.Loja+a.Departamento+a.Nome).localeCompare(b.Loja+b.Departamento+b.Nome));
  const wsVend=XLSX.utils.json_to_sheet(vendedores);
  wsVend['!cols']=fitColsFromJson(vendedores,12,36);
  styleWorksheetSafra(wsVend,['RETORNO','SPF','COMISSAO'],['SHARE','FAIXA']);
  XLSX.utils.book_append_sheet(wb,wsVend,'2_VENDEDORES');

  // ABA 3 - Analistas + Gestor F&I
  const analistasGestor=rowsFull
    .filter(r=>{
      const p=String(r.perfil||'').toUpperCase();
      return p.includes('ANALISTA') || p.includes('GESTOR');
    })
    .map(r=>{
      const auth=authByName(r.nome)||{};
      const isGestor=String(r.perfil||'').toUpperCase().includes('GESTOR');
      const qtdSpf=isGestor ? 0 : Math.round((+(r.comissao_spf||0))/150);
      const valorUnitario=isGestor ? 0 : 150;
      return {
        Nome:r.nome||'',
        CPF:r.cpf||auth.cpf||'',
        Cargo:r.perfil||auth.tipo||'',
        Loja:r.loja||auth.loja||'',
        Departamento:r.status||auth.status||'',
        Vendas:+(r.vendidas||0),
        Financiamentos:+(r.financiadas||0),
        Share:+(r.share||0),
        Retorno:+(r.retorno||0),
        '70% SPF':+(r.spf_liquido||0),
        'Retorno + 70% SPF':+(r.rentabilidade_total||0),
        'Faixa de Comissão':+(r.faixa||0),
        'Quantidade de SPF':qtdSpf,
        'Valor Unitário SPF':valorUnitario,
        'Comissão SPF':+(r.comissao_spf||0),
        'Comissão Principal':+(r.comissao_principal||0),
        Comissao_Total:+(r.comissao_total||0)
      };
    })
    .sort((a,b)=>(a.Loja+a.Cargo+a.Nome).localeCompare(b.Loja+b.Cargo+b.Nome));
  const wsAnal=XLSX.utils.json_to_sheet(analistasGestor);
  wsAnal['!cols']=fitColsFromJson(analistasGestor,12,38);
  styleWorksheetSafra(wsAnal,['RETORNO','SPF','COMISSAO','VALOR'],['SHARE','FAIXA']);
  XLSX.utils.book_append_sheet(wb,wsAnal,'3_ANALISTAS_GESTOR');

  // ABA 4 - Gerentes
  const gerentes=rowsFull
    .filter(r=>String(r.perfil||'').toUpperCase()==='GERENTE')
    .map(linhaPadrao)
    .sort((a,b)=>(a.Loja+a.Departamento+a.Nome).localeCompare(b.Loja+b.Departamento+b.Nome));
  const wsGer=XLSX.utils.json_to_sheet(gerentes);
  wsGer['!cols']=fitColsFromJson(gerentes,12,36);
  styleWorksheetSafra(wsGer,['RETORNO','SPF','COMISSAO'],['SHARE','FAIXA']);
  XLSX.utils.book_append_sheet(wb,wsGer,'4_GERENTES');

  // ABA 5 - Chassis financiados
  const finRows=chassisRowsReport(true);
  const wsFin=XLSX.utils.json_to_sheet(finRows);
  wsFin['!cols']=fitColsFromJson(finRows,12,42);
  styleWorksheetSafra(wsFin,['PRODUCAO','RETORNO','SPF','RENTABILIDADE','VALOR'],[]);
  XLSX.utils.book_append_sheet(wb,wsFin,'5_CHASSIS_FINANCIADOS');

  // ABA 6 - Todos os chassis por vendedor
  const allRows=chassisRowsReport(false);
  const wsAll=XLSX.utils.json_to_sheet(allRows);
  wsAll['!cols']=fitColsFromJson(allRows,12,42);
  styleWorksheetSafra(wsAll,['PRODUCAO','RETORNO','SPF','RENTABILIDADE','VALOR'],[]);
  XLSX.utils.book_append_sheet(wb,wsAll,'6_TODOS_CHASSIS_VENDEDOR');

  // ABA 7 - Auditoria SPF
  const spfAudit=[];
  currentSellerRowsForReport().forEach(({a,m})=>{
    (m.spfAudit||[]).forEach(s=>spfAudit.push({
      Loja:a.loja||s.loja||'',
      Vendedor:a.nome||s.vendedor||'',
      CPF:a.cpf||'',
      Departamento:a.status||'',
      Cliente:s.cliente||'',
      CPF_Cliente:s.cpf||'',
      Chassi:s.chassi||'',
      Data:excelDateBR(s.date||''),
      Opcional:s.opcionalNome||'',
      Valor_SPF_Extra:+(s.spfConsiderado||s.opcionalValor||0),
      Motivo:s.motivo||''
    }));
  });
  const wsSpf=XLSX.utils.json_to_sheet(spfAudit);
  wsSpf['!cols']=fitColsFromJson(spfAudit,12,60);
  styleWorksheetSafra(wsSpf,['VALOR','SPF'],[]);
  XLSX.utils.book_append_sheet(wb,wsSpf,'7_AUDITORIA_SPF');

  // ABA 8 - Memória de cálculo
  const memoria=rowsFull.map(r=>({
    Loja:r.loja||'',Perfil:r.perfil||'',Nome:r.nome||'',Status:r.status||'',
    Vendidas:+(r.vendidas||0),Financiadas:+(r.financiadas||0),Share:+(r.share||0),
    Producao:+(r.producao||0),Retorno:+(r.retorno||0),SPF_Extra:+(r.spf_extra||0),SPF_Liquido:+(r.spf_liquido||0),
    Rentabilidade_Total:+(r.rentabilidade_total||0),Faixa:+(r.faixa||0),Comissao_Principal:+(r.comissao_principal||0),
    Comissao_SPF:+(r.comissao_spf||0),Comissao_Total:+(r.comissao_total||0),Observacao:r.observacao||''
  }));
  const wsMem=XLSX.utils.json_to_sheet(memoria);
  wsMem['!cols']=fitColsFromJson(memoria,10,42);
  styleWorksheetSafra(wsMem,['PRODUCAO','RETORNO','SPF','RENTABILIDADE','COMISSAO'],['SHARE','FAIXA']);
  XLSX.utils.book_append_sheet(wb,wsMem,'8_MEMORIA_DE_CALCULO');

  XLSX.writeFile(wb,filename.replace('.xlsx','')+'_RH_DP_COMPLETO.xlsx');
}
function imprimirSnapshotPDF(rows,title='Relatório de Comissões RH/DP'){
  if(!rows||!rows.length){alert('Nenhum snapshot carregado para imprimir.');return}
  const agg=aggregateSnapshot(rows);
  const rowsHtml=rows.map(r=>`<tr><td>${r.loja}</td><td>${r.perfil}</td><td>${r.nome}</td><td>${r.status}</td><td>${r.vendidas}</td><td>${r.financiadas}</td><td>${fmtMoney(r.rentabilidade_total)}</td><td>${fmtMoney(r.comissao_total)}</td></tr>`).join('');
  const w=window.open('','_blank');
  const html='<!DOCTYPE html><html><head><meta charset="UTF-8"><title>'+title+'</title>'+
    '<style>body{font-family:Arial;margin:24px;color:#111}h1{margin-bottom:4px}.muted{color:#666}.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:18px 0}.card{border:1px solid #ddd;border-radius:10px;padding:10px}.k{font-size:11px;color:#666;text-transform:uppercase}.v{font-size:20px;font-weight:700}table{width:100%;border-collapse:collapse;font-size:11px}th{background:#7b111b;color:#fff}th,td{border:1px solid #ddd;padding:6px;text-align:left}@media print{button{display:none}}</style>'+
    '</head><body><button onclick="window.print()">Imprimir / salvar PDF</button><h1>'+title+'</h1><div class="muted">Valores originados do snapshot congelado. Sem recálculo.</div>'+
    '<div class="cards"><div class="card"><div class="k">Linhas</div><div class="v">'+rows.length+'</div></div><div class="card"><div class="k">Vendidas</div><div class="v">'+agg.vendidas+'</div></div><div class="card"><div class="k">Financiadas</div><div class="v">'+agg.financiadas+'</div></div><div class="card"><div class="k">Comissão</div><div class="v">'+fmtMoney(agg.comissao_total)+'</div></div></div>'+
    '<table><thead><tr><th>Loja</th><th>Perfil</th><th>Nome</th><th>Status</th><th>Vend.</th><th>Fin.</th><th>Rentab.</th><th>Comissão</th></tr></thead><tbody>'+rowsHtml+'</tbody></table></body></html>';
  w.document.write(html);
  w.document.close();
}
async function exportarRelatorioHistoricoSelecionado(){
  const id=document.getElementById('histFechamentoSel')?.value||document.getElementById('relFechamentoSel')?.value;
  if(!id){alert('Selecione uma competência.');return}
  const rows=await getSnapshotFechamento(id);
  exportSnapshotExcel(rows,'Relatorio_Comissoes_RH_DP_'+id+'.xlsx');
}
async function imprimirRelatorioHistoricoSelecionado(){
  const id=document.getElementById('histFechamentoSel')?.value||document.getElementById('relFechamentoSel')?.value;
  if(!id){alert('Selecione uma competência.');return}
  const rows=await getSnapshotFechamento(id);
  imprimirSnapshotPDF(rows);
}
async function compararCompetenciasHistorico(){
  const a=document.getElementById('cmpA')?.value,b=document.getElementById('cmpB')?.value;
  if(!a||!b){toastAdmin('Selecione duas competências para comparar.','err');return}
  const ra=await getSnapshotFechamento(a), rb=await getSnapshotFechamento(b);
  const aa=aggregateSnapshot(ra), ab=aggregateSnapshot(rb);
  SNAPSHOT_VIEW=[{loja:'COMPARATIVO',perfil:'A',nome:'Competência A',vendidas:aa.vendidas,financiadas:aa.financiadas,retorno:aa.retorno,spf_extra:aa.spf_extra,comissao_total:aa.comissao_total},{loja:'COMPARATIVO',perfil:'B',nome:'Competência B',vendidas:ab.vendidas,financiadas:ab.financiadas,retorno:ab.retorno,spf_extra:ab.spf_extra,comissao_total:ab.comissao_total},{loja:'DIFERENÇA',perfil:'B-A',nome:'Variação',vendidas:ab.vendidas-aa.vendidas,financiadas:ab.financiadas-aa.financiadas,retorno:ab.retorno-aa.retorno,spf_extra:ab.spf_extra-aa.spf_extra,comissao_total:ab.comissao_total-aa.comissao_total}];
  renderMasterAdmin();
}
function renderHistoricoCompetenciasHtml(){
  const opts=historicoOptions();
  const rows=(FECHAMENTOS_COMISSAO||[]).map(f=>`<tr><td><b>${f.nome_periodo||''}</b></td><td>${dataBR(f.data_inicio||'')} a ${dataBR(f.data_fim||'')}</td><td>${f.status||''}</td><td>${f.fechado_por||''}</td><td>${fmtMoney(fechamentoMetric(f,'comissao_total'))}</td><td class="adminActions"><button class="adminActionBtn wine" onclick="carregarHistoricoSnapshotSelecionado('${f.id}')">Abrir</button><button class="adminActionBtn good" onclick="(async()=>{const r=await getSnapshotFechamento('${f.id}');exportSnapshotExcel(r,'Relatorio_Comissoes_${f.id}.xlsx')})()">Excel</button><button class="adminActionBtn warn" onclick="(async()=>{const r=await getSnapshotFechamento('${f.id}');imprimirSnapshotPDF(r,'Relatório ${f.nome_periodo||''}')})()">PDF</button></td></tr>`).join('');
  return `<h2>Histórico de Competências</h2><p class="note">Consulte competências fechadas usando exclusivamente os snapshots congelados.</p><div class="readonlyBanner">Modo histórico: somente leitura e sem recálculo.</div><div class="reportActions"><select id="histFechamentoSel">${opts}</select><button onclick="carregarHistoricoSnapshotSelecionado(document.getElementById('histFechamentoSel').value)">Abrir competência</button><button onclick="exportarRelatorioHistoricoSelecionado()">Exportar Excel Completo RH/DP Completo</button><button onclick="imprimirRelatorioHistoricoSelecionado()">PDF / Imprimir</button></div><h3>Comparar competências</h3><div class="reportActions"><select id="cmpA">${opts}</select><select id="cmpB">${opts}</select><button onclick="compararCompetenciasHistorico()">Comparar</button></div><div class="tableWrap"><table class="adminTable"><thead><tr><th>Competência</th><th>Período</th><th>Status</th><th>Fechado por</th><th>Comissão Total</th><th>Ações</th></tr></thead><tbody>${rows||'<tr><td colspan="6">Nenhum fechamento encontrado.</td></tr>'}</tbody></table></div>${(SNAPSHOT_VIEW||[]).length?renderSnapshotReportHtml(SNAPSHOT_VIEW,'Snapshot / Relatório carregado'):''}`;
}
function renderRelatoriosRhDpHtml(){
  const opts=historicoOptions();
  return `<h2>Relatórios RH/DP</h2><p class="note">Relatórios para lançamento de comissões em folha. Todos os números vêm do snapshot congelado.</p><div class="readonlyBanner">Uso principal: DP/RH. Exportação sem recálculo e com memória do fechamento.</div><div class="reportActions"><select id="relFechamentoSel">${opts}</select><button onclick="carregarHistoricoSnapshotSelecionado(document.getElementById('relFechamentoSel').value)">Carregar</button><button onclick="exportarRelatorioHistoricoSelecionado()">Exportar Excel Completo</button><button onclick="imprimirRelatorioHistoricoSelecionado()">PDF / Imprimir</button></div>${(SNAPSHOT_VIEW||[]).length?renderSnapshotReportHtml(SNAPSHOT_VIEW,'Relatório RH/DP carregado'):'<div class="empty">Selecione uma competência fechada para gerar o relatório.</div>'}`;
}
async function showHistoricoRelatoriosRH(){
  await carregarFechamentosComissao();
  const view=document.getElementById('commissionRulesView');
  const hub=document.getElementById('commissionRulesHub');
  if(hub) hub.classList.add('hidden');
  ['kpis','content','audit','masterAdmin'].forEach(id=>document.getElementById(id)?.classList.add('hidden'));
  view.classList.remove('hidden');
  view.innerHTML=`<button class="backBtn" onclick="hideCommissionRules()">← Voltar</button>${renderRelatoriosRhDpHtml()}`;
}

let MASTER_RENDER_SEQUENCE=0;
async function renderMasterAdmin(){
  const sequence=++MASTER_RENDER_SEQUENCE;
  const box=document.getElementById('masterAdmin');
  try{
    await portalPromiseTimeout(renderMasterAdminContent(sequence),'Carregamento do Painel Master',12000);
  }catch(error){
    if(sequence!==MASTER_RENDER_SEQUENCE||!box) return;
    const detail=String(error?.message||'Falha não identificada.').slice(0,240);
    console.error('Falha no Painel Master:',error);
    box.classList.remove('hidden');
    box.innerHTML=`<div class="masterAdminLayout"><div></div><div class="masterBody"><h2>Painel Master</h2><p class="note" style="color:#ff6b61">Não foi possível carregar esta seção: ${detail}</p><button onclick="renderMasterAdmin()">Tentar novamente</button></div></div>`;
  }
}

async function renderMasterAdminContent(renderSequence){
  const box=document.getElementById('masterAdmin');
  if(!box) return;
  if(!USER || USER.tipo!=='MASTER' || !MASTER_PANEL_OPEN){box.classList.add('hidden');box.innerHTML='';return;}
  box.classList.remove('hidden');
  box.innerHTML='<h2>Painel Master</h2><p class="note">Carregando informações do Supabase...</p>';

  let body='';
  if(MASTER_TAB==='usuarios' || MASTER_TAB==='senhas'){
    const usuarios=filtroUsuarios(await carregarUsuariosSupabase());
    const total=usuarios.length, ativos=usuarios.filter(u=>u.ativo).length, primeiro=usuarios.filter(u=>u.primeiro_acesso).length, bloqueados=usuarios.filter(u=>!u.ativo).length;
    const rows=usuarios.map(u=>{
      const situacao=u.ativo?'<span class="adminStatus ok">ATIVO</span>':'<span class="adminStatus bad">BLOQUEADO</span>';
      const primeiroBadge=u.primeiro_acesso?'<span class="adminStatus warn">PENDENTE</span>':'<span class="adminStatus ok">OK</span>';
      const userActions=MASTER_TAB==='usuarios'?`
        <div class="adminActions">
          <button class="adminActionBtn wine" onclick="editarUsuarioModal('${u.cpf}','perfil','${u.perfil||''}')">Editar Perfil</button>
          <button class="adminActionBtn wine" onclick="editarUsuarioModal('${u.cpf}','loja','${u.loja||''}')">Editar Loja</button>
          <button class="adminActionBtn wine" onclick="editarUsuarioModal('${u.cpf}','status','${u.status||''}')">Editar STATUS</button>
        </div>`:'';
      const passActions=MASTER_TAB==='senhas'?`
        <div class="adminActions">
          <button class="adminActionBtn warn" onclick="resetarSenhaUsuario('${u.cpf}')">Redefinir senha</button>
          <button class="adminActionBtn warn" onclick="forcarTrocaSenha('${u.cpf}')">Forçar troca</button>
          ${u.ativo?`<button class="adminActionBtn danger" onclick="bloquearUsuario('${u.cpf}')">Bloquear</button>`:`<button class="adminActionBtn good" onclick="desbloquearUsuario('${u.cpf}')">Desbloquear</button>`}
        </div>`:'';
      return `<tr>
        <td>${u.nome||''}<br><span class="note">${u.cpf||''}</span></td>
        <td>${u.perfil||''}</td><td>${u.loja||''}</td><td>${u.status||''}</td>
        <td>${u.ultimo_login?new Date(u.ultimo_login).toLocaleString('pt-BR'):'-'}</td>
        <td>${situacao}</td><td>${primeiroBadge}</td>
        <td>${userActions}${passActions}</td>
      </tr>`;
    }).join('');
    body=`
      <h2>${MASTER_TAB==='usuarios'?'Gerenciamento de Usuários':'Gerenciamento de Senhas'}</h2>
      <div class="adminGrid">
        <div class="adminCard"><div class="k">Usuários</div><div class="v">${total}</div></div>
        <div class="adminCard"><div class="k">Ativos</div><div class="v">${ativos}</div></div>
        <div class="adminCard"><div class="k">Primeiro acesso</div><div class="v">${primeiro}</div></div>
        <div class="adminCard"><div class="k">Bloqueados</div><div class="v">${bloqueados}</div></div>
      </div>
      <div class="adminToolbar"><div><label>Pesquisar por nome, CPF ou loja</label><br><input class="adminSearch" oninput="setMasterSearch(this.value)" value="${MASTER_SEARCH}" placeholder="Digite para pesquisar"></div></div>
      <div id="adminMsg" class="adminMsg"></div>
      <div class="tableWrap" style="margin-top:12px"><table class="adminTable">
      <thead><tr><th>Nome / CPF</th><th>Perfil</th><th>Loja</th><th>Status</th><th>Último login</th><th>Situação</th><th>Primeiro acesso</th><th>AÇÕES</th></tr></thead>
      <tbody>${rows||'<tr><td colspan="8">Nenhum usuário encontrado.</td></tr>'}</tbody></table></div>`;
  }else if(MASTER_TAB==='config'){
    await carregarParametrosPortal();
    body=`
      <h2>Configurações do Portal</h2>
      <p class="note">Parâmetros operacionais salvos no Supabase. Ao salvar, o dashboard é recalculado imediatamente sem atualizar a página.</p>
      <div id="adminMsg" class="adminMsg"></div>
      <div class="configRoadmap">
        ${parametroCard('share_minimo','Share mínimo (%)','Valor mínimo para faixa superior. Padrão: 40.')}
        ${parametroCard('spf_liquido_percentual','SPF Líquido (%)','Percentual aplicado sobre SPF Extra. Padrão: 70.')}
        ${parametroCard('bonus_spf_analista','Bônus SPF Analista (R$)','Valor por unidade de SPF para analista. Padrão: 150.')}
        ${parametroCard('limite_retorno_novos','Limite Retorno Novos (R$)','Corte de retorno bruto para vendedores Novos. Padrão: 12000.')}
        ${parametroCard('limite_retorno_seminovos','Limite Retorno Seminovos (R$)','Corte de retorno bruto para vendedores Seminovos. Padrão: 8000.')}
        ${parametroCard('vendedor_faixa_baixo_share_baixo','Vendedor: baixo retorno + Share baixo (%)','Padrão: 10.')}
        ${parametroCard('vendedor_faixa_baixo_share_alto','Vendedor: baixo retorno + Share alto (%)','Padrão: 15.')}
        ${parametroCard('vendedor_faixa_alto_share_baixo','Vendedor: alto retorno + Share baixo (%)','Padrão: 15.')}
        ${parametroCard('vendedor_faixa_alto_share_alto','Vendedor: alto retorno + Share alto (%)','Padrão: 20.')}
        ${parametroCard('gerente_faixa_share_baixo','Gerente: Share baixo (%)','Padrão: 3.')}
        ${parametroCard('gerente_faixa_share_alto','Gerente: Share alto (%)','Padrão: 4.')}
        ${parametroCard('analista_faixa_share_baixo','Analista: Share baixo (%)','Padrão: 3,5.')}
        ${parametroCard('analista_faixa_share_alto','Analista: Share alto (%)','Padrão: 4,5.')}
      </div>`;
  }else if(MASTER_TAB==='periodos'){
    await carregarPeriodosComissao();
    const rows=(PERIODOS_COMISSAO||[]).map(p=>`
      <tr>
        <td><b>${p.nome_periodo||''}</b>${p.periodo_atual?'<br><span class="periodoAtualBadge">PERÍODO ATUAL</span>':''}</td>
        <td>${dataBR(p.data_inicio)}</td>
        <td>${dataBR(p.data_fim)}</td>
        <td>${p.status||'EM CONFERÊNCIA'}</td>
        <td>${p.ativo!==false?'<span class="periodoAtivoBadge">ATIVO</span>':'<span class="periodoInativoBadge">INATIVO</span>'}</td>
        <td class="adminActions">
          <button class="adminActionBtn good" onclick="definirPeriodoAtual('${p.id}')">Definir atual</button>
          <button class="adminActionBtn warn" onclick="alternarPeriodoAtivo('${p.id}',${p.ativo!==false})">${p.ativo!==false?'Inativar':'Ativar'}</button>
          <button class="adminActionBtn danger" onclick="arquivarPeriodoComissao('${p.id}')">Arquivar</button>
        </td>
      </tr>`).join('');
    body=`<h2>Períodos de Comissão</h2>
      <p class="note">Cadastre os períodos oficiais. Ao selecionar um período no Dashboard, as datas inicial e final são preenchidas automaticamente sem alterar as regras de cálculo.</p>
      <div class="periodoInfoBox"><b>Regra desta etapa:</b> o período controla somente os campos Data Inicial e Data Final. Os cálculos continuam usando as mesmas funções já homologadas.</div>
      <div class="periodoAdminGrid">
        <div><label>Nome do período</label><input id="periodoNome" placeholder="Ex.: Comissão Junho/2026"></div>
        <div><label>Data inicial</label><input id="periodoIni" type="date"></div>
        <div><label>Data final</label><input id="periodoFim" type="date"></div>
        <div><label>Atual</label><br><label style="display:flex;gap:8px;align-items:center;color:#fff;font-size:13px;text-transform:none;letter-spacing:0"><input id="periodoAtual" type="checkbox" style="min-width:0;width:auto"> Definir como período atual</label></div>
      </div>
      <button onclick="salvarPeriodoComissao()">Salvar Período</button>
      <div class="tableWrap" style="margin-top:16px"><table class="adminTable">
        <thead><tr><th>Período</th><th>Início</th><th>Fim</th><th>Status</th><th>Ativo</th><th>Ações</th></tr></thead>
        <tbody>${rows||'<tr><td colspan="6">Nenhum período cadastrado.</td></tr>'}</tbody>
      </table></div>`;
  }else if(MASTER_TAB==='ausencias'){
    await carregarAusenciasAnalistas();
    const rows=(AUSENCIAS_ANALISTAS||[]).map(a=>`
      <tr>
        <td><b>${a.nome_analista_ausente||''}</b><br><span class="note">${a.loja_origem||''}</span></td>
        <td><b>${a.nome_analista_substituto||''}</b></td>
        <td>${a.loja_coberta||''}</td>
        <td>${dataBR(a.data_inicio)} a ${dataBR(a.data_fim)}</td>
        <td>${a.motivo||''}</td>
        <td>${a.ativo!==false?'<span class="periodoAtivoBadge">ATIVA</span>':'<span class="periodoInativoBadge">INATIVA</span>'}</td>
        <td class="adminActions">
          <button class="adminActionBtn warn" onclick="alternarAusenciaAnalista('${a.id}',${a.ativo!==false})">${a.ativo!==false?'Inativar':'Ativar'}</button>
          <button class="adminActionBtn danger" onclick="arquivarAusenciaAnalista('${a.id}')">Arquivar</button>
        </td>
      </tr>`).join('');
    body=`<h2>Férias / Ausências de Analistas</h2>
      <p class="note">Cadastre coberturas temporárias para direcionar a comissão do Analista da loja coberta ao Analista substituto apenas no período informado.</p>
      <div class="ausenciaInfoBox"><b>Regra desta etapa:</b> somente a comissão de <b>Analista</b> é redistribuída. Vendedores, Gerentes, Gestor F&I, vendas, financiamentos, produção, retorno e SPF permanecem com as mesmas regras já homologadas.</div>
      <div class="ausenciaAdminGrid">
        <div><label>Analista ausente</label><select id="ausCpfAusente">${analistasOptions()}</select></div>
        <div><label>Analista substituto</label><select id="ausCpfSubstituto">${analistasOptions()}</select></div>
        <div><label>Loja coberta</label><select id="ausLojaCoberta">${lojasOptions()}</select></div>
        <div><label>Motivo</label><select id="ausMotivo"><option>FÉRIAS</option><option>AUSÊNCIA</option><option>LICENÇA</option><option>AFASTAMENTO</option><option>COBERTURA TEMPORÁRIA</option></select></div>
        <div><label>Data inicial</label><input id="ausDataIni" type="date" value="${document.getElementById('dtIni')?.value||''}"></div>
        <div><label>Data final</label><input id="ausDataFim" type="date" value="${document.getElementById('dtFim')?.value||''}"></div>
        <div style="grid-column:span 2"><label>Observação</label><input id="ausObs" placeholder="Ex.: cobertura durante férias"></div>
      </div>
      <button onclick="salvarAusenciaAnalista()">Salvar Ausência</button>
      <div class="tableWrap" style="margin-top:16px"><table class="adminTable">
        <thead><tr><th>Analista ausente</th><th>Substituto</th><th>Loja coberta</th><th>Período</th><th>Motivo</th><th>Status</th><th>Ações</th></tr></thead>
        <tbody>${rows||'<tr><td colspan="7">Nenhuma regra de ausência cadastrada.</td></tr>'}</tbody>
      </table></div>`;
  }else if(MASTER_TAB==='mudancas_loja'){
    await carregarMudancasLojaVendedores();
    body=renderMudancasLojaVendedoresHtml();
  }else if(MASTER_TAB==='metricas'){
    body=renderAnalystMetricAuditHtml();
  }else if(MASTER_TAB==='historico'){
    await carregarFechamentosComissao();
    body=renderHistoricoCompetenciasHtml();
  }else if(MASTER_TAB==='relatorios'){
    await carregarFechamentosComissao();
    body=renderRelatoriosRhDpHtml();
  }else if(MASTER_TAB==='fechamento'){
    await carregarFechamentosComissao();
    body=renderFechamentoCompetenciaPreview();
  }else if(MASTER_TAB==='auditoria'){
    const aud=await carregarAuditoriaSupabase();
    const rows=aud.map(a=>`<tr><td>${a.criado_em?new Date(a.criado_em).toLocaleString('pt-BR'):'-'}</td><td>${a.tipo||''}</td><td>${a.descricao||''}</td><td>${a.cpf||''}</td><td>${a.vendedor||''}</td><td>${a.resolvido?'SIM':'NÃO'}</td></tr>`).join('');
    body=`<h2>Auditoria Administrativa</h2><p class="note">Registro das ações executadas pelo Painel Master.</p><div class="tableWrap"><table class="adminTable"><thead><tr><th>Data</th><th>Tipo</th><th>Descrição</th><th>CPF/Chave</th><th>Master</th><th>Resolvido</th></tr></thead><tbody>${rows||'<tr><td colspan="6">Nenhum registro.</td></tr>'}</tbody></table></div>`;
  }else{
    body=`<h2>Futuras Funcionalidades</h2><div class="configRoadmap">
      <div class="roadCard"><div class="k">Fase 03</div><p class="note">Gestão de bases pelo Painel Master.</p></div>
      <div class="roadCard"><div class="k">Fechamento mensal</div><p class="note">Congelar comissões por competência.</p></div>
      <div class="roadCard"><div class="k">Histórico</div><p class="note">Consulta por mês e evolução de comissão.</p></div>
    </div>`;
  }
  if(renderSequence!==MASTER_RENDER_SEQUENCE) return;
  box.innerHTML=`<div class="masterAdminLayout">${adminTabsHtml()}<div class="masterBody">${body}</div></div>`;
}



function calcGestorFIGrupo(){
  const vendedores=DATA.auth.filter(a=>a.tipo==='VENDEDOR');
  const rows=vendedores.map(a=>({a,m:calcSeller(a)})).filter(x=>x.m.vendidas>0 || x.m.financiadas>0 || x.m.retorno>0 || x.m.spf>0);
  const t=sumRows(rows);
  const share=t.vendidas?((t.financiadas/t.vendidas)*100):0;
  const faixa=share<40?0.0016:0.0030; // 0,16% ou 0,30%
  const spfLiquido=(+t.spf||0)*(cfgNum('spf_liquido_percentual')/100);
  const base=(+t.retorno||0)+spfLiquido;
  const comissaoPrincipal=base*faixa;
  const bonusSpf=(+t.spfQty||0)*30;
  const comissaoFinal=comissaoPrincipal+bonusSpf;
  return {...t, share, faixa, spfLiquido, base, comissaoPrincipal, bonusSpf, comissaoFinal};
}
function showGestorFICommission(){
  if(!USER || USER.tipo!=='MASTER') return;
  const view=document.getElementById('commissionRulesView');
  const hub=document.getElementById('commissionRulesHub');
  if(!view) return;
  const g=calcGestorFIGrupo();
  const ini=document.getElementById('dtIni')?.value||'-';
  const fim=document.getElementById('dtFim')?.value||'-';
  if(hub) hub.classList.add('hidden');
  document.getElementById('kpis')?.classList.add('hidden');
  document.getElementById('content')?.classList.add('hidden');
  document.getElementById('audit')?.classList.add('hidden');
  document.getElementById('masterAdmin')?.classList.add('hidden');
  view.classList.remove('hidden');
  view.innerHTML=`
    <div class="rulesHero">
      <div class="rulesNav">
        <button class="rulesBack" onclick="hideCommissionRules()">← Voltar ao Dashboard</button>
      </div>
      <div class="rulesHeroTitle">COMISSÃO GESTOR DE F&I</div>
      <div class="rulesHeroText">Análise consolidada do Grupo no período filtrado, utilizando Retorno Total + SPF Líquido 70%.</div>
      <div class="gestorNotice">A Comissão do Gestor de F&I é calculada considerando o desempenho consolidado de todo o Grupo, independentemente da loja selecionada.</div>

      <div class="gestorKpiGrid">
        <div class="gestorKpi"><div class="k">Qtd Vendida Grupo</div><div class="v">${g.vendidas}</div></div>
        <div class="gestorKpi"><div class="k">Qtd Financiada Grupo</div><div class="v">${g.financiadas}</div></div>
        <div class="gestorKpi"><div class="k">Share Grupo</div><div class="v">${(g.share||0).toFixed(1).replace('.',',')}%</div></div>
        <div class="gestorKpi"><div class="k">Produção Total Grupo</div><div class="v">${fmtMoney(g.producao||0)}</div></div>
        <div class="gestorKpi"><div class="k">Retorno Total Grupo</div><div class="v">${fmtMoney(g.retorno||0)}</div></div>
        <div class="gestorKpi"><div class="k">SPF EXTRA Total Grupo</div><div class="v">${fmtMoney(g.spf||0)}</div></div>
        <div class="gestorKpi"><div class="k">SPF Líquido 70% Grupo</div><div class="v">${fmtMoney(g.spfLiquido||0)}</div></div>
        <div class="gestorKpi"><div class="k">Qtd SPF EXTRA</div><div class="v">${g.spfQty||0}</div></div>
        <div class="gestorKpi"><div class="k">Base Gestor</div><div class="v">${fmtMoney(g.base||0)}</div></div>
        <div class="gestorKpi"><div class="k">Faixa Aplicada</div><div class="v">${(g.faixa*100).toFixed(2).replace('.',',')}%</div></div>
        <div class="gestorKpi"><div class="k">Comissão Principal</div><div class="v">${fmtMoney(g.comissaoPrincipal||0)}</div></div>
        <div class="gestorKpi"><div class="k">Bônus SPF</div><div class="v">${fmtMoney(g.bonusSpf||0)}</div></div>
        <div class="gestorKpi final"><div class="k">Comissão Final Gestor</div><div class="v">${fmtMoney(g.comissaoFinal||0)}</div></div>
      </div>

      <div class="gestorMemo">
        <b>Memória de cálculo</b><br>
        Período: <b>${ini}</b> até <b>${fim}</b><br>
        Retorno Total do Grupo: <b>${fmtMoney(g.retorno||0)}</b><br>
        SPF EXTRA Total do Grupo: <b>${fmtMoney(g.spf||0)}</b><br>
        SPF Líquido 70% do Grupo: <b>${fmtMoney(g.spfLiquido||0)}</b><br>
        Base Gestor = Retorno Total + SPF Líquido 70% = <b>${fmtMoney(g.base||0)}</b><br>
        Share Grupo: <b>${(g.share||0).toFixed(2).replace('.',',')}%</b> → Faixa aplicada: <b>${(g.faixa*100).toFixed(2).replace('.',',')}%</b><br>
        Comissão Principal = Base Gestor × Faixa = <b>${fmtMoney(g.comissaoPrincipal||0)}</b><br>
        Bônus SPF = Qtd SPF (${g.spfQty||0}) × R$ 30,00 = <b>${fmtMoney(g.bonusSpf||0)}</b><br>
        Comissão Final Gestor = Comissão Principal + Bônus SPF = <b>${fmtMoney(g.comissaoFinal||0)}</b>
      </div>
      <div class="ruleFooter">Grupo Brabus Mitsubishi · F&I · cálculo consolidado do grupo</div>
    </div>`;
  view.scrollIntoView({behavior:'smooth',block:'start'});
}

function renderCommissionRulesHub(){
  const hub=document.getElementById('commissionRulesHub');
  if(!hub) return;
  if(!USER){hub.innerHTML='';return;}
  hub.innerHTML=`
    <div class="rulesHubCard">
      <div class="rulesHubTop">
        <div>
          <div class="rulesHubTitle">📖 Central de Regras de Comissão</div>
          <div class="rulesHubSub">Consulte rapidamente as regras oficiais de remuneração do F&I.</div>
        </div>
        <div class="rulesHubBtns">
          <button class="rulesBtn" onclick="showCommissionRules('NOVOS')">REGRA DE COMISSÃO NOVOS</button>
          <button class="rulesBtn" onclick="showCommissionRules('SEMINOVOS')">REGRA DE COMISSÃO SEMINOVOS</button>
          ${USER.tipo==='MASTER'?`<button class="rulesBtn gestorBtn" onclick="showGestorFICommission()">COMISSÃO GESTOR DE F&I</button>`:''}
          ${['MASTER','RECURSOS HUMANOS','RH'].includes(String(USER.tipo||'').toUpperCase())?`<button class="rulesBtn gestorBtn" onclick="showHistoricoRelatoriosRH()">HISTÓRICO / RELATÓRIOS RH</button>`:''}
        </div>
      </div>
    </div>`;
}
function hideCommissionRules(){
  const view=document.getElementById('commissionRulesView');
  if(view){view.classList.add('hidden');view.innerHTML='';}
  const hub=document.getElementById('commissionRulesHub');
  if(hub) hub.classList.remove('hidden');
  document.getElementById('kpis')?.classList.remove('hidden');
  document.getElementById('content')?.classList.remove('hidden');
  document.getElementById('audit')?.classList.remove('hidden');
  document.getElementById('masterAdmin')?.classList.remove('hidden');
}
function pctLabel(n){return Number(n||0).toFixed(Number(n)%1?1:0).replace('.',',')+'%';}
function showCommissionRules(tipo){
  const isNovos=tipo==='NOVOS';
  const limite=isNovos?cfgNum('limite_retorno_novos'):cfgNum('limite_retorno_seminovos');
  const titulo=isNovos?'REGRA DE COMISSÃO — NOVOS':'REGRA DE COMISSÃO — SEMINOVOS';
  const subtitulo=isNovos?'Aplicável aos vendedores classificados em NOVOS, conforme retorno bruto e share.':'Aplicável aos vendedores classificados em SEMINOVOS, conforme retorno bruto e share.';
  const view=document.getElementById('commissionRulesView');
  const hub=document.getElementById('commissionRulesHub');
  if(!view) return;
  if(hub) hub.classList.add('hidden');
  document.getElementById('kpis')?.classList.add('hidden');
  document.getElementById('content')?.classList.add('hidden');
  document.getElementById('audit')?.classList.add('hidden');
  document.getElementById('masterAdmin')?.classList.add('hidden');
  const shareMin=cfgNum('share_minimo');
  const spfPct=cfgNum('spf_liquido_percentual');
  const faixaBaixoBaixo=cfgNum('vendedor_faixa_baixo_share_baixo');
  const faixaBaixoAlto=cfgNum('vendedor_faixa_baixo_share_alto');
  const faixaAltoBaixo=cfgNum('vendedor_faixa_alto_share_baixo');
  const faixaAltoAlto=cfgNum('vendedor_faixa_alto_share_alto');
  const exemploRetorno=isNovos?13500:9000;
  const exemploSpf=1500;
  const exemploRent=exemploRetorno+(exemploSpf*(spfPct/100));
  const exemploCom=exemploRent*(faixaAltoAlto/100);
  view.classList.remove('hidden');
  view.innerHTML=`
    <div class="rulesHero">
      <div class="rulesNav">
        <button class="rulesBack" onclick="hideCommissionRules()">← Voltar ao Dashboard</button>
        <button class="rulesBack" onclick="hideCommissionRules();window.scrollTo({top:0,behavior:'smooth'})">← Voltar ao Menu Inicial</button>
      </div>
      <div class="rulesHeroTitle">${titulo}</div>
      <div class="rulesHeroText">${subtitulo}</div>

      <div class="rulesGrid">
        <div class="ruleCard">
          <h3>Como funciona</h3>
          <div class="ruleFlow">
            <div class="flowStep"><b>Venda</b><span>Unidade vendida</span></div>
            <div class="flowStep"><b>Financiamento</b><span>Operação válida</span></div>
            <div class="flowStep"><b>Share</b><span>Meta de penetração</span></div>
            <div class="flowStep"><b>Retorno</b><span>Retorno bruto</span></div>
            <div class="flowStep"><b>Comissão</b><span>Faixa aplicada</span></div>
          </div>
          <div class="ruleHighlight"><b>Fórmula:</b> Comissão = (Retorno Bruto + ${pctLabel(spfPct)} do SPF Extra) × Faixa de Comissão.</div>
        </div>

        <div class="ruleCard">
          <h3>Faixas de comissão</h3>
          <ul class="ruleList">
            <li>Retorno bruto abaixo de ${fmtMoney(limite)} + Share abaixo de ${pctLabel(shareMin)}: <b>${pctLabel(faixaBaixoBaixo)}</b></li>
            <li>Retorno bruto abaixo de ${fmtMoney(limite)} + Share igual ou acima de ${pctLabel(shareMin)}: <b>${pctLabel(faixaBaixoAlto)}</b></li>
            <li>Retorno bruto igual ou acima de ${fmtMoney(limite)} + Share abaixo de ${pctLabel(shareMin)}: <b>${pctLabel(faixaAltoBaixo)}</b></li>
            <li>Retorno bruto igual ou acima de ${fmtMoney(limite)} + Share igual ou acima de ${pctLabel(shareMin)}: <b>${pctLabel(faixaAltoAlto)}</b></li>
          </ul>
          <div class="ruleBadgeLine">
            <span class="ruleBadge">Share mínimo ${pctLabel(shareMin)}</span>
            <span class="ruleBadge">SPF líquido ${pctLabel(spfPct)}</span>
            <span class="ruleBadge">Corte ${fmtMoney(limite)}</span>
          </div>
        </div>

        <div class="ruleCard">
          <h3>Exemplo prático</h3>
          <div class="ruleFormula">
            Retorno: ${fmtMoney(exemploRetorno)}<br>
            SPF Extra: ${fmtMoney(exemploSpf)}<br>
            SPF líquido (${pctLabel(spfPct)}): ${fmtMoney(exemploSpf*(spfPct/100))}<br>
            Rentabilidade total: ${fmtMoney(exemploRent)}<br>
            Faixa: ${pctLabel(faixaAltoAlto)}<br><br>
            Comissão estimada: ${fmtMoney(exemploCom)}
          </div>
        </div>

        <div class="ruleCard">
          <h3>Observações importantes</h3>
          <ul class="ruleList">
            <li>A faixa é definida pelo <b>Retorno Bruto</b> e pelo <b>Share</b>.</li>
            <li>O SPF entra na base como <b>SPF Líquido</b>, conforme percentual vigente.</li>
            <li>Operações fora das regras aprovadas não entram no cálculo.</li>
            <li>As configurações podem ser parametrizadas pelo Painel Master.</li>
          </ul>
          <div class="ruleHighlight"><b>Importante:</b> esta tela é uma consulta visual das regras. O cálculo oficial continua sendo feito pelo Portal.</div>
        </div>
      </div>
      <div class="ruleFooter">Última atualização automática conforme parâmetros atuais do Portal · Grupo Brabus Mitsubishi · F&I</div>
    </div>`;
  view.scrollIntoView({behavior:'smooth',block:'start'});
}

function render(){ if(!USER) return; CHASSIS_STORE={}; DETAIL_STORE={}; CHASSIS_ID=0; const mb=document.getElementById('masterPanelBtn'); if(mb) mb.classList.toggle('hidden', USER.tipo!=='MASTER'); document.getElementById('userInfo').innerHTML=`Usuário: <b>${USER.nome}</b> · Perfil: <b>${USER.tipo}</b> · Loja: <b>${USER.loja||'TODAS'}</b> · Status: <b>${USER.status}</b><br>Período: <b>${periodoComissaoLabelAtual()}</b>${PERIODO_SELECIONADO?' · <span class="periodoAtualBadge">PERÍODO OFICIAL</span>':' · <span class="tag">Datas manuais</span>'}`; renderCommissionRulesHub(); let content=''; const secureMode=String(PORTAL_RUNTIME_CONFIG.authMode||'').toLowerCase()==='secure'; if(secureMode){content=renderOperationalSecureState()}else{const stores=visibleStores();stores.forEach(s=>{content+=renderStore(s)})} document.getElementById('content').innerHTML=content||'<div class="panel">Nenhum dado para o período/perfil selecionado.</div>'; renderKpis(); if(secureMode)renderOperationalSecureAudit();else renderAudit(); renderMasterAdmin(); }
function renderKpis(){
 const rows=[];
 visibleStores().forEach(st=>DATA.auth.filter(a=>a.tipo==='VENDEDOR'&&sellerRelevantToStore(a,st)&&allowedSellerForStore(a,st)).forEach(a=>{const m=calcSeller(a,st); if(m.vendidas>0) rows.push({a,m})}));
 const t=sumRows(rows);
 const kpis=document.getElementById('kpis');
 if(USER && USER.tipo==='VENDEDOR'){
   const sellerSummary=commissionSummaryFromBlocks(rows,'seller',b=>b.a?.status||USER.status); const c=sellerSummary.c;
   kpis.className='cards vendorKpis';
   kpis.innerHTML=`
    <div class="card"><div class="k">Qtd Vendida</div><div class="v">${t.vendidas}</div></div>
    <div class="card"><div class="k">Qtd Financiada</div><div class="v">${t.financiadas}</div></div>
    <div class="card"><div class="k">Share</div><div class="v">${shareBadge(t.financiadas,t.vendidas)}</div></div>
    <div class="card"><div class="k">Retorno</div><div class="v">${fmtMoney(t.retorno)}</div></div>
    <div class="card"><div class="k">70% SPF</div><div class="v">${fmtMoney(c.spfLiquido)}</div></div>
    <div class="card"><div class="k">Faixa Atual</div><div class="v">${c.faixaHtml||faixaBadge(c.faixa,'seller')}</div></div>
    <div class="card"><div class="k">Rentabilidade Total</div><div class="v">${fmtMoney(c.rentTotal)}</div></div>
    <div class="card comissaoCard"><div class="k">Comissão</div><div class="v">${fmtMoney(c.comissaoTotal)}</div></div>`;
   return;
 }
 kpis.className='cards';
 kpis.innerHTML=`<div class="card"><div class="k">Qtd Vendida</div><div class="v">${t.vendidas}</div></div><div class="card"><div class="k">Qtd Financiada</div><div class="v">${t.financiadas}</div></div><div class="card"><div class="k">Share</div><div class="v">${shareBadge(t.financiadas,t.vendidas)}</div></div><div class="card"><div class="k">Retorno</div><div class="v">${fmtMoney(t.retorno)}</div></div><div class="card"><div class="k">Produção</div><div class="v">${fmtMoney(t.producao)}</div></div><div class="card"><div class="k">SPF Extra</div><div class="v">${fmtMoney(t.spf)}</div></div>`;
}
function renderAudit(){ const spfInfo=`<p class="note"><b>SPF EXTRA:</b> Fonte oficial Base 03 após preenchimento para baixo. Encontrados: <b>${DATA.meta.spfRows||0}</b> · Valor total: <b>${fmtMoney(DATA.meta.spfTotal||0)}</b> · Não vinculados à Base 02: <b>${DATA.meta.spfUnmatched||0}</b>.</p>`; const finPeriod=DATA.finance.filter(f=>inPeriod(f.date)); const real=finPeriod.filter(f=>f.isFinReal); const newReal=real.filter(f=>f.origem==='Base 02 Nova'); const histReal=real.filter(f=>f.origem==='Base 02 Histórica'); const b03keys=new Set(DATA.b03.map(x=>x.clienteKey)); const crossed=real.filter(f=>b03keys.has(f.clienteKey)).length; const notFound=real.length-crossed; const badV=[...new Set([...DATA.sales.filter(s=>inPeriod(s.date)&&!s.authFound).map(s=>s.vendedor),...DATA.finance.filter(f=>inPeriod(f.date)&&!f.vendedorKey).map(f=>f.vendedor)])].filter(Boolean); const allPeople=[...DATA.auth,...DATA.master,...DATA.excluded]; const stCount={}; allPeople.forEach(a=>{stCount[a.status]=(stCount[a.status]||0)+1}); const paulo=allPeople.find(a=>a.nomeKey==='PAULO ROBERTO SANTOS DA SILVA'); const statusAudit=`<h3>Auditoria de STATUS</h3><div class="cards"><div class="card"><div class="k">Colaboradores lidos</div><div class="v">${allPeople.length}</div></div><div class="card"><div class="k">NOVOS</div><div class="v">${stCount['NOVOS']||0}</div></div><div class="card"><div class="k">SEMINOVOS</div><div class="v">${stCount['SEMINOVOS']||0}</div></div><div class="card"><div class="k">NOVOS/SEMINOVOS</div><div class="v">${stCount['NOVOS/SEMINOVOS']||0}</div></div><div class="card"><div class="k">REVENDA/INATIVO</div><div class="v">${(stCount['REVENDA']||0)+(stCount['INATIVO']||0)}</div></div><div class="card"><div class="k">MASTER</div><div class="v">${stCount['MASTER']||0}</div></div></div><p class="note"><b>Validação exemplo:</b> Paulo Roberto Santos da Silva · STATUS lido/aplicado: <b>${paulo?paulo.status:'não localizado'}</b> · Grupos aplicados: <b>${paulo?(paulo.statusGroups||[]).join(' + '):'-'}</b>.</p>`; document.getElementById('audit').innerHTML=`<h2>Auditoria</h2><p class="note"><b>Regra aplicada:</b> Quantidade Financiada, Produção e Retorno usam apenas financiamentos reais. Base 02 Nova = Descrição Serviço contém <b>Por Plano-Financiamento</b>. Base 02 Histórica = DESCRICAO contém <b>FINANCIAMENTO</b>. Serviços SPF, TAC, Fin-Plus e outros não entram nesses três indicadores.</p><div class="cards"><div class="card"><div class="k">Linhas Base 02 no período</div><div class="v">${finPeriod.length}</div></div><div class="card"><div class="k">Financiamentos reais</div><div class="v">${real.length}</div></div><div class="card"><div class="k">Históricos reais</div><div class="v">${histReal.length}</div></div><div class="card"><div class="k">Novos reais</div><div class="v">${newReal.length}</div></div><div class="card"><div class="k">Cruzados B02 x B03</div><div class="v">${crossed}</div></div><div class="card"><div class="k">Não cruzados</div><div class="v">${notFound}</div></div></div>${spfInfo}${statusAudit}${badV.length?'<p class="bad"><b>Vendedores não localizados:</b> '+badV.join(', ')+'</p>':''}`; }


// Ajustes finais de visualização: auditoria exclusiva MASTER e estética premium
let AUDIT_MASTER_VISIBLE=false;
function ensureMasterAuditButton(){
  const userInfo=document.getElementById('userInfo');
  if(!userInfo) return;
  let wrap=document.getElementById('auditToggleWrap');
  if(USER && USER.tipo==='MASTER'){
    if(!wrap){
      wrap=document.createElement('div');
      wrap.id='auditToggleWrap';
      wrap.innerHTML='<button class="auditBtn" onclick="toggleMasterAudit()">AUDITORIA</button>';
      userInfo.parentElement.appendChild(wrap);
    }
    wrap.style.display='flex';
  }else{
    if(wrap) wrap.style.display='none';
    AUDIT_MASTER_VISIBLE=false;
  }
}
function toggleMasterAudit(){
  AUDIT_MASTER_VISIBLE=!AUDIT_MASTER_VISIBLE;
  renderAudit();
  const audit=document.getElementById('audit');
  if(AUDIT_MASTER_VISIBLE && audit){ audit.scrollIntoView({behavior:'smooth',block:'start'}); }
}
const __oldInitApp=initApp;
initApp=function(){
  AUDIT_MASTER_VISIBLE=false;
  __oldInitApp();
  ensureMasterAuditButton();
};
const __oldLogout=logout;
logout=function(){
  AUDIT_MASTER_VISIBLE=false;
  const audit=document.getElementById('audit');
  if(audit) audit.style.display='none';
  const wrap=document.getElementById('auditToggleWrap');
  if(wrap) wrap.style.display='none';
  __oldLogout();
};
const __oldRender=render;
render=function(){
  __oldRender();
  ensureMasterAuditButton();
};
const __oldRenderAudit=renderAudit;
renderAudit=function(){
  __oldRenderAudit();
  const audit=document.getElementById('audit');
  if(!audit) return;
  audit.style.display=(USER && USER.tipo==='MASTER' && AUDIT_MASTER_VISIBLE)?'block':'none';
};


// Funcionalidade final: DSR mensal automático e KPIs por perfil (Analista/Gerente)
function pad2(n){return String(n).padStart(2,'0');}
function isoDate(y,m,d){return y+'-'+pad2(m+1)+'-'+pad2(d);}
function addDaysIso(dateObj, days){const d=new Date(dateObj.getTime()); d.setDate(d.getDate()+days); return isoDate(d.getFullYear(),d.getMonth(),d.getDate());}
function easterDate(year){
  const a=year%19, b=Math.floor(year/100), c=year%100, d=Math.floor(b/4), e=b%4;
  const f=Math.floor((b+8)/25), g=Math.floor((b-f+1)/3), h=(19*a+b-d-g+15)%30;
  const i=Math.floor(c/4), k=c%4, l=(32+2*e+2*i-h-k)%7, m=Math.floor((a+11*h+22*l)/451);
  const month=Math.floor((h+l-7*m+114)/31)-1;
  const day=((h+l-7*m+114)%31)+1;
  return new Date(year,month,day,12,0,0,0);
}
function brHolidaysForYear(year){
  const e=easterDate(year);
  const list=[
    isoDate(year,0,1),   // Confraternização Universal
    addDaysIso(e,-47),   // Carnaval - terça-feira (calendário trabalhista usado internamente)
    addDaysIso(e,-2),    // Paixão de Cristo
    isoDate(year,3,21),  // Tiradentes
    isoDate(year,4,1),   // Dia do Trabalho
    addDaysIso(e,60),    // Corpus Christi
    isoDate(year,8,7),   // Independência
    isoDate(year,9,12),  // Nossa Senhora Aparecida
    isoDate(year,10,2),  // Finados
    isoDate(year,10,15), // Proclamação da República
    isoDate(year,10,20), // Consciência Negra
    isoDate(year,11,25)  // Natal
  ];
  return [...new Set(list)];
}
function dsrReferenceDate(){
  const fim=document.getElementById('dtFim')?.value;
  const ini=document.getElementById('dtIni')?.value;
  const s=fim||ini;
  if(s){ const [y,m,d]=s.split('-').map(Number); return new Date(y,m-1,d||1,12,0,0,0); }
  const now=new Date(); return new Date(now.getFullYear(),now.getMonth(),1,12,0,0,0);
}
function calcDsrMes(){
  const ref=dsrReferenceDate();
  const y=ref.getFullYear(), m=ref.getMonth();
  const diasMes=new Date(y,m+1,0).getDate();
  let domingos=0;
  for(let d=1; d<=diasMes; d++){ if(new Date(y,m,d,12,0,0,0).getDay()===0) domingos++; }
  const feriados=brHolidaysForYear(y).filter(s=>{
    const [yy,mm,dd]=s.split('-').map(Number);
    return yy===y && (mm-1)===m && new Date(y,m,dd,12,0,0,0).getDay()!==0;
  });
  const descansos=domingos+feriados.length;
  const diasUteis=diasMes-descansos;
  const pct=diasUteis>0 ? (descansos/diasUteis) : 0;
  return {ano:y,mes:m+1,diasMes,domingos,feriados:feriados.length,feriadosLista:feriados,descansos,diasUteis,pct};
}
function dsrInfoHtml(dsr,valor){
  return `<div class="note" style="margin-top:6px">${fmtPct2(dsr.pct)} · ${fmtMoney(valor)}</div>`;
}
function buildComissionCards(t, c, opts={}){
  const cls=opts.className||'vendorKpis';
  const commissionLabel=opts.commissionLabel||'Comissão';
  const commissionValue=opts.commissionValue ?? c.comissaoTotal ?? c.comissaoPrincipal ?? 0;
  const extraCards=opts.extraCards||'';
  const blocks=(c.blocks||[]).filter(b=>b&&b.c);
  if((c.multiplasFaixas||blocks.length>1)&&blocks.length){
    return buildMultiBlockCommissionCards(c,{...opts,className:cls,commissionLabel,commissionValue,extraCards});
  }
  return {cls, html:`
    <div class="card"><div class="k">Qtd Vendida</div><div class="v">${t.vendidas}</div></div>
    <div class="card"><div class="k">Qtd Financiada</div><div class="v">${t.financiadas}</div></div>
    <div class="card"><div class="k">Share</div><div class="v">${shareBadge(t.financiadas,t.vendidas)}</div></div>
    <div class="card"><div class="k">Retorno</div><div class="v">${fmtMoney(t.retorno)}</div></div>
    <div class="card"><div class="k">70% SPF</div><div class="v">${fmtMoney(c.spfLiquido)}</div></div>
    <div class="card"><div class="k">Faixa Atual</div><div class="v">${opts.faixaHtml||c.faixaHtml||faixaBadge(c.faixa,opts.faixaKind||'seller')}</div></div>
    <div class="card"><div class="k">Rentabilidade Total</div><div class="v">${fmtMoney(c.rentTotal)}</div></div>
    <div class="card comissaoCard"><div class="k">${commissionLabel}</div><div class="v">${fmtMoney(commissionValue)}</div></div>
    ${extraCards}`};
}
function analystRowsForCurrentView(){
  const out=[];
  visibleStores().forEach(st=>{
    const sellers=DATA.auth.filter(a=>a.tipo==='VENDEDOR'&&sellerRelevantToStore(a,st)&&allowedSellerForStore(a,st)).map(a=>({a,m:calcSeller(a,st)})).filter(x=>x.m.vendidas>0);
    const novos=sellers.filter(x=>statusHas(x.a,'NOVOS'));
    const semis=sellers.filter(x=>statusHas(x.a,'SEMINOVOS'));
    analystCommissionRowsForStore(st,novos,semis).forEach(ar=>out.push(ar));
  });
  return out;
}
function sumAnalystCommissionRows(rows){
  const consolidated=combineAnalystRowsForDisplay(rows||[]);
  const t=sumRowsWithItems(consolidated.map(r=>({m:r.m||zeroMetrics()})));
  const c=consolidated.reduce((acc,r)=>{
    acc.spfLiquido+=(+r.c.spfLiquido||0);
    acc.rentTotal+=(+r.c.rentTotal||0);
    acc.comissaoPrincipal+=(+r.c.comissaoPrincipal||0);
    acc.comissaoSpf+=(+r.c.comissaoSpf||0);
    acc.comissaoTotal+=(+r.c.comissaoTotal||0);
    return acc;
  },{spfLiquido:0,rentTotal:0,comissaoPrincipal:0,comissaoSpf:0,comissaoTotal:0});
  c.share=shareNum(t.financiadas,t.vendidas);
  c.faixas=[...new Set(consolidated.map(r=>+r.c.faixa||0))];
  c.multiplasFaixas=c.faixas.length>1;
  c.faixa=c.faixas.length===1?c.faixas[0]:null;
  c.faixaHtml=c.multiplasFaixas
    ?c.faixas.map(f=>faixaBadge(f,'analyst')).join('<span style="padding:0 3px;color:#aaa">+</span>')
    :faixaBadge(c.faixa||0,'analyst');
  c.blocks=consolidated.map(r=>({loja:r.loja||'',status:'ANALISTA',m:r.m,c:r.c}));
  return {t,c,blocks:c.blocks,rows:consolidated};
}
function renderKpis(){
  const rows=[];
  visibleStores().forEach(st=>DATA.auth.filter(a=>a.tipo==='VENDEDOR'&&sellerRelevantToStore(a,st)&&allowedSellerForStore(a,st)).forEach(a=>{const m=calcSeller(a,st); if(m.vendidas>0) rows.push({a,m})}));
  const t=sumRows(rows);
  const kpis=document.getElementById('kpis');
  if(!kpis) return;

  if(String(PORTAL_RUNTIME_CONFIG.authMode||'').toLowerCase()==='secure'){
    const secureTotals=operationalTotalsForCurrentStore();
    if(secureTotals){
      const sold=Number(secureTotals.sold_count)||0;
      const financed=Number(secureTotals.financed_count)||0;
      kpis.className='cards masterKpis';
      kpis.innerHTML=`
      <div class="card"><div class="k">Qtd Vendida</div><div class="v">${sold}</div></div>
      <div class="card"><div class="k">Qtd Financiada</div><div class="v">${financed}</div></div>
      <div class="card"><div class="k">Share</div><div class="v">${shareBadge(financed,sold)}</div></div>
      <div class="card"><div class="k">Retorno</div><div class="v">${fmtMoney(Number(secureTotals.return_value)||0)}</div></div>
      <div class="card"><div class="k">70% SPF</div><div class="v">${fmtMoney(Number(secureTotals.spf_net_value)||0)}</div></div>
      <div class="card"><div class="k">Rentabilidade Total</div><div class="v">${fmtMoney(Number(secureTotals.profitability_value)||0)}</div></div>
      <div class="card"><div class="k">Produção</div><div class="v">${fmtMoney(Number(secureTotals.production_value)||0)}</div></div>
      <div class="card operationalSourceCard"><div class="k">Fonte dos KPIs</div><div class="v">API SEGURA</div></div>`;
      return;
    }
    const message=OPERATIONAL_METRICS_STATE.loading
      ?'Carregando indicadores autorizados...'
      :(OPERATIONAL_METRICS_STATE.error
        ?operationalMetricsSafeError(OPERATIONAL_METRICS_STATE.error)
        :'Indicadores autorizados ainda não carregados.');
    kpis.className='cards masterKpis';
    kpis.innerHTML=`<div class="card operationalSourceCard"><div class="k">Fonte dos KPIs</div><div class="v">API SEGURA</div><div class="note">${message}</div></div>`;
    return;
  }

  if(USER && USER.tipo==='VENDEDOR'){
    const sellerSummary=commissionSummaryFromBlocks(rows,'seller',b=>b.a?.status||USER.status); const c=sellerSummary.c;
    const built=buildComissionCards(t,c,{className:'cards vendorKpis',faixaKind:'seller',faixaHtml:c.faixaHtml,commissionLabel:'Comissão Total',commissionValue:c.comissaoTotal});
    kpis.className=built.cls;
    kpis.innerHTML=built.html;
    return;
  }

  if(USER && String(USER.tipo||'').toUpperCase()==='MASTER'){
    const secureTotals=operationalTotalsForCurrentStore();
    if(secureTotals){
      const sold=Number(secureTotals.sold_count)||0;
      const financed=Number(secureTotals.financed_count)||0;
      kpis.className='cards masterKpis';
      kpis.innerHTML=`
      <div class="card"><div class="k">Qtd Vendida</div><div class="v">${sold}</div></div>
      <div class="card"><div class="k">Qtd Financiada</div><div class="v">${financed}</div></div>
      <div class="card"><div class="k">Share</div><div class="v">${shareBadge(financed,sold)}</div></div>
      <div class="card"><div class="k">Retorno</div><div class="v">${fmtMoney(Number(secureTotals.return_value)||0)}</div></div>
      <div class="card"><div class="k">70% SPF</div><div class="v">${fmtMoney(Number(secureTotals.spf_net_value)||0)}</div></div>
      <div class="card"><div class="k">Rentabilidade Total</div><div class="v">${fmtMoney(Number(secureTotals.profitability_value)||0)}</div></div>
      <div class="card"><div class="k">Produção</div><div class="v">${fmtMoney(Number(secureTotals.production_value)||0)}</div></div>
      <div class="card operationalSourceCard"><div class="k">Fonte dos KPIs</div><div class="v">API SEGURA</div></div>`;
      return;
    }
    if(String(PORTAL_RUNTIME_CONFIG.authMode||'').toLowerCase()==='secure'){
      const message=OPERATIONAL_METRICS_STATE.loading
        ?'Carregando indicadores autorizados...'
        :(OPERATIONAL_METRICS_STATE.error
          ?operationalMetricsSafeError(OPERATIONAL_METRICS_STATE.error)
          :'Indicadores autorizados ainda não carregados.');
      kpis.className='cards masterKpis';
      kpis.innerHTML=`
        <div class="card operationalSourceCard">
          <div class="k">Fonte dos KPIs</div>
          <div class="v">API SEGURA</div>
          <div class="note">${message}</div>
        </div>`;
      return;
    }
    const c=commissionCalc('',t,'master');
    kpis.className='cards masterKpis';
    kpis.innerHTML=`
    <div class="card"><div class="k">Qtd Vendida</div><div class="v">${t.vendidas}</div></div>
    <div class="card"><div class="k">Qtd Financiada</div><div class="v">${t.financiadas}</div></div>
    <div class="card"><div class="k">Share</div><div class="v">${shareBadge(t.financiadas,t.vendidas)}</div></div>
    <div class="card"><div class="k">Retorno</div><div class="v">${fmtMoney(t.retorno)}</div></div>
    <div class="card"><div class="k">70% SPF</div><div class="v">${fmtMoney(c.spfLiquido)}</div></div>
    <div class="card"><div class="k">Rentabilidade Total</div><div class="v">${fmtMoney(c.rentTotal)}</div></div>
    <div class="card"><div class="k">Produção</div><div class="v">${fmtMoney(t.producao)}</div></div>`;
    return;
  }

  if(USER && USER.tipo==='GERENTE'){
    const managerSummary=managerCommissionSummary(rows);
    const c=managerSummary.c;
    const built=buildComissionCards(t,c,{className:'cards managerKpis vendorKpis',faixaKind:'manager',faixaHtml:c.faixaHtml,commissionLabel:'Comissão',commissionValue:c.comissaoPrincipal});
    kpis.className=built.cls;
    kpis.innerHTML=built.html;
    return;
  }

  if(USER && USER.tipo==='ANALISTA'){
    const analystRows=analystRowsForCurrentView();
    const summed=sumAnalystCommissionRows(analystRows);
    const at=summed.t, ac=summed.c;
    const dsr=calcDsrMes();
    const valorDsr=(ac.comissaoTotal||0)*(dsr.pct||0);
    const totalComDsr=(ac.comissaoTotal||0)+valorDsr;
    const extra=`
      <div class="card"><div class="k">DSR do mês</div><div class="v">${fmtPct2(dsr.pct||0)}</div>${dsrInfoHtml(dsr,valorDsr)}</div>
      <div class="card comissaoCard dsrTotalCard"><div class="k">Comissão + DSR</div><div class="v">${fmtMoney(totalComDsr)}</div></div>`;
    const built=buildComissionCards(at,ac,{className:'cards analystKpis vendorKpis',faixaKind:'analyst',faixaHtml:ac.faixaHtml,commissionLabel:'Comissão',commissionValue:ac.comissaoTotal,extraCards:extra});
    kpis.className=built.cls;
    kpis.innerHTML=built.html;
    kpis.setAttribute('data-dsr-validacao',`DSR: ${fmtPct2(dsr.pct||0)}; Comissão base: ${fmtMoney(ac.comissaoTotal||0)}; Valor DSR: ${fmtMoney(valorDsr)}; Comissão + DSR: ${fmtMoney(totalComDsr)}`);
    return;
  }

  kpis.className='cards';
  kpis.innerHTML=`<div class="card"><div class="k">Qtd Vendida</div><div class="v">${t.vendidas}</div></div><div class="card"><div class="k">Qtd Financiada</div><div class="v">${t.financiadas}</div></div><div class="card"><div class="k">Share</div><div class="v">${shareBadge(t.financiadas,t.vendidas)}</div></div><div class="card"><div class="k">Retorno</div><div class="v">${fmtMoney(t.retorno)}</div></div><div class="card"><div class="k">Produção</div><div class="v">${fmtMoney(t.producao)}</div></div><div class="card"><div class="k">SPF Extra</div><div class="v">${fmtMoney(t.spf)}</div></div>`;
}

