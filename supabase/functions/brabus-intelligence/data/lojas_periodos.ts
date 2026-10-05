// Lojas canônicas do Grupo e resolução de períodos.

export const LOJAS = ["ABC", "ALPHAVILLE", "ANALIA FRANCO", "BANDEIRANTES", "BARRA FUNDA", "EUROPA", "GASTAO", "NACOES"] as const;
export type Loja = (typeof LOJAS)[number];

const sem = (s: string) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim();

const ALIAS: Record<string, Loja> = {
  "A. FRANCO": "ANALIA FRANCO", "A FRANCO": "ANALIA FRANCO", "ANALIA": "ANALIA FRANCO",
  "GASTAO VIDIGAL": "GASTAO", "NACOES UNIDAS": "NACOES", "BARRAFUNDA": "BARRA FUNDA",
};

/** "Brabus Europa", "MITSUBISHI | EUROPA", "europa" → "EUROPA". null se não reconhecer. */
export function normalizaLoja(entrada: string | null | undefined): Loja | null {
  if (!entrada) return null;
  let s = sem(entrada).replace(/^MITSUBISHI\s*\|?\s*/, "").replace(/^(GRUPO\s+)?BRABUS\s+/, "").replace(/^LOJA\s+/, "").trim();
  if ((LOJAS as readonly string[]).includes(s)) return s as Loja;
  if (ALIAS[s]) return ALIAS[s];
  const hit = LOJAS.filter((l) => s.includes(l) || l.includes(s));
  return hit.length === 1 ? hit[0] : null;
}

/** Pseudo-lojas que não são loja de verdade (ficam fora de comparações). */
export function ehPseudoLoja(s: string): boolean {
  const x = sem(s);
  return x === "REVENDA" || x === "SEM LOJA" || x.startsWith("NAO ");
}

// ---------------- Períodos ----------------

export type TipoPeriodo =
  | "competencia_atual" | "competencia_anterior" | "mes_atual" | "mes_anterior"
  | "ultimos_30" | "ultimos_90" | "hoje" | "personalizado";

export type PeriodoComissao = { nome_periodo?: string; data_inicio: string; data_fim: string; periodo_atual?: boolean; ativo?: boolean };

export type PeriodoResolvido = {
  inicio: string; fim: string; tipo: TipoPeriodo; rotulo: string;
  comparavel_anterior: { inicio: string; fim: string } | null;
  aviso: string | null;
};

const iso = (d: Date) => d.toISOString().slice(0, 10);
const d = (s: string) => new Date(s + "T00:00:00Z");
const addDias = (s: string, n: number) => { const x = d(s); x.setUTCDate(x.getUTCDate() + n); return iso(x); };
const addMeses = (s: string, n: number) => {
  const x = d(s); const dia = x.getUTCDate(); x.setUTCMonth(x.getUTCMonth() + n);
  if (x.getUTCDate() !== dia) x.setUTCDate(0);
  return iso(x);
};
const minIso = (a: string, b: string) => (a < b ? a : b);
const br = (s: string) => `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;

/**
 * Resolve o período. "Competência" é o período de comissão cadastrado no Portal
 * (periodos_comissao, normalmente 21→20). Se não houver cadastro, usa 21→20 como regra.
 * "Mês" é o mês civil (usado pela Análise Geral e pela Análise F&I).
 * O comparável anterior é o mesmo intervalo deslocado um período para trás,
 * cortado em "hoje" quando o período está em andamento (como a Análise Geral faz).
 */
export function resolvePeriodo(
  tipo: TipoPeriodo, hoje: string, periodos: PeriodoComissao[],
  inicio?: string | null, fim?: string | null,
): PeriodoResolvido | { erro: string } {
  const comp = (deslocamento: 0 | -1): { inicio: string; fim: string; nome: string; aviso: string | null; anterior: { inicio: string; fim: string } } => {
    const ativos = periodos.filter((p) => p.ativo !== false).sort((a, b) => b.data_inicio.localeCompare(a.data_inicio));
    const atual = ativos.find((p) => p.periodo_atual) ?? ativos.find((p) => p.data_inicio <= hoje && hoje <= p.data_fim);
    if (atual) {
      const ant = ativos.find((p) => p.data_fim < atual.data_inicio);
      if (deslocamento === 0) {
        const anterior = ant ? { inicio: ant.data_inicio, fim: ant.data_fim } : { inicio: addMeses(atual.data_inicio, -1), fim: addDias(atual.data_inicio, -1) };
        return { inicio: atual.data_inicio, fim: atual.data_fim, nome: atual.nome_periodo ?? "", aviso: null, anterior };
      }
      if (ant) {
        const ant2 = ativos.find((p) => p.data_fim < ant.data_inicio);
        const anterior = ant2 ? { inicio: ant2.data_inicio, fim: ant2.data_fim } : { inicio: addMeses(ant.data_inicio, -1), fim: addDias(ant.data_inicio, -1) };
        return { inicio: ant.data_inicio, fim: ant.data_fim, nome: ant.nome_periodo ?? "", aviso: null, anterior };
      }
    }
    // Regra padrão 21→20 quando não há período cadastrado
    const dia = +hoje.slice(8, 10);
    let ini = dia >= 21 ? `${hoje.slice(0, 8)}21` : addMeses(`${hoje.slice(0, 8)}21`, -1);
    if (deslocamento === -1) ini = addMeses(ini, -1);
    return { inicio: ini, fim: addDias(addMeses(ini, 1), -1), nome: "", aviso: "Não há período de comissão cadastrado; usei a regra 21→20.", anterior: { inicio: addMeses(ini, -1), fim: addDias(ini, -1) } };
  };

  let r: PeriodoResolvido;
  switch (tipo) {
    case "competencia_atual":
    case "competencia_anterior": {
      const c = comp(tipo === "competencia_atual" ? 0 : -1);
      const fimEf = minIso(c.fim, hoje);
      const emAndamento = fimEf < c.fim;
      const dur = Math.round((d(fimEf).getTime() - d(c.inicio).getTime()) / 86400000);
      // Em andamento: mesmo número de dias da competência anterior. Fechada: competência anterior inteira.
      const comparavel = emAndamento ? { inicio: c.anterior.inicio, fim: minIso(addDias(c.anterior.inicio, dur), c.anterior.fim) } : c.anterior;
      r = {
        inicio: c.inicio, fim: fimEf, tipo, rotulo: `competência ${c.nome || `${br(c.inicio)} a ${br(c.fim)}`}`,
        comparavel_anterior: comparavel, aviso: c.aviso,
      };
      break;
    }
    case "mes_atual":
    case "mes_anterior": {
      const base = tipo === "mes_atual" ? `${hoje.slice(0, 8)}01` : addMeses(`${hoje.slice(0, 8)}01`, -1);
      const fimMes = addDias(addMeses(base, 1), -1);
      const fimEf = minIso(fimMes, hoje);
      const dur = Math.round((d(fimEf).getTime() - d(base).getTime()) / 86400000);
      const antIni = addMeses(base, -1);
      const emAndamento = fimEf < fimMes;
      // Em andamento: mesmo intervalo do mês anterior (como a Análise Geral). Fechado: mês anterior inteiro.
      const antFim = emAndamento ? minIso(addDias(antIni, dur), addDias(base, -1)) : addDias(base, -1);
      r = { inicio: base, fim: fimEf, tipo, rotulo: `mês ${base.slice(5, 7)}/${base.slice(0, 4)}`, comparavel_anterior: { inicio: antIni, fim: antFim }, aviso: null };
      break;
    }
    case "hoje": {
      r = { inicio: hoje, fim: hoje, tipo, rotulo: `hoje (${br(hoje)})`, comparavel_anterior: { inicio: addDias(hoje, -1), fim: addDias(hoje, -1) }, aviso: null };
      break;
    }
    case "ultimos_30":
    case "ultimos_90": {
      const n = tipo === "ultimos_30" ? 30 : 90;
      const ini = addDias(hoje, -(n - 1));
      r = { inicio: ini, fim: hoje, tipo, rotulo: `últimos ${n} dias`, comparavel_anterior: { inicio: addDias(ini, -n), fim: addDias(ini, -1) }, aviso: null };
      break;
    }
    case "personalizado": {
      const valida = (x?: string | null) => !!x && /^\d{4}-\d{2}-\d{2}$/.test(x) && iso(d(x)) === x;
      if (!valida(inicio) || !valida(fim)) return { erro: "Período personalizado precisa de data_inicio e data_fim válidas (AAAA-MM-DD)." };
      inicio = inicio!; fim = fim!;
      if (fim < inicio) return { erro: "data_fim é anterior a data_inicio." };
      const dur = Math.round((d(fim).getTime() - d(inicio).getTime()) / 86400000);
      r = { inicio, fim, tipo, rotulo: `${br(inicio)} a ${br(fim)}`, comparavel_anterior: { inicio: addDias(inicio, -(dur + 1)), fim: addDias(inicio, -1) }, aviso: null };
      break;
    }
    default:
      return { erro: `Período desconhecido: ${tipo}` };
  }
  const dias = Math.round((d(r.fim).getTime() - d(r.inicio).getTime()) / 86400000);
  if (dias > 731) return { erro: "O Portal aceita no máximo 2 anos por consulta." };
  if (dias < 4 && (tipo === "competencia_atual" || tipo === "mes_atual")) {
    r.aviso = [r.aviso, `O período atual tem só ${dias + 1} dia(s); a base é pequena. Ofereça o período anterior fechado.`].filter(Boolean).join(" ");
  }
  return r;
}
