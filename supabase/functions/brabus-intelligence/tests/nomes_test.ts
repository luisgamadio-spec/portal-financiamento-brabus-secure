// Busca de pessoas tolerante a grafia.
import { assert, assertEquals } from "./assert.ts";
import { filtraPorNome, fonetica, semelhancaNome } from "../data/nomes.ts";

const P = ["WILLIAM SYMARO", "WILSON TESTONI", "WILLIAN EXEMPLO", "DOUGLAS FERREIRA", "DOUGLAS FICTICIO", "LUIZ CARLITO", "THAIS TESTEIRA"];

Deno.test("fonética: grafias que soam igual viram a mesma forma", () => {
  assertEquals(fonetica("William"), fonetica("Wilian"));
  assertEquals(fonetica("Symaro"), fonetica("Simaro"));
  assertEquals(fonetica("Luiz"), fonetica("Luis"));
  assertEquals(fonetica("Thais"), fonetica("Tais"));
});

Deno.test("filtraPorNome: exato tem prioridade; aproximado só quando não acha", () => {
  const ex = filtraPorNome("Douglas Ferreira", P, (x) => x);
  assertEquals(ex, { itens: ["DOUGLAS FERREIRA"], aproximado: false });
  const ap = filtraPorNome("Wilian Simaro", P, (x) => x);
  assertEquals(ap.itens, ["WILLIAM SYMARO"]);
  assertEquals(ap.aproximado, true);
  assertEquals(filtraPorNome("Luis Carlito", P, (x) => x).itens, ["LUIZ CARLITO"]);
  assertEquals(filtraPorNome("Tais", P, (x) => x).itens, ["THAIS TESTEIRA"]);
});

Deno.test("filtraPorNome: não inventa pessoa quando nada é parecido", () => {
  assertEquals(filtraPorNome("Fulano de Tal", P, (x) => x).itens, []);
  assertEquals(filtraPorNome("Roberto", P, (x) => x).itens, []);
  assert(semelhancaNome("Wilian Simaro", "WILSON TESTONI") === 0);
});

Deno.test("filtraPorNome: só o primeiro nome parecido traz todos os candidatos próximos (vira pergunta 'qual deles?')", () => {
  const r = filtraPorNome("Wiliam", P, (x) => x);
  assert(r.itens.includes("WILLIAM SYMARO") && r.itens.includes("WILLIAN EXEMPLO"), JSON.stringify(r));
  assert(!r.itens.includes("WILSON TESTONI"));
});

Deno.test("fonética: C antes de E/I, vogal final fraca, CH/SH, QU/GU", () => {
  assertEquals(fonetica("Cinara"), fonetica("Synara"));
  assertEquals(fonetica("Silve"), fonetica("Cilv"));
  assertEquals(fonetica("Cintia"), fonetica("Sintia"));
  assertEquals(fonetica("Shirlei"), fonetica("Xirley"));
  assertEquals(fonetica("Henrique"), fonetica("Enrrique"));
  assertEquals(filtraPorNome("Pedro Cilv", ["PEDRO SYLVE", "PEDRO SANTOS"], (x) => x).itens, ["PEDRO SYLVE"]);
});
