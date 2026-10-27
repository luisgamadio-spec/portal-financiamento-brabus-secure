-- PREPARADO, NÃO APLICADO. Usar só se for confirmado que as 2 coberturas da Anália Franco (22/07–02/08 e 03/08–23/08,
-- analista ausente = cadastro de teste) foram registradas como teste.
-- Mesmo efeito do "Arquivar ausência" do Painel Master (master_admin_manage, ARCHIVE): ativo = false + auditoria.
-- Efeito nos cálculos AO VIVO do período 21/07–20/08: a linha de cobertura da Anália Franco 22/07–02/08 sai da
-- substituta e os resultados voltam para a analista oficial da loja. Os fechamentos JÁ GRAVADOS (snapshots) NÃO mudam;
-- acerto de pagamento, se houver, é decisão à parte (RH/DP).
-- Desfazer: desfazer_ausencias.sql.
begin;

do $$
begin
  if (select count(*) from public.ausencias_analistas
      where id in ('64c524c9-ab0b-4034-8c60-4dd9ee5dda7b', '262eac0c-b4e1-4ab3-a1aa-a9c8c5955aa4')
        and ativo is true and upper(loja_coberta) = 'ANALIA FRANCO') <> 2 then
    raise exception 'TRAVA: as 2 ausências não estão no estado esperado (ativas, cobrindo ANALIA FRANCO)';
  end if;
end $$;

update public.ausencias_analistas
   set ativo = false
 where id in ('64c524c9-ab0b-4034-8c60-4dd9ee5dda7b', '262eac0c-b4e1-4ab3-a1aa-a9c8c5955aa4');

insert into public.auditoria (tipo, descricao, base_origem, loja, vendedor, cpf, resolvido)
values ('MASTER_ABSENCE', 'ARCHIVE ABSENCE (2 coberturas de teste da Anália Franco, 22/07–23/08/2026)',
        'SQL manual aprovado pelo responsável', 'ANALIA FRANCO', 'Ajuste manual', '', false);

select id::text, ativo from public.ausencias_analistas
 where id in ('64c524c9-ab0b-4034-8c60-4dd9ee5dda7b', '262eac0c-b4e1-4ab3-a1aa-a9c8c5955aa4');

commit;
