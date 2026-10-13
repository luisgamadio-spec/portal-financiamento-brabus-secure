// Cash Conversion v2: o motor da IA é o MESMO arquivo dos simuladores do Portal, e bate com uma conta independente.
// Vetores: tests/fixtures/cash_v2_vectors.json, gerados por uma implementação em Python escrita a partir da regra
// (não do motor). O mesmo arquivo de vetores é conferido no navegador, na tela do homolog.
import { assert, assertAlmostEquals, assertEquals } from "./assert.ts";
import "../engine/cash-conversion-v2.js";

// deno-lint-ignore no-explicit-any
const E = (globalThis as any).NX_CASH_V2;
const V = JSON.parse(Deno.readTextFileSync(new URL("./fixtures/cash_v2_vectors.json", import.meta.url)));
/** sha256 do texto com fim de linha LF (o mesmo critério do versionamento de assets do Portal). */
async function sha(u: URL): Promise<string> {
  const bytes = new TextEncoder().encode((await Deno.readTextFile(u)).replace(/\r\n/g, "\n"));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.test("motor: o arquivo da IA é idêntico ao registrado para a tela (sha256)", async () => {
  const atual = await sha(new URL("../engine/cash-conversion-v2.js", import.meta.url));
  const registrado = Deno.readTextFileSync(new URL("./fixtures/cash_v2.sha256", import.meta.url)).trim();
  assertEquals(atual, registrado, "o motor mudou: atualize a tela (assets/js/adapters/cash-conversion-v2.js) e o sha registrado juntos");
  const front = Deno.env.get("CASH_V2_FRONT");
  if (front) assertEquals(await sha(new URL(`file:///${front.replace(/\\/g, "/").replace(/^\//, "")}`)), atual, "cópia da tela diferente da IA");
});

for (const c of V.casos) {
  Deno.test(`vetor ${c.nome}: CET, ganho líquido, IR, saldo e ponto de equilíbrio batem com a conta independente`, () => {
    const r = E.calcular({ capital: c.capital, fluxo: c.fluxo, referencias: V.referencias, dataBase: V.data_base });
    assert(!r.erro, r.erro);
    assertAlmostEquals(r.cet_am_pct, c.cet_am_pct, 1e-5, "CET");
    for (const cen of ["focus", "cdi_constante"]) {
      c.cenarios[cen].forEach((x: any, k: number) => {
        const p = r.cenarios[cen].produtos[k], m = `${cen} ${x.id}`;
        assertEquals(p.id, x.id);
        assertAlmostEquals(p.ganho_liquido, x.ganho_liquido, 0.011, `${m} ganho`);
        assertAlmostEquals(p.ir_total, x.ir_total, 0.011, `${m} IR`);
        assertAlmostEquals(p.saldo_final_liquido, x.saldo_final_liquido, 0.011, `${m} saldo`);
        assertAlmostEquals(p.aportes_do_bolso, x.aportes_do_bolso, 0.011, `${m} do bolso`);
        assertEquals(p.mes_dinheiro_acaba, x.mes_dinheiro_acaba, `${m} mês em que acaba`);
        assertAlmostEquals(p.ponto_equilibrio_cet_am_pct, x.ponto_equilibrio_cet_am_pct, 1e-4, `${m} equilíbrio`);
        assertEquals(p.resultado, Math.round(x.ganho_liquido * 100) === 0 ? "EQUIVALENTE" : x.ganho_liquido > 0 ? "FINANCIAR_COMPENSA" : "A_VISTA_COMPENSA", `${m} resultado`);
      });
    }
  });
}

const caso = (nome: string) => V.casos.find((c: any) => c.nome === nome);
const roda = (nome: string, ref = V.referencias) => { const c = caso(nome); return E.calcular({ capital: c.capital, fluxo: c.fluxo, referencias: ref, dataBase: V.data_base }); };

Deno.test("honestidade: frase do cliente sem 'garantido', 'sem risco' ou 'lucro certo'; diz estimativa, líquido e a fonte", () => {
  for (const c of V.casos) {
    const r = roda(c.nome);
    const tudo = [r.frase_cliente, r.leitura_taxas, ...r.avisos].join(" ").toLowerCase();
    for (const proibida of ["garantido.", "é garantido", "sem risco", "lucro certo", "rendimento certo"]) assert(!tudo.includes(proibida), `${c.nome}: "${proibida}"`);
    assert(r.frase_cliente.startsWith("Estimativa"), c.nome);
    assert(/Não há garantia|maior que o rendimento líquido/.test(r.frase_cliente), c.nome);
    assert(r.fonte.includes("13/10/2026") && r.fonte.includes("Banco Central") && r.fonte.includes("Focus"), r.fonte);
    assertEquals(r.rodape, "Material informativo, não é recomendação de investimento. Confirme com o seu banco ou assessor de investimentos.");
  }
});

Deno.test("quando o financiamento custa mais que o rendimento: diz que pagar à vista sai mais barato e que reserva não é ganho", () => {
  const r = roda("linear_48x_1_49");
  assert(r.cenarios.focus.produtos.every((p: any) => p.resultado === "A_VISTA_COMPENSA"));
  assert(r.frase_cliente.includes("pagar à vista sai mais barato") && r.frase_cliente.includes("não é ganho em dinheiro"), r.frase_cliente);
});

Deno.test("Taxa 0%: financiar compensa nas três aplicações, com faixa em R$", () => {
  const r = roda("taxa_zero_24x_semestral");
  assert(r.cenarios.focus.produtos.every((p: any) => p.resultado === "FINANCIAR_COMPENSA"));
  assert(/sobrariam entre R\$ [\d.]+,\d\d e R\$ [\d.]+,\d\d líquidos de IR/.test(r.frase_cliente), r.frase_cliente);
});

Deno.test("Selic em queda (Focus) rende menos que o CDI atual constante", () => {
  for (const c of V.casos) {
    const r = roda(c.nome);
    r.cenarios.focus.produtos.forEach((p: any, k: number) => assert(p.ganho_liquido <= r.cenarios.cdi_constante.produtos[k].ganho_liquido + 0.01, `${c.nome} ${p.id}`));
  }
});

Deno.test("1,12% não é base: a leitura usa o CDI atual e cita a média de 12 meses como passado", () => {
  const r = roda("coparticipado_36x");
  assert(r.leitura_taxas.includes("CDI atual de 13,65% a.a. (cerca de 1,07% a.m.)"), r.leitura_taxas);
  assert(r.leitura_taxas.includes("últimos 12 meses (CDI de 14,47%, cerca de 1,13% a.m.) é passado"), r.leitura_taxas);
});

Deno.test("avisos: referência com mais de 50 dias, FGC acima de R$ 250 mil, dinheiro que acaba, carência da LCI/LCA, custos do Tesouro", () => {
  const velha = roda("coparticipado_36x", { ...V.referencias, dias_desde_vigencia: 51, desatualizada: true });
  assert(velha.avisos[0].includes("são de 13/10/2026 (há 51 dias) e podem estar desatualizadas"), velha.avisos[0]);
  assert(!roda("coparticipado_36x").avisos.some((a: string) => a.includes("desatualizadas")));
  assert(roda("acima_fgc_12x").avisos.some((a: string) => a.includes("O FGC garante até R$ 250.000,00 por CPF por instituição (teto de R$ 1.000.000,00 a cada 4 anos)")));
  assert(!roda("coparticipado_36x").avisos.some((a: string) => a.includes("FGC")));
  assert(roda("dinheiro_acaba_60x").avisos.some((a: string) => /acaba no mês \d+; os pagamentos seguintes sairiam do bolso/.test(a)));
  const r = roda("coparticipado_36x");
  assert(r.avisos.some((a: string) => a.includes("LCI/LCA 85% do CDI costuma ter carência")));
  assert(r.avisos.some((a: string) => a.includes("Tesouro Selic é título público (risco soberano)")));
});

Deno.test("entradas inválidas: mensagens claras, sem número inventado", () => {
  const ref = V.referencias, f = [{ mes: 1, valor: 100 }];
  assert(E.calcular({ capital: 0, fluxo: f, referencias: ref, dataBase: "2026-10-13" }).erro);
  assert(E.calcular({ capital: 1000, fluxo: [], referencias: ref, dataBase: "2026-10-13" }).erro);
  assert(E.calcular({ capital: 1000, fluxo: f, referencias: null, dataBase: "2026-10-13" }).erro.includes("indisponíveis"));
  assert(E.calcular({ capital: 1000, fluxo: f, referencias: ref, dataBase: "13/10/2026" }).erro);
});
