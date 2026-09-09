#!/usr/bin/env node
/*
 * PERF-1 -- Matriz de testes determinísticos do núcleo de pontuação
 * PERFORMANCE (assets/js/performance-scoring.js).
 *
 * Cobre exatamente o que o brief PERF-1 especificou de forma completa:
 *   - seções 12/13/14/15: 35/17/0 (Novos), 35/17/0 (Seminovos),
 *     15/8/0 (UND Financiado), 15/8/0 (UND SPF);
 *   - seção 16: máximo teórico = 100 pontos, provado;
 *   - seção 17: total = soma das 4 categorias, ranking por total DESC;
 *   - seção 18/49: empate NUNCA resolvido em silêncio;
 *   - seção 19: atividade zero não vira 1º lugar;
 *   - seção 39: fixtures normal / 1 participante / 2 participantes /
 *     muitos / categoria toda zerada / retorno negativo / empate no 1º /
 *     empate no 2º / empate no total / sem SPF / sem financiamento /
 *     só Novos / só Seminovos / ativo nos dois.
 *
 * Nenhuma leitura de banco, nenhuma rede, nenhum dado real -- o núcleo é
 * uma função pura e os fixtures são sintéticos.
 */
const assert = require('assert');
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
console.log('\n[1] Contrato de pontuação (seções 12-16)');
// ---------------------------------------------------------------
{
  check('1.1 quatro categorias exatas', S.CATEGORIES.map(c => c.key).join(',') ===
    'returnNovos,returnSeminovos,financedUnits,spfUnits');
  check('1.2 Novos = 35/17', S.CATEGORIES[0].first === 35 && S.CATEGORIES[0].second === 17);
  check('1.3 Seminovos = 35/17', S.CATEGORIES[1].first === 35 && S.CATEGORIES[1].second === 17);
  check('1.4 UND Financiado = 15/8', S.CATEGORIES[2].first === 15 && S.CATEGORIES[2].second === 8);
  check('1.5 UND SPF = 15/8', S.CATEGORIES[3].first === 15 && S.CATEGORIES[3].second === 8);
  check('1.6 máximo teórico = 100', S.MAX_TOTAL_POINTS === 100);
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
  check('2.15 nenhum empate pendente', res.unresolved === false);
  check('2.16 soma nunca excede o máximo', res.rows.every(r => r.totalPoints <= S.MAX_TOTAL_POINTS));
}

// ---------------------------------------------------------------
console.log('\n[3] Máximo real de 100 pontos (seção 16)');
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
  // 2º lugar -- logo ambos pontuam nas 4 categorias e o piso da dupla é
  // alto por construção. Isso é consequência do contrato do Humano, não
  // um ajuste: com 2 participantes, 35+17 e 15+8 são sempre distribuídos.
  const dois = S.computePerformance([P('X', 1000, 10, 5, 2), P('Y', 10, 1000, 1, 1)]);
  check('4.3 X: 35 (Novos) + 17 (2º Semin.) + 15 + 15 = 82', pts(dois, 'X') === 82);
  check('4.4 Y: 17 + 35 + 8 + 8 = 68', pts(dois, 'Y') === 68);
  check('4.5 com 2 participantes o 2º ainda pontua', catPts(dois, 'returnNovos', 'Y') === 17);
  check('4.6 ranking geral respeita o total (X > Y)', dois.rows[0].id === 'X');
  check('4.7 com 2 participantes todos os 100 pontos são distribuídos', pts(dois, 'X') + pts(dois, 'Y') === 150);
}

// ---------------------------------------------------------------
console.log('\n[5] Muitos participantes: só 1º e 2º pontuam (seções 12-15)');
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
console.log('\n[6] Atividade zero não vira 1º lugar (seção 19)');
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
console.log('\n[7] Valores negativos (seção 20)');
// ---------------------------------------------------------------
{
  // Auditoria ao vivo (PERF-1): portal_finance_operations.return_value
  // tem min = 0.00 e zero linhas negativas hoje. O núcleo mesmo assim
  // trata negativo de forma explícita: não classifica (não é atividade
  // positiva) e nunca é "promovido" a zero para melhorar o ranking.
  const res = S.computePerformance([P('NEG', -5000, 100, 1, 1), P('POS', 100, 50, 2, 2)]);
  check('7.1 retorno negativo não é classificado', cat(res, 'returnNovos').ranking.every(r => r.id !== 'NEG'));
  check('7.2 retorno negativo não pontua', catPts(res, 'returnNovos', 'NEG') === 0);
  check('7.3 o positivo leva o 1º', catPts(res, 'returnNovos', 'POS') === 35);
  check('7.4 valor negativo preservado na tabela (não sanitizado)', res.rows.find(r => r.id === 'NEG').breakdown.returnNovos.value === -5000);
}

// ---------------------------------------------------------------
console.log('\n[8] Empates NUNCA resolvidos em silêncio (seções 18/49)');
// ---------------------------------------------------------------
{
  const t1 = S.computePerformance([P('A', 10000, 1, 1, 1), P('B', 10000, 2, 2, 2), P('C', 500, 3, 3, 3)]);
  check('8.1 empate no 1º: nenhum dos dois recebe os 35', catPts(t1, 'returnNovos', 'A') === 0 && catPts(t1, 'returnNovos', 'B') === 0);
  check('8.2 empate no 1º é reportado explicitamente', t1.ties.categories.some(t => t.category === 'returnNovos' && t.position === 1 && t.pointsAtStake === 35));
  check('8.3 empate no 1º cita os dois participantes', t1.ties.categories.find(t => t.category === 'returnNovos').participants.map(p => p.id).sort().join('') === 'AB');
  check('8.4 categoria marcada como não resolvida', cat(t1, 'returnNovos').unresolved === true);
  check('8.5 3º colocado real (posição 3, não 2) não recebe os 17', catPts(t1, 'returnNovos', 'C') === 0);
  check('8.6 posição competitiva: após 2 empatados no 1º, o próximo é 3º', cat(t1, 'returnNovos').ranking.find(r => r.id === 'C').position === 3);
  check('8.7 pontos retidos ficam visíveis para a UI', cat(t1, 'returnNovos').ranking.find(r => r.id === 'A').pointsWithheld === 35);

  const t2 = S.computePerformance([P('W', 90000, 1, 1, 1), P('A', 10000, 2, 2, 2), P('B', 10000, 3, 3, 3)]);
  check('8.8 empate no 2º: nenhum dos dois recebe os 17', catPts(t2, 'returnNovos', 'A') === 0 && catPts(t2, 'returnNovos', 'B') === 0);
  check('8.9 o 1º NÃO é afetado pelo empate no 2º', catPts(t2, 'returnNovos', 'W') === 35);
  check('8.10 empate no 2º reportado com os pontos em jogo', t2.ties.categories.some(t => t.position === 2 && t.pointsAtStake === 17));

  const t3 = S.computePerformance([P('A', 100, 100, 1, 1), P('B', 100, 100, 1, 1)]);
  check('8.11 empate total: ambos com 0 e nada premiado', pts(t3, 'A') === 0 && pts(t3, 'B') === 0);
  check('8.12 empate no total geral reportado', t3.ties.overall.some(t => t.position === 1));
  check('8.13 resultado global marcado como não resolvido', t3.unresolved === true);

  const t4 = S.computePerformance([P('A', 900, 10, 5, 9), P('B', 10, 900, 9, 5)]);
  check('8.14 totais iguais por caminhos diferentes empatam no geral', pts(t4, 'A') === pts(t4, 'B') && t4.ties.overall.length === 1);
  // A = 35 (Novos) + 17 (2º Semin.) + 8 (2º Fin.) + 15 (SPF) = 75
  // B = 17 (2º Novos) + 35 (Semin.) + 15 (Fin.) + 8 (2º SPF) = 75
  check('8.15 mas os pontos de categoria foram legitimamente atribuídos', pts(t4, 'A') === 75 && pts(t4, 'B') === 75);
  check('8.16 empate no total NÃO anula os pontos de categoria já ganhos', catPts(t4, 'returnNovos', 'A') === 35);

  // Empate a 3 no 2º lugar -- caso REAL observado na competência corrente
  // durante a auditoria PERF-1 (UND SPF: 1º com 7, três lojas com 2).
  const t5 = S.computePerformance([P('L1', 1, 1, 1, 7), P('L2', 1, 1, 1, 2), P('L3', 1, 1, 1, 2), P('L4', 1, 1, 1, 2)]);
  check('8.17 empate triplo no 2º não premia ninguém', [catPts(t5, 'spfUnits', 'L2'), catPts(t5, 'spfUnits', 'L3'), catPts(t5, 'spfUnits', 'L4')].every(v => v === 0));
  check('8.18 empate triplo listado com os 3 participantes', t5.ties.categories.find(t => t.category === 'spfUnits').participants.length === 3);
  check('8.19 o 1º isolado recebe os 15 normalmente', catPts(t5, 'spfUnits', 'L1') === 15);
}

// ---------------------------------------------------------------
console.log('\n[9] Política de empate é fail-closed');
// ---------------------------------------------------------------
{
  let threwShare = false, threwSkip = false, threwUnknown = false;
  try { S.computePerformance([P('A', 1, 1, 1, 1)], { tiePolicy: 'SHARE' }); } catch (e) { threwShare = true; }
  try { S.computePerformance([P('A', 1, 1, 1, 1)], { tiePolicy: 'SKIP' }); } catch (e) { threwSkip = true; }
  try { S.computePerformance([P('A', 1, 1, 1, 1)], { tiePolicy: 'ALFABETICA' }); } catch (e) { threwUnknown = true; }
  check('9.1 política SHARE recusada (decisão pendente)', threwShare);
  check('9.2 política SKIP recusada (decisão pendente)', threwSkip);
  check('9.3 política arbitrária recusada', threwUnknown);
  check('9.4 padrão é PENDING', S.computePerformance([P('A', 1, 1, 1, 1)]).tiePolicy === 'PENDING');
}

// ---------------------------------------------------------------
console.log('\n[10] Perfis de atividade parcial (seção 39)');
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
console.log('\n[11] Integridade de entrada e determinismo');
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
  check('11.5 resultado independe da ordem de entrada',
    JSON.stringify(r1.rows.map(r => [r.id, r.totalPoints])) === JSON.stringify(r2.rows.map(r => [r.id, r.totalPoints])));

  // Mutação: mudar uma métrica TEM de mudar a pontuação (prova de que
  // não há resultado hardcoded).
  const mut = S.computePerformance([P('A', 1, 5000, 9, 5), P('B', 20000, 12000, 7, 3), P('C', 10000, 20000, 5, 1)]);
  check('11.6 mutação da métrica muda a pontuação', pts(mut, 'A') !== pts(r1, 'A'));

  // Tolerância de meio centavo: 0.001 de diferença é o mesmo valor.
  const eps = S.computePerformance([P('A', 1000.000, 1, 1, 1), P('B', 1000.001, 1, 1, 1)]);
  check('11.7 diferença sub-centavo é tratada como empate, não como vitória', eps.ties.categories.some(t => t.category === 'returnNovos'));
  const noEps = S.computePerformance([P('A', 1000.00, 1, 1, 1), P('B', 1000.01, 1, 1, 1)]);
  check('11.8 diferença de 1 centavo é vitória real', catPts(noEps, 'returnNovos', 'B') === 35);
}

// ---------------------------------------------------------------
console.log('\n[12] Sem PII no resultado (seção 26)');
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
