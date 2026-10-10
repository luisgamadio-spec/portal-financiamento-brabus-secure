import { assert, assertEquals } from "./assert.ts";
import { faixaScore, scoresDoServidor } from "../data/score.ts";

const PAYLOAD = {
  rows: [
    { vendedor: "ANA SOUZA", loja: "EUROPA", departamento: "Novos", score: 760, vendas: 6, financiados: 3, share: 0.5, spf_qtd: 1, plano_mais_vendido: "LINEAR",
      composicao: [{ item: "Volume de vendas", pontos: 200, maximo: 250, vendas: 6, referencia: 8 }, { item: "Retorno médio", pontos: 80, maximo: 160, financiados: 3 }] },
    { vendedor: "BRUNO LIMA", loja: "ABC", departamento: "Seminovos", score: 910, vendas: 9, financiados: 5, share: 0.55, spf_qtd: 2, plano_mais_vendido: "BALÃO",
      retorno_medio_pct: 6.25, composicao: [{ item: "Retorno médio", pontos: 210, maximo: 280, financiados: 5 }] },
    { vendedor: "CARLA DIAS", loja: "EUROPA", departamento: "Novos", score: 290, vendas: 1, financiados: 0, share: 0, spf_qtd: 0, plano_mais_vendido: "—", composicao: [] },
  ],
};

Deno.test("Score do servidor: mesmas faixas da tela do V2", () => {
  assertEquals([900, 899, 750, 749, 550, 549, 300, 299, 0].map(faixaScore),
    ["Elite", "Alta performance", "Alta performance", "Performance", "Performance", "Desenvolvimento", "Desenvolvimento", "Crítico", "Crítico"]);
});

Deno.test("Score do servidor: nota e pontos vêm do servidor, ordenados; filtros de loja e departamento", () => {
  const todos = scoresDoServidor(PAYLOAD, null, null);
  assertEquals(todos.map((x) => x.vendedor), ["BRUNO LIMA", "ANA SOUZA", "CARLA DIAS"]);
  assertEquals(todos[1].composicao.map((c) => [c.item, c.pontos, c.maximo]), [["Volume de vendas", 200, 250], ["Retorno médio", 80, 160]]);
  assertEquals(todos[1].faixa, "Alta performance");
  assertEquals(scoresDoServidor(PAYLOAD, "Europa", null).map((x) => x.vendedor), ["ANA SOUZA", "CARLA DIAS"]);
  assertEquals(scoresDoServidor(PAYLOAD, null, "Seminovos").map((x) => x.vendedor), ["BRUNO LIMA"]);
});

Deno.test("Score do servidor: % de retorno só quando o servidor manda (perfil autorizado); nunca R$", () => {
  const [bruno, ana] = scoresDoServidor(PAYLOAD, null, null);
  assertEquals(bruno.retorno_medio, 0.0625);
  assertEquals(ana.retorno_medio, undefined);
  assert(!JSON.stringify(ana).includes("producao") && !JSON.stringify(ana).includes("return_value"));
});
