/* PORTAL-NEXT V2 — Cash Conversion v2 (motor único da tela e da Brabus IA).
   O MESMO arquivo é carregado pelos simuladores (<script>) e importado pela edge
   function brabus-intelligence (engine/cash-conversion-v2.js); os testes da IA
   conferem o sha256 das duas cópias. Mudou aqui, muda nos dois lugares.

   Compara: (a) pagar à vista × (b) financiar e deixar o capital (preço − entrada)
   aplicado, sacando cada pagamento do plano no mês em que vence.
   - Rendimento LÍQUIDO de IR: cada saque paga IR pela tabela regressiva conforme
     os dias corridos desde a aplicação (LCI/LCA isenta para PF).
   - Cenários: "focus" (Selic segue a mediana do Focus, em linha reta mês a mês
     até o fim de cada ano; depois do último ano fica constante) e "cdi_constante".
   - CDI = Selic − (Selic − CDI da referência). Taxa do produto = % do indexador ×
     taxa anual do indexador, capitalizada mês a mês (aproximação; o real é diário).
   - Custo do financiamento = CET do fluxo (os pagamentos já incluem IOF e tarifas).
   - Ponto de equilíbrio = CET acima do qual financiar deixa de compensar.
   - Sem IOF de aplicação (o primeiro saque é a partir de 30 dias) e sem custódia
     do Tesouro (a fonte não dá o número): avisos explícitos no resultado.
   Sem dependências; ES5; nunca lê a rede nem o DOM. */
(function (global) {
  'use strict';

  var RODAPE = 'Material informativo, não é recomendação de investimento. Confirme com o seu banco ou assessor de investimentos.';

  function parseData(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
  }
  function somaMeses(t, n) {
    var d = new Date(t), y = d.getUTCFullYear(), mo = d.getUTCMonth() + n, dia = d.getUTCDate();
    var ult = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
    return Date.UTC(y, mo, Math.min(dia, ult));
  }
  var DIA = 86400000;
  function fmtData(t) { var d = new Date(t); return pad(d.getUTCDate()) + '/' + pad(d.getUTCMonth() + 1) + '/' + d.getUTCFullYear(); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function brl(v) { return 'R$ ' + num(Math.abs(v), 2); }
  function num(v, c) {
    var s = Math.round(Math.abs(v) * Math.pow(10, c)).toString();
    while (s.length <= c) s = '0' + s;
    var int = s.slice(0, s.length - c), dec = s.slice(s.length - c), out = '';
    for (var i = 0; i < int.length; i++) { if (i && (int.length - i) % 3 === 0) out += '.'; out += int.charAt(i); }
    return (v < 0 && Math.round(Math.abs(v) * Math.pow(10, c)) !== 0 ? '-' : '') + out + (c ? ',' + dec : '');
  }
  function pct(v, c) { return num(v, c == null ? 2 : c) + '%'; }
  function r2(v) { return Math.round(v * 100) / 100; }
  function r6(v) { return Math.round(v * 1e6) / 1e6; }
  function mensal(aaPct) { return Math.pow(1 + aaPct / 100, 1 / 12) - 1; }

  /* ---------- referências ---------- */
  function validaReferencias(ref) {
    if (!ref || typeof ref !== 'object') return 'Referências de mercado indisponíveis.';
    var campos = ['selic_aa', 'cdi_aa', 'cdi_12m_pct'];
    for (var i = 0; i < campos.length; i++) if (!(Number(ref[campos[i]]) > 0)) return 'Referências de mercado incompletas.';
    if (isNaN(parseData(ref.vigencia))) return 'Referências de mercado sem data de vigência.';
    if (!ref.ir_faixas || !ref.ir_faixas.length || !ref.produtos || !ref.produtos.length) return 'Referências de mercado incompletas.';
    return null;
  }

  /* Selic anual (%) na data t, no cenário pedido. */
  function selicNa(ref, cenario, t) {
    var s0 = Number(ref.selic_aa);
    if (cenario !== 'focus') return s0;
    var pts = [{ t: parseData(ref.vigencia), v: s0 }];
    (ref.focus_selic || []).forEach(function (f) { pts.push({ t: Date.UTC(Number(f.fim_de), 11, 31), v: Number(f.selic_aa) }); });
    if (t <= pts[0].t) return s0;
    for (var i = 1; i < pts.length; i++) {
      if (t <= pts[i].t) { var a = pts[i - 1], b = pts[i]; return a.v + (b.v - a.v) * (t - a.t) / (b.t - a.t); }
    }
    return pts[pts.length - 1].v;
  }
  function taxaProdutoAa(ref, cenario, produto, t) {
    var selic = selicNa(ref, cenario, t);
    var idx = produto.indexador === 'SELIC' ? selic : selic - (Number(ref.selic_aa) - Number(ref.cdi_aa));
    return Number(produto.pct_indexador) / 100 * idx;
  }
  function aliquotaIr(ref, produto, dias) {
    if (produto.isento_ir_pf) return 0;
    var f = ref.ir_faixas;
    for (var i = 0; i < f.length; i++) if (f[i].ate_dias == null || dias <= Number(f[i].ate_dias)) return Number(f[i].aliquota_pct) / 100;
    return Number(f[f.length - 1].aliquota_pct) / 100;
  }

  /* ---------- financiamento ---------- */
  function normalizaFluxo(fluxo) {
    var porMes = {};
    (fluxo || []).forEach(function (p) {
      var m = Number(p.mes), v = Number(p.valor);
      if (!(m >= 1) || Math.floor(m) !== m || !(v > 0)) return;
      porMes[m] = (porMes[m] || 0) + v;
    });
    return Object.keys(porMes).map(Number).sort(function (a, b) { return a - b; }).map(function (m) { return { mes: m, valor: porMes[m] }; });
  }
  /* Taxa mensal i em que capital = Σ valor/(1+i)^mês (CET do fluxo). */
  function cetMensal(capital, fluxo) {
    function vp(i) { var s = 0; for (var k = 0; k < fluxo.length; k++) s += fluxo[k].valor / Math.pow(1 + i, fluxo[k].mes); return s; }
    var lo = -0.5, hi = 1;
    if (vp(lo) < capital || vp(hi) > capital) return null;
    for (var n = 0; n < 200; n++) { var m = (lo + hi) / 2; if (vp(m) > capital) lo = m; else hi = m; }
    return (lo + hi) / 2;
  }

  /* ---------- aplicação com saques ---------- */
  function simulaAplicacao(capital, fluxo, ref, cenario, produto, t0) {
    var saldo = capital, custo = capital, ir = 0, rendBruto = 0, aportes = 0, mesAcabou = null;
    var ultimo = fluxo.length ? fluxo[fluxo.length - 1].mes : 0, idx = 0, somaTaxas = 0;
    for (var k = 1; k <= ultimo; k++) {
      var tk = somaMeses(t0, k);
      var j = mensal(taxaProdutoAa(ref, cenario, produto, tk));
      somaTaxas += j;
      var juros = saldo * j; saldo += juros; rendBruto += juros;
      if (idx < fluxo.length && fluxo[idx].mes === k) {
        var devido = fluxo[idx].valor; idx++;
        var a = aliquotaIr(ref, produto, Math.round((tk - t0) / DIA));
        var g = saldo > 0 ? Math.max(0, (saldo - custo) / saldo) : 0;
        var liquidoDisp = saldo * (1 - g * a);
        if (liquidoDisp + 1e-9 >= devido) {
          var bruto = devido / (1 - g * a);
          ir += bruto * g * a; custo -= bruto * (1 - g); saldo -= bruto;
        } else {
          ir += saldo * g * a; aportes += devido - liquidoDisp;
          if (mesAcabou == null) mesAcabou = k;
          saldo = 0; custo = 0;
        }
      }
    }
    var tFim = somaMeses(t0, ultimo);
    var aFim = aliquotaIr(ref, produto, Math.round((tFim - t0) / DIA));
    var irFim = Math.max(0, saldo - custo) * aFim;
    var saldoLiq = saldo - irFim;
    return {
      saldo_final_liquido: saldoLiq, ir_total: ir + irFim, rendimento_bruto: rendBruto, aportes: aportes,
      ganho_liquido: saldoLiq - aportes, mes_dinheiro_acaba: mesAcabou,
      taxa_media_bruta_am: ultimo ? somaTaxas / ultimo : 0
    };
  }
  function resultado(ganho) {
    var c = Math.round(ganho * 100);
    return c === 0 ? 'EQUIVALENTE' : c > 0 ? 'FINANCIAR_COMPENSA' : 'A_VISTA_COMPENSA';
  }
  /* CET a partir do qual o ganho líquido zera (escala o fluxo inteiro). */
  function pontoEquilibrio(capital, fluxo, ref, cenario, produto, t0) {
    function ganho(f) { return simulaAplicacao(capital, fluxo.map(function (p) { return { mes: p.mes, valor: p.valor * f }; }), ref, cenario, produto, t0).ganho_liquido; }
    var lo = 0, hi = 1;
    while (ganho(hi) > 0 && hi < 1e6) hi *= 2;
    for (var n = 0; n < 100; n++) { var m = (lo + hi) / 2; if (ganho(m) > 0) lo = m; else hi = m; }
    var f = (lo + hi) / 2;
    return cetMensal(capital, fluxo.map(function (p) { return { mes: p.mes, valor: p.valor * f }; }));
  }

  /* ---------- texto para o cliente ---------- */
  function frase(capital, cet, foco) {
    var ganhos = foco.produtos.map(function (p) { return p.ganho_liquido; });
    var min = Math.min.apply(null, ganhos), max = Math.max.apply(null, ganhos);
    var lista = 'Tesouro Selic, CDB 100% do CDI ou LCI/LCA 85% do CDI';
    if (foco.produtos.length) lista = foco.produtos.map(function (p) { return p.nome; }).join(', ').replace(/, ([^,]*)$/, ' ou $1');
    var faixa = function (a, b) { return Math.round(a) === Math.round(b) ? 'cerca de ' + brl(a) : 'entre ' + brl(Math.min(a, b)) + ' e ' + brl(Math.max(a, b)); };
    if (min > 0) {
      return 'Estimativa: financiando e mantendo ' + brl(capital) + ' aplicado, depois de pagar o financiamento sobrariam ' + faixa(min, max) +
        ' líquidos de IR, conforme a aplicação (' + lista + '), no cenário de Selic em queda do Boletim Focus. Não há garantia: depende das taxas futuras.';
    }
    if (max < 0) {
      return 'Estimativa: neste plano o custo do financiamento (CET de ' + pct(cet * 100) + ' a.m.) é maior que o rendimento líquido das aplicações de referência (' + lista +
        '). Financeiramente, pagar à vista sai mais barato: ' + faixa(-max, -min) + ' de diferença. Financiar só se justifica por outros motivos, como manter uma reserva disponível, o que não é ganho em dinheiro.';
    }
    return 'Estimativa: o resultado depende da aplicação. ' + foco.produtos.map(function (p) {
      return p.ganho_liquido >= 0 ? 'Em ' + p.nome + ', sobrariam cerca de ' + brl(p.ganho_liquido) : 'em ' + p.nome + ', pagar à vista sairia cerca de ' + brl(-p.ganho_liquido) + ' mais barato';
    }).join('; ') + ' (líquido de IR, cenário de Selic em queda do Boletim Focus). Não há garantia: depende das taxas futuras.';
  }

  /* ---------- entrada principal ----------
     params: { capital, fluxo: [{mes, valor}], referencias (cash_referencias_mercado()), dataBase: 'AAAA-MM-DD' (hoje) } */
  function calcular(params) {
    params = params || {};
    var capital = Number(params.capital);
    if (!(capital > 0)) return { erro: 'Informe o valor que o cliente pagaria à vista (preço − entrada).' };
    var fluxo = normalizaFluxo(params.fluxo);
    if (!fluxo.length) return { erro: 'Informe os pagamentos do financiamento.' };
    if (fluxo[fluxo.length - 1].mes > 120) return { erro: 'Prazo acima de 120 meses.' };
    var ref = params.referencias, eRef = validaReferencias(ref);
    if (eRef) return { erro: eRef };
    var t0 = parseData(params.dataBase);
    if (isNaN(t0)) return { erro: 'Informe a data da simulação.' };
    var total = fluxo.reduce(function (s, p) { return s + p.valor; }, 0);
    var cet = cetMensal(capital, fluxo);
    if (cet == null) return { erro: 'Os pagamentos informados não são compatíveis com o valor financiado.' };

    var cenarios = {};
    ['focus', 'cdi_constante'].forEach(function (c) {
      var produtos = ref.produtos.map(function (p) {
        var s = simulaAplicacao(capital, fluxo, ref, c, p, t0);
        var pe = pontoEquilibrio(capital, fluxo, ref, c, p, t0);
        return {
          id: p.id, nome: p.nome, isento_ir_pf: !!p.isento_ir_pf, garantia: p.garantia,
          taxa_media_bruta_am_pct: r6(s.taxa_media_bruta_am * 100),
          rendimento_bruto: r2(s.rendimento_bruto), ir_total: r2(s.ir_total), aportes_do_bolso: r2(s.aportes),
          mes_dinheiro_acaba: s.mes_dinheiro_acaba, saldo_final_liquido: r2(s.saldo_final_liquido),
          ganho_liquido: r2(s.ganho_liquido), resultado: resultado(s.ganho_liquido),
          ponto_equilibrio_cet_am_pct: pe == null ? null : r6(pe * 100)
        };
      });
      cenarios[c] = { produtos: produtos };
    });

    var tv = parseData(ref.vigencia);
    var dias = ref.dias_desde_vigencia != null ? Number(ref.dias_desde_vigencia) : Math.round((t0 - tv) / DIA);
    var desatualizada = ref.desatualizada != null ? !!ref.desatualizada : dias > 50;
    var avisos = [];
    if (desatualizada) avisos.push('As taxas de referência são de ' + fmtData(tv) + ' (há ' + dias + ' dias) e podem estar desatualizadas.');
    cenarios.focus.produtos.forEach(function (p) {
      if (p.mes_dinheiro_acaba) avisos.push('Em ' + p.nome + ', o dinheiro aplicado acaba no mês ' + p.mes_dinheiro_acaba + '; os pagamentos seguintes sairiam do bolso (' + brl(p.aportes_do_bolso) + ', já descontados do resultado).');
    });
    ref.produtos.forEach(function (p) {
      if (p.isento_ir_pf) avisos.push(p.nome + ' costuma ter carência e prazo de vencimento: o saque mensal pode não estar disponível em todos os meses.');
      if (p.garantia === 'SOBERANO') avisos.push(p.nome + ' é título público (risco soberano); pode haver custos da plataforma e da B3 que não entram nesta conta.');
    });
    if (capital > Number(ref.fgc_limite_instituicao)) {
      avisos.push('O FGC garante até ' + brl(Number(ref.fgc_limite_instituicao)) + ' por CPF por instituição (teto de ' + brl(Number(ref.fgc_teto_total)) + ' a cada ' + ref.fgc_teto_anos + ' anos): acima disso, o valor em CDB/LCI/LCA de uma mesma instituição não tem essa garantia.');
    }
    var media12 = (Math.pow(1 + Number(ref.cdi_12m_pct) / 100, 1 / 12) - 1) * 100;
    var cdiAtualAm = mensal(Number(ref.cdi_aa)) * 100;
    return {
      capital: r2(capital), total_pago: r2(total), juros_e_custos: r2(total - capital),
      prazo_meses: fluxo[fluxo.length - 1].mes, pagamentos: fluxo.length, data_base: fmtData(t0),
      cet_am_pct: r6(cet * 100), cet_aa_pct: r6((Math.pow(1 + cet, 12) - 1) * 100),
      cenarios: cenarios,
      referencias: {
        vigencia: fmtData(tv), fonte: ref.fonte, dias_desde_vigencia: dias, desatualizada: desatualizada,
        selic_aa_pct: Number(ref.selic_aa), cdi_aa_pct: Number(ref.cdi_aa), cdi_atual_am_pct: r6(cdiAtualAm),
        cdi_12m_pct: Number(ref.cdi_12m_pct), cdi_12m_media_am_pct: r6(media12), cdi_12m_ate: ref.cdi_12m_ate ? fmtData(parseData(ref.cdi_12m_ate)) : null,
        focus_data: ref.focus_data ? fmtData(parseData(ref.focus_data)) : null, focus_selic: ref.focus_selic
      },
      leitura_taxas: 'Base da conta: CDI atual de ' + pct(Number(ref.cdi_aa)) + ' a.a. (cerca de ' + pct(cdiAtualAm) + ' a.m.). A média dos últimos 12 meses (CDI de ' + pct(Number(ref.cdi_12m_pct)) +
        ', cerca de ' + pct(media12) + ' a.m.) é passado e não entra como base.',
      frase_cliente: frase(capital, cet, cenarios.focus),
      avisos: avisos,
      fonte: 'Referências de ' + fmtData(tv) + ': ' + ref.fonte,
      rodape: RODAPE
    };
  }

  global.NX_CASH_V2 = { calcular: calcular, cetMensal: cetMensal, selicNa: selicNa, RODAPE: RODAPE, versao: 1 };
})(typeof window !== 'undefined' ? window : globalThis);
