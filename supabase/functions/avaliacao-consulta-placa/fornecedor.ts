// Avaliações de Seminovos — fornecedor de consulta veicular (placa/chassi).
//
// Regra de privacidade: o que sai deste arquivo passa SEMPRE por filtrarRetorno(),
// uma lista fechada de campos do VEÍCULO. Nome, CPF/CNPJ, endereço ou qualquer
// outro dado do proprietário que um fornecedor real devolva é descartado aqui,
// antes de gravar no banco ou responder ao navegador. O retorno bruto nunca vai
// para log.
//
// Fornecedor ativo: variável AVAL_FORNECEDOR (padrão "SIMULADO"). O real entra
// quando a cotação fechar: chave em AVAL_FORNECEDOR_CHAVE (segredo do Supabase,
// nunca no navegador nem no repositório) e um adaptador em consultarReal().

export type Versao = {
  marca: string; modelo: string; versao: string; fipe_codigo: string; fipe_valor: number;
  fipe_mes_ref: string; ano_modelo: number; combustivel: string; chassi: string | null;
};
export type Retorno = {
  ano_fabricacao: number | null; cor: string | null; versoes: Versao[];
  restricoes: { gravame: boolean | null; leilao: boolean | null; sinistro: boolean | null };
};
export type Consulta = { placa: string | null; chassi: string | null };
export type Resultado = { fornecedor: string; simulado: boolean; custo: number; retorno: Retorno };

const txt = (v: unknown, max = 60): string | null => {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).replace(/\s+/g, " ").trim().toUpperCase();
  return s ? s.slice(0, max) : null;
};
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : Number(String(v ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
};
const ano = (v: unknown): number | null => {
  const n = num(v);
  return n && n >= 1950 && n <= 2101 ? Math.trunc(n) : null;
};
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const CHASSI = /^[A-HJ-NPR-Z0-9]{17}$/;

/** Lista fechada: só campos do veículo, com tipo conferido. Todo o resto é descartado. */
export function filtrarRetorno(bruto: unknown): Retorno {
  const b = (bruto && typeof bruto === "object" ? bruto : {}) as Record<string, unknown>;
  const lista = Array.isArray(b.versoes) ? b.versoes : [];
  const versoes: Versao[] = [];
  for (const item of lista.slice(0, 12)) {
    const v = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const fipe_codigo = txt(v.fipe_codigo, 20);
    const ano_modelo = ano(v.ano_modelo);
    const modelo = txt(v.modelo);
    if (!fipe_codigo || !ano_modelo || !modelo) continue;
    const mes = typeof v.fipe_mes_ref === "string" && /^\d{4}-\d{2}$/.test(v.fipe_mes_ref) ? v.fipe_mes_ref : "";
    const chassi = txt(v.chassi, 17);
    versoes.push({
      marca: txt(v.marca, 30) ?? "", modelo, versao: txt(v.versao, 80) ?? "", fipe_codigo,
      fipe_valor: num(v.fipe_valor) ?? 0, fipe_mes_ref: mes, ano_modelo,
      combustivel: txt(v.combustivel, 20) ?? "", chassi: chassi && CHASSI.test(chassi) ? chassi : null,
    });
  }
  const r = (b.restricoes && typeof b.restricoes === "object" ? b.restricoes : {}) as Record<string, unknown>;
  return {
    ano_fabricacao: ano(b.ano_fabricacao), cor: txt(b.cor, 20), versoes,
    restricoes: { gravame: bool(r.gravame), leilao: bool(r.leilao), sinistro: bool(r.sinistro) },
  };
}

// ---------------------------------------------------------------- simulado
// Dados FICTÍCIOS e determinísticos (a mesma placa devolve sempre o mesmo carro).
// Códigos FIPE começam com "SIM-" para nunca serem confundidos com os reais.
// Placas de teste: final 7 = gravame; final 8 = leilão; final 9 = sinistro.
const CATALOGO: { marca: string; modelo: string; versoes: [string, number, string][] }[] = [
  { marca: "MITSUBISHI", modelo: "ECLIPSE CROSS", versoes: [["HPE 1.5 TURBO CVT", 118000, "GASOLINA"], ["HPE-S 1.5 TURBO S-AWC", 129000, "GASOLINA"], ["GLS 1.5 TURBO CVT", 109000, "GASOLINA"]] },
  { marca: "MITSUBISHI", modelo: "L200 TRITON", versoes: [["SPORT HPE-S 2.4 CD 4X4 DIESEL", 189000, "DIESEL"], ["SPORT GLS 2.4 CD 4X4 DIESEL", 168000, "DIESEL"]] },
  { marca: "MITSUBISHI", modelo: "OUTLANDER", versoes: [["2.0 16V CVT", 125000, "GASOLINA"], ["3.0 GT V6 4X4", 168000, "GASOLINA"]] },
  { marca: "MITSUBISHI", modelo: "ASX", versoes: [["2.0 MIVEC FLEX CVT", 92000, "FLEX"], ["2.0 4X4 AWD GASOLINA", 98000, "GASOLINA"]] },
  { marca: "MITSUBISHI", modelo: "PAJERO SPORT", versoes: [["HPE-S 2.4 DIESEL 4X4", 228000, "DIESEL"], ["HPE 2.4 DIESEL 4X4", 205000, "DIESEL"]] },
  { marca: "JEEP", modelo: "COMPASS", versoes: [["LONGITUDE 1.3 T270 FLEX", 131000, "FLEX"], ["LIMITED 1.3 T270 FLEX", 146000, "FLEX"]] },
  { marca: "TOYOTA", modelo: "COROLLA CROSS", versoes: [["XRE 2.0 FLEX CVT", 139000, "FLEX"], ["XRX 1.8 HIBRIDO CVT", 162000, "HIBRIDO"]] },
  { marca: "HONDA", modelo: "HR-V", versoes: [["EXL 1.5 FLEX CVT", 121000, "FLEX"], ["EX 1.5 FLEX CVT", 112000, "FLEX"]] },
  { marca: "VOLKSWAGEN", modelo: "T-CROSS", versoes: [["HIGHLINE 1.4 250 TSI", 117000, "FLEX"], ["COMFORTLINE 1.0 200 TSI", 98000, "FLEX"]] },
  { marca: "CHEVROLET", modelo: "ONIX", versoes: [["PLUS LT 1.0 TURBO AUT", 76000, "FLEX"], ["LT 1.0 MANUAL", 61000, "FLEX"]] },
];
const CORES = ["BRANCO", "PRATA", "CINZA", "PRETO", "AZUL", "VERMELHO"];

function hash(s: string): number {
  let h = 2166136261;
  for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function consultarSimulado(c: Consulta, hoje = new Date()): Resultado {
  const chave = c.placa ?? c.chassi ?? "";
  const h = hash(chave);
  const item = CATALOGO[h % CATALOGO.length];
  const anoFab = 2017 + ((h >>> 8) % 9);                       // 2017..2025
  const anoMod = (h >>> 12) % 3 === 0 ? anoFab : anoFab + 1;
  const idade = Math.max(0, hoje.getFullYear() - anoMod);
  const mes = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, "0")}`;
  const final = chave.slice(-1);
  const bruto = {
    ano_fabricacao: anoFab,
    cor: CORES[(h >>> 4) % CORES.length],
    versoes: item.versoes.map(([versao, novo, comb], i) => ({
      marca: item.marca, modelo: item.modelo, versao,
      fipe_codigo: `SIM-${String((h % 9000) + 1000 + i)}`,
      fipe_valor: Math.round((novo * Math.pow(0.9, idade)) / 100) * 100,
      fipe_mes_ref: mes, ano_modelo: anoMod, combustivel: comb, chassi: c.chassi,
    })),
    restricoes: { gravame: final === "7", leilao: final === "8", sinistro: final === "9" },
    // campos que um fornecedor real costuma mandar e que NUNCA podem passar:
    proprietario: { nome: "FULANO SIMULADO", documento: "00000000000", endereco: "RUA SIMULADA" },
  };
  return { fornecedor: "SIMULADO", simulado: true, custo: 0, retorno: filtrarRetorno(bruto) };
}

// ---------------------------------------------------------------- real (a fazer)
// deno-lint-ignore require-await
export async function consultarReal(_c: Consulta, _chave: string): Promise<Resultado> {
  // Adaptador do fornecedor contratado: chamar a API com a chave, mapear o JSON
  // dele para o formato de filtrarRetorno() e devolver filtrarRetorno(mapeado).
  throw new Error("FORNECEDOR_REAL_NAO_CONFIGURADO");
}
