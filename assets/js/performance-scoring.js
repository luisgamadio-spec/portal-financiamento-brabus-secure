/*
 * PERF-1 -- Núcleo de pontuação do módulo PERFORMANCE.
 *
 * ESTADO: FUNDAÇÃO. Este arquivo NÃO está ligado a nenhuma página do
 * Portal e NÃO é carregado por index.html nem por modules/*.html. Ele
 * existe para que o contrato de pontuação -- a única parte do módulo
 * PERFORMANCE que o Humano especificou de forma completa e inequívoca --
 * fique implementado, versionado e provado por testes determinísticos
 * (tests/perf1_performance_scoring_test.js) enquanto a AUTORIDADE DE
 * MÉTRICA das categorias A/B permanece bloqueada. Ver o relatório PERF-1,
 * seções 8/9/10 e 15.
 *
 * O que este arquivo deliberadamente NÃO faz:
 *  - não lê Supabase, não conhece RPC, não conhece perfil/loja/período;
 *  - não decide QUEM participa (população de participantes é decisão
 *    pendente do Humano/autoridade -- ver relatório, seção 6);
 *  - não resolve empates em silêncio (ver TIE_POLICY abaixo).
 *
 * Ele é uma função pura: recebe métricas já apuradas por uma autoridade
 * servidora e devolve posições + pontos. Isso mantém o frontend fora da
 * autoridade financeira (brief PERF-1, seções 22/23) mesmo quando este
 * núcleo for reaproveitado dentro do renderizador.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PerformanceScoring = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ----------------------------------------------------------------
  // Contrato de pontuação -- literal do brief PERF-1, seções 12 a 16.
  // 35 + 35 + 15 + 15 = 100 pontos é o máximo teórico.
  // ----------------------------------------------------------------
  const CATEGORIES = Object.freeze([
    Object.freeze({ key: 'returnNovos', label: 'MAIOR RETORNO EM NOVOS', unit: 'BRL', metric: 'return_novos', first: 35, second: 17 }),
    Object.freeze({ key: 'returnSeminovos', label: 'MAIOR RETORNO EM SEMINOVOS', unit: 'BRL', metric: 'return_seminovos', first: 35, second: 17 }),
    Object.freeze({ key: 'financedUnits', label: 'MAIOR QUANTIDADE DE PROPOSTAS', unit: 'UND', metric: 'financed_units', first: 15, second: 8 }),
    Object.freeze({ key: 'spfUnits', label: 'MAIOR QUANTIDADE DE SPF', unit: 'UND', metric: 'spf_units', first: 15, second: 8 })
  ]);

  const MAX_TOTAL_POINTS = CATEGORIES.reduce((a, c) => a + c.first, 0);

  // ----------------------------------------------------------------
  // Política de empate -- NÃO DEFINIDA PELO HUMANO (brief, seções 18/49).
  //
  // 'PENDING' (padrão, e único valor seguro hoje): um empate em posição
  // que vale pontos (1º ou 2º) NÃO é resolvido. Nenhum dos empatados
  // recebe os pontos daquela posição, a categoria é marcada como
  // `unresolved: true` e o empate é descrito em `ties[]` para a UI exibir
  // explicitamente ao Humano. Nunca ordena por nome, por produção, por
  // primeiro registro nem por timestamp.
  //
  // 'SHARE' e 'SKIP' existem apenas como pontos de extensão nomeados,
  // para que a decisão do Humano vire uma linha de configuração e não
  // uma reescrita -- ambos permanecem NÃO AUTORIZADOS até decisão
  // explícita, e por isso levantam erro se usados.
  // ----------------------------------------------------------------
  const TIE_POLICY = Object.freeze({ PENDING: 'PENDING', SHARE: 'SHARE', SKIP: 'SKIP' });

  // ----------------------------------------------------------------
  // Regra de atividade zero (brief, seção 19).
  //
  // Convenção reaproveitada de operational_analyst_commission_metrics(),
  // cujo SELECT final já descarta linhas sem nenhuma atividade
  // (`where sold_count > 0 or financed_count > 0 or return_value > 0 or
  // spf_value > 0`). Aplicada aqui POR CATEGORIA: métrica <= 0 não é
  // classificada naquela categoria e não pode virar "1º lugar" só porque
  // todo mundo zerou. O participante continua na tabela consolidada com
  // 0 pontos naquela categoria.
  // ----------------------------------------------------------------
  function isRankable(value) {
    return Number.isFinite(value) && value > 0;
  }

  function normalizeParticipant(p, index) {
    if (!p || typeof p !== 'object') throw new Error('Participante inválido na posição ' + index + '.');
    const id = String(p.id != null ? p.id : '').trim();
    if (!id) throw new Error('Participante sem id na posição ' + index + '.');
    const out = { id: id, name: String(p.name || '').trim() };
    CATEGORIES.forEach(function (c) {
      const raw = p[c.key];
      const n = Number(raw == null ? 0 : raw);
      if (!Number.isFinite(n)) throw new Error('Métrica "' + c.key + '" não numérica para o participante ' + id + '.');
      out[c.key] = n;
    });
    return out;
  }

  // Comparação monetária/quantidade com tolerância explícita.
  // Valores BRL chegam da autoridade já arredondados em numeric(18,2);
  // 0.005 é meio centavo -- abaixo da menor diferença representável, então
  // nunca funde dois valores realmente distintos, e nunca separa dois
  // valores iguais por ruído de ponto flutuante.
  const EPSILON = 0.005;
  function sameValue(a, b) { return Math.abs(a - b) < EPSILON; }

  /**
   * Classifica uma categoria e distribui os pontos.
   * Devolve { ranking, points, ties, unresolved }.
   */
  function rankCategory(participants, category, tiePolicy) {
    const eligible = participants
      .filter(function (p) { return isRankable(p[category.key]); })
      .sort(function (a, b) { return b[category.key] - a[category.key]; });

    const points = {};
    participants.forEach(function (p) { points[p.id] = 0; });

    const ties = [];
    let unresolved = false;

    // Agrupa por valor para detectar empates reais antes de premiar.
    const groups = [];
    eligible.forEach(function (p) {
      const last = groups[groups.length - 1];
      if (last && sameValue(last.value, p[category.key])) last.members.push(p);
      else groups.push({ value: p[category.key], members: [p] });
    });

    // Posição ocupada por cada grupo: 1º grupo -> posição 1, 2º grupo ->
    // posição 1 + tamanho do grupo anterior (ranking competitivo padrão).
    let position = 1;
    const ranking = [];
    groups.forEach(function (g) {
      const award = position === 1 ? category.first : (position === 2 ? category.second : 0);
      const tied = g.members.length > 1;

      if (tied && award > 0) {
        // Empate em posição premiada: nunca resolvido em silêncio.
        unresolved = true;
        ties.push({
          category: category.key,
          position: position,
          value: g.value,
          pointsAtStake: award,
          participants: g.members.map(function (m) { return { id: m.id, name: m.name }; })
        });
      }

      g.members.forEach(function (m) {
        const awarded = (tied && award > 0) ? 0 : award;
        points[m.id] = awarded;
        ranking.push({
          id: m.id,
          name: m.name,
          value: m[category.key],
          position: position,
          tied: tied,
          points: awarded,
          pointsWithheld: (tied && award > 0) ? award : 0
        });
      });

      position += g.members.length;
    });

    return { key: category.key, label: category.label, unit: category.unit, first: category.first, second: category.second, ranking: ranking, points: points, ties: ties, unresolved: unresolved };
  }

  /**
   * Calcula o ranking consolidado PERFORMANCE.
   *
   * @param {Array} rawParticipants métricas já apuradas pela autoridade
   *        servidora: { id, name, returnNovos, returnSeminovos,
   *        financedUnits, spfUnits }.
   * @param {Object} [options] { tiePolicy }.
   */
  function computePerformance(rawParticipants, options) {
    const opts = options || {};
    const tiePolicy = opts.tiePolicy || TIE_POLICY.PENDING;
    // Fail-closed: qualquer política de desempate diferente de PENDING
    // exigiria uma decisão de produto que o Humano ainda não tomou.
    if (tiePolicy !== TIE_POLICY.PENDING) {
      throw new Error('Política de empate não autorizada: ' + tiePolicy + '. Decisão de produto pendente (PERF-1, seção 15).');
    }
    if (!Array.isArray(rawParticipants)) throw new Error('Lista de participantes inválida.');

    const participants = rawParticipants.map(normalizeParticipant);
    const seen = new Set();
    participants.forEach(function (p) {
      if (seen.has(p.id)) throw new Error('Participante duplicado: ' + p.id + '.');
      seen.add(p.id);
    });

    const categories = CATEGORIES.map(function (c) { return rankCategory(participants, c, tiePolicy); });

    const rows = participants.map(function (p) {
      const breakdown = {};
      let total = 0;
      categories.forEach(function (c) {
        breakdown[c.key] = { value: p[c.key], points: c.points[p.id] };
        total += c.points[p.id];
      });
      return { id: p.id, name: p.name, breakdown: breakdown, totalPoints: total };
    });

    rows.sort(function (a, b) { return b.totalPoints - a.totalPoints; });

    // Ranking geral -- mesma regra competitiva, mesmos empates explícitos.
    const overallTies = [];
    let overallPosition = 1;
    let i = 0;
    while (i < rows.length) {
      let j = i;
      while (j + 1 < rows.length && rows[j + 1].totalPoints === rows[i].totalPoints) j++;
      const groupSize = j - i + 1;
      for (let k = i; k <= j; k++) {
        rows[k].overallRank = overallPosition;
        rows[k].overallTied = groupSize > 1;
      }
      if (groupSize > 1) {
        overallTies.push({
          position: overallPosition,
          totalPoints: rows[i].totalPoints,
          participants: rows.slice(i, j + 1).map(function (r) { return { id: r.id, name: r.name }; })
        });
      }
      overallPosition += groupSize;
      i = j + 1;
    }

    const categoryTies = categories.reduce(function (a, c) { return a.concat(c.ties); }, []);

    return {
      maxTotalPoints: MAX_TOTAL_POINTS,
      tiePolicy: tiePolicy,
      categories: categories,
      rows: rows,
      ties: { categories: categoryTies, overall: overallTies },
      unresolved: categoryTies.length > 0 || overallTies.length > 0
    };
  }

  return {
    CATEGORIES: CATEGORIES,
    MAX_TOTAL_POINTS: MAX_TOTAL_POINTS,
    TIE_POLICY: TIE_POLICY,
    computePerformance: computePerformance
  };
});
