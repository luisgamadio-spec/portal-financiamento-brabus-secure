-- ===========================================================================
-- [RANKING] PERF-RETIRE-1 -- aposentadoria do Ranking de Performance de Analistas.
--
-- Decisao do Humano:
--   "Nao vamos fazer mais nada, eu te passei o prompt muito confuso, era pra
--    ser algo rapido e o negocio se estendeu muito. Pode eliminar isso do
--    nosso portal, sem mexer em mais nada."
--
-- Esta migracao e ADITIVA a historia: nenhuma migracao antiga foi apagada.
-- Ela remove apenas os objetos VIVOS criados exclusivamente para o Ranking.
--
-- Nenhum periodo foi fechado e nenhum snapshot oficial existiu:
--   performance_periodo = 0, performance_snapshot = 0,
--   performance_snapshot_resultado = 0, performance_snapshot_detalhe = 0.
-- Verificado ao vivo imediatamente antes desta remocao.
--
-- PROVA DE PROPRIEDADE (feita antes de qualquer escrita):
--   - nenhuma funcao fora do proprio Ranking referencia qualquer objeto
--     performance_* (busca em todas as funcoes do schema public);
--   - nenhuma view depende de qualquer objeto performance_*;
--   - nenhuma chave estrangeira APONTA PARA objetos performance_* a partir
--     de fora do Ranking -- as unicas FKs de entrada sao internas;
--   - as FKs de SAIDA apontam para usuarios, que nao e tocado;
--   - nenhum modulo do Portal, rota, navegacao, permissao ou feature flag
--     expunha o Ranking (12 modulos cadastrados, nenhum e o Ranking).
--
-- ---------------------------------------------------------------------------
-- DELIBERADAMENTE PRESERVADO -- autoridade de RH/[SALARIOS], nao do Ranking
-- ---------------------------------------------------------------------------
-- A tabela analista_responsavel_loja NAO e do Ranking: foi criada pela onda
-- RH-ANALYST-2 (20260909130000) e continua sendo autoridade administrativa de
-- RH. Ficam intactos, com dados e restricoes:
--   * public.analista_responsavel_loja                (27 linhas, nada apagado)
--   * public.analista_responsavel_loja_auditoria
--   * a coluna procedencia e seu CHECK -- introduzidos pelo Ranking, mas hoje
--     consumidos pela garantia de bootstrap do RH-ANALYST-3, que exige que
--     nada resolva como DIRECT_AUTHORITY antes da data autorizada;
--   * a restricao EXCLUDE de nao sobreposicao, que impoe no BANCO a regra de
--     responsabilidade unica por loja/periodo;
--   * resolve_analista_responsavel, resolve_analista_responsavel_procedencia,
--     master_definir_analista_responsavel, analista_responsabilidade_janelas
--     e analista_responsabilidade_cobertura;
--   * resolve_store_temporal e todas as funcoes operational_* de Salario.
--
-- Nenhuma linha de responsabilidade e apagada: as atribuicoes loja/analista
-- foram aprovadas pelo Humano como fatos do negocio, e o comportamento do
-- Salario nao pode mudar em nenhuma direcao.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. RPCs e funcoes exclusivas do Ranking
-- ---------------------------------------------------------------------------
drop function if exists public.master_performance_criar_periodo(date);
drop function if exists public.master_performance_fechar_periodo(uuid, text);
drop function if exists public.master_performance_reabrir_periodo(uuid, text);
drop function if exists public.performance_ranking_periodo(uuid);
drop function if exists public.performance_calcular_periodo(date, date, uuid);
drop function if exists public.performance_operacoes_fora_de_escopo(date, date);
drop function if exists public.performance_lojas_fora_de_escopo_versao(uuid);
drop function if exists public.performance_loja_fora_de_escopo_ranking(text);
drop function if exists public.performance_loja_por_venda_do_chassi(text, date);
drop function if exists public.performance_normalizar_loja(text);

-- Backfill historico de responsabilidade: criado pela PERF-5 apenas para
-- reconstruir a linha do tempo do Ranking. Nenhum consumidor -- nem funcao,
-- nem teste, nem tela. A tabela e os dados que ele escreveu permanecem.
drop function if exists public.master_backfill_analista_responsavel_historico(
  text, uuid, date, date, text, text);

-- ---------------------------------------------------------------------------
-- 2. Tabelas exclusivas do Ranking, em ordem de dependencia. Sem CASCADE.
-- ---------------------------------------------------------------------------
-- Filhas primeiro.
drop table if exists public.performance_snapshot_detalhe;
drop table if exists public.performance_snapshot_resultado;

-- performance_snapshot e performance_periodo referenciam uma a outra
-- (current_snapshot_id x periodo_id). Sao removidas no MESMO comando, que
-- resolve a dependencia mutua sem recorrer a CASCADE.
drop table if exists public.performance_snapshot, public.performance_periodo;

-- Agora as autoridades de regra, que as anteriores referenciavam.
drop table if exists public.performance_regra_versao;

-- Auditoria do Ranking: tabela exclusiva do Ranking (PERF-5C). Suas 40 linhas
-- registram o fechamento acidental da PERF-5D.1A e a reversao governada --
-- um incidente ja encerrado, sem fechamento oficial resultante. Nenhuma outra
-- estrutura de auditoria do Portal e tocada.
drop table if exists public.performance_auditoria;

-- Autoridades de classificacao de loja do Ranking (H7 e H10).
drop table if exists public.performance_loja_fora_de_escopo;
drop table if exists public.performance_loja_codigo_map;

-- ---------------------------------------------------------------------------
-- 3. Funcoes de gatilho, orfas depois que suas tabelas sairam
-- ---------------------------------------------------------------------------
drop function if exists public.performance_snapshot_imutavel();
drop function if exists public.performance_auditoria_append_only();
