#!/usr/bin/env node
/*
 * PERF-1/PERF-2 -- Matriz de testes determinísticos do núcleo de
 * pontuação PERFORMANCE (assets/js/performance-scoring.js).
 *
 * Cobre o que o Humano especificou de forma completa:
 *   - PERF-1 seções 12/13/14/15: 35/17/0 (Novos), 35/17/0 (Seminovos),
 *     15/8/0 (UND Financiado), 15/8/0 (UND SPF);
 *   - PERF-1 seção 16: máximo individual = 100 pontos, provado;
 *   - PERF-1 seção 17: total = soma das 4 categorias, ranking por total;
 *   - PERF-2 seção 2.4: FULL_POINTS_COMPETITION_RANKING -- todos os
 *     empatados recebem os pontos INTEGRAIS da posição empatada, e as
 *     posições seguintes são puladas competitivamente;
 *   - PERF-2 seção 20: as cinco formas de empate em cada faixa de
 *     pontuação, empate no total, e prova de que ordem alfabética e
 *     ordem de entrada nunca afetam pontos;
 *   - PERF-2 seção 57: fixture obrigatória do empate triplo no 2º lugar
 *     em UND SPF (1º = 15; três empatados = 8 cada; próximo = posição 5);
 *   - PERF-2 seção 21: atividade zero não vence;
 *   - PERF-2 seção 22: valores negativos não são coagidos para cima.
 *
 * Nenhuma leitura de banco, nenhuma rede, nenhum dado real -- o núcleo é
 * uma função pura e os fixtures são sintéticos.
 */
const path = require('path');
const S = require(path.join(__dirname, '..', 'assets', 'js', 'performance-scoring.js'));

let passed = 0, failed = 0;
function check(label, cond) {
  if (cond) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}`); }
}

function P(id, rn, rs, fin, spf) {
  return { id: id, name: id, returnNovos: rn, returnSeminovos: rs, financedUnits: fin, spfUnits: spf };
}
function pts(res, id) { return res.rows.find(r => r.id === id).totalPoints; }
function catPts(res, key, id) { return res.categories.find(c => c.key === key).points[id]; }
function cat(res, key) { return res.categories.find(c => c.key === key); }

// ---------------------------------------------------------------
console.log('\n[1] Contrato de pontuação (PERF-1, 12-16)');
// ---------------------------------------------------------------
{
  check('1.1 quatro categorias exatas', S.CATEGORIES.map(c => c.key).join(',') ===
    'returnNovos,returnSeminovos,financedUnits,spfUnits');
  check('1.2 Novos = 35/17', S.CATEGORIES[0].first === 35 && S.CATEGORIES[0].second === 17);
  check('1.3 Seminovos = 35/17', S.CATEGORIES[1].first === 35 && S.CATEGORIES[1].second === 17);
  check('1.4 UND Financiado = 15/8', S.CATEGORIES[2].first === 15 && S.CATEGORIES[2].second === 8);
  check('1.5 UND SPF = 15/8', S.CATEGORIES[3].first === 15 && S.CATEGORIES[3].second === 8);
  check('1.6 máximo individual = 100', S.MAX_TOTAL_POINTS === 100);
  check('1.7 SPF é quantidade, não valor (unidade UND)', S.CATEGORIES[3].unit === 'UND');
  check('1.8 Retorno é monetário (unidade BRL)', S.CATEGORIES[0].unit === 'BRL' && S.CATEGORIES[1].unit === 'BRL');
}

// ---------------------------------------------------------------
console.log('\n[2] Ranking normal, 3+ participantes, sem empate');
// ---------------------------------------------------------------
{
  const res = S.computePerformance([
    P('A', 30000, 5000, 9, 5),
    P('B', 20000, 12000, 7, 3),
    P('C', 10000, 20000, 5, 1)
  ]);
  check('2.1 A vence Novos = 35', catPts(res, 'returnNovos', 'A') === 35);
  check('2.2 B 2º em Novos = 17', catPts(res, 'returnNovos', 'B') === 17);
  check('2.3 C 3º em Novos = 0', catPts(res, 'returnNovos', 'C') === 0);
  check('2.4 C vence Seminovos = 35', catPts(res, 'returnSeminovos', 'C') === 35);
  check('2.5 B 2º em Seminovos = 17', catPts(res, 'returnSeminovos', 'B') === 17);
  check('2.6 A vence UND Financiado = 15', catPts(res, 'financedUnits', 'A') === 15);
  check('2.7 B 2º em UND Financiado = 8', catPts(res, 'financedUnits', 'B') === 8);
  check('2.8 A vence UND SPF = 15', catPts(res, 'spfUnits', 'A') === 15);
  check('2.9 B 2º em UND SPF = 8', catPts(res, 'spfUnits', 'B') === 8);
  check('2.10 total A = 35+0+15+15 = 65', pts(res, 'A') === 65);
  check('2.11 total B = 17+17+8+8 = 50', pts(res, 'B') === 50);
  check('2.12 total C = 0+35+0+0 = 35', pts(res, 'C') === 35);
  check('2.13 ranking geral por total DESC', res.rows.map(r => r.id).join('') === 'ABC');
  check('2.14 posições gerais 1,2,3', res.rows.map(r => r.overallRank).join(',') === '1,2,3');
  check('2.15 nenhum empate', res.hasTies === false);
  check('2.16 nenhum individual excede o máximo', res.rows.every(r => r.totalPoints <= S.MAX_TOTAL_POINTS));
}

// ---------------------------------------------------------------
console.log('\n[3] Máximo individual de 100 pontos (PERF-1, 16)');
// ---------------------------------------------------------------
{
  const res = S.computePerformance([
    P('DOMINANTE', 99999, 88888, 50, 40),
    P('SEGUNDO', 100, 100, 1, 1),
    P('TERCEIRO', 50, 50, 1, 1)
  ]);
  check('3.1 varrer as 4 categorias = exatamente 100', pts(res, 'DOMINANTE') === 100);
  check('3.2 100 == máximo declarado', pts(res, 'DOMINANTE') === S.MAX_TOTAL_POINTS);
  check('3.3 nenhum participante ultrapassa 100', res.rows.every(r => r.totalPoints <= 100));
}

// ---------------------------------------------------------------
console.log('\n[4] Populações degeneradas: 1 e 2 participantes');
// ---------------------------------------------------------------
{
  const um = S.computePerformance([P('SOZINHO', 1000, 2000, 3, 4)]);
  check('4.1 participante único leva 100', pts(um, 'SOZINHO') === 100);
  check('4.2 participante único é 1º geral', um.rows[0].overallRank === 1);

  // Com apenas 2 participantes o perdedor de cada categoria ainda ocupa o
  // 2º lugar -- logo ambos pontuam nas 4 categorias. Isso é consequência
  // do contrato do Humano, não um ajuste.
  const dois = S.computePerformance([P('X', 1000, 10, 5, 2), P('Y', 10, 1000, 1, 1)]);
  check('4.3 X: 35 (Novos) + 17 (2º Semin.) + 15 + 15 = 82', pts(dois, 'X') === 82);
  check('4.4 Y: 17 + 35 + 8 + 8 = 68', pts(dois, 'Y') === 68);
  check('4.5 com 2 participantes o 2º ainda pontua', catPts(dois, 'returnNovos', 'Y') === 17);
  check('4.6 ranking geral respeita o total (X > Y)', dois.rows[0].id === 'X');
  check('4.7 com 2 participantes todo o pool 1º+2º é distribuído', pts(dois, 'X') + pts(dois, 'Y') === 150);
}

// ---------------------------------------------------------------
console.log('\n[5] Muitos participantes: só 1º e 2º pontuam');
// ---------------------------------------------------------------
{
  const many = [];
  for (let i = 1; i <= 12; i++) many.push(P('P' + i, i * 1000, i * 100, i, i));
  const res = S.computePerformance(many);
  check('5.1 P12 (1º em tudo) = 100', pts(res, 'P12') === 100);
  check('5.2 P11 (2º em tudo) = 17+17+8+8 = 50', pts(res, 'P11') === 50);
  check('5.3 do 3º para baixo, todos zeram', res.rows.filter(r => !['P12', 'P11'].includes(r.id)).every(r => r.totalPoints === 0));
  check('5.4 todos os 12 aparecem na tabela consolidada', res.rows.length === 12);
}

// ---------------------------------------------------------------
console.log('\n[6] Atividade zero não vence (PERF-2, 21)');
// ---------------------------------------------------------------
{
  const res = S.computePerformance([P('A', 0, 0, 0, 0), P('B', 0, 0, 0, 0), P('C', 0, 0, 0, 0)]);
  check('6.1 categoria inteiramente zerada não premia ninguém', res.rows.every(r => r.totalPoints === 0));
  check('6.2 nenhum classificado em Novos', cat(res, 'returnNovos').ranking.length === 0);
  check('6.3 nenhum classificado em UND SPF', cat(res, 'spfUnits').ranking.length === 0);
  check('6.4 zero não gera empate premiado', res.ties.categories.length === 0);
  check('6.5 participantes continuam listados com 0 pontos', res.rows.length === 3);

  const mix = S.computePerformance([P('ATIVO', 500, 0, 2, 0), P('ZERO1', 0, 0, 0, 0), P('ZERO2', 0, 0, 0, 0)]);
  check('6.6 único com atividade leva o 1º da categoria', catPts(mix, 'returnNovos', 'ATIVO') === 35);
  check('6.7 zerados não recebem o 2º lugar', catPts(mix, 'returnNovos', 'ZERO1') === 0 && catPts(mix, 'returnNovos', 'ZERO2') === 0);
  check('6.8 Seminovos zerado para todos = ninguém pontua', cat(mix, 'returnSeminovos').ranking.length === 0);
}

// ---------------------------------------------------------------
console.log('\n[7] Valores negativos (PERF-2, 22)');
// ---------------------------------------------------------------
{
  // Auditoria ao vivo: portal_finance_operations.return_value tem
  // min = 0.00 e zero linhas negativas hoje. O núcleo mesmo assim trata
  // negativo explicitamente: não classifica e nunca é coagido para cima.
  const res = S.computePerformance([P('NEG', -5000, 100, 1, 1), P('POS', 100, 50, 2, 2)]);
  check('7.1 retorno negativo não é classificado', cat(res, 'returnNovos').ranking.every(r => r.id !== 'NEG'));
  check('7.2 retorno negativo não pontua', catPts(res, 'returnNovos', 'NEG') === 0);
  check('7.3 o positivo leva o 1º', catPts(res, 'returnNovos', 'POS') === 35);
  check('7.4 valor negativo preservado na tabela (não sanitizado)', res.rows.find(r => r.id === 'NEG').breakdown.returnNovos.value === -5000);
}

// ---------------------------------------------------------------
console.log('\n[8] Empates -- FULL_POINTS_COMPETITION_RANKING (PERF-2, 2.4)');
// ---------------------------------------------------------------
{
  // ---- categoria 35/17: dois empatados em 1º ----
  const t1 = S.computePerformance([P('A', 10000, 1, 1, 1), P('B', 10000, 2, 2, 2), P('C', 500, 3, 3, 3)]);
  check('8.1 dois empatados em 1º recebem 35 CADA (integral)', catPts(t1, 'returnNovos', 'A') === 35 && catPts(t1, 'returnNovos', 'B') === 35);
  check('8.2 o empate continua reportado para a UI', t1.ties.categories.some(t => t.category === 'returnNovos' && t.position === 1 && t.pointsEach === 35));
  check('8.3 o empate cita os dois participantes', t1.ties.categories.find(t => t.category === 'returnNovos').participants.map(p => p.id).sort().join('') === 'AB');
  check('8.4 posição pulada competitivamente: o próximo é 3º', cat(t1, 'returnNovos').ranking.find(r => r.id === 'C').position === 3);
  check('8.5 o 3º NÃO herda os 17 (a posição 2 não existe)', catPts(t1, 'returnNovos', 'C') === 0);
  check('8.6 as linhas empatadas ficam marcadas como tied', cat(t1, 'returnNovos').ranking.filter(r => r.tied).length === 2);
  check('8.7 a categoria distribuiu 70 pts (excede o pool nominal 35+17)', ['A', 'B', 'C'].reduce((a, id) => a + catPts(t1, 'returnNovos', id), 0) === 70);

  // ---- categoria 35/17: três empatados em 1º ----
  const t2 = S.computePerformance([P('A', 900, 1, 1, 1), P('B', 900, 1, 1, 1), P('C', 900, 1, 1, 1), P('D', 10, 1, 1, 1)]);
  check('8.8 três empatados em 1º recebem 35 cada', ['A', 'B', 'C'].every(id => catPts(t2, 'returnNovos', id) === 35));
  check('8.9 após três empatados em 1º o próximo é a posição 4', cat(t2, 'returnNovos').ranking.find(r => r.id === 'D').position === 4);
  check('8.10 e a posição 4 não pontua', catPts(t2, 'returnNovos', 'D') === 0);

  // ---- categoria 35/17: dois empatados em 2º ----
  const t3 = S.computePerformance([P('W', 90000, 1, 1, 1), P('A', 10000, 2, 2, 2), P('B', 10000, 3, 3, 3), P('C', 5, 4, 4, 4)]);
  check('8.11 dois empatados em 2º recebem 17 CADA', catPts(t3, 'returnNovos', 'A') === 17 && catPts(t3, 'returnNovos', 'B') === 17);
  check('8.12 o 1º não é afetado', catPts(t3, 'returnNovos', 'W') === 35);
  check('8.13 após dois empatados em 2º o próximo é a posição 4', cat(t3, 'returnNovos').ranking.find(r => r.id === 'C').position === 4);

  // ---- categoria 35/17: três empatados em 2º ----
  const t4 = S.computePerformance([P('W', 90000, 1, 1, 1), P('A', 100, 2, 2, 2), P('B', 100, 3, 3, 3), P('C', 100, 4, 4, 4), P('D', 5, 5, 5, 5)]);
  check('8.14 três empatados em 2º recebem 17 cada', ['A', 'B', 'C'].every(id => catPts(t4, 'returnNovos', id) === 17));
  check('8.15 após 1º + três empatados em 2º o próximo é a posição 5', cat(t4, 'returnNovos').ranking.find(r => r.id === 'D').position === 5);

  // ---- categoria 15/8: as mesmas formas ----
  const q1 = S.computePerformance([P('A', 1, 1, 9, 1), P('B', 1, 1, 9, 1), P('C', 1, 1, 2, 1)]);
  check('8.16 15/8: dois empatados em 1º recebem 15 cada', catPts(q1, 'financedUnits', 'A') === 15 && catPts(q1, 'financedUnits', 'B') === 15);
  check('8.17 15/8: o próximo é a posição 3 e não recebe os 8', cat(q1, 'financedUnits').ranking.find(r => r.id === 'C').position === 3 && catPts(q1, 'financedUnits', 'C') === 0);

  const q2 = S.computePerformance([P('A', 1, 1, 9, 1), P('B', 1, 1, 9, 1), P('C', 1, 1, 9, 1), P('D', 1, 1, 2, 1)]);
  check('8.18 15/8: três empatados em 1º recebem 15 cada', ['A', 'B', 'C'].every(id => catPts(q2, 'financedUnits', id) === 15));
  check('8.19 15/8: o próximo é a posição 4', cat(q2, 'financedUnits').ranking.find(r => r.id === 'D').position === 4);

  const q3 = S.computePerformance([P('W', 1, 1, 20, 1), P('A', 1, 1, 5, 1), P('B', 1, 1, 5, 1), P('C', 1, 1, 2, 1)]);
  check('8.20 15/8: dois empatados em 2º recebem 8 cada', catPts(q3, 'financedUnits', 'A') === 8 && catPts(q3, 'financedUnits', 'B') === 8);
  check('8.21 15/8: o próximo é a posição 4', cat(q3, 'financedUnits').ranking.find(r => r.id === 'C').position === 4);

  // ---- PERF-2 seção 57: fixture obrigatória ----
  // Empate triplo no 2º em UND SPF -- forma REAL observada na competência
  // corrente na auditoria PERF-1 (1º com 7 unidades; três com 2 unidades).
  const spf = S.computePerformance([P('L1', 1, 1, 1, 7), P('L2', 1, 1, 1, 2), P('L3', 1, 1, 1, 2), P('L4', 1, 1, 1, 2), P('L5', 1, 1, 1, 1)]);
  check('8.22 [S.57] 1º em UND SPF recebe 15', catPts(spf, 'spfUnits', 'L1') === 15);
  check('8.23 [S.57] os três empatados em 2º recebem 8 CADA', ['L2', 'L3', 'L4'].every(id => catPts(spf, 'spfUnits', id) === 8));
  check('8.24 [S.57] a próxima posição competitiva é a 5ª', cat(spf, 'spfUnits').ranking.find(r => r.id === 'L5').position === 5);
  check('8.25 [S.57] e a 5ª posição não pontua', catPts(spf, 'spfUnits', 'L5') === 0);
  check('8.26 [S.57] os três empatados constam do relatório de empates', spf.ties.categories.find(t => t.category === 'spfUnits' && t.position === 2).participants.length === 3);

  // ---- empate no total geral ----
  const tot = S.computePerformance([P('A', 100, 100, 1, 1), P('B', 100, 100, 1, 1)]);
  check('8.27 empate total: ambos recebem os pontos integrais das 4 categorias', pts(tot, 'A') === 100 && pts(tot, 'B') === 100);
  check('8.28 empate no total geral reportado', tot.ties.overall.some(t => t.position === 1 && t.totalPoints === 100));
  check('8.29 ambos são 1º no ranking geral e marcados como empatados', tot.rows.every(r => r.overallRank === 1 && r.overallTied === true));
  check('8.30 individual continua limitado a 100 mesmo empatado', tot.rows.every(r => r.totalPoints <= 100));

  const tot2 = S.computePerformance([P('A', 100, 100, 5, 5), P('B', 100, 100, 5, 5), P('C', 1, 1, 1, 1)]);
  check('8.31 após dois empatados em 1º geral, o próximo é o 3º geral', tot2.rows.find(r => r.id === 'C').overallRank === 3);
  check('8.32 hasTies sinaliza empate sem bloquear nada', tot2.hasTies === true && tot2.rows.every(r => typeof r.totalPoints === 'number'));
}

// ---------------------------------------------------------------
console.log('\n[9] Política de empate é fail-closed');
// ---------------------------------------------------------------
{
  let threwPending = false, threwUnknown = false, threwShare = false;
  try { S.computePerformance([P('A', 1, 1, 1, 1)], { tiePolicy: 'PENDING' }); } catch (e) { threwPending = true; }
  try { S.computePerformance([P('A', 1, 1, 1, 1)], { tiePolicy: 'ALFABETICA' }); } catch (e) { threwUnknown = true; }
  try { S.computePerformance([P('A', 1, 1, 1, 1)], { tiePolicy: 'SHARE' }); } catch (e) { threwShare = true; }
  check('9.1 a política provisória PENDING de PERF-1 agora é recusada', threwPending);
  check('9.2 política arbitrária recusada', threwUnknown);
  check('9.3 SHARE (nunca autorizada) recusada', threwShare);
  check('9.4 padrão é FULL_POINTS_COMPETITION_RANKING', S.computePerformance([P('A', 1, 1, 1, 1)]).tiePolicy === 'FULL_POINTS_COMPETITION_RANKING');
  check('9.5 a política autorizada é explicitamente aceita', S.computePerformance([P('A', 1, 1, 1, 1)], { tiePolicy: S.TIE_POLICY.FULL_POINTS_COMPETITION_RANKING }).rows[0].totalPoints === 100);
}

// ---------------------------------------------------------------
console.log('\n[10] Perfis de atividade parcial');
// ---------------------------------------------------------------
{
  const soNovos = S.computePerformance([P('N1', 5000, 0, 4, 2), P('N2', 3000, 0, 2, 1)]);
  check('10.1 só Novos: Seminovos não premia ninguém', cat(soNovos, 'returnSeminovos').ranking.length === 0);
  check('10.2 só Novos: teto real é 65, não 100', pts(soNovos, 'N1') === 65);

  const soSemi = S.computePerformance([P('S1', 0, 5000, 4, 2), P('S2', 0, 3000, 2, 1)]);
  check('10.3 só Seminovos: Novos não premia ninguém', cat(soSemi, 'returnNovos').ranking.length === 0);
  check('10.4 só Seminovos: teto real é 65', pts(soSemi, 'S1') === 65);

  const semSpf = S.computePerformance([P('A', 100, 100, 3, 0), P('B', 50, 50, 1, 0)]);
  check('10.5 sem SPF: categoria D não premia', cat(semSpf, 'spfUnits').ranking.length === 0);
  check('10.6 sem SPF: teto real é 85', pts(semSpf, 'A') === 85);

  const semFin = S.computePerformance([P('A', 100, 100, 0, 3), P('B', 50, 50, 0, 1)]);
  check('10.7 sem financiamento: categoria C não premia', cat(semFin, 'financedUnits').ranking.length === 0);
  check('10.8 sem financiamento: teto real é 85', pts(semFin, 'A') === 85);

  const ambos = S.computePerformance([P('AMBOS', 7000, 7000, 6, 4), P('OUTRO', 100, 100, 1, 1)]);
  check('10.9 ativo nos dois departamentos alcança os 100', pts(ambos, 'AMBOS') === 100);
}

// ---------------------------------------------------------------
console.log('\n[11] Ordem nunca decide pontos (PERF-2, 20)');
// ---------------------------------------------------------------
{
  let dup = false, semId = false, naoNumerico = false, naoLista = false;
  try { S.computePerformance([P('A', 1, 1, 1, 1), P('A', 2, 2, 2, 2)]); } catch (e) { dup = true; }
  try { S.computePerformance([{ id: '', returnNovos: 1 }]); } catch (e) { semId = true; }
  try { S.computePerformance([{ id: 'A', returnNovos: 'muito' }]); } catch (e) { naoNumerico = true; }
  try { S.computePerformance(null); } catch (e) { naoLista = true; }
  check('11.1 participante duplicado é recusado', dup);
  check('11.2 participante sem id é recusado', semId);
  check('11.3 métrica não numérica é recusada', naoNumerico);
  check('11.4 entrada não-lista é recusada', naoLista);

  const base = [P('A', 30000, 5000, 9, 5), P('B', 20000, 12000, 7, 3), P('C', 10000, 20000, 5, 1)];
  const r1 = S.computePerformance(base);
  const r2 = S.computePerformance(base.slice().reverse());
  check('11.5 ordem de entrada não altera pontos nem posições',
    JSON.stringify(r1.rows.map(r => [r.id, r.totalPoints, r.overallRank])) ===
    JSON.stringify(r2.rows.map(r => [r.id, r.totalPoints, r.overallRank])));

  // Ordem alfabética não pode decidir pontos: dois empatados com nomes em
  // extremos opostos do alfabeto recebem exatamente os mesmos pontos.
  const alfa = S.computePerformance([
    { id: 'z', name: 'ZULMIRA', returnNovos: 5000, returnSeminovos: 1, financedUnits: 1, spfUnits: 1 },
    { id: 'a', name: 'ANA', returnNovos: 5000, returnSeminovos: 1, financedUnits: 1, spfUnits: 1 }
  ]);
  check('11.6 empate: nome alfabeticamente menor NÃO ganha vantagem', pts(alfa, 'a') === pts(alfa, 'z'));
  check('11.7 empate: ambos na mesma posição de categoria', cat(alfa, 'returnNovos').ranking.every(r => r.position === 1));
  check('11.8 empate: ambos no mesmo rank geral', alfa.rows.every(r => r.overallRank === 1));
  check('11.9 ordenação alfabética é apenas visual dentro do grupo empatado', alfa.rows.map(r => r.id).join('') === 'az');

  const mut = S.computePerformance([P('A', 1, 5000, 9, 5), P('B', 20000, 12000, 7, 3), P('C', 10000, 20000, 5, 1)]);
  check('11.10 mutação da métrica muda a pontuação (sem hardcode)', pts(mut, 'A') !== pts(r1, 'A'));

  const eps = S.computePerformance([P('A', 1000.000, 1, 1, 1), P('B', 1000.001, 1, 1, 1)]);
  check('11.11 diferença sub-centavo é empate (ambos recebem 35)', catPts(eps, 'returnNovos', 'A') === 35 && catPts(eps, 'returnNovos', 'B') === 35);
  const noEps = S.computePerformance([P('A', 1000.00, 1, 1, 1), P('B', 1000.01, 1, 1, 1)]);
  check('11.12 diferença de 1 centavo é vitória real', catPts(noEps, 'returnNovos', 'B') === 35 && catPts(noEps, 'returnNovos', 'A') === 17);
}

// ---------------------------------------------------------------
console.log('\n[12] Sem PII no resultado (PERF-2, 33)');
// ---------------------------------------------------------------
{
  const res = S.computePerformance([{ id: 'u1', name: 'FULANO', cpf: '12345678901', email: 'x@y.z', returnNovos: 10, returnSeminovos: 10, financedUnits: 1, spfUnits: 1 }]);
  const json = JSON.stringify(res);
  check('12.1 CPF não atravessa o núcleo', !json.includes('12345678901') && !json.includes('cpf'));
  check('12.2 e-mail não atravessa o núcleo', !json.includes('x@y.z') && !json.includes('email'));
  check('12.3 apenas id + nome de exibição sobrevivem', res.rows[0].id === 'u1' && res.rows[0].name === 'FULANO');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
