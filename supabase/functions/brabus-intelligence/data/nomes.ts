// Busca de pessoas por nome tolerante a grafia: "Wilian Simaro" encontra "WILLIAM SYMARO".
// 1º tenta o jeito exato (nome contém o que foi digitado); só se não achar ninguém, usa a busca aproximada.

const norm = (s: string) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z ]/g, " ").replace(/\s+/g, " ").trim();

/** Forma "falada" de uma palavra: junta grafias que soam igual em nomes brasileiros. */
export function fonetica(palavra: string): string {
  let s = norm(palavra).replace(/ /g, "");
  s = s.replace(/PH/g, "F").replace(/TH/g, "T").replace(/Y/g, "I").replace(/W/g, "V")
    .replace(/C([EI])/g, "S$1")             // Cíntia/Síntia, Cesar/Sesar: C antes de E/I soa S
    .replace(/QU([EI])/g, "C$1").replace(/GU([EI])/g, "G$1").replace(/K/g, "C")
    .replace(/SH/g, "X").replace(/CH/g, "X") // Shirley/Xirlei, Chaves/Xaves
    .replace(/SS/g, "S").replace(/^H/, "").replace(/([^LN])H/g, "$1")
    .replace(/(.)\1+/g, "$1")              // letras dobradas: LL → L, TT → T
    .replace(/M$/, "N").replace(/Z$/, "S")  // William/Wilian, Luiz/Luis
    .replace(/(.{3,})[EI]$/, "$1");         // vogal final fraca: Simare/Simar, Jorge/Jorg
  return s;
}

function lev(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

/** Semelhança 0..1 entre o que foi digitado e um nome cadastrado (0 = não serve). */
export function semelhancaNome(consulta: string, nome: string): number {
  const qs = norm(consulta).split(" ").filter((t) => t.length >= 2).map(fonetica);
  const ns = norm(nome).split(" ").filter(Boolean).map(fonetica);
  if (!qs.length || !ns.length) return 0;
  let soma = 0;
  for (const q of qs) {
    let melhor = 0;
    for (const n of ns) {
      let s = 0;
      if (q === n) s = 1;
      else if (q.length >= 3 && n.startsWith(q)) s = 0.9;               // "Will" → WILLIAM
      else if (Math.min(q.length, n.length) >= 4) s = 1 - lev(q, n) / Math.max(q.length, n.length);
      if (s > melhor) melhor = s;
    }
    if (melhor < 0.75) return 0;                                       // toda palavra digitada precisa casar com alguma
    soma += melhor;
  }
  return soma / qs.length;
}

export const LIMIAR_NOME = 0.8;

/**
 * Filtra itens pelo nome: primeiro exato (contém); se não achar, aproximado.
 * Na aproximada, fica só com os mais parecidos (empate técnico de até 0,05).
 */
export function filtraPorNome<T>(consulta: string, itens: T[], nomeDe: (x: T) => string): { itens: T[]; aproximado: boolean } {
  const q = norm(consulta);
  const exatos = itens.filter((x) => norm(nomeDe(x)).includes(q));
  if (exatos.length) return { itens: exatos, aproximado: false };
  const notas = itens.map((x) => ({ x, s: semelhancaNome(consulta, nomeDe(x)) })).filter((p) => p.s >= LIMIAR_NOME);
  if (!notas.length) return { itens: [], aproximado: true };
  const top = Math.max(...notas.map((p) => p.s));
  return { itens: notas.filter((p) => p.s >= top - 0.05).map((p) => p.x), aproximado: true };
}
