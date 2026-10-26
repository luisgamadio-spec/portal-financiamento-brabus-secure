// Acesso e utilização da Brabus Intelligence (26/10/2026).
// - Acesso: a lista de perfis fica no banco (configuracoes.ia_perfis_liberados — todos, exceto RH/DP; decisão do Luis)
//   e é decidida no servidor por bi_acesso_liberado(). O segredo BI_PERFIS só vale se essa função não existir no banco
//   (ex.: depois de um desfazer da migração 20261026120000).
// - Utilização: 1 registro por pergunta em bi_uso_perguntas (bi_registrar_pergunta), SÓ com nomes de ferramenta,
//   canal, status e duração. Nunca o texto da pergunta nem parâmetros. Falha ao registrar nunca derruba a resposta.

import { LimiteLlm } from "../agent/llm.ts";
import { type Rpc, RpcError } from "./rpc.ts";

export type PerfilUsuario = { perfil: string; perfil_bruto: string };

/** Regra antiga (segredo BI_PERFIS), mantida só como reserva. */
export function liberadoPeloSegredo(usuario: PerfilUsuario, perfis: string | undefined): boolean {
  const liberados = (perfis ?? "MASTER").split(",").map((s) => s.trim().toUpperCase());
  return liberados.includes(usuario.perfil) || liberados.includes(usuario.perfil_bruto);
}

/** Pergunta ao banco se o usuário logado pode usar a IA. 404 (função ausente) → regra do segredo. */
export async function acessoLiberado(rpc: Rpc, usuario: PerfilUsuario, perfisSegredo: string | undefined): Promise<boolean> {
  try {
    const r = await rpc.call<{ liberado?: boolean }>("bi_acesso_liberado");
    return r?.liberado === true;
  } catch (e) {
    if (e instanceof RpcError && e.status === 404) return liberadoPeloSegredo(usuario, perfisSegredo);
    throw e;
  }
}

export type StatusPergunta = "ok" | "erro" | "limite" | "negado";

/** Status de utilização de uma pergunta que terminou em erro (null = não registrar: sessão expirada). */
export function statusDoErro(e: unknown): StatusPergunta | null {
  if (e instanceof LimiteLlm) return "limite";
  if (e instanceof RpcError && e.status === 401) return null;
  if (e instanceof RpcError && e.negado) return "negado";
  return "erro";
}

export async function registrarPergunta(
  rpc: Rpc,
  d: { sessao: string; canal: "texto" | "voz"; ferramentas: string[]; status: StatusPergunta; duracaoMs: number },
): Promise<void> {
  try {
    await rpc.call("bi_registrar_pergunta", {
      p_sessao: d.sessao, p_canal: d.canal, p_ferramentas: [...new Set(d.ferramentas)], p_status: d.status,
      p_duracao_ms: Math.max(0, Math.round(d.duracaoMs)),
    });
  } catch (e) {
    console.error("[bi] falha ao registrar utilização", (e as Error).message);
  }
}
