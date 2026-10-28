-- Desfaz a Fase 2 das Avaliações: remove as funções, as tabelas e o bucket da vistoria.
-- ATENÇÃO: apaga avarias, checklist, registros de fotos e a tabela de reparos (exportar antes, se houver uso real).
-- Trava: o bucket precisa estar vazio (o Supabase não deixa apagar arquivos por SQL; esvaziar pelo painel do Storage).
-- Não mexe em nada da Fase 1.
begin;

do $t$ begin
  if exists (select 1 from storage.objects where bucket_id = 'avaliacoes-fotos') then
    raise exception 'TRAVA: o bucket avaliacoes-fotos tem arquivos -- esvaziar pelo painel do Storage antes de desfazer';
  end if;
end $t$;

drop function if exists public._aval_peca_info(text),
  public._aval_tipos_avaria(text),
  public._aval_checklist_opcoes(),
  public._aval_tabela_vigente(),
  public._aval_pode_editar(public.aval_avaliacoes, jsonb),
  public._aval_vistoria_json(public.aval_avaliacoes, jsonb),
  public.aval_vistoria_obter(uuid),
  public.aval_vistoria_salvar(uuid, jsonb),
  public.aval_vistoria_concluir(uuid),
  public.aval_foto_preparar(uuid, uuid, uuid, integer),
  public.aval_foto_registrar(uuid, integer),
  public.aval_fotos_listar(uuid),
  public.aval_foto_remover(uuid),
  public.aval_reparos_listar(),
  public.aval_master_salvar_reparos(jsonb, text);
drop table if exists public.aval_fotos, public.aval_avarias, public.aval_vistorias, public.aval_tabela_reparos;
delete from storage.buckets where id = 'avaliacoes-fotos';
delete from public.aval_eventos where tipo in ('VISTORIA_INICIADA', 'VISTORIA_REABERTA', 'VISTORIA_CONCLUIDA');

commit;
