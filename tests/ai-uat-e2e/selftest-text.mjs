// Harness self-test: exercises the running TEXT homolog (against the
// mock backend) directly over HTTP, before layering browser automation
// on top. Not the final Playwright suite -- a fast sanity pass on the
// mock+bootstrap plumbing itself.
const BASE = process.argv[2] || "http://127.0.0.1:8801";

async function call(message, conversation = [], authHeader = "Bearer uat-mock-access-token") {
  const resp = await fetch(BASE + "/", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: authHeader, apikey: "uat-anon-key" },
    body: JSON.stringify({ message, conversation })
  });
  const body = await resp.json().catch(() => null);
  return { status: resp.status, body };
}

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`[PASS] ${label}`); }
  else { fail++; console.log(`[FAIL] ${label}${detail ? " -- " + JSON.stringify(detail) : ""}`); }
}

const scenarios = [
  ["Basic resultado", "Qual foi o resultado do mês passado?", "consultar_resultado"],
  ["Linear 36m", "Simula um financiamento linear de um veículo novo de R$ 120.000, com R$ 30.000 de entrada, em 36 meses.", "simular_financiamento"],
  ["Balão", "Simula um financiamento com balão de R$ 40.000 num veículo de R$ 150.000, entrada de R$ 20.000, em 36 meses.", "simular_financiamento"],
  ["Coparticipado", "Quero simular Coparticipado para a L200 Triton, R$ 200.000, entrada R$ 120.000, 24 meses.", "simular_financiamento"],
  ["Subsidiado", "Quais as condições de Taxas Subsidiadas para um bem de R$ 90.000 com entrada de R$ 50.000?", "simular_financiamento"],
  ["Negative/ineligible", "Simula uma Taxas Subsidiadas para um bem de R$ 50.000 com entrada de R$ 10.000", "simular_financiamento"],
  ["Taxa Implícita", "Um cliente financiou R$ 100.000 em 36x de R$ 4.485,75. Qual a taxa implícita desse contrato?", "calcular_taxa_financiamento"],
  ["Antecipação sem due date", "Quero simular a antecipação de um contrato com saldo de R$ 50.000, sem informar a data da próxima parcela.", "simular_antecipacao"],
  ["Cash Conversion basic", "Vale mais a pena o cliente pagar à vista R$ 50.000 ou financiar e deixar o dinheiro aplicado por 12 meses?", "simular_cash_conversion"],
  ["Cash Conversion custom rate", "E se a taxa de aplicação fosse 2% ao mês em vez da taxa oficial?", "simular_cash_conversion"]
];

for (const [label, message, expectedTool] of scenarios) {
  const { status, body } = await call(message);
  check(`${label}: HTTP 200`, status === 200, { status, body });
  check(`${label}: dispatched ${expectedTool}`, body?._homolog_debug?.tools_used?.includes(expectedTool), body?._homolog_debug);
  check(`${label}: no error field in tool result`, !body?._homolog_debug?.calls?.some((c) => c.result?.error), body?._homolog_debug?.calls);
}

// ---- Multi-turn + Novo Cliente ----
{
  const r1 = await call("Simula um financiamento linear de um veículo novo de R$ 120.000, com R$ 30.000 de entrada, em 36 meses.");
  const conv = [
    { role: "user", content: "Simula um financiamento linear de um veículo novo de R$ 120.000, com R$ 30.000 de entrada, em 36 meses." },
    { role: "assistant", content: r1.body.reply }
  ];
  const r2 = await call("E se fosse 48 meses em vez de 36?", conv);
  check("Multi-turn: follow-up dispatches simular_financiamento again with reused vehicle", r2.body?._homolog_debug?.calls?.[0]?.args?.vehicle_value === 120000, r2.body?._homolog_debug);
  check("Multi-turn: follow-up uses term_months=48", r2.body?._homolog_debug?.calls?.[0]?.args?.term_months === 48, r2.body?._homolog_debug);

  const conv2 = [...conv, { role: "user", content: "E se fosse 48 meses em vez de 36?" }, { role: "assistant", content: r2.body.reply }];
  const r3 = await call("Beleza, agora é outro cliente, esquece esse", conv2);
  check("Novo Cliente: HTTP 200", r3.status === 200);
  check("Novo Cliente: scenario_reset=true", r3.body?.scenario_reset === true, r3.body);
  check("Novo Cliente: iniciar_novo_cliente was the tool dispatched", r3.body?._homolog_debug?.tools_used?.includes("iniciar_novo_cliente"), r3.body?._homolog_debug);
}

// ---- Security negatives ----
{
  const noAuth = await call("oi", [], "");
  check("Security: missing/invalid token -> HTTP 401", noAuth.status === 401, noAuth);

  const nonMaster = await call("oi", [], "Bearer uat-mock-non-master-access-token");
  check("Security: authenticated non-MASTER -> HTTP 403", nonMaster.status === 403, nonMaster);
}

console.log(`\n=== TEXT harness self-test: ${pass}/${pass + fail} ===`);
process.exit(fail === 0 ? 0 : 1);
