// Quem é o usuário, qual o escopo e quais módulos ele pode usar.
// Tudo vem do banco, com o JWT do próprio usuário.

import type { Rpc } from "./rpc.ts";

export type Perfil = "MASTER" | "DIRETOR" | "GERENTE" | "ANALISTA" | "VENDEDOR" | "RH";

export type Contexto = {
  nome: string | null;
  perfil: Perfil;
  perfil_bruto: string;
  loja: string | null;
  departamentos: string[];
  modulos: string[];
};

export async function carregaContexto(rpc: Rpc): Promise<Contexto> {
  const [escopo, modulos, usuario] = await Promise.all([
    rpc.call<any>("operational_current_scope"),
    rpc.call<string[]>("portal_modulos_permitidos").catch(() => [] as string[]),
    rpc.call<any>("usuario_logado_fi").catch(() => null),
  ]);
  const bruto = String(escopo?.profile ?? "").toUpperCase();
  const perfil: Perfil = bruto.startsWith("DIRETOR") ? "DIRETOR"
    : (["MASTER", "GERENTE", "ANALISTA", "VENDEDOR", "RH"].includes(bruto) ? bruto as Perfil : "VENDEDOR");
  const u = Array.isArray(usuario) ? usuario[0] : usuario;
  return {
    // Só o nome é usado. CPF e demais dados do cadastro são descartados aqui.
    nome: u?.nome ? String(u.nome) : null,
    perfil, perfil_bruto: bruto,
    loja: escopo?.store ?? null,
    departamentos: Array.isArray(escopo?.departments) ? escopo.departments : [],
    modulos: Array.isArray(modulos) ? modulos.map(String) : [],
  };
}

// ---------------- Política de campos sensíveis ----------------
// O banco já filtra QUAIS LINHAS cada perfil vê. Aqui a IA é mais restritiva
// em alguns CAMPOS (decisão do projeto): o vendedor não vê retorno/rentabilidade.

const CAMPOS_RETORNO = [
  "return_value", "average_return_percent", "profitability_value", "retorno", "retorno_medio",
  "retorno_total", "retorno_pct", "retorno_medio_pct", "retorno_pct_producao", "rentabilidade",
];

export function podeVerRetorno(c: Contexto): boolean {
  return c.perfil !== "VENDEDOR";
}

/** Remove recursivamente os campos de retorno quando o perfil não pode vê-los. */
export function filtraCampos<T>(c: Contexto, dado: T): T {
  if (podeVerRetorno(c)) return dado;
  const limpa = (x: any): any => {
    if (Array.isArray(x)) return x.map(limpa);
    if (x && typeof x === "object") {
      const o: any = {};
      for (const [k, v] of Object.entries(x)) if (!CAMPOS_RETORNO.includes(k)) o[k] = limpa(v);
      return o;
    }
    return x;
  };
  return limpa(dado);
}

export const MODULO = {
  simNovos: "simuladorCompleto",
  simSeminovos: "simuladorSeminovos",
  analiseGeral: "dashbi",
  analiseFi: "gestao",
  score: "analiseScoreVendedores",
  comissoes: "comissoes",
} as const;

export function temModulo(c: Contexto, m: string): boolean {
  return c.perfil === "MASTER" || c.modulos.includes(m);
}
