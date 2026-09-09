/*
 * PERF-1 -- Núcleo de pontuação do módulo PERFORMANCE.
 *
 * ESTADO: FUNDAÇÃO. Este arquivo NÃO está ligado a nenhuma página do
 * Portal e NÃO é carregado por index.html nem por modules/*.html. Ele
 * existe para que o contrato de pontuação -- a parte do módulo
 * PERFORMANCE que o Humano especificou de forma completa e inequívoca --
 * fique implementado, versionado e provado por testes determinísticos
 * (tests/perf1_performance_scoring_test.js).
 *
 * PERF-2: a política de empate foi decidida pelo Humano e está
 * implementada aqui (FULL_POINTS_COMPETITION_RANKING). O módulo continua
 * NÃO construído porque a ATRIBUIÇÃO INDIVIDUAL POR ANALISTA não existe
 * no Secure: nenhuma das 143 funções do banco liga uma tabela de
 * analista a um fato financeiro, e portal_finance_operations não possui
 * nenhuma coluna de analista. Ver o relatório PERF-2, seções 7 e 16.
 *
 * O que este arquivo deliberadamente NÃO faz:
 *  - não lê Supabase, não conhece RPC, não conhece perfil/loja/período;
 *  - não decide QUEM participa -- a população (ANALISTA) é regra de
 *    negócio do Humano, e a ATRIBUIÇÃO por analista segue bloqueada;
 *  - não usa ordem alfabética, ordem de entrada nem timestamp para
 *    decidir pontos.
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
  // Política de empate -- DECIDIDA PELO HUMANO em PERF-2, seção 2.4.
  //
  // FULL_POINTS_COMPETITION_RANKING (padrão e única política autorizada):
  // todos os participantes empatados numa posição que vale pontos recebem
  // INTEGRALMENTE os pontos daquela posição. As posições seguintes são
  // puladas pelo padrão de competition ranking.
  //
  //   dois empatados em 1º numa categoria 35/17:
  //     ambos = posição 1 = 35 pontos; o próximo = posição 3 = 0 pontos.
  //   um 1º e três empatados em 2º numa categoria 15/8:
  //     1º = 15; os três = posição 2 = 8 pontos cada;
  //     o próximo = posição 5 = 0 pontos.
  //
  // Consequência explicitamente aceita pelo Humano: o total distribuído
  // por uma categoria pode exceder o pool nominal 1º+2º. O máximo
  // INDIVIDUAL continua sendo 100, porque cada participante só pode
  // ocupar uma posição por categoria.
  //
  // O empate continua sendo reportado (tied/ties[]) para que a UI o
  // mostre explicitamente -- mas ele já não bloqueia a premiação.
  // Ordem alfabética, ordem de entrada, produção, primeiro registro e
  // timestamp NUNCA decidem pontos (provado em tests, grupo [11]).
  //
  // 'PENDING' era a política provisória de PERF-1, mantida aqui apenas
  // como nome reservado para que qualquer chamada antiga falhe de forma
  // ruidosa em vez de silenciosamente reter pontos.
  // ----------------------------------------------------------------
  const TIE_POLICY = Object.freeze({
    FULL_POINTS_COMPETITION_RANKING: 'FULL_POINTS_COMPETITION_RANKING',
    PENDING: 'PENDING'
  });

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
        // Empate em posição premiada: TODOS recebem os pontos integrais.
        // Continua reportado para a UI poder exibir "empate".
        ties.push({
          category: category.key,
          position: position,
          value: g.value,
          pointsEach: award,
          participants: g.members.map(function (m) { return { id: m.id, name: m.name }; })
        });
      }

      g.members.forEach(function (m) {
        points[m.id] = award;
        ranking.push({
          id: m.id,
          name: m.name,
          value: m[category.key],
          position: position,
          tied: tied,
          points: award
        });
      });

      // Competition ranking: a próxima posição pula o tamanho do grupo.
      position += g.members.length;
    });

    return { key: category.key, label: category.label, unit: category.unit, first: category.first, second: category.second, ranking: ranking, points: points, ties: ties, hasTies: ties.length > 0 };
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
    const tiePolicy = opts.tiePolicy || TIE_POLICY.FULL_POINTS_COMPETITION_RANKING;
    // Fail-closed: FULL_POINTS_COMPETITION_RANKING é a única política
    // autorizada pelo Humano (PERF-2, seção 2.4). Qualquer outro valor --
    // inclusive o 'PENDING' provisório de PERF-1 -- falha ruidosamente,
    // em vez de reter pontos em silêncio.
    if (tiePolicy !== TIE_POLICY.FULL_POINTS_COMPETITION_RANKING) {
      throw new Error('Política de empate não autorizada: ' + tiePolicy + '. Única política válida: FULL_POINTS_COMPETITION_RANKING (PERF-2, seção 2.4).');
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

    // Ordenação: pontos DESC. O desempate por nome é APENAS ordenação
    // visual determinística DENTRO de um grupo já empatado (brief 3.5) --
    // não altera overallRank nem pontos, e é aplicado depois que os
    // pontos já foram atribuídos. Prova disso no teste 11.5/11.9.
    rows.sort(function (a, b) {
      if (b.totalPoints !== a.totalPoints) return b.totalPoints - a.totalPoints;
      return a.name.localeCompare(b.name, 'pt-BR');
    });

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
      // hasTies é informativo (a UI deve marcar "empate" visivelmente).
      // Sob FULL_POINTS_COMPETITION_RANKING um empate JÁ ESTÁ resolvido:
      // não bloqueia nada, ao contrário do `unresolved` de PERF-1.
      hasTies: categoryTies.length > 0 || overallTies.length > 0
    };
  }

  return {
    CATEGORIES: CATEGORIES,
    MAX_TOTAL_POINTS: MAX_TOTAL_POINTS,
    TIE_POLICY: TIE_POLICY,
    computePerformance: computePerformance
  };
});
