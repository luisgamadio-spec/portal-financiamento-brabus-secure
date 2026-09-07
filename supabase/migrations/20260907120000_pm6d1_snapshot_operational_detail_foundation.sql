-- PM-6D.1 -- RH/DP Historical Immutability, additive backend foundation.
--
-- CONTEXTO: PM-6B-H1 provou, por medicao real contra o banco de producao,
-- que Exportar RH/DP pode bloquear (fail-closed, corretamente) para uma
-- competencia real ja fechada, porque as abas 5/6/7 (detalhe de chassi e
-- auditoria SPF) sao reconstruidas AO VIVO a partir de
-- operational_salary_details/master_operational_spf_audit_period no
-- momento da exportacao, nunca congeladas no fechamento -- e essas RPCs
-- sempre usam o ultimo lote VALIDATED por source_type, mesmo para um
-- periodo historico (contrato ja documentado e aceito em
-- 20260901120000_incidente_salary_details_spf_batch_scope.sql). PM-6C
-- provou ainda, por leitura direta do corpo real de tres migrations
-- (20260819180000/20260822060000/20260823040000), que portal_sales/
-- portal_finance_operations NAO sao imutaveis ao nivel de linha mesmo
-- dentro de um batch ja VALIDATED (seller_user_id e corrigido in-place
-- por reconciliacao de identidade posterior) -- por isso referenciar
-- apenas o batch_id usado no fechamento nao bastaria sozinho.
--
-- Esta migration cria SOMENTE a fundacao aditiva: nenhuma linha de
-- fechamento existente e alterada, master_close_commission_period nao e
-- tocada (fica para PM-6D.2), e snapshot_operational_detail comeca e
-- permanece vazia ate essa proxima fase popula-la dentro da MESMA
-- transacao do fechamento.
--
-- FINANCIAL_RESULT_AUTHORITY continua sendo snapshot_comissoes, sem
-- excecao -- esta tabela nova e estritamente suplementar/auditoria,
-- nunca recalcula nem sobrescreve comissao/faixa/share/SPF liquido/
-- rentabilidade oficiais.
--
-- =========================================================================
-- ACHADO DE SEGURANCA DESTA WAVE (nao assumido, medido ao vivo antes de
-- escrever esta migration): o schema public tem um DEFAULT ACL de TABELA
-- que concede arwdDxtm (praticamente todos os privilegios, incluindo
-- SELECT/INSERT/UPDATE/DELETE) a anon E authenticated para QUALQUER
-- tabela nova criada em public, a menos que explicitamente revogado --
-- confirmado via pg_default_acl (obj_type='r') nesta mesma sessao,
-- mesmo padrao ja conhecido para funcoes (Incidente AGP-1 Bloco 3,
-- migration 20260824040000, que ja documentava o equivalente para
-- obj_type='f'). Sem o REVOKE explicito abaixo, esta tabela nasceria
-- diretamente legivel/escrevivel por QUALQUER usuario autenticado do
-- Portal, contornando toda a autoridade MASTER-only pretendida.
-- =========================================================================

-- =========================================================================
-- PARTE A -- nova tabela filha, mesmo padrao de fechamentos_comissao/
-- snapshot_comissoes (FK com ON DELETE CASCADE -- confirmado ao vivo
-- que snapshot_comissoes_fechamento_id_fkey ja usa esse mesmo
-- comportamento, nao assumido).
--
-- Uma linha por operacao (chassi ou SPF), nunca agregada -- as abas 5/6/7
-- do RH/DP sao listas linha-a-linha, um agregado nao permite reconstruir
-- o relatorio (PM-6C, Gate 18/22).
--
-- Campos deliberadamente OMITIDOS (data minimization, PM-6C Gate 19,
-- provado contra o corpo real de exportSnapshotExcel no V1, nunca
-- inferido):
--   - CPF: a coluna espelho em snapshot_comissoes.cpf existe mas nunca e
--     populada pelo fechamento oficial (confirmado, INSERT real de
--     master_close_commission_period nao inclui a coluna cpf) e o RH/DP
--     historico do V1 tambem nunca a usa em modo seguro (authByName() so
--     enxerga DATA.auth/DATA.master, populados exclusivamente pelo
--     carregador legado de XLSX, nunca em modo seguro -- achado PM-6B).
--   - cliente/nome de cliente: nunca aparece em nenhuma das 8 abas do
--     RH/DP (confirmado, releitura completa de exportSnapshotExcel).
--   - chassi completo: a RPC fonte (operational_salary_details) so
--     retorna chassis_masked (ultimos 6 digitos), nunca o valor cru --
--     esta tabela persiste exatamente o que a RPC entrega, nada mais.
--
-- seller_user_id E seller_name sao AMBOS persistidos deliberadamente
-- (nao apenas um): seller_user_id para provenance/join futuro,
-- seller_name CONGELADO como texto para que a exibicao historica nunca
-- mude caso o cadastro do usuario seja renomeado depois (principio:
-- "historical display must also be deterministic").
--
-- snapshot_order NAO foi adicionado: a ordenacao real usada pelo builder
-- V1/V2 (store+department+seller_name+sale_date+chassis_masked) ja e uma
-- chave composta deterministica derivavel das proprias colunas
-- persistidas -- adicionar uma coluna ordinal separada duplicaria
-- informacao sem necessidade provada (PM-6C Gate 20).
-- =========================================================================

create table public.snapshot_operational_detail (
  id uuid primary key default gen_random_uuid(),
  fechamento_id uuid not null references public.fechamentos_comissao(id) on delete cascade,
  kind text not null check (kind in ('CHASSIS', 'SPF')),

  -- Campos compartilhados pelos dois "kind".
  store text,
  department text,
  seller_user_id uuid,
  seller_name text,

  -- kind = 'CHASSIS' (abas 5/6, contrato PM-6C Gate 12, verbatim de
  -- exportSnapshotExcel's chassisDetailRowHistoricoAba5/Aba6).
  sale_date date,
  chassis_masked text,
  vehicle_model text,
  financed boolean,
  finance_date date,
  sale_value numeric,
  financed_value numeric,
  return_considered numeric,
  included_in_commission boolean,

  -- kind = 'SPF' (aba 7, contrato PM-6C Gate 13, verbatim do mapeamento
  -- spfAudit de exportSnapshotExcel).
  operation_date date,
  operation_code text,
  bank text,
  finance_code text,
  optional_name text,
  spf_bruto numeric,
  spf_liquido numeric,

  criado_em timestamptz not null default now()
);

comment on table public.snapshot_operational_detail is
  'PM-6D.1: detalhe operacional CONGELADO por fechamento (chassi financiado/nao-financiado + auditoria SPF), usado pelas abas 5/6/7 do Exportar RH/DP. Nunca alterar apos escrita -- imutavel, uma linha por operacao. NAO e FINANCIAL_RESULT_AUTHORITY (isso continua sendo snapshot_comissoes) -- puramente suplementar/auditoria. Populado apenas por fechamentos futuros (PM-6D.2); fechamentos existentes permanecem sem linhas aqui (ver fechamentos_comissao.historical_detail_status).';

create index snapshot_operational_detail_fechamento_id_idx
  on public.snapshot_operational_detail (fechamento_id);
-- Desvio deliberado do padrao irmao (snapshot_comissoes NAO tem indice em
-- fechamento_id hoje) -- este indice e uma melhoria aditiva, segura e de
-- baixo custo, justificada porque o unico padrao de leitura real desta
-- tabela e sempre "where fechamento_id = :id" (a nova RPC de leitura,
-- Parte D abaixo).

-- Guard de seguranca critico (ver achado no cabecalho desta migration):
-- reverte explicitamente o default ACL de tabela do schema public antes
-- de habilitar RLS, para que anon/authenticated NUNCA tenham acesso
-- direto -- somente via a RPC SECURITY DEFINER da Parte D.
revoke all on public.snapshot_operational_detail from public, anon, authenticated;

alter table public.snapshot_operational_detail enable row level security;

-- RLS como defesa em profundidade (mesmo padrao ja usado por
-- fechamentos_comissao/snapshot_comissoes: authenticated tem policy mas
-- ZERO grant direto na tabela -- a policy so importaria se um GRANT
-- futuro fosse acidentalmente adicionado). Deliberadamente SOMENTE
-- select/insert -- SEM policy de update/delete: esta tabela deve ser
-- estritamente append-only/imutavel uma vez escrita (mais restritivo que
-- snapshot_comissoes, que tem uma policy de update legada -- decisao
-- consciente desta wave, nao uma copia cega).
create policy sod_select_master on public.snapshot_operational_detail
  for select to authenticated using (public.is_master());
create policy sod_insert_master on public.snapshot_operational_detail
  for insert to authenticated with check (public.is_master());

-- =========================================================================
-- PARTE B -- provenance aditiva em fechamentos_comissao. Todas NULLABLE,
-- ZERO backfill (nenhum UPDATE nesta migration) -- fechamentos existentes
-- permanecem NULL em todas elas, interpretados como LEGACY_PARTIAL pela
-- nova RPC de leitura (Parte D), nunca reconstruidos/inventados.
--
-- *_batch_id SEM foreign key para public.portal_import_batches: avaliado
-- e rejeitado deliberadamente (PM-6C Gate 22/23) -- referenciar apenas o
-- batch nao bastaria sozinho (linhas dentro do mesmo batch podem ter
-- seller_user_id corrigido depois, achado real desta wave), entao o
-- valor e mantido como metadado de diagnostico/auditoria, nunca como
-- mecanismo de reconstrucao; uma FK aqui adicionaria risco de a migration
-- falhar ou de deletes futuros em portal_import_batches ficarem
-- bloqueados/restringidos sem necessidade provada.
-- =========================================================================

alter table public.fechamentos_comissao
  add column if not exists sales_batch_id uuid,
  add column if not exists finance_batch_id uuid,
  add column if not exists spf_batch_id uuid,
  add column if not exists snapshot_payload_hash text,
  add column if not exists commission_engine_version text,
  add column if not exists historical_detail_status text
    check (historical_detail_status is null or historical_detail_status = 'COMPLETE');

comment on column public.fechamentos_comissao.sales_batch_id is 'PM-6D.1: metadado de diagnostico -- qual portal_import_batches (SALES_CURRENT/HISTORY) estava VALIDATED no momento do fechamento. NAO usar como unica fonte de reconstrucao (linhas de um batch podem ser corrigidas in-place depois, achado PM-6C). NULL para fechamentos anteriores a esta migration.';
comment on column public.fechamentos_comissao.finance_batch_id is 'PM-6D.1: idem, para FINANCE_CURRENT/HISTORY.';
comment on column public.fechamentos_comissao.spf_batch_id is 'PM-6D.1: idem, para SPF_CURRENT.';
comment on column public.fechamentos_comissao.snapshot_payload_hash is 'PM-6D.1: hash de integridade (SHA-256 hex esperado) de p_rows -- detecta corrupcao/adulteracao das abas 1-4/8, NAO permite reconstrucao. NULL para fechamentos anteriores a esta migration; PM-6D.2 define o calculo real.';
comment on column public.fechamentos_comissao.commission_engine_version is 'PM-6D.1: identificador curto da versao da formula de comissao usada neste fechamento (ex.: hash curto de commit). NULL para fechamentos anteriores a esta migration.';
comment on column public.fechamentos_comissao.historical_detail_status is 'PM-6D.1: NULL = fechamento legado, sem detalhe operacional (abas 5/6/7) congelado -- interpretado como LEGACY_PARTIAL. ''COMPLETE'' = snapshot_operational_detail foi populado nesta MESMA transacao de fechamento (PM-6D.2) -- inclusive quando zero linhas de operacao existirem legitimamente (NUNCA inferir completude por count(linhas) > 0, PM-6C Gate 28/56).';

-- =========================================================================
-- PARTE C -- validacao pos-DDL: nenhum fechamento existente foi alterado
-- em nenhuma coluna pre-existente (somente colunas NOVAS, todas NULL);
-- checagem executada manualmente apos aplicacao (nao gravada aqui).
-- =========================================================================

-- =========================================================================
-- PARTE D -- nova RPC read-only, MASTER-only, mesma disciplina de
-- seguranca ja usada por toda a familia master_commission_*
-- (SECURITY DEFINER + search_path pinado + is_master() gate real,
-- confirmado ao vivo antes desta migration). NUNCA chama
-- operational_salary_details nem master_operational_spf_audit_period --
-- le exclusivamente o snapshot congelado (PM-6D.1 Gate 36).
-- =========================================================================

create or replace function public.master_commission_operational_detail(p_closing_id uuid)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_status text;
begin
  if not public.is_master() then
    raise exception 'Acesso exclusivo do perfil Master.'
      using errcode = '42501';
  end if;

  select f.historical_detail_status into v_status
  from public.fechamentos_comissao f
  where f.id = p_closing_id;

  if not found then
    raise exception 'Fechamento não encontrado.'
      using errcode = 'P0002';
  end if;

  -- completeness vem SEMPRE da coluna explicita do fechamento, nunca de
  -- count(linhas) > 0 -- uma competencia legitima com zero operacoes
  -- ainda pode ser COMPLETE (PM-6C Gate 28, testado no harness PM-6D.1
  -- como zero-op COMPLETE).
  return jsonb_build_object(
    'completeness', coalesce(v_status, 'LEGACY_PARTIAL'),
    'rows', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'kind', d.kind,
          'store', d.store,
          'department', d.department,
          'seller_user_id', d.seller_user_id,
          'seller_name', d.seller_name,
          'sale_date', d.sale_date,
          'chassis_masked', d.chassis_masked,
          'vehicle_model', d.vehicle_model,
          'financed', d.financed,
          'finance_date', d.finance_date,
          'sale_value', d.sale_value,
          'financed_value', d.financed_value,
          'return_considered', d.return_considered,
          'included_in_commission', d.included_in_commission,
          'operation_date', d.operation_date,
          'operation_code', d.operation_code,
          'bank', d.bank,
          'finance_code', d.finance_code,
          'optional_name', d.optional_name,
          'spf_bruto', d.spf_bruto,
          'spf_liquido', d.spf_liquido
        )
        order by d.kind, d.store, d.department, d.seller_name, d.sale_date, d.operation_date, d.chassis_masked
      )
      from public.snapshot_operational_detail d
      where d.fechamento_id = p_closing_id
    ), '[]'::jsonb)
  );
end;
$function$;

revoke all on function public.master_commission_operational_detail(uuid) from public, anon;
grant execute on function public.master_commission_operational_detail(uuid) to authenticated, service_role;
