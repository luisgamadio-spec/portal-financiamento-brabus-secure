// Acesso pela lista do banco + registro de utilização (26/10/2026).
import { assertEquals, assert } from "./assert.ts";
import { Rpc } from "../data/rpc.ts";
import { LimiteLlm } from "../agent/llm.ts";
import { RpcError } from "../data/rpc.ts";
import { acessoLiberado, liberadoPeloSegredo, registrarPergunta, statusDoErro } from "../data/utilizacao.ts";
import { sanitizaParametros } from "../data/store.ts";

type Chamada = { fn: string; body: any };
function rpcFalso(resp: (fn: string, body: any) => { status: number; body: unknown }) {
  const chamadas: Chamada[] = [];
  const f = async (url: string, init?: RequestInit) => {
    const fn = url.split("/rest/v1/rpc/")[1];
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    chamadas.push({ fn, body });
    const r = resp(fn, body);
    return new Response(JSON.stringify(r.body), { status: r.status });
  };
  return { rpc: new Rpc("https://x.supabase.co", "k", "jwt", f as any), chamadas };
}
const HOJE = "MASTER,DIRETOR,GERENTE,ANALISTA,VENDEDOR"; // valor do segredo BI_PERFIS em 26/10/2026

Deno.test("acesso: decide pelo banco (bi_acesso_liberado), não pelo segredo", async () => {
  for (const liberado of [true, false]) {
    const { rpc, chamadas } = rpcFalso(() => ({ status: 200, body: { liberado, perfil: "X" } }));
    // o segredo diria o contrário — vale o banco
    assertEquals(await acessoLiberado(rpc, { perfil: liberado ? "RH" : "MASTER", perfil_bruto: "" }, HOJE), liberado);
    assertEquals(chamadas.map((c) => c.fn), ["bi_acesso_liberado"]);
  }
});

Deno.test("acesso: função ausente no banco (404) → volta à regra do segredo, perfil por perfil", async () => {
  const { rpc } = rpcFalso(() => ({ status: 404, body: { code: "PGRST202", message: "not found" } }));
  for (const [perfil, esperado] of [["MASTER", true], ["DIRETOR", true], ["GERENTE", true], ["ANALISTA", true], ["VENDEDOR", true], ["RH", false]] as const) {
    assertEquals(await acessoLiberado(rpc, { perfil, perfil_bruto: perfil }, HOJE), esperado, perfil);
  }
});

Deno.test("acesso: outro erro do banco não libera nem cai no segredo (propaga)", async () => {
  const { rpc } = rpcFalso(() => ({ status: 500, body: { message: "falha" } }));
  let erro: unknown = null;
  try { await acessoLiberado(rpc, { perfil: "MASTER", perfil_bruto: "MASTER" }, HOJE); } catch (e) { erro = e; }
  assert(erro instanceof RpcError && erro.status === 500);
});

Deno.test("segredo (reserva): mesma regra de antes", () => {
  assert(liberadoPeloSegredo({ perfil: "DIRETOR", perfil_bruto: "DIRETOR_NOVOS" }, HOJE));
  assert(!liberadoPeloSegredo({ perfil: "RH", perfil_bruto: "RH" }, HOJE));
  assert(liberadoPeloSegredo({ perfil: "MASTER", perfil_bruto: "MASTER" }, undefined));
  assert(!liberadoPeloSegredo({ perfil: "VENDEDOR", perfil_bruto: "VENDEDOR" }, undefined)); // padrão do segredo: só MASTER
});

Deno.test("registro: só nomes de ferramenta, sem repetir, canal/status/duração", async () => {
  const { rpc, chamadas } = rpcFalso(() => ({ status: 204, body: null }));
  await registrarPergunta(rpc, { sessao: "s1", canal: "voz", ferramentas: ["simular_financiamento", "simular_financiamento", "consultar_score"], status: "ok", duracaoMs: 1234.6 });
  assertEquals(chamadas.length, 1);
  assertEquals(chamadas[0].fn, "bi_registrar_pergunta");
  assertEquals(chamadas[0].body, { p_sessao: "s1", p_canal: "voz", p_ferramentas: ["simular_financiamento", "consultar_score"], p_status: "ok", p_duracao_ms: 1235 });
  assert(!JSON.stringify(chamadas[0].body).includes("pergunta\""), "nada de texto da pergunta no registro");
});

Deno.test("registro: falha ao gravar nunca derruba a resposta", async () => {
  const { rpc } = rpcFalso(() => ({ status: 500, body: { message: "fora do ar" } }));
  const erroOriginal = console.error; console.error = () => {};
  try { await registrarPergunta(rpc, { sessao: "s", canal: "texto", ferramentas: [], status: "erro", duracaoMs: 1 }); }
  finally { console.error = erroOriginal; }
});

Deno.test("status do erro: limite, negado, erro; sessão expirada não registra", () => {
  assertEquals(statusDoErro(new LimiteLlm(30)), "limite");
  assertEquals(statusDoErro(new RpcError("x", 403, "42501", "negado")), "negado");
  assertEquals(statusDoErro(new RpcError("x", 401, null, "expirada")), null);
  assertEquals(statusDoErro(new RpcError("x", 500, null, "falha")), "erro");
  assertEquals(statusDoErro(new Error("qualquer")), "erro");
});

Deno.test("auditoria: texto da pergunta omitido; sim/não e nomes de colegas mantidos", () => {
  const p = sanitizaParametros({ pergunta: "como faço X?", pergunta_financeira_direta: true, pessoa: "Fulano", vendedor: "Beltrano", mensagem: "oi", cpf: "1" }) as any;
  assertEquals(p.pergunta, "[omitido]");
  assertEquals(p.mensagem, "[omitido]");
  assertEquals(p.cpf, "[omitido]");
  assertEquals(p.pergunta_financeira_direta, true);
  assertEquals(p.pessoa, "Fulano");
  assertEquals(p.vendedor, "Beltrano");
});
