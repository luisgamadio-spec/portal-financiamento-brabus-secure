-- Incidente P2: Fail-Closed no export/impressao oficial de RH/DP quando
-- o snapshot historico da competencia esta inconsistente.
--
-- Contexto (achado na AGP-1, investigado a fundo em incidente proprio):
-- os fechamentos oficiais de 21/05-20/06 e 21/06-20/07 tem 100% das
-- linhas de snapshot_comissoes com comissao=0 e detalhes=NULL -- bug ja
-- corrigido (ver migration 20260821200000_incidente_fechamento10...),
-- mas os dois snapshots historicos continuam gravados assim. Antes
-- desta migration, o Portal permitia exportar/imprimir esses dois
-- fechamentos como se fossem relatorios oficiais validos, sem nenhum
-- aviso -- um RH/DP aparentemente correto, mas com todo mundo a
-- R$0,00, podia sair do sistema sem sinal de alerta.
--
-- Esta migration NAO corrige os snapshots historicos (decisao separada,
-- fora de escopo) -- so impede que a exportacao/impressao oficial
-- prossiga quando a fonte esta estruturalmente inconsistente.
--
-- Nova RPC: master_commission_snapshot_export(p_closing_id). Reusa
-- exatamente a mesma query e o mesmo gate MASTER de
-- master_commission_snapshot (que permanece intocada e continua
-- alimentando "Ver snapshot"/comparacao -- ferramentas de conferencia
-- que nao devem ser bloqueadas). A nova funcao adiciona uma checagem
-- ANTES de devolver as linhas: bloqueia (raise exception, nunca em
-- silencio) somente quando TODAS as linhas do snapshot tem
-- comissao=0 E detalhes IS NULL simultaneamente, ou quando o snapshot
-- nao tem nenhuma linha. Zeros parciais legitimos (ex.: 21/07-20/08
-- tem 10 de 97 linhas zeradas, de vendedores sem producao no periodo)
-- nunca disparam o bloqueio, testado com o dado real.
--
-- O bloqueio e server-side de verdade: acontece dentro da RPC, antes
-- de qualquer linha ser devolvida -- chamar a RPC diretamente (sem
-- passar pelo frontend) tem exatamente o mesmo resultado. A mensagem
-- de erro e amigavel, sem nome de tabela/coluna/SQLSTATE tecnico.
--
-- Frontend: 6 pontos de entrada que geram arquivo oficial (Excel/PDF)
-- passam a usar getSnapshotFechamentoParaExportacao() (nova, so para
-- estes casos) em vez de getSnapshotFechamento() (mantida, ainda usada
-- por "Ver snapshot" e comparacao de competencias, nunca bloqueadas).
--
-- Testado em transacao com ROLLBACK: 21/05 e 21/06 bloqueados com a
-- mensagem amigavel; 21/07 permitido (97 linhas, identico a antes);
-- fechamento inexistente rejeitado; perfil nao-MASTER negado
-- (autorizacao preservada, sem alteracao de contrato). Nenhum dado
-- alterado. Candidato apenas -- nao promovido ao banco live nesta fase.

CREATE OR REPLACE FUNCTION public.master_commission_snapshot_export(p_closing_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_total integer;
  v_zero integer;
  v_detalhes_null integer;
begin
  if not public.is_master() then
    raise exception 'Acesso exclusivo do perfil Master.'
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.fechamentos_comissao f where f.id = p_closing_id
  ) then
    raise exception 'Fechamento não encontrado.'
      using errcode = 'P0002';
  end if;

  select
    count(*),
    count(*) filter (where coalesce(s.comissao, 0) = 0),
    count(*) filter (where s.detalhes is null)
  into v_total, v_zero, v_detalhes_null
  from public.snapshot_comissoes s
  where s.fechamento_id = p_closing_id;

  if v_total = 0 or (v_zero = v_total and v_detalhes_null = v_total) then
    raise exception 'Exportação bloqueada: o fechamento desta competência possui um snapshot histórico inconsistente. Procure a Administração/RH F&I.'
      using errcode = '22023';
  end if;

  return jsonb_build_object(
    'rows',
    coalesce((
      select jsonb_agg(to_jsonb(s) order by s.loja, s.perfil, s.nome)
      from public.snapshot_comissoes s
      where s.fechamento_id = p_closing_id
    ), '[]'::jsonb)
  );
end;
$function$;

-- Incidente AGP-1 Bloco 3 (default privileges): funcoes novas em public
-- herdam EXECUTE automatico para anon+authenticated (confirmado via
-- pg_default_acl). O gate is_master() ja torna isso nao explorável
-- (auth.uid() nulo para anon nega corretamente), mas o contrato real de
-- master_commission_snapshot (a funcao gemea que esta substitui para o
-- caminho de exportacao) e postgres+authenticated+service_role, sem
-- anon -- alinhando explicitamente aqui em vez de herdar o default.
REVOKE ALL ON FUNCTION public.master_commission_snapshot_export(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.master_commission_snapshot_export(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.master_commission_snapshot_export(uuid) TO authenticated, service_role;
