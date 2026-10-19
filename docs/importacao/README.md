# Importação de bases confiável (wave de 19/10/2026)

Problema: a Gestão de Bases falhava com "canceling statement due to statement timeout". Cada chamada do navegador
(papel `authenticated`) tem 8 s no banco; as partes de 500 linhas das Bases 01 e 02 chegavam a 8–29 s.

## Fase 0 — diagnóstico (só leitura, rollback)
- Busca do vendedor pelo Login NBS normalizado na hora, por linha, sobre todos os usuários ativos: ~3,9 s por parte da Base 02.
- Herança do vendedor (`previous_resolution`) lendo TODO o histórico validado a cada parte: 0,7 s (cache quente) a 4,3 s (frio).
- Base 03: uma chamada única com o arquivo inteiro (3,8 s hoje; 9,7 s com +50%) — tratada na Fase 2.

## Fase 1 — aplicada em 19/10/2026
- `usuarios.login_nbs_normalizado` = `portal_normaliza_nbs(login_nbs)` (coluna gerada, STORED) + índice parcial (ativos).
  **Se `portal_normaliza_nbs` mudar, a coluna precisa ser recalculada** (ela é IMMUTABLE; o banco não recalcula sozinho).
- `master_operational_import_finance`, `master_operational_import_sales` e `portal_fechar_alertas_cadastro_resolvidos` usam a coluna.
- Herança do vendedor limitada aos chassis da própria parte (+ índice `(chassis, service_description)` na Base 02).
- Migração: `supabase/migrations/20261019140000_importacao_fase1_login_nbs_heranca.sql`; desfazer: `docs/rollback/importacao_fase1_rollback.sql`.

Prova (rollback, arquivos reais do dia, envios montados pelo código da tela): linhas gravadas e pendências cadastrais com
md5 idêntico ao código anterior; pior parte Base 01 8,8 s → 0,4–1,2 s; Base 02 7,7–29 s → 0,5–0,8 s; com +50%: < 0,5 s.

## Fase 2 (Base 03) — função aplicada em 19/10/2026
- `master_operational_base03_consolidar(p_spf_batch_id, p_finance_rows)`: o SPF vai em partes (`begin_import` + `import_spf`,
  lote em validação, invisível); a consolidação faz numa transação só o enriquecimento (trecho copiado da `apply_base03`),
  as travas (principais > 0, enriquecidas > 0 e ≥ 50% da última normal — agora também no servidor) e a confirmação.
- A `apply_base03` não mudou (a tela atual da produção usa). Migração `20261019160000_importacao_fase2_base03_consolidar.sql`;
  desfazer: `docs/rollback/importacao_fase2_base03_rollback.sql`.
- Prova (rollback): SPF, enriquecimento e mensagem do lote com md5 idêntico ao fluxo antigo; consolidação 2,6 s hoje e
  3,8 s com +50% (antes, a chamada única: 7,6 s hoje e até 9,7 s com +50%); partes ≤ 0,23 s; travas bloqueiam sem mudar nada.

## Testes (`testes/`)
Rodam contra o banco ligado, sempre em transação com ROLLBACK (exceto `gera_fase1.py`, que só lê e gera SQL).
Precisam dos auxiliares `sq.py`/`rpc.py`/`harness.py` do ambiente local e dos envios em `payloads/` (gerados por
`gera_payloads.py` a partir dos arquivos do dia). Os envios têm dados reais e NUNCA entram no repositório.
- `mede_importacao.py [fator] <01|02|03p|03g>` — tempo de cada chamada.
- `mede_causas.py`, `mede_explain.py` — peso de cada causa / EXPLAIN ANALYZE.
- `prova_fase1.py <atual|fase1> <fator> <01|02>` — tempo + impressão digital (md5) das linhas e das pendências.
