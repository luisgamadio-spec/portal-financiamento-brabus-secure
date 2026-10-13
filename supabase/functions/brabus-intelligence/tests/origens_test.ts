// Origens aceitas (CORS) e destino dos links de e-mail das funções do Portal.
// Desativação do v1 (13/10/2026): v1.brabus e v2.brabus saíram de todas as funções; produção
// (brabus.blistiq.com.br), homolog (luisgamadio-spec.github.io) e local continuam.
import { assert, assertEquals } from "./assert.ts";

const raiz = new URL("../../", import.meta.url);
const fonte = (fn: string) => Deno.readTextFile(new URL(`${fn}/index.ts`, raiz));
const V1 = "https://v1.brabus.blistiq.com.br";
const V2 = "https://v2.brabus.blistiq.com.br";
const HOMOLOG = "https://luisgamadio-spec.github.io/portal-fi-v2-homolog";
const ANTES = ["https://brabus.blistiq.com.br", "https://luisgamadio-spec.github.io", "http://localhost:8080", "http://127.0.0.1:8080"];

function conjunto(t: string, nome: string): string[] {
  const m = t.match(new RegExp(`const ${nome} = new Set\\(\\[([\\s\\S]*?)\\]`));
  assert(m, `${nome} não encontrado`);
  return [...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}
function mapa(t: string, nome: string): Record<string, string> {
  const m = t.match(new RegExp(`const ${nome}[^=]*= \\{([\\s\\S]*?)\\};`));
  assert(m, `${nome} não encontrado`);
  return Object.fromEntries([...m![1].matchAll(/"([^"]+)":\s*"([^"]+)"/g)].map((x) => [x[1], x[2]]));
}

const TODAS = ["activation-complete", "activation-lookup", "activation-request", "admin-generate-legacy-migration-link", "admin-generate-user-access-link",
  "admin-invite-user", "admin-resend-user-invite", "brabus-intelligence", "confirm-access-activation", "confirm-email-migration",
  "confirm-modern-onboarding-continuation", "password-recovery-complete", "password-recovery-request", "portal-ai", "reconcile-email-migration", "request-email-migration"];
for (const fn of TODAS) {
  Deno.test(`${fn}: não aceita mais v1.brabus nem v2.brabus`, async () => {
    const t = await fonte(fn);
    assert(!t.includes(V1) && !t.includes(V2), "ainda cita v1/v2");
  });
}

const COM_LISTA: [string, string][] = [["brabus-intelligence", "ORIGENS"], ["password-recovery-request", "ALLOWED_ORIGINS"], ["password-recovery-complete", "ALLOWED_ORIGINS"],
  ...["activation-lookup", "activation-request", "activation-complete", "confirm-access-activation", "confirm-email-migration", "admin-invite-user",
    "admin-generate-user-access-link", "admin-resend-user-invite", "admin-generate-legacy-migration-link", "portal-ai"].map((f) => [f, "ALLOWED_ORIGINS"] as [string, string])];
for (const [fn, nome] of COM_LISTA) {
  Deno.test(`${fn}: mantém produção, homolog e local`, async () => {
    const o = conjunto(await fonte(fn), nome);
    for (const a of ANTES) assert(o.includes(a), `perdeu ${a}`);
  });
}

for (const [fn, constante] of [["admin-invite-user", "PRODUCTION_INVITE_REDIRECT"], ["admin-generate-user-access-link", "PRODUCTION_ACCESS_REDIRECT"]]) {
  Deno.test(`${fn}: convite sempre vai para o primeiro-acesso de produção`, async () => {
    const t = await fonte(fn);
    assert(t.includes(`const ${constante} = "https://brabus.blistiq.com.br/primeiro-acesso.html"`), "destino de produção mudou");
    const usos = [...t.matchAll(/redirectTo: ([^,}\n]+)/g)].map((m) => m[1].trim());
    assertEquals(usos, [constante]);
  });
}

Deno.test("request-email-migration: link do e-mail volta para a página do próprio site (homolog → homolog, produção → produção)", async () => {
  const t = await fonte("request-email-migration");
  const m = mapa(t, "ALLOWED_ORIGINS");
  assertEquals(m["https://luisgamadio-spec.github.io"], `${HOMOLOG}/verificar-email.html`);
  assertEquals(m["https://brabus.blistiq.com.br"], "https://brabus.blistiq.com.br/verificar-email.html");
  assertEquals(Object.keys(m).length, 4);
  const cors = conjunto(t, "ALLOWED_CORS_ORIGINS");
  for (const a of ANTES) assert(cors.includes(a), `perdeu ${a}`);
});

Deno.test("password-recovery-request: link do e-mail volta para o próprio site; origem desconhecida vai para produção", async () => {
  const t = await fonte("password-recovery-request");
  const m = mapa(t, "ORIGIN_BASE_URL");
  assertEquals(m["https://luisgamadio-spec.github.io"], HOMOLOG);
  assertEquals(m["https://brabus.blistiq.com.br"], "https://brabus.blistiq.com.br");
  assert(t.includes('const DEFAULT_BASE_URL = "https://brabus.blistiq.com.br";'));
  assert(/\$\{origemFrontend\}\/index\.html#recuperar-senha=/.test(t));
});
