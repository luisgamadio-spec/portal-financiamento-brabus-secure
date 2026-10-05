// Asserts mínimos (sem dependência externa).
export function assert(cond: unknown, msg = "assert falhou"): asserts cond {
  if (!cond) throw new Error(msg);
}
export function assertEquals(a: unknown, b: unknown, msg = "") {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${msg} esperado ${sb} veio ${sa}`);
}
export function assertAlmostEquals(a: number, b: number, tol: number, msg = "") {
  if (!(Math.abs(a - b) <= tol)) throw new Error(`${msg}: esperado ${b} veio ${a} (tol ${tol})`);
}
