import { assert, assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { consultarSimulado, filtrarRetorno } from "./fornecedor.ts";

Deno.test("filtro descarta dados do proprietário e campos desconhecidos", () => {
  const r = filtrarRetorno({
    ano_fabricacao: 2022, cor: "branco",
    proprietario: { nome: "X", documento: "123" }, cpf: "123", nome_proprietario: "Y", endereco: "Z",
    versoes: [{ marca: "m", modelo: "eclipse cross", versao: "hpe", fipe_codigo: "001", fipe_valor: 100000,
                fipe_mes_ref: "2026-10", ano_modelo: 2023, combustivel: "gasolina", chassi: "INVALIDO",
                proprietario: "W", renavam: "999" }],
    restricoes: { gravame: true, leilao: "sim", sinistro: false, credor: "BANCO X" },
  });
  const texto = JSON.stringify(r);
  for (const proibido of ["proprietario", "documento", "cpf", "nome_proprietario", "endereco", "renavam", "credor", "BANCO X", "\"W\""]) {
    assert(!texto.includes(proibido), `vazou: ${proibido}`);
  }
  assertEquals(Object.keys(r).sort(), ["ano_fabricacao", "cor", "restricoes", "versoes"]);
  assertEquals(Object.keys(r.versoes[0]).sort(),
    ["ano_modelo", "chassi", "combustivel", "fipe_codigo", "fipe_mes_ref", "fipe_valor", "marca", "modelo", "versao"]);
  assertEquals(r.versoes[0].chassi, null);          // chassi fora do padrão não passa
  assertEquals(r.restricoes.leilao, null);          // só booleano passa
  assertEquals(r.versoes[0].modelo, "ECLIPSE CROSS");
});

Deno.test("versão sem código FIPE, ano ou modelo é descartada", () => {
  const r = filtrarRetorno({ versoes: [{ modelo: "X", ano_modelo: 2020 }, { fipe_codigo: "1", ano_modelo: 1800, modelo: "Y" }, "lixo"] });
  assertEquals(r.versoes.length, 0);
});

Deno.test("simulado: determinístico, marcado como simulado, sem proprietário, restrições pelo final da placa", () => {
  const a = consultarSimulado({ placa: "ABC1D27", chassi: null }, new Date("2026-10-27"));
  const b = consultarSimulado({ placa: "ABC1D27", chassi: null }, new Date("2026-10-27"));
  assertEquals(a, b);
  assert(a.simulado && a.custo === 0 && a.fornecedor === "SIMULADO");
  assert(a.retorno.versoes.length >= 2 && a.retorno.versoes.every((v) => v.fipe_codigo.startsWith("SIM-")));
  assert(!JSON.stringify(a).includes("FULANO"));
  assertEquals(a.retorno.restricoes, { gravame: true, leilao: false, sinistro: false });
  assertEquals(consultarSimulado({ placa: "ABC1D28", chassi: null }).retorno.restricoes.leilao, true);
  assertEquals(consultarSimulado({ placa: "ABC1D29", chassi: null }).retorno.restricoes.sinistro, true);
});
