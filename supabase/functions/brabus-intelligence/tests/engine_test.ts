// Confere o motor novo contra os vetores gerados da página ORIGINAL do Portal.
// Rodar: deno test tests/
import { assert, assertAlmostEquals, assertEquals } from "./assert.ts";
import * as N from "../engine/novos.ts";
import * as S from "../engine/seminovos.ts";
import * as F from "../engine/ferramentas.ts";

const fx = (f: string) => JSON.parse(Deno.readTextFileSync(new URL(`./fixtures/${f}`, import.meta.url)));
const TN_FB = fx("tabelas_novos_fallback.json");
const TN_XLSX = { ...TN_FB, ...fx("tabelas_novos_xlsx.json") };
const TS_FB = fx("tabelas_seminovos_fallback.json");
const VN = fx("novos_vectors.json").vetores as any[];
const VS = fx("seminovos_vectors.json").vectors as any[];

const close = (a: number | null | undefined, b: number | null | undefined, msg: string) => {
  if (b === null || b === undefined) return assert(a === null || a === undefined, `${msg}: esperado vazio, veio ${a}`);
  assert(typeof a === "number", `${msg}: esperado ${b}, veio ${a}`);
  assertAlmostEquals(a!, b, Math.max(1e-6, Math.abs(b) * 1e-9), msg);
};
const isErr = (r: unknown): r is { erro: string } => !!r && typeof r === "object" && "erro" in (r as any);

Deno.test("Novos — vetores do Portal", async (t) => {
  let conferidos = 0;
  for (const v of VN) {
    const tab = v.fonte === "XLSX" ? TN_XLSX : TN_FB;
    const i = v.input, o = v.output;
    conferidos++;
    await t.step(`${v.id} ${v.plano}`, () => {
      const esperaErro = !!o.erro || !!o.vazio || o.valido === false || o.valid === false || o.empty;
      let r: any;
      switch (v.plano) {
        case "LINEAR":
          r = N.linear(i.bem, i.entrada, tab);
          if (esperaErro) return assert(isErr(r));
          close(r.faixa, o.faixa, "faixa");
          o.itens.forEach((x: any, k: number) => close(r.itens[k].parcela, x.parcela, `parcela ${x.prazo}x`));
          break;
        case "BALAO_TRADICIONAL":
          r = N.balaoTradicional(i.bem, i.entrada, i.prazo, i.baloes ?? [], tab);
          if (o.erro || o.parcela == null) return assert(isErr(r), JSON.stringify(r));
          close(r.parcela, o.parcela, "parcela");
          break;
        case "SEMESTRAL_ANUAL":
          r = N.semestralAnual(i.bem, i.entrada, i.prazo, i.tipo, tab);
          if (o.erro || o.parcela == null) return assert(isErr(r));
          close(r.parcela, o.parcela, "parcela");
          assertEquals(r.meses, o.meses);
          break;
        case "PARCELA_UNICA":
          r = N.parcelaUnica(i.bem, i.entrada);
          if (o.erro || o.parcela == null) return assert(isErr(r));
          close(r.parcela, o.parcela, "parcela");
          break;
        case "TAXAS_SUBSIDIADAS":
          r = N.taxasSubsidiadas(i.bem, i.entrada, i.minVenda ?? 0, tab);
          if (esperaErro) return assert(isErr(r));
          o.rows.forEach((x: any) => {
            const y = r.linhas.find((z: any) => z.prazo === x.prazo && z.taxa === x.taxa);
            close(y.parcela, x.parcela, `parcela ${x.prazo}`);
            close(y.rebateValor, x.rebateValor, "rebate");
            close(y.valorFinalVenda, x.valorFinalVenda, "valor final");
            assertEquals(y.melhor, x.melhor, "melhor");
          });
          break;
        case "COPIAR_TAXA_BANCO":
          r = N.taxaBancoCopiar(i.prazo, tab);
          if (o.erro) return assertEquals(r, null);
          close(r, o.taxa, "taxa");
          break;
        case "COPARTICIPADO":
          r = N.coparticipado(i.modelo, i.venda, i.entrada, tab);
          // Divergência intencional: o Portal cai em silêncio no 1º modelo quando o nome não existe;
          // o motor novo recusa (evita ofertar condição de outro carro).
          if (!o.valid || o.modelo !== i.modelo) return assert(isErr(r));
          o.termos.forEach((x: any, k: number) => close(r.termos[k].parcela, x.parcela, `parcela ${x.prazo}`));
          close(r.rebateTotal, o.rebateTotal, "rebate total");
          close(r.rebateBrabus, o.rebateBrabus, "rebate brabus");
          close(r.valorFinalVenda, o.valorFinalVenda, "valor final");
          break;
        case "SEMESTRAL_TRITON_OUTLANDER":
          r = N.semestralTritonOutlander(i.modelo, i.bem, tab);
          if (!o.valido) return assert(isErr(r));
          close(r.parcela, o.parcela, "parcela");
          close(r.rebateBrabus, o.rebateBrabus, "rebate brabus");
          close(r.valorFinalVenda, o.valorFinalVenda, "valor final");
          break;
        case "CALCULADORA_TAXA":
          r = F.calculadoraTaxa(i.financiado, i.prazo, i.parcela);
          if (o.erro) return assert(isErr(r));
          close(r.taxaNet, o.taxaNet, "taxa net");
          close(r.taxaCetMes, o.taxaCetMes, "cet");
          break;
        case "ANTECIPACAO":
          r = F.antecipacao({ ...i, parcelaEscolhida: i.parcelaEscolhida }, tab.antecipacao);
          if (o.erro) return assert(isErr(r));
          assertEquals(r.qtd, o.rows.length);
          close(r.finalTotal, o.finalTotal, "final total");
          o.rows.forEach((x: any, k: number) => { assertEquals(r.linhas[k].venc, x.venc); assertEquals(r.linhas[k].meses, x.meses); });
          break;
        case "CASH_CONVERSION":
          r = F.cashConversion(i.capital, i.parcela, i.prazoMeses, i.taxaAplicacao);
          if (o.erro) return assert(isErr(r));
          close(r.valorFuturoAplicacao, o.valorFuturoAplicacao, "VF");
          assertEquals(r.classificacao, o.classificacao);
          break;
        default:
          throw new Error("plano sem mapeamento: " + v.plano);
      }
    });
  }
  assert(conferidos === VN.length, `poucos vetores conferidos: ${conferidos}`);
});

Deno.test("Seminovos — vetores do Portal", async (t) => {
  for (const v of VS) {
    if (String(v.plano).startsWith("LEGADO")) continue; // código sem botão no menu: fora do motor novo
    const i = v.input, e = v.expected;
    await t.step(`${v.id} ${v.plano}`, () => {
      let r: any;
      const tol = (a: number, b: number, m: string) => assertAlmostEquals(a, b, Math.max(2e-6, Math.abs(b) * 1e-9), m); // vetores arredondados a 6 casas
      switch (v.plano) {
        case "FINANCIAMENTO_LINEAR_SEMINOVO":
          r = S.linearSeminovo(Number(i.ano), Number(i.valorVeiculo), Number(i.valorEntrada), TS_FB);
          if (e.invalid) return assert(isErr(r) || r.itens.every((x: any) => x.parcela === null), JSON.stringify(r).slice(0, 200));
          e.parcelas.forEach((x: any, k: number) => x.parcela == null ? assertEquals(r.itens[k].parcela, null) : tol(r.itens[k].parcela, x.parcela, `parcela ${x.prazo}`));
          break;
        case "PLANO_BALAO_SEMINOVO":
          r = S.balaoSeminovo(Number(i.bem), Number(i.entrada), Number(i.ano), Number(i.prazo), i.baloes ?? [], TS_FB);
          if (e.erro || e.parcela == null) return assert(isErr(r), JSON.stringify(r));
          tol(r.parcela, e.parcela, "parcela");
          break;
        case "CALCULADORA_TAXA":
          r = F.calculadoraTaxa(i.financiado, i.prazo, i.parcela);
          if (e.erro) return assert(isErr(r));
          tol(r.taxaNet, e.taxaNet, "net");
          tol(r.taxaCetMes, e.taxaCetMes, "cet");
          break;
        case "ANTECIPACAO":
          r = F.antecipacao({ ...i, parcelaEscolhida: i.parcelaUnica }, TS_FB.antecipacao);
          if (e.erro) return assert(isErr(r));
          assertEquals(r.qtd, e.qtd);
          tol(r.finalTotal, e.finalTotal, "final");
          break;
        case "CASH_CONVERSION":
          r = F.cashConversion(i.capital, i.parcela, i.prazoMeses, i.taxaAplicacao);
          if (e.erro) return assert(isErr(r));
          tol(r.valorFuturoAplicacao, e.valorFuturoAplicacao, "VF");
          assertEquals(r.classificacao, e.classificacao);
          break;
        default:
          throw new Error("plano sem mapeamento: " + v.plano);
      }
    });
  }
});
