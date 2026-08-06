(function () {
  "use strict";

  const runtime = window.PORTAL_RUNTIME_CONFIG || {};
  const secureMode = String(runtime.authMode || "").toLowerCase() === "secure";
  const client = secureMode && window.supabase && runtime.supabaseUrl && runtime.supabasePublishableKey
    ? window.supabase.createClient(runtime.supabaseUrl, runtime.supabasePublishableKey)
    : null;
  let requestSequence = 0;

  const number = value => Number(value) || 0;
  const iso = date => date ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}` : "";
  const titleDepartment = value => {
    const normalized = String(value || "").trim().toUpperCase();
    if (normalized === "NOVOS") return "Novos";
    if (normalized === "SEMINOVOS") return "Seminovos";
    return normalized || "Não informado";
  };

  function safeDate(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
    const parts = String(value || "").split("-").map(Number);
    return parts.length === 3 ? new Date(parts[0], parts[1] - 1, parts[2]) : null;
  }

  function distribute(total, count, index) {
    if (!count) return 0;
    const base = total / count;
    return index === count - 1 ? total - base * (count - 1) : base;
  }

  function metricsToLegacy(rows, recordDate) {
    const sales = [];
    const fins = [];
    (rows || []).forEach((row, rowIndex) => {
      const sold = Math.max(0, Math.round(number(row.sold_count)));
      const financed = Math.max(0, Math.round(number(row.financed_count)));
      const store = String(row.store || "NÃO LOCALIZADO");
      const department = titleDepartment(row.department);
      const seller = String(row.seller_name || "NÃO INFORMADO");
      const model = String(row.model || "NÃO INFORMADO");
      for (let index = 0; index < sold; index += 1) {
        sales.push({
          loja: store,
          dept: department,
          vendedor: seller,
          modelo: model,
          valorVenda: distribute(number(row.sales_value), sold, index),
          origem: { "Data venda": recordDate, __secureAggregate: true, __row: rowIndex }
        });
      }
      // plan_breakdown particiona financed_count por tipo de plano (SUBSIDIADO/REVERSÃO/
      // COPARTICIPADO/BALÃO/LINEAR), calculado pela API segura com a mesma prioridade de
      // planTypeFromFields(). SPF não tem quebra por plano, por isso continua distribuído
      // pelo total financiado (spfIndex), não pelo subtotal de cada grupo.
      const planGroups = Array.isArray(row.plan_breakdown) && row.plan_breakdown.length
        ? row.plan_breakdown
        : (financed ? [{ plan_type: "LINEAR", financed_count: financed, production_value: row.production_value, return_value: row.return_value }] : []);
      let spfIndex = 0;
      planGroups.forEach(group => {
        const groupCount = Math.max(0, Math.round(number(group.financed_count)));
        const planType = String(group.plan_type || "LINEAR").toUpperCase();
        for (let index = 0; index < groupCount; index += 1) {
          fins.push({
            loja: store,
            dept: department,
            vendedor: seller,
            modelo: model,
            receita: distribute(number(group.return_value), groupCount, index),
            receitaSPF: distribute(number(row.spf_net_value), financed, spfIndex),
            producao: distribute(number(group.production_value), groupCount, index),
            parcelas: 0,
            pmt: 0,
            balaoValor: planType === "BALÃO" ? 1 : 0,
            planoClassificado: planType,
            isCoparticipadoFlag: planType === "COPARTICIPADO",
            isSubsidiadoFlag: planType === "SUBSIDIADO",
            isReversaoFlag: planType === "REVERSÃO",
            isBalaoFlag: planType === "BALÃO",
            matched: true,
            origem: { "Data Venda": recordDate, __secureAggregate: true, __row: rowIndex }
          });
          spfIndex += 1;
        }
      });
    });
    return { sales, fins };
  }

  function previousPeriod(start, end) {
    if (typeof window.getPreviousMonthComparablePeriod === "function") {
      return window.getPreviousMonthComparablePeriod(start, end);
    }
    return {
      start: new Date(start.getFullYear(), start.getMonth() - 1, start.getDate()),
      end: new Date(end.getFullYear(), end.getMonth() - 1, end.getDate())
    };
  }

  async function fetchMetrics(start, end) {
    const response = await client.rpc("operational_metrics", { p_start: iso(start), p_end: iso(end) });
    if (response.error) throw response.error;
    const payload = response.data || {};
    if (!Array.isArray(payload.rows)) throw new Error("A API segura retornou uma resposta incompleta.");
    if (payload.contains_personal_documents || payload.contains_client_identity || payload.contains_chassis) {
      throw new Error("A resposta segura contém campos não autorizados.");
    }
    return payload;
  }

  function renderFailure(error) {
    console.error("[Análise Geral segura]", error);
    const status = document.getElementById("status");
    const wrap = document.getElementById("autoStatusWrap");
    if (wrap) wrap.style.display = "flex";
    if (status) status.innerHTML = `<span class="bad">Não foi possível carregar os indicadores autorizados. ${String(error && error.message || "")}</span>`;
  }

  async function loadSecureDashboard() {
    const sequence = ++requestSequence;
    const start = currentPeriodFilter && currentPeriodFilter.start;
    const end = currentPeriodFilter && currentPeriodFilter.end;
    if (!client || !secureMode) {
      renderFailure(new Error("Configuração segura indisponível."));
      return;
    }
    if (!start || !end || start > end) {
      renderFailure(new Error("Informe um período válido."));
      return;
    }
    const status = document.getElementById("status");
    const wrap = document.getElementById("autoStatusWrap");
    if (wrap) wrap.style.display = "flex";
    if (status) status.textContent = "Carregando indicadores autorizados...";
    try {
      const previous = previousPeriod(start, end);
      const [currentPayload, previousPayload] = await Promise.all([
        fetchMetrics(start, end),
        fetchMetrics(previous.start, previous.end)
      ]);
      if (sequence !== requestSequence) return;
      const current = metricsToLegacy(currentPayload.rows, iso(end));
      const prior = metricsToLegacy(previousPayload.rows, iso(previous.end));
      const results = {
        sales: prior.sales.concat(current.sales),
        fins: prior.fins.concat(current.fins),
        excluded: [],
        semMatch: [],
        secureScope: currentPayload.scope || {},
        secureSource: true
      };
      results.aggs = window.aggregate(results);
      lastResults = results;
      currentFilteredResults = null;
      render(results);
      if (status) status.innerHTML = '<span class="ok">Indicadores carregados pela API segura.</span>';
      if (wrap) wrap.style.display = "flex";
    } catch (error) {
      if (sequence === requestSequence) renderFailure(error);
    }
  }

  function setInputs(start, end) {
    const startInput = document.getElementById("dateStart");
    const endInput = document.getElementById("dateEnd");
    if (startInput) startInput.value = iso(start);
    if (endInput) endInput.value = iso(end);
  }

  function initializePeriod() {
    const end = new Date();
    const start = new Date(end);
    start.setDate(start.getDate() - 731);
    currentPeriodFilter = { start, end, mode: "secureDefault" };
    setInputs(start, end);
  }

  window.applyPeriodFromInputs = function () {
    const start = safeDate(document.getElementById("dateStart").value);
    const end = safeDate(document.getElementById("dateEnd").value);
    currentPeriodFilter = { start, end, mode: "custom" };
    loadSecureDashboard();
  };

  window.clearPeriodFilter = function () {
    initializePeriod();
    loadSecureDashboard();
  };

  window.setQuickPeriod = function (mode) {
    const today = new Date();
    let start;
    let end = today;
    if (mode === "currentMonth") start = new Date(today.getFullYear(), today.getMonth(), 1);
    else if (mode === "lastMonth") {
      start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      end = new Date(today.getFullYear(), today.getMonth(), 0);
    } else if (mode === "last6") start = new Date(today.getFullYear(), today.getMonth() - 5, 1);
    else if (mode === "lastYear") start = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate());
    else return;
    currentPeriodFilter = { start, end, mode };
    setInputs(start, end);
    document.querySelectorAll(".quickBtn").forEach(button => button.classList.toggle("active", (button.getAttribute("onclick") || "").includes(`'${mode}'`)));
    loadSecureDashboard();
  };

  window.processar = loadSecureDashboard;

  document.addEventListener("DOMContentLoaded", function () {
    const diagnostic = document.getElementById("diagnosticoBasesNovas");
    if (diagnostic) diagnostic.style.display = "none";
    initializePeriod();
    loadSecureDashboard();
  });
})();
