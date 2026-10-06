// Origens aceitas (CORS) e destino dos links de e-mail das funções do V2: o piloto de produção
// (v2.brabus.blistiq.com.br) entra sem tirar nenhuma origem que já existia.
import { assert, assertEquals } from "./assert.ts";

const raiz = new URL("../../", import.meta.url);
const fonte = (fn: string) => Deno.readTextFile(new URL(`${fn}/index.ts`, raiz));
const PILOTO = "https://v2.brabus.blistiq.com.br";
const ANTES = ["https://brabus.blistiq.com.br", "https://luisgamadio-spec.github.io", "http://localhost:8080", "http://127.0.0.1:8080"];

function conjunto(t: string, nome: string): string[] {
  const m = t.match(new RegExp(`const ${nome} = new Set\\(\\[([\\s\\S]*?)\\]`));
  assert(m, `${nome} não encontrado`);
  return [...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

for (const [fn, nome] of [["brabus-intelligence", "ORIGENS"], ["password-recovery-request", "ALLOWED_ORIGINS"], ["password-recovery-complete", "ALLOWED_ORIGINS"]]) {
  Deno.test(`${fn}: aceita o piloto e mantém as origens de antes`, async () => {
    const o = conjunto(await fonte(fn), nome);
    assert(o.includes(PILOTO), JSON.stringify(o));
    for (const a of ANTES) assert(o.includes(a), `perdeu ${a}`);
  });
}

Deno.test("password-recovery-request: link do e-mail pedido no piloto volta para o piloto; os outros não mudam", async () => {
  const t = await fonte("password-recovery-request");
  const m = t.match(/const ORIGIN_BASE_URL[^=]*= \{([\s\S]*?)\};/);
  assert(m);
  const mapa = Object.fromEntries([...m![1].matchAll(/"([^"]+)":\s*"([^"]+)"/g)].map((x) => [x[1], x[2]]));
  assertEquals(mapa[PILOTO], PILOTO);
  assertEquals(mapa["https://brabus.blistiq.com.br"], "https://brabus.blistiq.com.br");
  assertEquals(mapa["https://luisgamadio-spec.github.io"], "https://luisgamadio-spec.github.io/portal-fi-v2");
  assert(/\$\{origemFrontend\}\/index\.html#recuperar-senha=/.test(t));
});
