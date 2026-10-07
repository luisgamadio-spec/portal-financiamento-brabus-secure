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

const COMPARTILHADAS = ["activation-lookup", "activation-request", "activation-complete", "confirm-access-activation", "confirm-email-migration",
  "admin-invite-user", "admin-generate-user-access-link"];
for (const [fn, nome] of [["brabus-intelligence", "ORIGENS"], ["password-recovery-request", "ALLOWED_ORIGINS"], ["password-recovery-complete", "ALLOWED_ORIGINS"],
  ...COMPARTILHADAS.map((f) => [f, "ALLOWED_ORIGINS"])]) {
  Deno.test(`${fn}: aceita o piloto e mantém as origens de antes`, async () => {
    const o = conjunto(await fonte(fn), nome);
    assert(o.includes(PILOTO), JSON.stringify(o));
    for (const a of ANTES) assert(o.includes(a), `perdeu ${a}`);
  });
}

for (const [fn, constante] of [["admin-invite-user", "PRODUCTION_INVITE_REDIRECT"], ["admin-generate-user-access-link", "PRODUCTION_ACCESS_REDIRECT"]]) {
  Deno.test(`${fn}: convite pedido no piloto vai para o primeiro-acesso do piloto; qualquer outra origem mantém o destino de produção`, async () => {
    const t = await fonte(fn);
    assert(t.includes(`const ${constante} = "https://brabus.blistiq.com.br/primeiro-acesso.html"`), "destino de produção mudou");
    const usos = [...t.matchAll(/redirectTo: ([^,}\n]+(?:\)[^,}\n]*)?)/g)].map((m) => m[1].trim());
    assertEquals(usos.length, 1);
    assertEquals(usos[0], `(req.headers.get("origin") === "${PILOTO}" ? "${PILOTO}/primeiro-acesso.html" : ${constante})`);
  });
}

// Reserva do oficial em v1.brabus (troca de endereço): as 11 funções que o oficial usa aceitam v1 sem perder as de antes.
const V1 = "https://v1.brabus.blistiq.com.br";
const USADAS_PELO_OFICIAL = ["activation-lookup", "activation-request", "activation-complete", "confirm-access-activation", "confirm-email-migration",
  "admin-invite-user", "admin-resend-user-invite", "admin-generate-user-access-link", "admin-generate-legacy-migration-link", "portal-ai"];
for (const fn of USADAS_PELO_OFICIAL) {
  Deno.test(`${fn}: aceita a reserva v1 e mantém as origens de antes`, async () => {
    const o = conjunto(await fonte(fn), "ALLOWED_ORIGINS");
    assert(o.includes(V1), JSON.stringify(o));
    for (const a of ["https://brabus.blistiq.com.br", "https://luisgamadio-spec.github.io", "http://localhost:8080", "http://127.0.0.1:8080"]) assert(o.includes(a), `perdeu ${a}`);
  });
}
Deno.test("request-email-migration: pedido feito na reserva v1 recebe o link da página da própria reserva; o resto não muda", async () => {
  const t = await fonte("request-email-migration");
  const m = t.match(/const ALLOWED_ORIGINS = \{([\s\S]*?)\};/);
  assert(m);
  const mapa = Object.fromEntries([...m![1].matchAll(/"([^"]+)":\s*"([^"]+)"/g)].map((x) => [x[1], x[2]]));
  assertEquals(mapa[V1], `${V1}/verificar-email.html`);
  assertEquals(mapa["https://brabus.blistiq.com.br"], "https://brabus.blistiq.com.br/verificar-email.html");
  assertEquals(Object.keys(mapa).length, 5);
});

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
