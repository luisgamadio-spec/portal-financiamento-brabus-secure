// Ferramentas da Brabus Intelligence: definição (schema estrito) + execução.
// Regra central: TODO número que a IA mostra sai daqui. A IA não calcula.

import { Bases, BaseIndisponivel } from "../data/bases.ts";
import { type Contexto, filtraCampos, MODULO, podeVerRetorno, temModulo } from "../data/contexto.ts";
import { ehPseudoLoja, LOJAS, normalizaLoja, type PeriodoComissao, type PeriodoResolvido, resolvePeriodo, type TipoPeriodo } from "../data/lojas_periodos.ts";
import { Rpc, RpcError } from "../data/rpc.ts";
import { calculaScores, utilConvPara } from "../data/score.ts";
import type { Store } from "../data/store.ts";
import * as N from "../engine/novos.ts";
import * as S from "../engine/seminovos.ts";
import * as F from "../engine/ferramentas.ts";
import { addMonths, parseISO, toISO } from "../engine/comum.ts";
import { casaModelo, type Contexto as CtxSim, entradaMinimaParaParcela, type EstruturaBalao, type ModoBalao, normalizaModelo, type Opcao, opcaoSemestralTriton, opcoesParaEntrada } from "../engine/ofertas.ts";
import { buscaManual } from "./manual.ts";
import { filtraPorNome } from "../data/nomes.ts";

export type ToolCtx = {
  rpc: Rpc; bases: Bases; usuario: Contexto; store: Store;
  sessao: string; canal: string; hoje: string; uuid: () => string;
  cache: Map<string, unknown>;
  /** Cartões visuais da resposta (montados com os números das ferramentas, nunca pelo modelo). */
  blocos?: Map<string, Bloco>;
};

/** Contrato de cartões para o chat do Portal (ver README → "Cartões"). */
export type Bloco =
  | { tipo: "opcoes"; titulo: string; veiculo: Record<string, unknown>; parcela_alvo?: number | null; destaque: OpcaoSaida | null; alternativas: OpcaoSaida[]; base?: string | null }
  | { tipo: "resultado"; titulo: string; periodo: string; visao: string; lojas: Record<string, unknown>[]; total?: Record<string, unknown> | null }
  | { tipo: "comparacao"; titulo: string; periodo: string; visao: string; lojas: string[]; linhas: { indicador: string; rotulo: string; formato: "int" | "brl" | "pct"; valores: (number | null)[]; lider: string | null }[] }
  | { tipo: "score"; titulo: string; periodo: string; visao: string; vendedor: Record<string, unknown>; composicao: Record<string, unknown>[]; destaques: string[]; melhorar: Record<string, unknown>[]; utilizacao_conversao?: Record<string, unknown>; ranking: Record<string, unknown>[] }
  | { tipo: "antecipacao"; titulo: string; [k: string]: unknown }
  | { tipo: "cash"; titulo: string; [k: string]: unknown }
  | { tipo: "salario"; titulo: string; [k: string]: unknown }
  | { tipo: "fandi"; titulo: string; [k: string]: unknown }
  | { tipo: "plano"; titulo: string; [k: string]: unknown };

function poeBloco(ctx: ToolCtx, chave: string, b: Bloco) {
  if (!ctx.blocos) ctx.blocos = new Map();
  ctx.blocos.delete(chave);
  ctx.blocos.set(chave, b);
}

// ---------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------
const S_ = (type: string, extra: Record<string, unknown> = {}) => ({ type, ...extra });
const Nul = (type: string, extra: Record<string, unknown> = {}) => ({ type: [type, "null"], ...extra });

const PERIODO_ENUM = ["competencia_atual", "competencia_anterior", "mes_atual", "mes_anterior", "ultimos_30", "ultimos_90", "ultimos_dias", "hoje", "personalizado"];
const periodoProps = (padrao: string) => ({
  periodo: S_("string", { enum: PERIODO_ENUM, description: `Padrão: ${padrao}. Use EXATAMENTE o período pedido, nunca outro parecido. "competencia" = período de comissão do Portal (21→20). "mes" = mês civil. "hoje" = só o dia de hoje. "Últimos N dias" com QUALQUER N (7, 45, 60, 120...) = ultimos_dias com dias=N (ultimos_30/ultimos_90 são só atalhos de 30 e 90). Intervalo com datas ("de 01/09 a 15/09", "desde 21/09") = personalizado com data_inicio e data_fim (data_fim null = até hoje). Mês pelo nome ("agosto") = personalizado do dia 1 ao último dia desse mês (ano atual; se o mês ainda não chegou, ano anterior). O backend resolve as datas e devolve o período usado.` }),
  dias: Nul("integer", { description: "Só com periodo='ultimos_dias': o N de 'últimos N dias' (1 a 731). Senão null." }),
  data_inicio: Nul("string", { description: "AAAA-MM-DD, só com periodo='personalizado'; senão null." }),
  data_fim: Nul("string", { description: "AAAA-MM-DD, só com periodo='personalizado' (null = até hoje); senão null." }),
});
const lojaProp = (desc: string) => Nul("string", { description: `${desc} Lojas: ${LOJAS.join(", ")}.` });

const VEICULO = {
  tipo: S_("string", { enum: ["novo", "seminovo"], description: "Padrão 'novo'. 'seminovo' só se o usuário disser seminovo/usado ou citar km." }),
  modelo: S_("string", { description: "Família/modelo como o usuário disse. Ex.: 'Eclipse Cross', 'Triton', 'Outlander'." }),
  versao: Nul("string", { description: "Versão. Ex.: 'HPE', 'HPE-S', 'HPE-S S-AWC', 'Katana'. null se não informada." }),
  ano_modelo: Nul("integer", { description: "Obrigatório para seminovo (define a faixa de taxa). Para novo, null." }),
  valor_veiculo: S_("number", { description: "Valor de venda do veículo em R$, informado pelo usuário." }),
};

function tool(name: string, description: string, props: Record<string, unknown>) {
  return {
    type: "function", name, description, strict: true,
    parameters: { type: "object", properties: props, required: Object.keys(props), additionalProperties: false },
  };
}

export const DEFINICOES = [
  tool("listar_planos_elegiveis",
    "Lista os planos dos simuladores em que o veículo se enquadra, com entrada mínima e prazos de cada um. Use antes de ofertar quando não souber quais planos cabem (ex.: o modelo está no Coparticipado?).",
    { ...VEICULO }),
  tool("simular_financiamento",
    "Simula planos com o mesmo motor dos Simuladores do Portal e devolve as opções já RANQUEADAS (ranking + motivo_ranking), cada uma com simulacao_id. objetivo='oferta' (padrão, quando passam carro + entrada): planos estratégicos, Plano Balão primeiro e depois Linear. objetivo='estrategia_historico' (quando pedem ajuda para montar algo estratégico): ordena pelos planos que a equipe mais vendeu desse modelo. Taxa Subsidiada, Coparticipado e Semestral Taxa 0% SÓ entram se o usuário pedir esses planos (custam rebate para a loja). entrada=null usa a entrada média (%) do histórico do modelo.",
    {
      ...VEICULO,
      entrada: Nul("number", { description: "Entrada em R$ dita pelo usuário. null = backend usa a entrada média do histórico do modelo e devolve entrada_usada/origem_entrada." }),
      objetivo: S_("string", { enum: ["oferta", "estrategia_historico"], description: "Padrão 'oferta'. 'estrategia_historico' só quando o usuário pedir ajuda para montar uma estratégia." }),
      planos_com_subsidio: Nul("array", { items: S_("string", { enum: ["TAXA_SUBSIDIADA", "COPARTICIPADO", "SEMESTRAL_TAXA_ZERO"] }), description: "Só os que o USUÁRIO pediu explicitamente. null = nenhum." }),
      apenas_planos: Nul("array", { items: S_("string", { enum: ["LINEAR", "BALAO", "SEMESTRAL_ANUAL", "PARCELA_UNICA", "TAXA_SUBSIDIADA", "COPARTICIPADO", "SEMESTRAL_TAXA_ZERO"] }), description: "Quando o usuário quer ver só certos planos (ex.: 'só o linear'). null = todos os permitidos." }),
      prazos: Nul("array", { items: S_("integer"), description: "Filtrar prazos em meses. null = todos." }),
      parcela_alvo: Nul("number", { description: "Parcela mensal que o cliente quer, se ele disse. Opções que cabem sobem no ranking." }),
      estrutura_balao: S_("string", { enum: ["preferidas", "ate_2_baloes", "todas"], description: "Estruturas do Plano Balão. 'preferidas' (padrão) = as que mais vendem, sempre 1 balão: 48x balão na última, 48x balão na 36ª, 36x balão na última, 36x balão na 24ª. 'ate_2_baloes' = inclui 48x (24ª e 48ª) e 36x (18ª e 36ª), só se o cliente aceitar 2 balões. 'todas' = 3-4 balões e outros prazos, só se o usuário pedir explicitamente." }),
    }),
  tool("simular_plano_campanha",
    "Planos com subsídio (Coparticipado, Taxa Subsidiada, Semestral Triton/Outlander Taxa 0%) do jeito que a tela do Simulador de Novos mostra: TODOS os prazos do plano com taxa a.m. e parcela, entrada mínima, valor financiado, rebate (total e divisão HPE × Brabus quando houver) e valor final de venda. Use SEMPRE que o usuário pedir um desses planos pelo nome (ex.: 'coparticipado do Eclipse HPE', 'menor entrada no coparticipado', 'taxa subsidiada em todos os prazos', 'semestral do Triton'). entrada=null = entrada mínima do plano.",
    {
      ...VEICULO,
      plano: S_("string", { enum: ["COPARTICIPADO", "TAXA_SUBSIDIADA", "SEMESTRAL_TAXA_ZERO"] }),
      entrada: Nul("number", { description: "Entrada em R$ dita pelo usuário. null = entrada mínima do plano (no Semestral Taxa 0% a entrada é fixa)." }),
      prazos: Nul("array", { items: S_("integer"), description: "Só se o usuário pediu prazos específicos. null = todos os prazos do plano." }),
    }),
  tool("buscar_entrada_minima",
    "Cálculo reverso para quando pedem uma parcela específica com a menor entrada: para cada plano mensal e prazo, a MENOR entrada que faz a parcela caber no alvo. Ordena primeiro pelos planos MAIS VENDIDOS desse modelo no histórico e, dentro de cada plano, pela menor entrada. Subsídio só se o usuário pedir. Se nenhuma atinge o alvo, atingivel=false e mais_proxima.",
    {
      ...VEICULO,
      parcela_alvo: S_("number", { description: "Parcela mensal máxima que o cliente aceita (R$). Se ele aceita 'um pouco mais', some a folga que ele disser; se não disse quanto, use +10%." }),
      planos_com_subsidio: Nul("array", { items: S_("string", { enum: ["TAXA_SUBSIDIADA", "COPARTICIPADO"] }), description: "Só os que o USUÁRIO pediu explicitamente. null = nenhum." }),
      estrutura_balao: S_("string", { enum: ["preferidas", "ate_2_baloes", "todas"], description: "Estruturas do Plano Balão. 'preferidas' (padrão) = as que mais vendem, sempre 1 balão: 48x balão na última, 48x balão na 36ª, 36x balão na última, 36x balão na 24ª. 'ate_2_baloes' = inclui 48x (24ª e 48ª) e 36x (18ª e 36ª), só se o cliente aceitar 2 balões. 'todas' = 3-4 balões e outros prazos, só se o usuário pedir explicitamente." }),
      balao_personalizado: Nul("object", { properties: { prazo: S_("integer", { enum: [12, 24, 30, 36, 40, 42, 48] }), meses: S_("array", { items: S_("integer"), description: "Meses dos balões (1 a 4; Seminovos até 2)." }) }, required: ["prazo", "meses"], additionalProperties: false, description: "Quando o usuário define a estrutura (ex.: 'balão no mês 30 em 48x'). O motor acha a menor entrada com o balão máximo nesses meses. null = usar estrutura_balao." }),
    }),
  tool("simular_balao",
    "Plano Balão com balões escolhidos (meses e valores). Use para montar uma estrutura sob medida (ex.: um balão grande num mês específico, ou balões menores para caber no bolso). Novos: até 4 balões; Seminovos: até 2. A soma não passa do limite da tabela (limite_baloes vem nas opções de Balão). Pelo menos 1 balão: não existe Plano Balão sem balão.",
    {
      ...VEICULO,
      entrada: S_("number", { description: "Entrada em R$." }),
      prazo: S_("integer", { enum: [12, 24, 30, 36, 40, 42, 48] }),
      baloes: S_("array", { items: { type: "object", properties: { mes: S_("integer"), valor: S_("number") }, required: ["mes", "valor"], additionalProperties: false }, description: "Lista de balões {mes, valor}, de 1 a 4 (Seminovos: até 2)." }),
    }),
  tool("apresentar_opcoes",
    "Opcional. Troca as opções dos CARTÕES visuais (por padrão já mostram a 1ª opção em destaque e as 2 seguintes). Use só para destacar outra opção ou outra combinação: 1 a 3 simulacao_id; destaque_id = a melhor condição para ESTE cliente.",
    {
      simulacao_ids: S_("array", { items: S_("string"), description: "1 a 3 ids, na ordem de recomendação." }),
      destaque_id: S_("string", { description: "Id da opção que vai na caixa 'Melhor condição'." }),
      titulo: S_("string", { description: "Título curto do cartão. Ex.: 'Eclipse Cross HPE · entrada R$ 90.000'." }),
    }),
  tool("simular_antecipacao",
    "Antecipação/quitação com a tabela de desconto do Portal. Para uma simulação desta conversa use simulacao_id. Para contrato do cliente informe prazo TOTAL (contando a parcela do balão), parcela mensal e os balões. 'Daqui a N meses/anos' → meses_ate_antecipacao (o backend calcula HOJE + N meses).",
    {
      simulacao_id: Nul("string", { description: "Id de simular_financiamento/buscar_entrada_minima/simular_balao. null se for contrato informado pelo usuário." }),
      prazo: Nul("integer", { description: "Prazo TOTAL do contrato em meses, incluindo a parcela do balão (ex.: 47 mensais + balão na 48 → 48). Só sem simulacao_id." }),
      parcela: Nul("number", { description: "Parcela mensal do contrato (só sem simulacao_id)." }),
      baloes: Nul("array", { items: { type: "object", properties: { mes: S_("integer"), valor: S_("number") }, required: ["mes", "valor"], additionalProperties: false }, description: "Balões do contrato do cliente (ex.: 'parcela final na 48 de R$ 55.663' → [{mes:48, valor:55663}]). No mês do balão ele SUBSTITUI a parcela. null se não houver." }),
      primeiro_vencimento: Nul("string", { description: "AAAA-MM-DD da 1ª parcela, se o usuário disser. null = contrato começando agora (1ª parcela em 30 dias)." }),
      meses_ate_antecipacao: Nul("integer", { description: "'Daqui a um ano' = 12; 'daqui a 6 meses' = 6. O backend usa HOJE + N meses. null = hoje (ou data_antecipacao)." }),
      data_antecipacao: Nul("string", { description: "AAAA-MM-DD só se o usuário der uma data exata; senão null." }),
      tipo: S_("string", { enum: ["todo", "algumas", "uma"], description: "'todo' = quitar o contrato; 'uma' = uma parcela (parcela_escolhida); 'algumas' = intervalo de/ate." }),
      de: Nul("integer"), ate: Nul("integer"),
      parcela_escolhida: Nul("integer", { description: "Nº da parcela em tipo='uma'. 'A última parcela' quando o contrato tem balão final = o mês do BALÃO." }),
    }),
  tool("simular_cash_conversion",
    "CASH CONVERSION do Portal. Use SEMPRE que perguntarem se compensa financiar ou pagar à vista / guardar / aplicar o dinheiro. Compara o total pago no financiamento com quanto o capital renderia aplicado no mesmo prazo, e devolve a taxa de empate.",
    {
      simulacao_id: Nul("string", { description: "Opção já simulada. null se o usuário informou parcela e prazo." }),
      parcela: Nul("number"), prazo: Nul("integer"),
      capital: S_("number", { description: "Dinheiro que o cliente usaria para pagar à vista (R$). Se ele disse 'financiando 90.000', capital = 90000." }),
      taxa_aplicacao_mensal: Nul("number", { description: "Rendimento mensal líquido da aplicação do cliente em fração (1% a.m. = 0.01). null se o usuário não disse: o backend roda cenários de referência e a taxa de empate." }),
    }),
  tool("calcular_taxa",
    "Descobre a taxa (NET e CET ao mês) de uma proposta a partir do valor financiado, prazo e parcela. Útil para comparar proposta de concorrente.",
    { financiado: S_("number"), prazo: S_("integer"), parcela: S_("number") }),
  tool("historico_vendas",
    "Vendas e financiamentos de um modelo no período: vendidos, financiados, penetração, entrada média, prazo médio, parcela média e mix de planos. Se vierem menos de 5 financiados e o período foi o padrão, chame de novo com ultimos_90 e avise.",
    { modelo: S_("string"), versao: Nul("string"), loja: lojaProp("null = escopo do usuário."), ...periodoProps("ultimos_30") }),
  tool("resultado_loja",
    "Resultado de Financiamentos por loja: vendidos, financiados, share, produção, SPF e (se o perfil permitir) retorno e rentabilidade, com o período anterior comparável e as variações já calculadas.",
    { loja: lojaProp("null = lojas do escopo do usuário (todas, se ele puder ver o grupo)."), departamento: Nul("string", { enum: ["NOVOS", "SEMINOVOS", null], description: "Visão do Portal. NOVOS ou SEMINOVOS quando o usuário disser; null = Grupo (Novos + Seminovos), que já vem com a divisão por departamento." }), ...periodoProps("competencia_atual") }),
  tool("comparar_lojas",
    "Compara 2 ou mais lojas no mesmo período: indicadores de cada uma, líder por indicador e diferença de cada loja para o líder.",
    { lojas: S_("array", { items: S_("string"), description: "Nomes das lojas (2 ou mais)." }), departamento: Nul("string", { enum: ["NOVOS", "SEMINOVOS", null], description: "Visão do Portal. NOVOS ou SEMINOVOS quando o usuário disser; null = Grupo (Novos + Seminovos), que já vem com a divisão por departamento." }), ...periodoProps("competencia_atual") }),
  tool("ranking_vendedores",
    "Ranking de vendedores no período por um critério. O banco limita quem aparece conforme o perfil.",
    {
      criterio: S_("string", { enum: ["producao", "financiados", "share", "vendidos", "spf", "retorno"] }),
      loja: lojaProp("null = escopo do usuário."), departamento: Nul("string", { enum: ["NOVOS", "SEMINOVOS", null], description: "Visão do Portal. NOVOS ou SEMINOVOS quando o usuário disser; null = Grupo (Novos + Seminovos), que já vem com a divisão por departamento." }), ...periodoProps("competencia_atual"),
    }),
  tool("analise_fi",
    "Análise F&I / FANDI (base de propostas importada no Portal): propostas por banco (recusadas, aprovadas, faturadas, taxa de recusa), propostas aprovadas e recusadas por loja, operações financiadas e mix de planos (Linear, Balão, Coparticipado, Subsidiado, Reversão). Use para 'qual banco mais recusou', 'quantas aprovadas hoje', 'quantos coparticipados em agosto'.",
    {
      foco: S_("string", { enum: ["geral", "recusas_por_banco", "aprovacoes", "faturamento", "planos", "bancos", "lojas"], description: "O que a pergunta quer saber: o cartão destaca essa parte. 'aprovacoes' = quantas aprovadas; 'faturamento' = quantas faturadas/pagas." }),
      plano: Nul("string", { enum: ["LINEAR", "BALÃO", "COPARTICIPADO", "SUBSIDIADO", "REVERSÃO", null], description: "Quando perguntarem por um plano específico." }),
      loja: lojaProp("null = todas do escopo."), departamento: Nul("string", { enum: ["NOVOS", "SEMINOVOS", null] }), ...periodoProps("mes_atual"),
    }),
  tool("consultar_score",
    "Score de vendedores (0–1000) com a composição dos pontos, igual à tela Análise de Score.",
    {
      vendedor: Nul("string", { description: "Nome (ou parte) do vendedor. null = ranking." }),
      loja: lojaProp("null = escopo do usuário."),
      departamento: Nul("string", { enum: ["NOVOS", "SEMINOVOS", null], description: "null = os dois." }),
      ...periodoProps("competencia_atual"),
    }),
  tool("consultar_salario",
    "Salário variável / comissão de uma pessoa (vendedor, gerente, analista) ou da própria pessoa logada. fechamento='ultimo_fechado' = último fechamento oficial (snapshot gravado no Painel Master); 'AAAA-MM' = fechamento cuja competência termina nesse mês; 'competencia_atual' = prévia da competência em andamento. O banco limita quem cada perfil pode ver.",
    {
      pessoa: Nul("string", { description: "Nome (ou parte) de quem o usuário perguntou. null = o próprio usuário logado ('meu salário')." }),
      fechamento: S_("string", { description: "'ultimo_fechado' quando falarem em último fechamento/salário pago/mês passado; 'competencia_atual' para prévia/este mês; ou 'AAAA-MM' (mês em que a competência termina; ex.: competência 21/08–20/09 = '2026-09')." }),
      loja: lojaProp("Opcional, para desempatar nomes iguais. null = todas."),
    }),
  tool("consultar_manual",
    "Como funciona um plano, o cash conversion, a antecipação, o score, termos do Grupo e argumentos de venda. Texto conceitual, sem valores vigentes.",
    { pergunta: S_("string") }),
];

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
const r2 = (v: number) => Math.round(v * 100) / 100;
const r4 = (v: number) => Math.round(v * 1e6) / 1e6;
const pctv = (v: number) => Math.round(v * 10000) / 100; // fração → % com 2 casas

async function periodo(ctx: ToolCtx, a: any, padrao: TipoPeriodo): Promise<PeriodoResolvido> {
  const tipo = (a.periodo ?? padrao) as TipoPeriodo;
  let periodos: PeriodoComissao[] = [];
  if (tipo.startsWith("competencia")) {
    if (!ctx.cache.has("periodos")) {
      const r = await ctx.rpc.call<any>("operational_commission_periods").catch(() => null);
      // Só datas e nome: o campo criado_por (CPF) é descartado aqui.
      ctx.cache.set("periodos", (r?.rows ?? []).map((p: any) => ({ nome_periodo: p.nome_periodo, data_inicio: p.data_inicio, data_fim: p.data_fim, periodo_atual: p.periodo_atual, ativo: p.ativo })));
    }
    periodos = ctx.cache.get("periodos") as PeriodoComissao[];
  }
  const r = resolvePeriodo(tipo, ctx.hoje, periodos, a.data_inicio, a.data_fim, a.dias);
  if ("erro" in r) throw new ErroFerramenta(r.erro);
  return r;
}

/** Período REAL usado na consulta (com datas), para toda resposta com número citar exatamente esse período. */
function infoPeriodo(p: PeriodoResolvido) {
  return { periodo: p.rotulo, periodo_inicio: p.inicio, periodo_fim: p.fim, aviso_periodo: p.aviso };
}

/** Loja/escopo considerado quando a ferramenta roda: a pedida ou, sem loja, o escopo do perfil. */
function lojaConsiderada(ctx: ToolCtx, loja: string | null): string {
  if (loja) return loja;
  if (ctx.usuario.perfil === "VENDEDOR") return "só os seus números (perfil Vendedor)";
  // O escopo do MASTER/Diretor vem com valores que não são loja (ex.: "MASTER"): aí é o Grupo.
  const sua = normalizaLoja(ctx.usuario.loja ?? "");
  if (sua && !ehPseudoLoja(sua) && (LOJAS as readonly string[]).includes(sua)) return `sua loja (${sua})`;
  return "todas as lojas (Grupo)";
}

export class ErroFerramenta extends Error {}

const tokens = (s: string) => normalizaModelo(s).split(/[\s/]+/).filter(Boolean);
/** Todas as palavras pedidas aparecem como palavras inteiras no texto do modelo ("HPE" não casa "HPE-S"). */
export function casaModeloTexto(modeloRpc: string, modelo: string, versao: string | null): boolean {
  const alvo = tokens(`${modelo} ${versao ?? ""}`);
  const tem = new Set(tokens(modeloRpc));
  return alvo.every((t) => tem.has(t));
}

function exigeModulo(ctx: ToolCtx, m: string, nome: string) {
  if (!temModulo(ctx.usuario, m)) throw new ErroFerramenta(`Seu perfil não tem acesso ao módulo ${nome} no Portal.`);
}

/** Antecipação, Cash Conversion e Calculadora de Taxa vivem dentro dos simuladores no Portal. */
function exigeSimulador(ctx: ToolCtx) {
  if (!temModulo(ctx.usuario, MODULO.simNovos) && !temModulo(ctx.usuario, MODULO.simSeminovos)) {
    throw new ErroFerramenta("Seu perfil não tem acesso aos Simuladores no Portal.");
  }
}

/** O próprio usuário? (comparação por nome normalizado, sem trocar de pessoa) */
function ehProprio(ctx: ToolCtx, nome: string): boolean {
  const eu = normalizaModelo(String(ctx.usuario.nome ?? ""));
  const q = normalizaModelo(nome);
  return !!eu && !!q && (eu === q || eu.includes(q) && q.length >= 3 && eu.split(" ")[0] === q.split(" ")[0]);
}

function lojaOuErro(l: string | null | undefined): string | null {
  if (l == null) return null;
  const n = normalizaLoja(l);
  if (!n) throw new ErroFerramenta(`Loja "${l}" não reconhecida. Lojas: ${LOJAS.join(", ")}.`);
  return n;
}

async function tabelasPara(ctx: ToolCtx, a: any): Promise<{ sim: CtxSim; avisos: string[] }> {
  const valor = Number(a.valor_veiculo);
  if (!(valor > 0)) throw new ErroFerramenta("Informe o valor do veículo.");
  if (a.tipo === "seminovo") {
    exigeModulo(ctx, MODULO.simSeminovos, "Simulador de Seminovos");
    if (!a.ano_modelo) throw new ErroFerramenta("Para seminovo preciso do ano do veículo (define a faixa de taxa).");
    const t = await ctx.bases.seminovos();
    return { sim: { tipo: "seminovo", modelo: a.modelo, versao: a.versao, ano: Number(a.ano_modelo), valor, tabelas: t }, avisos: [] };
  }
  exigeModulo(ctx, MODULO.simNovos, "Simulador de Novos");
  const { tabelas, indisponiveis } = await ctx.bases.novos();
  return {
    sim: { tipo: "novo", modelo: a.modelo, versao: a.versao, valor, tabelas },
    avisos: indisponiveis.length ? [`Bases fora do ar no Portal (planos não simulados): ${indisponiveis.join(", ")}.`] : [],
  };
}

/** Histórico do modelo (últimos 30 → 90 dias) para entrada média e popularidade dos planos. */
async function historicoModelo(ctx: ToolCtx, modelo: string, versao: string | null) {
  for (const tipo of ["ultimos_30", "ultimos_90"] as TipoPeriodo[]) {
    const p = await periodo(ctx, { periodo: tipo }, tipo);
    const r = await ctx.rpc.call<any>("operational_model_metrics", { p_start: p.inicio, p_end: p.fim, p_group_view: true }).catch(() => null);
    const rows = (r?.rows ?? []).filter((x: any) => casaModeloTexto(x.model, modelo, versao));
    const fin = rows.reduce((s: number, x: any) => s + (Number(x.financed_count) || 0), 0);
    if (fin >= 5 || tipo === "ultimos_90") {
      const entTot = rows.reduce((s: number, x: any) => s + (Number(x.entry_total) || 0), 0);
      const entVenda = rows.reduce((s: number, x: any) => s + (Number(x.entry_sales_value_total) || 0), 0);
      const mix: Record<string, number> = {};
      for (const x of rows) for (const pb of x.plan_breakdown ?? []) mix[pb.plan_type] = (mix[pb.plan_type] || 0) + (Number(pb.financed_count) || 0);
      return { periodo: p, financiados: fin, entradaPct: entVenda > 0 ? entTot / entVenda : null, mix };
    }
  }
  return null;
}

/** Planos que custam rebate para a loja: só entram quando o usuário pede. */
const PLANOS_SUBSIDIO = ["TAXA_SUBSIDIADA", "COPARTICIPADO", "SEMESTRAL_TAXA_ZERO"];

// Plano do simulador → categoria do histórico (plan_type do banco)
const CATEGORIA: Record<string, string> = {
  LINEAR: "LINEAR", BALAO: "BALÃO", SEMESTRAL_ANUAL: "BALÃO", PARCELA_UNICA: "BALÃO",
  TAXA_SUBSIDIADA: "SUBSIDIADO", COPARTICIPADO: "COPARTICIPADO", SEMESTRAL_TAXA_ZERO: "COPARTICIPADO",
};

type OpcaoSaida = Record<string, unknown>;
function saidaOpcao(ctx: ToolCtx, o: Opcao, id: string, extra: Record<string, unknown> = {}): OpcaoSaida {
  const s: OpcaoSaida = {
    simulacao_id: id, plano: o.plano, plano_nome: o.plano_nome, prazo: o.prazo, periodicidade: o.periodicidade,
    qtd_pagamentos: o.qtd_pagamentos, entrada: r2(o.entrada), entrada_pct: pctv(o.entrada / (o.entrada + o.financiado)),
    financiado: r2(o.financiado), taxa_tabela_pct_am: o.taxa_tabela == null ? null : r4(o.taxa_tabela * 100),
    parcela: r2(o.parcela), ...extra,
  };
  if (o.rebate_concessionaria != null) { s.rebate_concessionaria = r2(o.rebate_concessionaria); s.valor_final_venda = r2(o.valor_final_venda ?? 0); }
  if (!o.baloes?.length && o.periodicidade === "mensal") s.como_paga = [{ rotulo: `${o.prazo} parcelas mensais`, valor: r2(o.parcela) }];
  if (o.baloes?.length) {
    s.estrutura_baloes = o.estrutura_baloes;
    s.baloes = o.baloes.map((b) => ({ mes: b.mes, valor: r2(b.valor), total_no_mes: r2(o.parcela + b.valor) }));
    s.total_baloes = r2(o.total_baloes ?? 0);
    s.limite_baloes = r2(o.limite_baloes ?? 0);
    s.baloes_pct_do_veiculo = pctv((o.total_baloes ?? 0) / (o.entrada + o.financiado));
    // Leitura simples para o cliente: "1 balão de R$ 90.000 na 48ª parcela"
    const bs = o.baloes.slice().sort((x, y) => x.mes - y.mes);
    const iguais = bs.every((b) => Math.abs(b.valor - bs[0].valor) < 0.01);
    const meses = bs.map((b) => `${b.mes}ª`);
    const lista = meses.length > 1 ? `${meses.slice(0, -1).join(", ")} e ${meses[meses.length - 1]}` : meses[0];
    s.resumo_baloes = bs.length === 1
      ? `1 balão de ${brlTxt(bs[0].valor)} na ${lista} parcela`
      : iguais ? `${bs.length} balões de ${brlTxt(bs[0].valor)} (${lista} parcelas)` : `${bs.length} balões (${bs.map((b) => `${b.mes}ª: ${brlTxt(b.valor)}`).join("; ")})`;
    s.como_paga = [
      { rotulo: `${o.prazo} parcelas mensais`, valor: r2(o.parcela) },
      ...bs.map((b) => ({ rotulo: `+ balão na ${b.mes}ª parcela`, valor: r2(b.valor) })),
    ];
    if (o.aceitacao != null) s.aceitacao_comercial = o.aceitacao <= 4 ? "alta (estrutura que mais vende)" : o.aceitacao <= 6 ? "média (2 balões)" : "baixa (3+ balões / prazo pouco usado)";
  }
  return s;
}

async function salvar(ctx: ToolCtx, base: Record<string, unknown>, ops: Opcao[]): Promise<string[]> {
  const itens = ops.map((o) => ({ id: ctx.uuid(), payload: { ...base, opcao: o, ...(o.baloes?.length && !base.baloes ? { baloes: o.baloes } : {}) } }));
  await ctx.store.salvarSimulacoes(ctx.sessao, itens);
  return itens.map((i) => i.id);
}

async function simulacaoPorId(ctx: ToolCtx, id: string): Promise<{ opcao: Opcao; veiculo: any; baloes: N.Balao[] }> {
  const r = await ctx.store.lerSimulacao(id);
  if (r.status === "expirada") throw new ErroFerramenta("Essa simulação expirou. Quer que eu refaça?");
  if (r.status === "nao_encontrada") throw new ErroFerramenta("Simulação não encontrada.");
  return { opcao: r.payload.opcao, veiculo: r.payload.veiculo, baloes: Array.isArray(r.payload.baloes) ? r.payload.baloes : [] };
}

// ---------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------
type Handler = (a: any, ctx: ToolCtx) => Promise<unknown>;

const H: Record<string, Handler> = {
  async listar_planos_elegiveis(a, ctx) {
    const { sim, avisos } = await tabelasPara(ctx, a);
    const planos = new Map<string, { plano: string; plano_nome: string; entrada_minima_pct: number; prazos: Set<number> }>();
    for (let p = 0; p <= 95; p += 1) {
      for (const o of opcoesParaEntrada(sim, sim.valor * p / 100)) {
        const k = o.plano_nome.startsWith("Taxa Subsidiada") ? "Taxa Subsidiada" : o.plano_nome;
        const cur = planos.get(k) ?? { plano: o.plano, plano_nome: k, entrada_minima_pct: p, prazos: new Set<number>() };
        cur.prazos.add(o.prazo); planos.set(k, cur);
      }
    }
    const out: any[] = [...planos.values()].map((x) => ({ plano: x.plano, plano_nome: x.plano_nome, entrada_minima_pct: x.entrada_minima_pct, prazos: [...x.prazos].sort((m, n) => m - n), ...(PLANOS_SUBSIDIO.includes(x.plano) ? { com_subsidio_so_se_pedido: true } : {}) }));
    if (sim.tipo === "novo") {
      const st = opcaoSemestralTriton(sim);
      if (st) out.push({ plano: st.plano, plano_nome: st.plano_nome, entrada_fixa_pct: pctv(st.entrada / sim.valor), prazos: [24], com_subsidio_so_se_pedido: true });
      out.push({ modelos_coparticipado: sim.tabelas.copartModels.map((m) => m.name), modelos_semestral_taxa_zero: Object.keys(sim.tabelas.semestralModelos) });
    }
    return { veiculo: { tipo: sim.tipo, modelo: a.modelo, versao: a.versao }, planos: out, bases: ctx.bases.usadas, avisos };
  },

  async simular_financiamento(a, ctx) {
    const { sim, avisos } = await tabelasPara(ctx, a);
    const hist = await historicoModelo(ctx, a.modelo, a.versao);
    let entrada: number, origem: string;
    if (a.entrada != null) { entrada = Number(a.entrada); origem = "informada"; }
    else if (hist?.entradaPct != null) { entrada = r2(sim.valor * hist.entradaPct); origem = "media_historico"; }
    else return { origem_entrada: "sem_historico", mensagem: "Não há histórico de vendas desse modelo para estimar a entrada. Pergunte ao usuário a entrada do cliente." };
    if (!(entrada >= 0) || entrada >= sim.valor) throw new ErroFerramenta("A entrada deve ser menor que o valor do veículo.");

    const subsidios: string[] = a.planos_com_subsidio ?? [];
    const modo: ModoBalao = a.estrutura_balao ?? "preferidas";
    let ops = opcoesParaEntrada(sim, entrada, modo);
    if (sim.tipo === "novo") { const st = opcaoSemestralTriton(sim); if (st) ops.push(st); }
    const apenas: string[] = a.apenas_planos ?? [];
    // Pedir um plano com subsídio em "apenas_planos" também conta como pedido explícito.
    for (const p of apenas) if (PLANOS_SUBSIDIO.includes(p) && !subsidios.includes(p)) subsidios.push(p);
    ops = ops.filter((o) => !PLANOS_SUBSIDIO.includes(o.plano) || subsidios.includes(o.plano));
    if (apenas.length) ops = ops.filter((o) => apenas.includes(o.plano));
    if (a.prazos?.length) ops = ops.filter((o) => a.prazos.includes(o.prazo));
    if (!ops.length) return { entrada_usada: entrada, origem_entrada: origem, opcoes: [], mensagem: "Nenhum plano elegível com essa entrada/filtros. Veja listar_planos_elegiveis.", avisos };

    const objetivo = a.objetivo === "estrategia_historico" ? "estrategia_historico" : "oferta";
    const totalHist = hist ? Object.values(hist.mix).reduce((s, n) => s + n, 0) : 0;
    const pop = (o: Opcao) => (totalHist ? (hist!.mix[CATEGORIA[o.plano]] ?? 0) / totalHist : 0);
    const alvo = a.parcela_alvo != null ? Number(a.parcela_alvo) : null;
    const cabe = (o: Opcao) => (alvo == null || o.periodicidade !== "mensal") ? 0 : o.parcela <= alvo ? 1 : 0;
    // Ordem estratégica da oferta padrão: Plano Balão, depois Linear, depois os subsídios pedidos.
    const ORDEM_OFERTA = ["BALAO", "LINEAR", "COPARTICIPADO", "TAXA_SUBSIDIADA"];
    const estrat = (o: Opcao) => { const k = ORDEM_OFERTA.indexOf(o.plano); return k < 0 ? 99 : k; };
    const mensais = ops.filter((o) => o.periodicidade === "mensal");
    const especiais = ops.filter((o) => o.periodicidade !== "mensal");
    mensais.sort(objetivo === "oferta"
      ? (x, y) => cabe(y) - cabe(x) || estrat(x) - estrat(y) || (x.aceitacao ?? 0) - (y.aceitacao ?? 0) || x.parcela - y.parcela
      : (x, y) => cabe(y) - cabe(x) || pop(y) - pop(x) || (x.aceitacao ?? 0) - (y.aceitacao ?? 0) || x.parcela - y.parcela);

    // Uma opção por plano no topo (o melhor prazo de cada plano), depois o resto
    const vistos = new Set<string>(); const topo: Opcao[] = []; const resto: Opcao[] = [];
    for (const o of mensais) (vistos.has(o.plano) ? resto : (vistos.add(o.plano), topo)).push(o);
    const ordenadas = [...topo, ...resto].slice(0, 6);

    const motivo = (o: Opcao): string => {
      const partes: string[] = [];
      if (alvo != null) partes.push(o.parcela <= alvo ? "cabe na parcela que o cliente pediu" : "acima da parcela pedida");
      if (o.plano === "BALAO") partes.push(`${o.estrutura_baloes}, usando o máximo de balão da tabela`);
      if (objetivo === "oferta") partes.push(o.plano === "BALAO" ? "plano estratégico da loja (Plano Balão vem primeiro)" : o.plano === "LINEAR" ? "plano estratégico da loja (Linear)" : "plano com subsídio pedido pelo usuário");
      else if (pop(o) > 0) partes.push(`${Math.round(pop(o) * 100)}% dos financiamentos desse modelo no histórico foram ${CATEGORIA[o.plano]}`);
      if (o.plano !== "BALAO") partes.push("menor parcela entre os prazos desse plano");
      return partes.join("; ");
    };
    const veiculo = { tipo: sim.tipo, modelo: a.modelo, versao: a.versao, ano_modelo: a.ano_modelo, valor: sim.valor };
    const ids = await salvar(ctx, { veiculo }, [...ordenadas, ...especiais]);
    const opcoes = ordenadas.map((o, k) => saidaOpcao(ctx, o, ids[k], { ranking: k + 1, motivo_ranking: motivo(o) }));
    const outras = especiais.map((o, k) => saidaOpcao(ctx, o, ids[ordenadas.length + k]));
    poeBloco(ctx, "opcoes", { tipo: "opcoes", titulo: `${a.modelo}${a.versao ? " " + a.versao : ""} · entrada ${brlTxt(entrada)}`, veiculo, parcela_alvo: alvo, destaque: opcoes[0] ?? null, alternativas: opcoes.slice(1, 3), base: hist ? `Histórico: ${hist.financiados} financiamentos do modelo (${hist.periodo.rotulo})` : null });
    if (subsidios.length) avisos.push("Os planos com subsídio pedidos têm rebate pago pela concessionária (reduz o valor final de venda).");
    return filtraCampos(ctx.usuario, {
      veiculo, entrada_usada: entrada, origem_entrada: origem, objetivo,
      subsidio_disponivel_se_pedir: subsidios.length ? undefined : "Taxa Subsidiada / Coparticipado não foram incluídos (só se o usuário pedir).",
      historico_base: hist ? { periodo: hist.periodo.rotulo, financiados: hist.financiados } : null,
      opcoes, pagamentos_nao_mensais: outras, bases: ctx.bases.usadas, avisos,
    });
  },

  async simular_plano_campanha(a, ctx) {
    if (a.tipo === "seminovo") throw new ErroFerramenta("Coparticipado, Taxa Subsidiada e Semestral Taxa 0% são planos do Simulador de Novos (0km).");
    const { sim, avisos } = await tabelasPara(ctx, { ...a, tipo: "novo" });
    if (sim.tipo !== "novo") throw new ErroFerramenta("Plano disponível só para 0km.");
    const t = sim.tabelas, v = sim.valor;
    const veiculo = { tipo: "novo", modelo: a.modelo, versao: a.versao, valor: v };
    const nomeV = `${a.modelo}${a.versao ? " " + a.versao : ""}`;
    const cent = (x: number) => Math.ceil(x * 100 - 1e-6) / 100;
    const filtroPrazo = (p: number) => !a.prazos?.length || a.prazos.includes(p);
    const pctTxt = (f: number) => `${(f * 100).toFixed(2).replace(".", ",")}%`;
    // Nome da tabela: igual ao Portal; se o usuário abreviou ("Eclipse HPE"), aceita quando só um nome contém todas as palavras.
    const acha = (nomes: string[]) => casaModelo(a.modelo, a.versao, nomes)
      ?? ((c) => c.length === 1 ? c[0] : null)(nomes.filter((n) => casaModeloTexto(n, a.modelo, a.versao)));

    if (a.plano === "COPARTICIPADO") {
      const nome = acha(t.copartModels.map((m) => m.name));
      if (!nome) throw new ErroFerramenta(`${nomeV} não está no Plano Coparticipado. Modelos do plano: ${t.copartModels.map((m) => m.name).join(", ")}.`);
      const m = t.copartModels.find((x) => x.name === nome)!;
      const entMin = cent(v * m.entry);
      const entrada = a.entrada != null ? Number(a.entrada) : entMin;
      if (entrada < entMin - 0.005) throw new ErroFerramenta(`No Coparticipado a entrada mínima é ${pctv(m.entry)}% (${brlTxt(entMin)}).`);
      const cp = N.coparticipado(nome, v, entrada, t);
      if ("erro" in cp) throw new ErroFerramenta(cp.erro);
      const termos = cp.termos.filter((x) => x.parcela != null && filtroPrazo(x.prazo));
      const ops: Opcao[] = termos.map((x) => ({ plano: "COPARTICIPADO", plano_nome: "Plano Coparticipado", prazo: x.prazo, periodicidade: "mensal", qtd_pagamentos: x.prazo, entrada, financiado: cp.financiado, taxa_tabela: x.taxa, parcela: x.parcela!, rebate_concessionaria: cp.rebateBrabus, valor_final_venda: cp.valorFinalVenda }));
      const ids = await salvar(ctx, { veiculo }, ops);
      const linhas = termos.map((x, k) => ({ simulacao_id: ids[k], prazo: x.prazo, taxa_pct_am: r4(x.taxa * 100), parcela: r2(x.parcela!) }));
      const rebate = {
        total: r2(cp.rebateTotal), total_pct_do_financiado: pctv(m.rebate),
        hpe: r2(cp.rebateHpe), hpe_pct_do_rebate: pctv(m.hpe),
        brabus: r2(cp.rebateBrabus), brabus_pct_do_rebate: pctv(m.brabus),
      };
      const out = {
        plano: "COPARTICIPADO", plano_nome: "Plano Coparticipado", modelo_tabela: nome, veiculo,
        entrada: r2(entrada), entrada_pct: pctv(entrada / v), entrada_minima: entMin, entrada_minima_pct: pctv(m.entry),
        financiado: r2(cp.financiado), prazos_do_plano: termos.map((x) => x.prazo), linhas,
        rebate, valor_final_venda: r2(cp.valorFinalVenda),
        leitura: `Rebate total ${brlTxt(rebate.total)}: HPE paga ${brlTxt(rebate.hpe)} e a Brabus paga ${brlTxt(rebate.brabus)}. O rebate é o mesmo em todos os prazos.`,
      };
      poeBloco(ctx, "plano", { tipo: "plano", titulo: `${nomeV} · Plano Coparticipado`, ...out, colunas: ["prazo", "taxa", "parcela"] });
      return { ...out, bases: ctx.bases.usadas, avisos };
    }

    if (a.plano === "TAXA_SUBSIDIADA") {
      const entMin = cent(v * 0.5);
      const entrada = a.entrada != null ? Number(a.entrada) : entMin;
      const sub = N.taxasSubsidiadas(v, entrada, 0, t);
      if ("erro" in sub) throw new ErroFerramenta(`${sub.erro} (${brlTxt(entMin)})`);
      const ls = sub.linhas.filter((l) => filtroPrazo(l.prazo)).sort((x, y) => x.taxa - y.taxa || x.prazo - y.prazo);
      const ops: Opcao[] = ls.map((l) => ({ plano: "TAXA_SUBSIDIADA", plano_nome: `Taxa Subsidiada ${pctTxt(l.taxa)}`, prazo: l.prazo, periodicidade: "mensal", qtd_pagamentos: l.prazo, entrada, financiado: sub.financiado, taxa_tabela: l.taxa, parcela: l.parcela, rebate_concessionaria: l.rebateValor, valor_final_venda: l.valorFinalVenda }));
      const ids = await salvar(ctx, { veiculo }, ops);
      const linhas = ls.map((l, k) => ({
        simulacao_id: ids[k], prazo: l.prazo, taxa_pct_am: r4(l.taxa * 100), parcela: r2(l.parcela),
        rebate_pct_do_financiado: pctv(l.rebatePct), rebate: r2(l.rebateValor), valor_final_venda: r2(l.valorFinalVenda),
        taxa_banco_cadastrar_pct_am: (() => { const x = N.taxaBancoCopiar(l.prazo, t); return x == null ? null : r4(x * 100); })(),
        ...(l.melhor ? { melhor_valor_final: true } : {}),
      }));
      const taxas = [...new Set(ls.map((l) => r4(l.taxa * 100)))];
      const out = {
        plano: "TAXA_SUBSIDIADA", plano_nome: "Taxa Subsidiada", veiculo,
        entrada: r2(entrada), entrada_pct: pctv(entrada / v), entrada_minima: entMin, entrada_minima_pct: 50,
        financiado: r2(sub.financiado), taxas_pct_am: taxas, prazos_do_plano: [...new Set(ls.map((l) => l.prazo))].sort((x, y) => x - y), linhas,
        leitura: "Na Taxa Subsidiada o rebate é pago pela concessionária (total, sem divisão com a HPE) e muda com a taxa e o prazo. taxa_banco_cadastrar = taxa a cadastrar no banco (botão 'Copiar Taxa Banco').",
      };
      poeBloco(ctx, "plano", { tipo: "plano", titulo: `${nomeV} · Taxa Subsidiada`, ...out, colunas: ["prazo", "taxa", "parcela", "rebate", "valor_final_venda"] });
      return { ...out, bases: ctx.bases.usadas, avisos };
    }

    // SEMESTRAL_TAXA_ZERO
    const nome = acha(Object.keys(t.semestralModelos));
    if (!nome) throw new ErroFerramenta(`${nomeV} não está na campanha Semestral Taxa 0%. Modelos: ${Object.keys(t.semestralModelos).join(", ")}.`);
    const r = N.semestralTritonOutlander(nome, v, t);
    if ("erro" in r) throw new ErroFerramenta(r.erro);
    const m = t.semestralModelos[nome];
    if (a.entrada != null && Math.abs(Number(a.entrada) - r.entrada) > 1) avisos.push(`No Semestral Taxa 0% a entrada é fixa em ${pctv(m.entradaMinima)}% (${brlTxt(r.entrada)}); a entrada informada não se aplica.`);
    const [id] = await salvar(ctx, { veiculo }, [{ plano: "SEMESTRAL_TAXA_ZERO", plano_nome: "Semestral Triton/Outlander Taxa 0%", prazo: 24, periodicidade: "semestral", qtd_pagamentos: r.meses.length, entrada: r.entrada, financiado: r.financiado, taxa_tabela: 0, parcela: r.parcela, rebate_concessionaria: r.rebateBrabus, valor_final_venda: r.valorFinalVenda }]);
    const rebate = {
      total: r2(r.rebateTotal), total_pct_do_financiado: pctv(m.rebateTotal),
      hpe: r2(r.rebateHpe), hpe_pct_do_rebate: pctv(m.hpeShare),
      brabus: r2(r.rebateBrabus), brabus_pct_do_rebate: pctv(m.brabusShare),
    };
    const out = {
      plano: "SEMESTRAL_TAXA_ZERO", plano_nome: "Semestral Triton/Outlander Taxa 0%", modelo_tabela: nome, veiculo, simulacao_id: id,
      entrada: r2(r.entrada), entrada_pct: pctv(m.entradaMinima), entrada_fixa: true, financiado: r2(r.financiado),
      prazo: 24, taxa_pct_am: 0, pagamentos: r.meses.map((mes) => ({ mes, valor: r2(r.parcela) })),
      parcela_semestral: r2(r.parcela), total_parcelas: r2(r.parcela * r.meses.length),
      rebate, valor_final_venda: r2(r.valorFinalVenda),
      leitura: `Entrada fixa + 4 parcelas semestrais (meses ${r.meses.join(", ")}) a taxa 0%. Rebate total ${brlTxt(rebate.total)}: HPE ${brlTxt(rebate.hpe)} e Brabus ${brlTxt(rebate.brabus)}.`,
    };
    poeBloco(ctx, "plano", { tipo: "plano", titulo: `${nomeV} · Semestral Taxa 0%`, ...out, colunas: ["mes", "parcela"] });
    return { ...out, bases: ctx.bases.usadas, avisos };
  },

  async buscar_entrada_minima(a, ctx) {
    const { sim, avisos } = await tabelasPara(ctx, a);
    const alvo = Number(a.parcela_alvo);
    if (!(alvo > 0)) throw new ErroFerramenta("Informe a parcela que o cliente quer.");
    const subsidios: string[] = a.planos_com_subsidio ?? [];
    const permitidos = ["LINEAR", "BALAO", ...subsidios];
    const pers = a.balao_personalizado;
    const maxQ = sim.tipo === "novo" ? 4 : 2;
    if (pers && (!Array.isArray(pers.meses) || !pers.meses.length || pers.meses.length > maxQ || pers.meses.some((m: number) => !(m >= 1 && m <= pers.prazo)))) {
      throw new ErroFerramenta(`Balão personalizado inválido: de 1 a ${maxQ} balões, com meses entre 1 e ${pers?.prazo}.`);
    }
    const so: EstruturaBalao[] | undefined = pers ? [{ prazo: Number(pers.prazo), meses: [...new Set<number>(pers.meses.map(Number))].sort((x, y) => x - y), nome: `${pers.prazo}x com balão ${pers.meses.length > 1 ? "nas parcelas " : "na parcela "}${pers.meses.join(", ")}`, aceitacao: 0 }] : undefined;
    const r = entradaMinimaParaParcela(sim, alvo, pers ? ["BALAO"] : permitidos, a.estrutura_balao ?? "preferidas", so);
    // Planos mais vendidos desse modelo primeiro; dentro de cada plano, a menor entrada.
    const hist = await historicoModelo(ctx, a.modelo, a.versao);
    const totalHist = hist ? Object.values(hist.mix).reduce((s, n) => s + n, 0) : 0;
    const pop = (o: Opcao) => (totalHist ? (hist!.mix[CATEGORIA[o.plano]] ?? 0) / totalHist : 0);
    r.opcoes.sort((x, y) => pop(y) - pop(x) || x.entrada_minima_necessaria - y.entrada_minima_necessaria || x.parcela - y.parcela);
    const veiculo = { tipo: sim.tipo, modelo: a.modelo, versao: a.versao, ano_modelo: a.ano_modelo, valor: sim.valor };
    // Topo: a melhor opção (menor entrada) de cada plano, na ordem dos mais vendidos; depois os outros prazos.
    // A opção de MENOR ENTRADA de todas (normalmente um Plano Balão bem estruturado) sempre vai junto, em destaque.
    const menor = r.opcoes.slice().sort((x, y) => x.entrada_minima_necessaria - y.entrada_minima_necessaria || x.parcela - y.parcela)[0] ?? null;
    const vistosPl = new Set<string>(); const melhores: typeof r.opcoes = []; const demais: typeof r.opcoes = [];
    for (const o of r.opcoes) (vistosPl.has(o.plano) ? demais : (vistosPl.add(o.plano), melhores)).push(o);
    // outras estruturas de balão (1 por estrutura) antes dos demais prazos
    const estrut = new Set<string>(); const balOutras: typeof r.opcoes = []; const resto2: typeof r.opcoes = [];
    for (const o of demais) (o.plano === "BALAO" && !estrut.has(o.plano_nome) && !melhores.some((m) => m.plano_nome === o.plano_nome) ? (estrut.add(o.plano_nome), balOutras) : resto2).push(o);
    let top = [...melhores, ...balOutras, ...resto2];
    if (menor && !top.slice(0, 10).includes(menor)) top = [menor, ...top];
    top = top.slice(0, 5);
    const ids = await salvar(ctx, { veiculo }, top);
    const opcoes = top.map((o, k) => saidaOpcao(ctx, o, ids[k], {
      ordem: k + 1, entrada_minima_necessaria: o.entrada_minima_necessaria,
      ...(o === menor ? { destaque: "MENOR ENTRADA de todas as opções" } : {}),
      motivo_ordem: pop(o) > 0 ? `${Math.round(pop(o) * 100)}% dos financiamentos desse modelo no histórico foram ${CATEGORIA[o.plano]}` : "sem histórico desse plano para o modelo",
    }));
    let mais_proxima = null;
    if (!opcoes.length && r.mais_proxima) {
      const [id] = await salvar(ctx, { veiculo }, [r.mais_proxima]);
      mais_proxima = saidaOpcao(ctx, r.mais_proxima, id, { observacao: "menor parcela possível com 95% de entrada" });
    }
    const dest = opcoes.find((o) => o.destaque) ?? opcoes[0] ?? null;
    poeBloco(ctx, "opcoes", { tipo: "opcoes", titulo: `${a.modelo}${a.versao ? " " + a.versao : ""} · parcela até ${brlTxt(alvo)}`, veiculo, parcela_alvo: alvo, destaque: dest, alternativas: opcoes.filter((o) => o !== dest).slice(0, 2), base: hist ? `Histórico: ${hist.financiados} financiamentos do modelo (${hist.periodo.rotulo})` : null });
    return {
      veiculo, parcela_alvo: alvo, atingivel: opcoes.length > 0, ordem: "planos mais vendidos primeiro; dentro do plano, menor entrada; a opção marcada com destaque é a de menor entrada de todas",
      historico_base: hist ? { periodo: hist.periodo.rotulo, financiados: hist.financiados } : null,
      subsidio_disponivel_se_pedir: subsidios.length ? undefined : "Taxa Subsidiada / Coparticipado não foram incluídos (só se o usuário pedir).",
      opcoes, mais_proxima, bases: ctx.bases.usadas, avisos,
    };
  },

  async simular_balao(a, ctx) {
    const { sim } = await tabelasPara(ctx, a);
    if (!Array.isArray(a.baloes) || !a.baloes.length) throw new ErroFerramenta("Plano Balão precisa de pelo menos 1 balão. Informe mês e valor (ou use simular_financiamento, que já testa as estruturas de balão).");
    const r = sim.tipo === "novo"
      ? N.balaoTradicional(sim.valor, Number(a.entrada), Number(a.prazo), a.baloes ?? [], sim.tabelas)
      : S.balaoSeminovo(sim.valor, Number(a.entrada), sim.ano, Number(a.prazo), a.baloes ?? [], sim.tabelas);
    if ("erro" in r) throw new ErroFerramenta(r.erro);
    const op: Opcao = { plano: "BALAO", plano_nome: "Plano Balão", prazo: r.prazo, periodicidade: "mensal", qtd_pagamentos: r.prazo, entrada: Number(a.entrada), financiado: r.financiado, taxa_tabela: r.taxa, parcela: r.parcela };
    const [id] = await salvar(ctx, { veiculo: { tipo: sim.tipo, modelo: a.modelo, versao: a.versao, valor: sim.valor }, baloes: a.baloes }, [op]);
    const saida = saidaOpcao(ctx, { ...op, estrutura_baloes: `${r.prazo}x com ${r.fluxo.length} balão(ões)`, baloes: r.fluxo.map((f) => ({ mes: f.mes, valor: f.balao })), total_baloes: r.totalBaloes, limite_baloes: r.limiteBaloes }, id);
    poeBloco(ctx, "opcoes", { tipo: "opcoes", titulo: `${a.modelo}${a.versao ? " " + a.versao : ""} · Plano Balão sob medida`, veiculo: { modelo: a.modelo, versao: a.versao, valor: sim.valor }, destaque: saida, alternativas: [] });
    return {
      ...saidaOpcao(ctx, op, id), total_baloes: r2(r.totalBaloes), limite_baloes: r2(r.limiteBaloes),
      meses_com_balao: r.fluxo.map((f) => ({ mes: f.mes, parcela: r2(f.parcela), balao: r2(f.balao), total_no_mes: r2(f.total) })),
      bases: ctx.bases.usadas,
    };
  },

  async apresentar_opcoes(a, ctx) {
    const ids: string[] = (a.simulacao_ids ?? []).slice(0, 3);
    if (!ids.length) throw new ErroFerramenta("Informe de 1 a 3 simulacao_id.");
    const itens: OpcaoSaida[] = [];
    let veiculo: any = null;
    for (const id of ids) {
      const s = await simulacaoPorId(ctx, id);
      veiculo ??= s.veiculo;
      itens.push(saidaOpcao(ctx, { ...s.opcao, baloes: s.opcao.baloes ?? (s.baloes.length ? s.baloes : undefined) }, id));
    }
    const di = Math.max(0, ids.indexOf(a.destaque_id));
    const anterior: any = ctx.blocos?.get("opcoes");
    poeBloco(ctx, "opcoes", { base: anterior?.base ?? null, parcela_alvo: anterior?.parcela_alvo ?? null, tipo: "opcoes", titulo: String(a.titulo ?? "").slice(0, 80) || "Opções", veiculo: veiculo ?? {}, destaque: itens[di], alternativas: itens.filter((_, k) => k !== di) });
    return { ok: true, cartoes: itens.length, observacao: "Os cartões já mostram planos, prazos e valores: no texto, explique a recomendação em 2 a 4 frases sem repetir a tabela." };
  },

  async simular_antecipacao(a, ctx) {
    exigeSimulador(ctx);
    let prazo = a.prazo, parcela = a.parcela, baloes: N.Balao[] = (a.baloes ?? []).map((b: any) => ({ mes: Number(b.mes), valor: Number(b.valor) }));
    if (a.simulacao_id) {
      const s = await simulacaoPorId(ctx, a.simulacao_id);
      if (s.opcao.periodicidade !== "mensal") throw new ErroFerramenta("A antecipação funciona para planos com parcela mensal.");
      prazo = s.opcao.prazo; parcela = s.opcao.parcela; baloes = s.baloes;
    }
    if (!prazo || !parcela) throw new ErroFerramenta("Preciso do prazo e da parcela do contrato (ou de um simulacao_id).");
    const hoje = ctx.hoje;
    const hojeD = parseISO(hoje)!;
    const primeiroInformado = !!a.primeiro_vencimento;
    const primeiro = a.primeiro_vencimento ?? (() => { const d = new Date(hojeD.getTime()); d.setUTCDate(d.getUTCDate() + 30); return toISO(d); })();
    // "Daqui a N meses" = HOJE + N meses (regra do Grupo). Data exata só se o usuário der.
    const data = a.meses_ate_antecipacao != null ? toISO(addMonths(hojeD, Number(a.meses_ate_antecipacao))) : (a.data_antecipacao ?? hoje);
    const tipo = a.tipo ?? "todo";
    const tabela = await ctx.bases.antecipacao();
    const r = F.antecipacao({ prazo, parcela, primeiroVenc: primeiro, data, tipo, de: a.de, ate: a.ate, parcelaEscolhida: a.parcela_escolhida, baloes }, tabela);
    if ("erro" in r) throw new ErroFerramenta(r.erro);
    // Parcelas que já terão vencido (pagas) até a data da antecipação
    const pd = parseISO(primeiro)!, dd = parseISO(data)!;
    let pagas = 0;
    for (let k = 1; k <= prazo; k++) if (addMonths(pd, k - 1).getTime() <= dd.getTime()) pagas++;
    const linha = (l: F.LinhaAntecipacao) => ({ parcela: l.num, tipo: l.tipo, vencimento: l.venc, meses_antecedencia: l.meses, valor_original: r2(l.valorOriginal), desconto_pct: pctv(l.desconto), desconto: r2(l.valorDesconto), valor_a_pagar: r2(l.final) });
    const out = {
      contrato: { prazo, parcela_mensal: r2(parcela), baloes: baloes.map((b) => ({ mes: b.mes, valor: r2(b.valor) })), primeiro_vencimento: primeiro,
        premissa_primeiro_vencimento: primeiroInformado ? null : "Contrato começando agora (1ª parcela em 30 dias), porque a data de início não foi informada." },
      data_antecipacao: data, regra_data: a.meses_ate_antecipacao != null ? `Hoje (${hoje}) + ${a.meses_ate_antecipacao} meses` : null,
      modalidade: tipo === "todo" ? "quitação total" : tipo === "uma" ? "uma parcela" : "intervalo de parcelas", parcelas_ja_pagas_ate_a_data: pagas, parcelas_em_aberto_na_data: prazo - pagas,
      parcelas_antecipadas: r.qtd, valor_original: r2(r.brutoTotal), desconto_total: r2(r.descTotal), desconto_pct: pctv(r.descTotal / r.brutoTotal),
      valor_a_pagar: r2(r.finalTotal), economia: r2(r.descTotal),
      linhas: r.qtd <= 6 ? r.linhas.map(linha) : undefined,
      primeiras_linhas: r.qtd > 6 ? r.linhas.slice(0, 3).map(linha) : undefined,
      ultimas_linhas: r.qtd > 6 ? r.linhas.slice(-3).map(linha) : undefined,
      aviso: r.aviso,
    };
    poeBloco(ctx, "antecipacao", { tipo: "antecipacao", titulo: tipo === "todo" ? "Quitação do contrato" : tipo === "uma" ? `Antecipação da parcela ${a.parcela_escolhida}` : `Antecipação das parcelas ${a.de} a ${a.ate}`, ...out });
    return out;
  },

  async simular_cash_conversion(a, ctx) {
    exigeSimulador(ctx);
    let parcela = a.parcela, prazo = a.prazo;
    if (a.simulacao_id) {
      const s = await simulacaoPorId(ctx, a.simulacao_id);
      if (s.opcao.periodicidade !== "mensal") throw new ErroFerramenta("O Cash Conversion usa planos com parcela mensal.");
      if (s.baloes.length) throw new ErroFerramenta("O Cash Conversion do Portal compara só parcelas iguais; essa simulação tem balões. Use uma opção sem balão.");
      parcela = s.opcao.parcela; prazo = s.opcao.prazo;
    }
    const capital = Number(a.capital);
    const informada = a.taxa_aplicacao_mensal != null;
    const taxas: number[] = informada ? [Number(a.taxa_aplicacao_mensal)] : [0.008, 0.01, 0.012];
    const cenarios = taxas.map((t) => {
      const r = F.cashConversion(capital, Number(parcela), Number(prazo), t);
      if ("erro" in r) throw new ErroFerramenta(r.erro);
      return { taxa_aplicacao_pct_am: r4(t * 100), valor_futuro_da_aplicacao: r2(r.valorFuturoAplicacao), rendimento_da_aplicacao: r2(r.rendimentoAplicacao), diferenca: r2(r.diferencaProjetada), recomendacao: r.classificacao };
    });
    const total = Number(parcela) * Number(prazo);
    // Taxa mensal em que aplicar o capital empata com o total pago no financiamento
    const empate = capital > 0 && total > 0 ? Math.pow(total / capital, 1 / Number(prazo)) - 1 : null;
    const out = {
      capital: r2(capital), parcela: r2(parcela), prazo, total_pago_no_financiamento: r2(total), juros_pagos: r2(total - capital),
      taxa_de_empate_pct_am: empate == null ? null : r4(empate * 100),
      leitura_empate: empate == null ? null : `Financiar compensa se a aplicação do cliente render mais que ${(empate * 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}% a.m. líquido; abaixo disso, compensa pagar à vista.`,
      taxa_informada: informada, cenarios,
      observacao: informada ? "Comparação nominal do Cash Conversion do Portal (sem imposto sobre o rendimento)." : "Taxa da aplicação do cliente não informada: cenários de referência (0,8% / 1,0% / 1,2% a.m.). Pergunte quanto rende a aplicação dele para fechar a conta.",
    };
    poeBloco(ctx, "cash", { tipo: "cash", titulo: "Financiar × pagar à vista", ...out });
    return out;
  },

  async calcular_taxa(a, ctx) {
    exigeSimulador(ctx);
    const r = F.calculadoraTaxa(Number(a.financiado), Number(a.prazo), Number(a.parcela));
    if ("erro" in r) throw new ErroFerramenta(r.erro);
    return { taxa_net_pct_am: r4(r.taxaNet * 100), cet_pct_am: r4(r.taxaCetMes * 100), total_pago: r2(r.total), juros_total: r2(r.juros) };
  },

  async historico_vendas(a, ctx) {
    exigeModulo(ctx, MODULO.analiseGeral, "Análise Geral");
    const p = await periodo(ctx, a, "ultimos_30");
    const loja = lojaOuErro(a.loja);
    const r = await ctx.rpc.call<any>("operational_model_metrics", { p_start: p.inicio, p_end: p.fim, p_group_view: true });
    const rows = (r?.rows ?? []).filter((x: any) => casaModeloTexto(x.model, a.modelo, a.versao) && (!loja || normalizaLoja(x.store) === loja) && !ehPseudoLoja(x.store));
    const soma = (f: string) => rows.reduce((s: number, x: any) => s + (Number(x[f]) || 0), 0);
    const vendidos = soma("sold_count"), financiados = soma("financed_count");
    const mix: Record<string, number> = {};
    for (const x of rows) for (const pb of x.plan_breakdown ?? []) mix[pb.plan_type] = (mix[pb.plan_type] || 0) + (Number(pb.financed_count) || 0);
    const pond = (f: string) => financiados ? rows.reduce((s: number, x: any) => s + (Number(x[f]) || 0) * (Number(x.financed_count) || 0), 0) / financiados : null;
    const entVenda = soma("entry_sales_value_total");
    const out: any = {
      ...infoPeriodo(p), loja_considerada: lojaConsiderada(ctx, loja),
      modelo_pedido: `${a.modelo} ${a.versao ?? ""}`.trim(),
      versoes_encontradas: [...new Set(rows.map((x: any) => x.model))],
      vendidos, financiados, qtd_contratos: financiados,
      penetracao_pct: vendidos ? pctv(financiados / vendidos) : null,
      entrada_media_pct: entVenda ? pctv(soma("entry_total") / entVenda) : null,
      entrada_media_valor: soma("valid_entry_count") ? r2(soma("entry_total") / soma("valid_entry_count")) : null,
      prazo_medio_meses: pond("average_installments") != null ? Math.round(pond("average_installments")! * 10) / 10 : null,
      parcela_media: pond("average_installment_value") != null ? r2(pond("average_installment_value")!) : null,
      mix_planos: Object.entries(mix).sort((x, y) => y[1] - x[1]).map(([plano, qtd]) => ({ plano, financiados: qtd, pct: financiados ? pctv(qtd / financiados) : 0 })),
      retorno_medio_pct: soma("production_value") ? pctv(soma("return_value") / soma("production_value")) : null,
      base_pequena: financiados < 5,
    };
    return filtraCampos(ctx.usuario, out);
  },

  async resultado_loja(a, ctx) {
    exigeModulo(ctx, MODULO.analiseGeral, "Análise Geral");
    const p = await periodo(ctx, a, "competencia_atual");
    const loja = lojaOuErro(a.loja);
    const [atual, ant, cfg] = await Promise.all([
      ctx.rpc.call<any>("operational_metrics", { p_start: p.inicio, p_end: p.fim, p_group_view: true }),
      p.comparavel_anterior ? ctx.rpc.call<any>("operational_metrics", { p_start: p.comparavel_anterior.inicio, p_end: p.comparavel_anterior.fim, p_group_view: true }) : Promise.resolve(null),
      ctx.rpc.call<any>("operational_portal_config").catch(() => null),
    ]);
    const shareMin = Number((cfg?.rows ?? []).find((x: any) => x.chave === "share_minimo")?.valor) || null;
    const dep: string | null = a.departamento ?? null;
    const A = agregaPorLoja(doDep(atual?.rows, dep)), B = agregaPorLoja(doDep(ant?.rows, dep));
    const lojas = loja ? [loja] : Object.keys(A).sort();
    if (loja && !A[loja]) return { ...infoPeriodo(p), loja, loja_considerada: loja, mensagem: "Sem vendas dessa loja no período, ou ela está fora do seu escopo de acesso." };
    const blocos: any[] = lojas.filter((l) => A[l]).map((l) => indicadores(l, A[l], B[l] ?? null, shareMin));
    if (!dep) {
      // Visão Grupo: sempre com a divisão Novos × Seminovos (como na Análise Geral)
      const AN = agregaPorLoja(doDep(atual?.rows, "NOVOS")), AS = agregaPorLoja(doDep(atual?.rows, "SEMINOVOS"));
      for (const b of blocos) b.por_departamento = {
        NOVOS: AN[b.loja] ? resumoDep(AN[b.loja]) : null,
        SEMINOVOS: AS[b.loja] ? resumoDep(AS[b.loja]) : null,
      };
    }
    const total = !loja && lojas.length > 1 ? indicadores("GRUPO (escopo)", somaAcc(Object.values(A)), somaAcc(Object.values(B)), shareMin) : null;
    const visao = dep ?? "GRUPO (Novos + Seminovos)";
    const out = filtraCampos(ctx.usuario, {
      ...infoPeriodo(p), loja_considerada: lojaConsiderada(ctx, loja), visao,
      comparado_com: p.comparavel_anterior ? `${p.comparavel_anterior.inicio} a ${p.comparavel_anterior.fim}` : null,
      lojas: blocos, total,
    }) as any;
    poeBloco(ctx, "resultado", { tipo: "resultado", titulo: `Resultado ${loja ?? "das lojas"}`, periodo: p.rotulo, visao, lojas: out.lojas, total: out.total });
    return out;
  },

  async comparar_lojas(a, ctx) {
    exigeModulo(ctx, MODULO.analiseGeral, "Análise Geral");
    const lojas: string[] = (a.lojas ?? []).map((l: string) => lojaOuErro(l)!);
    if (lojas.length < 2) throw new ErroFerramenta("Informe pelo menos 2 lojas.");
    const p = await periodo(ctx, a, "competencia_atual");
    const atual = await ctx.rpc.call<any>("operational_metrics", { p_start: p.inicio, p_end: p.fim, p_group_view: true });
    const dep: string | null = a.departamento ?? null;
    const A = agregaPorLoja(doDep(atual?.rows, dep));
    const fora = lojas.filter((l) => !A[l]);
    const blocos = lojas.filter((l) => A[l]).map((l) => indicadores(l, A[l], null, null));
    const nomes = ["vendidos", "financiados", "share_pct", "producao", "spf_qtd", "retorno", "rentabilidade"] as const;
    const comparacao = nomes.filter((n) => n !== "retorno" && n !== "rentabilidade" || podeVerRetorno(ctx.usuario)).map((n) => {
      const vals = blocos.map((b: any) => ({ loja: b.loja, valor: b[n] as number }));
      const lider = vals.slice().sort((x, y) => y.valor - x.valor)[0];
      return {
        indicador: n, lider: lider?.loja ?? null,
        por_loja: vals.map((v) => ({ ...v, diferenca_para_lider: lider ? r2(v.valor - lider.valor) : null, diferenca_para_lider_pct: lider?.valor ? pctv((v.valor - lider.valor) / lider.valor) : null })),
      };
    });
    const visao = dep ?? "GRUPO (Novos + Seminovos)";
    const ROT: Record<string, [string, "int" | "brl" | "pct"]> = { vendidos: ["Vendidos", "int"], financiados: ["Financiados", "int"], share_pct: ["Share", "pct"], producao: ["Produção", "brl"], spf_qtd: ["SPF", "int"], retorno: ["Retorno", "brl"], rentabilidade: ["Rentabilidade", "brl"] };
    poeBloco(ctx, "comparacao", {
      tipo: "comparacao", titulo: `Comparativo ${blocos.map((b: any) => b.loja).join(" × ")}`, periodo: p.rotulo, visao, lojas: blocos.map((b: any) => b.loja),
      linhas: comparacao.map((c) => ({ indicador: c.indicador, rotulo: ROT[c.indicador][0], formato: ROT[c.indicador][1], valores: c.por_loja.map((v) => v.valor ?? null), lider: c.lider })),
    });
    return filtraCampos(ctx.usuario, {
      ...infoPeriodo(p), visao,
      lojas: blocos, comparacao,
      sem_dados_ou_fora_do_escopo: fora.length ? fora : undefined,
    });
  },

  async ranking_vendedores(a, ctx) {
    exigeModulo(ctx, MODULO.analiseGeral, "Análise Geral");
    if (a.criterio === "retorno" && !podeVerRetorno(ctx.usuario)) throw new ErroFerramenta("Seu perfil não vê retorno.");
    const p = await periodo(ctx, a, "competencia_atual");
    const loja = lojaOuErro(a.loja);
    const r = await ctx.rpc.call<any>("operational_metrics", { p_start: p.inicio, p_end: p.fim, p_group_view: true });
    // operational_metrics vem por vendedor × loja × departamento: agrega por vendedor antes de ranquear.
    const rows = doDep(r?.rows, a.departamento ?? null).filter((x: any) => !ehPseudoLoja(x.store) && (!loja || normalizaLoja(x.store) === loja));
    type V = { vendedor: string; lojas: Set<string>; deps: Set<string>; vendidos: number; financiados: number; producao: number; spf: number; retorno: number };
    const por = new Map<string, V>();
    for (const x of rows) {
      const k = String(x.seller_id ?? x.seller_name);
      const v = por.get(k) ?? { vendedor: x.seller_name, lojas: new Set(), deps: new Set(), vendidos: 0, financiados: 0, producao: 0, spf: 0, retorno: 0 };
      v.lojas.add(normalizaLoja(x.store) ?? x.store); v.deps.add(x.department);
      v.vendidos += Number(x.sold_count) || 0; v.financiados += Number(x.financed_count) || 0;
      v.producao += Number(x.production_value) || 0; v.spf += Number(x.spf_count) || 0; v.retorno += Number(x.return_value) || 0;
      por.set(k, v);
    }
    const val = (v: V) => ({ producao: v.producao, financiados: v.financiados, share: v.vendidos ? v.financiados / v.vendidos : 0, vendidos: v.vendidos, spf: v.spf, retorno: v.retorno } as Record<string, number>)[a.criterio];
    const ord = [...por.values()].sort((x, y) => val(y) - val(x));
    // Perfil Vendedor: o servidor só devolve as linhas do próprio vendedor (escopo por perfil). Não há como
    // calcular posição no ranking sem ver os colegas — então só os próprios números, sem posição nem total.
    if (ctx.usuario.perfil === "VENDEDOR") {
      const eu = ord.find((v) => ehProprio(ctx, v.vendedor)) ?? null;
      return filtraCampos(ctx.usuario, {
        ...infoPeriodo(p), loja_considerada: lojaConsiderada(ctx, loja), visao: a.departamento ?? "GRUPO (Novos + Seminovos)", criterio: a.criterio,
        observacao: "No perfil Vendedor o Portal mostra só os seus próprios números; não há posição no ranking nem dados de colegas.",
        seus_numeros: eu ? { vendidos: eu.vendidos, financiados: eu.financiados, share_pct: eu.vendidos ? pctv(eu.financiados / eu.vendidos) : 0, producao: r2(eu.producao), spf_qtd: eu.spf } : null,
      });
    }
    return filtraCampos(ctx.usuario, {
      ...infoPeriodo(p), loja_considerada: lojaConsiderada(ctx, loja), visao: a.departamento ?? "GRUPO (Novos + Seminovos)", criterio: a.criterio, total_vendedores: ord.length,
      ranking: ord.slice(0, 15).map((v, k) => ({
        posicao: k + 1, vendedor: v.vendedor, loja: [...v.lojas].join(" / "), departamento: [...v.deps].join(" / "),
        vendidos: v.vendidos, financiados: v.financiados, share_pct: v.vendidos ? pctv(v.financiados / v.vendidos) : 0,
        producao: r2(v.producao), spf_qtd: v.spf, return_value: r2(v.retorno),
      })),
    });
  },

  async analise_fi(a, ctx) {
    exigeModulo(ctx, MODULO.analiseFi, "Análise F&I");
    const p = await periodo(ctx, a, "mes_atual");
    const loja = lojaOuErro(a.loja);
    const args = { p_start: p.inicio, p_end: p.fim, p_store: loja, p_department: a.departamento ?? null };
    // bi_fandi_dashboard = mesma RPC da tela + propostas por banco. Sem ela (não aplicada), cai na da tela.
    let r: any, completo = true, motivoFallback = "";
    try { r = await ctx.rpc.call<any>("bi_fandi_dashboard", args); }
    catch (e) {
      // 404 = função ainda não aplicada; 504/57014 = passou do tempo (8 s): usa a RPC da tela, que é a mesma base sem a parte por banco.
      const semFuncao = e instanceof RpcError && (e.status === 404 || /bi_fandi_dashboard/.test(String(e.message)));
      const tempo = e instanceof RpcError && (e.status === 504 || e.code === "57014");
      if (!semFuncao && !tempo) throw e;
      completo = false; motivoFallback = tempo ? "A consulta por banco demorou demais agora; mostrei a visão da tela (sem recusas por banco). Tente filtrar uma loja." : "Recusas por banco ainda não disponíveis (função bi_fandi_dashboard não aplicada no banco).";
      r = await ctx.rpc.call<any>("operational_fandi_dashboard", args);
    }
    const n = (v: unknown) => Number(v) || 0;
    const outs = (r?.proposal_outcomes ?? []) as any[];
    const somaOut = (o: string, f: string) => outs.filter((x) => x.outcome === o).reduce((t, x) => t + n(x[f]), 0);
    const porLoja: Record<string, { aprovadas: number; recusadas: number }> = {};
    for (const o of outs) {
      const l = normalizaLoja(o.store) ?? o.store;
      const x = porLoja[l] ??= { aprovadas: 0, recusadas: 0 };
      if (o.outcome === "APROVADA") x.aprovadas += n(o.quantity); else if (o.outcome === "RECUSADA") x.recusadas += n(o.quantity);
    }
    const operacoes = n(r?.summary?.operational_quantity);
    const planos = ((r?.plans ?? []) as any[]).map((x) => ({ plano: x.plan_type, operacoes: n(x.quantity), financiado: r2(n(x.financed_value)), pct: operacoes ? pctv(n(x.quantity) / operacoes) : 0 }))
      .sort((x, y) => y.operacoes - x.operacoes);
    const bancosOp = new Map(((r?.banks ?? []) as any[]).map((b) => [b.bank, b]));
    const bancos = completo
      ? ((r?.bank_outcomes ?? []) as any[]).map((b) => ({
          banco: b.bank, propostas: n(b.proposals), recusadas: n(b.refused), aprovadas_nao_faturadas: n(b.approved_not_billed), faturadas_pagas: n(b.billed),
          taxa_recusa_pct: n(b.proposals) ? pctv(n(b.refused) / n(b.proposals)) : 0, valor_recusado: r2(n(b.refused_value)),
          financiado: r2(n(bancosOp.get(b.bank)?.total_financed)),
        })).sort((x, y) => y.recusadas - x.recusadas || y.taxa_recusa_pct - x.taxa_recusa_pct)
      : ((r?.banks ?? []) as any[]).map((b) => ({ banco: b.bank, faturadas_pagas: n(b.quantity), financiado: r2(n(b.total_financed)) }));
    const maisRecusou = completo ? bancos.find((b: any) => b.recusadas > 0) ?? null : null;
    const plano = a.plano ? planos.find((x) => normalizaModelo(x.plano) === normalizaModelo(a.plano)) ?? { plano: a.plano, operacoes: 0, financiado: 0, pct: 0 } : null;
    const statusProp = ((r?.proposal_status ?? []) as any[]).map((x) => ({ status: x.status, propostas: n(x.quantity), valor: r2(n(x.financed_value)) }));
    const dadosAte = r?.source_completed_at ? String(r.source_completed_at) : null;
    // Situação das propostas do período (status mais recente de cada proposta)
    const st = (nomes: string[]) => statusProp.filter((x) => nomes.includes(String(x.status).toUpperCase())).reduce((t, x) => t + x.propostas, 0);
    const situacao = completo ? {
      propostas_no_periodo: statusProp.reduce((t, x) => t + x.propostas, 0),
      faturadas_ou_pagas: st(["FATURADA", "PAGA"]),
      aguardando_faturamento: st(["AG. FATURAMENTO"]),
      aprovadas_sem_faturar: st(["APROVADA", "ASSINADA", "TRANSITO"]),
      aprovadas_nao_convertidas: st(["ENC. A VISTA", "ENCERRADA", "CANCELADA"]),
      recusadas: st(["RECUSADA", "ENC. RECUS."]),
    } : null;
    const situacaoComTotal = situacao ? { ...situacao, aprovadas_total: situacao.faturadas_ou_pagas + situacao.aguardando_faturamento + situacao.aprovadas_sem_faturar + situacao.aprovadas_nao_convertidas, outras: situacao.propostas_no_periodo - situacao.faturadas_ou_pagas - situacao.aguardando_faturamento - situacao.aprovadas_sem_faturar - situacao.aprovadas_nao_convertidas - situacao.recusadas } : null;
    // A base do FANDI é importada: se a última importação é anterior ao fim do período, os dias seguintes ainda não estão nela.
    const diaBase = dadosAte ? new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(dadosAte)) : null;
    const horaBase = dadosAte ? new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(dadosAte)) : null;
    const baseAviso = diaBase && diaBase < p.inicio
      ? `A base do FANDI foi importada pela última vez em ${horaBase}: ainda não há propostas deste período no Portal (não significa que não houve). É preciso importar a base atualizada.`
      : diaBase && diaBase < p.fim ? `A base do FANDI foi importada pela última vez em ${horaBase}: propostas depois disso ainda não aparecem.` : null;
    const out = {
      ...infoPeriodo(p), loja_considerada: lojaConsiderada(ctx, loja),
      visao: [loja ?? "Todas as lojas", a.departamento ?? "Novos + Seminovos"].join(" · "),
      base_atualizada_em: dadosAte, base_aviso: baseAviso, sem_dados_do_periodo: !!(diaBase && diaBase < p.inicio), foco: a.foco ?? "geral",
      situacao_das_propostas: situacaoComTotal ? { ...situacaoComTotal, pct: Object.fromEntries(Object.entries(situacaoComTotal).filter(([k]) => k !== "propostas_no_periodo").map(([k, v]) => [k, situacaoComTotal.propostas_no_periodo ? pctv((v as number) / situacaoComTotal.propostas_no_periodo) : 0])) } : undefined,
      resumo: {
        operacoes_financiadas: operacoes, total_financiado: r2(n(r?.summary?.total_financed)),
        propostas_aprovadas_em_aberto: somaOut("APROVADA", "quantity"), valor_aprovado_em_aberto: r2(somaOut("APROVADA", "financed_value")),
        propostas_recusadas: somaOut("RECUSADA", "quantity"), valor_recusado: r2(somaOut("RECUSADA", "financed_value")),
      },
      definicoes: "Situação das propostas: cada proposta do período pelo status mais recente (aprovadas_total = faturadas/pagas + aguardando faturamento + aprovadas sem faturar + aprovadas não convertidas). Na visão por cliente (como a tela Análise F&I), “clientes aprovados que ainda não financiaram” são clientes aprovados em algum banco e ainda sem financiamento faturado, e “clientes perdidos por recusa” são clientes cuja última resposta dos bancos foi recusa. Operações financiadas = propostas FANDI pagas, faturadas ou aguardando faturamento. Por banco conta propostas.",
      banco_que_mais_recusou: maisRecusou, plano_pedido: plano,
      por_banco: bancos.slice(0, 8), por_plano: planos, propostas_por_status: completo ? statusProp : undefined,
      por_loja: Object.entries(porLoja).map(([l, v]) => ({ loja: l, ...v, taxa_aprovacao_pct: v.aprovadas + v.recusadas ? pctv(v.aprovadas / (v.aprovadas + v.recusadas)) : null }))
        .sort((x, y) => y.aprovadas + y.recusadas - (x.aprovadas + x.recusadas)),
      aviso: completo ? undefined : motivoFallback,
    };
    poeBloco(ctx, "fandi", { tipo: "fandi", titulo: "Análise F&I · FANDI", ...out });
    return out;
  },

  async consultar_score(a, ctx) {
    exigeModulo(ctx, MODULO.score, "Análise de Score");
    const p = await periodo(ctx, a, "competencia_atual");
    const loja = lojaOuErro(a.loja);
    const [r, gov] = await Promise.all([
      ctx.rpc.call<any>("operational_score_coparticipated_data", { p_start: p.inicio, p_end: p.fim }),
      // Utilização + Conversão (critério do Score V2): falha vira "indisponível", nunca zero
      ctx.rpc.call<any>("score_utilization_conversion_scope_data", { p_start: p.inicio, p_end: p.fim }).then((x) => Array.isArray(x) ? x : null).catch(() => null),
    ]);
    const depS = a.departamento ? (String(a.departamento).toUpperCase() === "SEMINOVOS" ? "Seminovos" : "Novos") : null;
    const geral = calculaScores(r ?? {}, p.inicio, p.fim, loja, depS as any);
    let lista = geral;
    if (ctx.usuario.perfil === "VENDEDOR") {
      // Vendedor: só o próprio score (sem ranking de colegas).
      if (a.vendedor && !ehProprio(ctx, a.vendedor)) throw new ErroFerramenta("No seu perfil (Vendedor) a IA mostra só o seu próprio score.");
      a = { ...a, vendedor: ctx.usuario.nome ?? "__sem_nome__" };
    }
    let avisoNome: string | null = null;
    if (a.vendedor) {
      // Vendedor: só o próprio nome, exato (a busca aproximada nunca pode cair num colega).
      const fx = ctx.usuario.perfil === "VENDEDOR"
        ? { itens: lista.filter((x: any) => normalizaModelo(x.vendedor).includes(normalizaModelo(a.vendedor))), aproximado: false }
        : filtraPorNome(a.vendedor, lista, (x: any) => String(x.vendedor ?? ""));
      lista = fx.itens;
      if (fx.aproximado && lista.length) avisoNome = `Não achei "${a.vendedor}" exatamente; usei o nome mais parecido: ${[...new Set(lista.map((x: any) => x.vendedor))].join(", ")}.`;
      if (!lista.length) return { ...infoPeriodo(p), mensagem: "Vendedor não encontrado no período (ou fora do seu escopo)." };
    }
    const pos = (x: any) => geral.indexOf(x) + 1;
    const mostrar = a.vendedor ? lista.slice(0, 3) : lista.slice(0, 10);
    const comp = (x: any) => x.composicao.filter((c: any) => podeVerRetorno(ctx.usuario) || c.item !== "Retorno médio")
      .map((c: any) => ({ ...c, pct: c.maximo ? Math.round((c.pontos / c.maximo) * 100) : 0, pontos_perdidos: c.maximo - c.pontos }));
    const analise = (x: any) => {
      const cs = comp(x);
      return {
        composicao: cs,
        destaques: cs.filter((c: any) => c.pct >= 80).sort((m: any, n: any) => n.pct - m.pct).map((c: any) => `${c.item}: ${c.pontos}/${c.maximo} (${c.detalhe})`),
        pontos_a_melhorar: cs.filter((c: any) => c.pct < 60).sort((m: any, n: any) => n.pontos_perdidos - m.pontos_perdidos).map((c: any) => ({ item: c.item, pontos: c.pontos, maximo: c.maximo, pontos_perdidos: c.pontos_perdidos, detalhe: c.detalhe })),
      };
    };
    const linhaV = (x: any) => ({
      posicao: pos(x), vendedor: x.vendedor, loja: normalizaLoja(x.loja) ?? x.loja, departamento: x.departamento,
      score: x.score, faixa: x.faixa, vendas: x.vendas, financiados: x.financiados, share_pct: pctv(x.share),
      retorno_medio_pct: pctv(x.retorno_medio), spf_qtd: x.spf_qtd, plano_mais_vendido: x.plano_mais_vendido,
    });
    // Análise completa (composição, destaques, onde perdeu pontos) do vendedor pedido ou do 1º do ranking
    const foco = mostrar[0];
    const af: any = analise(foco);
    const uc = utilConvPara(foco, gov, p.fim);
    af.utilizacao_conversao = { ...uc, observacao: "Critério à parte (0–100) da tela de Score do V2; não entra no Score Oficial nem no ranking." };
    af.destaques = af.destaques.slice(0, 2);
    af.pontos_a_melhorar = af.pontos_a_melhorar.slice(0, 2);
    const out = filtraCampos(ctx.usuario, {
      ...infoPeriodo(p), loja_considerada: lojaConsiderada(ctx, loja), visao: depS ?? "Novos e Seminovos", aviso_nome: avisoNome ?? undefined, total_vendedores: geral.length,
      foco: { ...linhaV(foco), ...af },
      ranking: ctx.usuario.perfil === "VENDEDOR" ? undefined : mostrar.map(linhaV),
    }) as any;
    poeBloco(ctx, "score", {
      tipo: "score", titulo: `Score · ${foco.vendedor}`, periodo: p.rotulo, visao: depS ?? "Novos e Seminovos",
      // O cartão vai direto ao navegador: passa pelo mesmo filtro de campos (antes levava retorno_medio_pct sem filtro).
      vendedor: filtraCampos(ctx.usuario, { ...linhaV(foco), total_vendedores: geral.length }), composicao: out.foco.composicao, destaques: out.foco.destaques, melhorar: out.foco.pontos_a_melhorar,
      utilizacao_conversao: out.foco.utilizacao_conversao,
      ranking: ctx.usuario.perfil === "VENDEDOR" ? [] : geral.slice(0, 5).map((x) => ({ posicao: pos(x), vendedor: x.vendedor, loja: normalizaLoja(x.loja) ?? x.loja, score: x.score, faixa: x.faixa })),
    });
    return out;
  },

  async consultar_salario(a, ctx) {
    exigeModulo(ctx, MODULO.comissoes, "Salários e Comissões");
    // Regra do Portal: vendedor só vê o próprio salário.
    if (ctx.usuario.perfil === "VENDEDOR" && a.pessoa && !ehProprio(ctx, a.pessoa)) {
      throw new ErroFerramenta("No seu perfil (Vendedor) o Portal mostra só o seu próprio salário.");
    }
    if (ctx.usuario.perfil === "VENDEDOR") a = { ...a, pessoa: null };
    const q = a.pessoa ? normalizaModelo(a.pessoa) : null;
    const lojaF = lojaOuErro(a.loja);
    const fech = String(a.fechamento ?? "ultimo_fechado");
    const daLoja = (loja: unknown) => !lojaF || (normalizaLoja(String(loja ?? "")) ?? "") === lojaF;
    let avisoNome: string | null = null;
    /** Filtra por nome: exato primeiro; se ninguém, o mais parecido (ex.: "Wilian Simaro" → WILLIAM SYMARO). */
    const porNome = <T>(itens: T[], nomeDe: (x: T) => string): T[] => {
      const daL = itens.filter((x: any) => daLoja((x as any).__loja));
      if (!q) return daL;
      const r = filtraPorNome(a.pessoa, daL, nomeDe);
      if (r.aproximado && r.itens.length) avisoNome = `Não achei "${a.pessoa}" exatamente; considerei o nome mais parecido: ${[...new Set(r.itens.map(nomeDe))].join(", ")}.`;
      return r.itens;
    };
    const comAviso = (o: any) => (avisoNome && o && typeof o === "object" ? { aviso_nome: avisoNome, ...o } : o);
    const ambiguo = (nomes: string[]) => ({ mensagem: "Encontrei mais de uma pessoa com esse nome. Qual delas?", opcoes: [...new Set(nomes)].slice(0, 8) });

    // Valores calculados pelo Portal para um período (mesmas RPCs da tela de Salários, escopo do login).
    const previa = async (p: { inicio: string; fim: string; rotulo: string }, prev: string): Promise<any> => {
      if (!q) {
        const r = await ctx.rpc.call<any>("operational_own_commission_summary", { p_start: p.inicio, p_end: p.fim });
        const rows = r?.rows ?? [];
        if (!rows.length) return { competencia: p.rotulo, perfil: r?.profile ?? ctx.usuario.perfil_bruto, mensagem: `O perfil ${r?.profile ?? ctx.usuario.perfil_bruto} não tem comissão calculada no Portal (só Vendedor, Gerente e Analista).` };
        const out = montaSalario(ctx, prev, p.rotulo, { nome: ctx.usuario.nome, perfil: r?.profile ?? ctx.usuario.perfil }, rows.map((x: any) => ({
          loja: x.store, departamento: x.department, faixa: x.faixa ?? x.faixa_level, principal: x.comissao_principal, spf: x.comissao_spf ?? x.bonus_spf, total: x.comissao_total })), null);
        return out;
      }
      const opc = <T>(pr: Promise<T>) => pr.then((x) => x, () => null);
      const [faixas, met, ana, ger, esc] = await Promise.all([
        opc(ctx.rpc.call<any>("operational_commission_faixa_rows", { p_start: p.inicio, p_end: p.fim })),
        opc(ctx.rpc.call<any>("operational_commission_metrics", { p_start: p.inicio, p_end: p.fim })),
        opc(ctx.rpc.call<any>("operational_analyst_commission_metrics_v2", { p_start: p.inicio, p_end: p.fim })),
        opc(ctx.rpc.call<any>("operational_salary_manager_directory", { p_start: p.inicio, p_end: p.fim })),
        opc(ctx.rpc.call<any>("operational_scope_commission_rows", { p_start: p.inicio, p_end: p.fim })),
      ]);
      type Cand = { nome: string; perfil: string; loja: string; departamento: string | null; seller_id?: string; transfer?: boolean; ind?: any };
      const todos: (Cand & { __loja: string })[] = [];
      for (const m of met?.rows ?? []) if (m.seller_name) todos.push({ nome: m.seller_name, perfil: "VENDEDOR", loja: m.store, __loja: m.store, departamento: m.department, seller_id: m.seller_id, ind: m });
      for (const m of ana?.rows ?? []) if (m.analyst_name) todos.push({ nome: m.analyst_name, perfil: "ANALISTA", loja: m.store, __loja: m.store, departamento: null, transfer: !!m.transfer, ind: m });
      for (const m of ger?.rows ?? []) if (m.manager_name) todos.push({ nome: m.manager_name, perfil: "GERENTE", loja: m.store, __loja: m.store, departamento: m.department, ind: null });
      const cands: Cand[] = porNome(todos, (c) => c.nome);
      if (!cands.length) return { competencia: p.rotulo, mensagem: "Não encontrei essa pessoa na prévia desta competência (ou ela está fora do seu escopo de acesso)." };
      const nomes = [...new Set(cands.map((c) => normalizaModelo(c.nome)))];
      if (nomes.length > 1) return comAviso(ambiguo(cands.map((c) => `${c.nome} (${c.perfil.toLowerCase()}, ${normalizaLoja(c.loja) ?? c.loja})`)));
      const fx = (faixas?.rows ?? []) as any[];
      const linhas = cands.map((c) => {
        const f = c.perfil === "VENDEDOR" ? (fx.find((r) => r.perfil === "VENDEDOR" && r.seller_id === c.seller_id) ?? (esc?.rows ?? []).find((r: any) => r.seller_id === c.seller_id))
          : c.perfil === "ANALISTA" ? fx.find((r) => r.perfil === "ANALISTA" && r.store === c.loja && (r.transfer == null || !!r.transfer === !!c.transfer))
          : fx.find((r) => r.perfil === "GERENTE" && r.store === c.loja && r.department === c.departamento);
        return { loja: c.loja, departamento: c.departamento, cobertura: c.transfer || undefined, faixa: f?.faixa ?? f?.faixa_level, principal: f?.comissao_principal, spf: f?.comissao_spf ?? f?.bonus_spf, total: f?.comissao_total, ind: c.ind };
      });
      const sem = linhas.every((l) => l.total == null);
      // Fora do escopo de comissão do perfil: não mostra nem os indicadores da pessoa.
      if (sem && ctx.usuario.perfil !== "MASTER") return { competencia: p.rotulo, mensagem: "O salário dessa pessoa não está no seu escopo de acesso no Portal." };
      return comAviso(montaSalario(ctx, prev, p.rotulo, { nome: cands[0].nome, perfil: cands[0].perfil }, linhas, sem ? "O banco não liberou a comissão dessa pessoa para o seu perfil (só os indicadores)." : null));
    };

    if (fech === "competencia_atual") {
      const p = await periodo(ctx, { periodo: "competencia_atual" }, "competencia_atual");
      return previa(p, "Prévia da competência em andamento (o valor oficial é o do fechamento)");
    }

    // Competência passada para quem não é MASTER: a tela de Salários recalcula pelo Portal para o período escolhido
    // (o snapshot oficial do fechamento é só do Painel Master). A IA faz o mesmo.
    if (ctx.usuario.perfil !== "MASTER") {
      const ant = await periodo(ctx, { periodo: "competencia_anterior" }, "competencia_anterior");
      let alvoP: { inicio: string; fim: string; rotulo: string } | null = ant;
      if (/^\d{4}-\d{2}$/.test(fech)) {
        const lista = (ctx.cache.get("periodos") as PeriodoComissao[] | undefined) ?? [];
        const c = lista.filter((x) => x.ativo !== false).find((x) => String(x.data_fim).slice(0, 7) === fech);
        alvoP = c ? { inicio: c.data_inicio, fim: c.data_fim, rotulo: `competência ${c.nome_periodo || `${c.data_inicio} a ${c.data_fim}`}` } : null;
      }
      if (!alvoP) return { mensagem: `Não encontrei a competência que termina em ${fech}.` };
      return previa(alvoP, "Valores calculados pelo Portal para essa competência (o mesmo da tela de Salários; o fechamento oficial fica no Painel Master)");
    }

    // Fechamento oficial (snapshot gravado no Painel Master)
    let fechs: any;
    try { fechs = await ctx.rpc.call<any>("master_commission_closings", {}); }
    catch (e) { if (e instanceof RpcError && (e.negado || e.status === 403)) throw new ErroFerramenta("O histórico de fechamentos oficiais é restrito ao Painel Master."); throw e; }
    const validos = (fechs?.rows ?? []).filter((c: any) => String(c.status ?? "").toUpperCase() === "FECHADO" && c.ativo !== false)
      .sort((x: any, y: any) => String(y.data_fim).localeCompare(String(x.data_fim)) || (Number(y.versao) || 0) - (Number(x.versao) || 0));
    const alvo = /^\d{4}-\d{2}$/.test(fech) ? validos.find((c: any) => String(c.data_fim).slice(0, 7) === fech) : validos[0];
    if (!alvo) return { mensagem: /^\d{4}-\d{2}$/.test(fech) ? `Não há fechamento oficial para a competência que termina em ${fech}.` : "Ainda não há fechamento oficial registrado." };
    const snap = await ctx.rpc.call<any>("master_commission_snapshot", { p_closing_id: alvo.id });
    const doNome = q ? porNome((snap?.rows ?? []).map((r: any) => ({ ...r, __loja: r.loja })), (r: any) => String(r.nome ?? "")) : (snap?.rows ?? []).filter((r: any) => normalizaModelo(String(r.nome ?? "")) === normalizaModelo(String(ctx.usuario.nome ?? "")));
    if (!doNome.length) return { competencia: `${alvo.data_inicio} a ${alvo.data_fim}`, mensagem: "Essa pessoa não aparece no fechamento oficial dessa competência." };
    if (new Set(doNome.map((r: any) => normalizaModelo(r.nome))).size > 1) return comAviso(ambiguo(doNome.map((r: any) => `${r.nome} (${normalizaLoja(r.loja) ?? r.loja})`)));
    const det = (r: any) => r.detalhes ?? {};
    return comAviso(montaSalario(ctx, `Fechamento oficial (versão ${alvo.versao ?? 1}, fechado em ${String(alvo.fechado_em ?? "").slice(0, 10)})`, `${alvo.data_inicio} a ${alvo.data_fim}`,
      { nome: doNome[0].nome, perfil: doNome[0].perfil },
      doNome.map((r: any) => ({ loja: r.loja, departamento: r.departamento, faixa: r.faixa, principal: det(r).comissao_principal, spf: det(r).comissao_spf, total: det(r).comissao_total ?? r.comissao,
        ind: { sold_count: r.vendidas, financed_count: r.financiadas, production_value: r.producao, return_value: r.retorno, spf_value: r.spf_extra, profitability_value: r.rentabilidade_total } })), null));
  },

  async consultar_manual(a) {
    const t = buscaManual(String(a.pergunta ?? ""));
    if (!t.length) return { encontrado: false, mensagem: "Não há tópico no manual sobre isso." };
    return { encontrado: true, topicos: t.map((x) => ({ titulo: x.titulo, texto: x.texto })) };
  },
};

// ---------- agregação por loja (operational_metrics) ----------
type Acc = { vendidos: number; financiados: number; producao: number; retorno: number; spf_qtd: number; spf_valor: number; spf_liquido: number; rentabilidade: number; mix: Record<string, number> };
/** Faixa como se lê: 0,045 → "4,5%"; 3 → "Faixa 3". */
function faixaTexto(f: unknown): string | null {
  if (f == null || f === "") return null;
  const n = Number(f);
  if (!isFinite(n)) return String(f);
  return n > 0 && n < 1 ? `${(n * 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%` : `Faixa ${n}`;
}

type LinhaSal = { loja: string; departamento: string | null; cobertura?: boolean; faixa?: unknown; principal?: unknown; spf?: unknown; total?: unknown; ind?: any };
/** Monta a saída e o cartão de salário a partir de linhas já vindas do banco (nenhuma regra de comissão é recalculada aqui). */
function montaSalario(ctx: ToolCtx, origem: string, competencia: string, pessoa: { nome: string | null; perfil: string }, linhas: LinhaSal[], aviso: string | null) {
  const num = (v: unknown) => (v == null || v === "" || !isFinite(Number(v)) ? null : Number(v));
  const soma = (f: (l: LinhaSal) => unknown) => { const xs = linhas.map(f).map(num).filter((x): x is number => x != null); return xs.length ? r2(xs.reduce((a, b) => a + b, 0)) : null; };
  const somaInd = (k: string) => { const xs = linhas.map((l) => num(l.ind?.[k])).filter((x): x is number => x != null); return xs.length ? r2(xs.reduce((a, b) => a + b, 0)) : null; };
  const vend = somaInd("sold_count"), fin = somaInd("financed_count");
  const lojas = [...new Set(linhas.map((l) => normalizaLoja(l.loja) ?? l.loja))];
  const out = filtraCampos(ctx.usuario, {
    origem, oficial: origem.startsWith("Fechamento"), competencia,
    pessoa: { nome: pessoa.nome, perfil: pessoa.perfil, loja: lojas.join(" / "), departamento: [...new Set(linhas.map((l) => l.departamento).filter(Boolean))].join(" / ") || null,
      faixa: [...new Set(linhas.map((l) => faixaTexto(l.faixa)).filter(Boolean))].join(" / ") || null },
    comissao_total: soma((l) => l.total), comissao_principal: soma((l) => l.principal), comissao_spf: soma((l) => l.spf),
    indicadores: linhas.some((l) => l.ind) ? {
      vendidas: vend, financiadas: fin, conversao_pct: vend ? pctv((fin ?? 0) / vend) : null,
      producao: somaInd("production_value"), spf: somaInd("spf_value"), retorno: somaInd("return_value"), rentabilidade: somaInd("profitability_value"),
    } : undefined,
    linhas: linhas.length > 1 ? linhas.map((l) => ({ loja: normalizaLoja(l.loja) ?? l.loja, departamento: l.departamento, cobertura: l.cobertura, faixa: faixaTexto(l.faixa), comissao_total: num(l.total) == null ? null : r2(num(l.total)!) })) : undefined,
    aviso: aviso ?? undefined,
  }) as any;
  poeBloco(ctx, "salario", { tipo: "salario", titulo: `Salário variável · ${pessoa.nome ?? "você"}`, ...out });
  return out;
}

/** Filtra linhas por departamento (NOVOS/SEMINOVOS). null = Grupo. */
function doDep(rows: any[] | undefined, dep: string | null): any[] {
  const xs = rows ?? [];
  return dep ? xs.filter((x) => String(x.department ?? "").toUpperCase() === dep) : xs;
}
function resumoDep(a: Acc) {
  return { vendidos: a.vendidos, financiados: a.financiados, share_pct: a.vendidos ? pctv(a.financiados / a.vendidos) : 0, producao: r2(a.producao) };
}
const brlTxt = (v: number) => "R$ " + Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

function agregaPorLoja(rows: any[]): Record<string, Acc> {
  const out: Record<string, Acc> = {};
  for (const x of rows) {
    if (ehPseudoLoja(x.store)) continue;
    const l = normalizaLoja(x.store) ?? String(x.store).toUpperCase();
    const a = out[l] ??= { vendidos: 0, financiados: 0, producao: 0, retorno: 0, spf_qtd: 0, spf_valor: 0, spf_liquido: 0, rentabilidade: 0, mix: {} };
    a.vendidos += Number(x.sold_count) || 0; a.financiados += Number(x.financed_count) || 0;
    a.producao += Number(x.production_value) || 0; a.retorno += Number(x.return_value) || 0;
    a.spf_qtd += Number(x.spf_count) || 0; a.spf_valor += Number(x.spf_value) || 0; a.spf_liquido += Number(x.spf_net_value) || 0;
    a.rentabilidade += Number(x.profitability_value) || 0;
    for (const pb of x.plan_breakdown ?? []) a.mix[pb.plan_type] = (a.mix[pb.plan_type] || 0) + (Number(pb.financed_count) || 0);
  }
  return out;
}
function somaAcc(xs: Acc[]): Acc {
  const t: Acc = { vendidos: 0, financiados: 0, producao: 0, retorno: 0, spf_qtd: 0, spf_valor: 0, spf_liquido: 0, rentabilidade: 0, mix: {} };
  for (const a of xs) { for (const k of ["vendidos", "financiados", "producao", "retorno", "spf_qtd", "spf_valor", "spf_liquido", "rentabilidade"] as const) t[k] += a[k]; for (const [p, n] of Object.entries(a.mix)) t.mix[p] = (t.mix[p] || 0) + n; }
  return t;
}
function indicadores(loja: string, a: Acc, b: Acc | null, shareMin: number | null) {
  const share = a.vendidos ? a.financiados / a.vendidos : 0;
  const shareB = b && b.vendidos ? b.financiados / b.vendidos : null;
  const d = (x: number, y: number | null | undefined) => y == null ? null : r2(x - y);
  const dp = (x: number, y: number | null | undefined) => (y == null || y === 0) ? null : pctv((x - y) / y);
  return {
    loja, vendidos: a.vendidos, financiados: a.financiados, share_pct: pctv(share),
    producao: r2(a.producao), ticket_medio_financiado: a.financiados ? r2(a.producao / a.financiados) : null,
    spf_qtd: a.spf_qtd, spf_valor: r2(a.spf_valor), retorno: r2(a.retorno),
    retorno_pct_producao: a.producao ? pctv(a.retorno / a.producao) : null, rentabilidade: r2(a.rentabilidade),
    mix_planos: Object.entries(a.mix).sort((x, y) => y[1] - x[1]).map(([plano, n]) => ({ plano, financiados: n })),
    share_minimo_portal_pct: shareMin != null ? (shareMin > 1 ? shareMin : pctv(shareMin)) : undefined,
    variacao_vs_anterior: b ? {
      vendidos: d(a.vendidos, b.vendidos), vendidos_pct: dp(a.vendidos, b.vendidos),
      financiados: d(a.financiados, b.financiados), financiados_pct: dp(a.financiados, b.financiados),
      share_pp: shareB == null ? null : r2((share - shareB) * 100),
      producao: d(a.producao, b.producao), producao_pct: dp(a.producao, b.producao),
      retorno: d(a.retorno, b.retorno), retorno_pct: dp(a.retorno, b.retorno),
      spf_qtd: d(a.spf_qtd, b.spf_qtd),
    } : null,
  };
}

// ---------------------------------------------------------------------
// Despacho com auditoria e tratamento de erro
// ---------------------------------------------------------------------
export async function executar(nome: string, args: unknown, ctx: ToolCtx): Promise<unknown> {
  const h = H[nome];
  if (!h) return { erro: `Ferramenta desconhecida: ${nome}` };
  try {
    const r = await h(args ?? {}, ctx);
    await ctx.store.auditar({ sessao: ctx.sessao, perfil: ctx.usuario.perfil_bruto, canal: ctx.canal, ferramenta: nome, parametros: args, status: "ok" });
    return r;
  } catch (e) {
    const negado = e instanceof RpcError && e.negado;
    const msg = e instanceof ErroFerramenta || e instanceof BaseIndisponivel ? e.message
      : negado ? "Seu perfil não tem acesso a esse dado no Portal."
      : e instanceof RpcError ? `O Portal não respondeu a consulta (${e.status}).`
      : "Erro interno ao executar a ferramenta.";
    if (!(e instanceof ErroFerramenta)) console.error(`[bi] ${nome}`, e);
    await ctx.store.auditar({ sessao: ctx.sessao, perfil: ctx.usuario.perfil_bruto, canal: ctx.canal, ferramenta: nome, parametros: args, status: negado ? "negado" : "erro", detalhe: msg });
    return { erro: msg };
  }
}
