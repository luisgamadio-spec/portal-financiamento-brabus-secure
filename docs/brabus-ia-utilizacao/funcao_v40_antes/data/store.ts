// Persistência da Brabus Intelligence: simulações (para reaproveitar por id) e log de auditoria.
// Tabela bi_simulacoes (RLS: cada um só vê o que é seu) e RPC bi_auditar (perfil vem do servidor).
// Migration 20261002120000_brabus_intelligence_foundation.sql. Sempre com o JWT do usuário.

import type { Rpc } from "./rpc.ts";

export type Store = {
  salvarSimulacoes(sessao: string, itens: { id: string; payload: unknown }[]): Promise<void>;
  lerSimulacao(id: string): Promise<{ status: "ok"; payload: any } | { status: "expirada" } | { status: "nao_encontrada" }>;
  auditar(e: EventoAuditoria): Promise<void>;
};

export type EventoAuditoria = {
  sessao: string; perfil: string; canal: string; ferramenta: string;
  parametros: unknown; status: "ok" | "erro" | "negado"; detalhe?: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Remove do log qualquer valor que pareça dado pessoal ou salário: o log guarda só o "quê", não o "quanto". */
export function sanitizaParametros(p: unknown): unknown {
  const SENSIVEIS = /cpf|telefone|email|salario|comissao/i;
  const limpa = (x: any): any => {
    if (Array.isArray(x)) return x.map(limpa);
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, SENSIVEIS.test(k) ? "[omitido]" : limpa(v)]));
    return x;
  };
  return limpa(p);
}

export function storeSupabase(rpc: Rpc): Store {
  return {
    async salvarSimulacoes(sessao, itens) {
      if (!itens.length) return;
      // PostgREST aceita array no corpo para inserir várias linhas.
      await rpc.insert("bi_simulacoes", itens.map((i) => ({ id: i.id, sessao_id: sessao, payload: i.payload })) as any);
    },
    async lerSimulacao(id) {
      if (!UUID.test(id)) return { status: "nao_encontrada" };
      const rows = await rpc.select<any>("bi_simulacoes", `id=eq.${id}&select=payload,expires_at`);
      if (!rows.length) return { status: "nao_encontrada" }; // de outro usuário = invisível pela RLS
      if (new Date(rows[0].expires_at).getTime() < Date.now()) return { status: "expirada" };
      return { status: "ok", payload: rows[0].payload };
    },
    async auditar(e) {
      try {
        await rpc.call("bi_auditar", {
          p_sessao: e.sessao, p_canal: e.canal, p_ferramenta: e.ferramenta,
          p_parametros: sanitizaParametros(e.parametros), p_status: e.status, p_detalhe: e.detalhe ?? null,
        });
      } catch (err) {
        console.error("[bi] falha ao gravar auditoria", (err as Error).message);
      }
    },
  };
}

/** Store em memória (testes e desenvolvimento local). */
export function storeMemoria(agora = () => Date.now(), ttlMs = 4 * 3600_000): Store & { log: EventoAuditoria[] } {
  const sims = new Map<string, { payload: unknown; expira: number }>();
  const log: EventoAuditoria[] = [];
  return {
    log,
    async salvarSimulacoes(_s, itens) { for (const i of itens) sims.set(i.id, { payload: i.payload, expira: agora() + ttlMs }); },
    async lerSimulacao(id) {
      const s = sims.get(id);
      if (!s) return { status: "nao_encontrada" };
      if (s.expira < agora()) return { status: "expirada" };
      return { status: "ok", payload: s.payload };
    },
    async auditar(e) { log.push({ ...e, parametros: sanitizaParametros(e.parametros) }); },
  };
}
