-- Desfaz desativar_ausencias.sql: as 2 coberturas voltam a valer (ativo = true), como no backup_antes.json.
begin;

do $$
begin
  if (select count(*) from public.ausencias_analistas
      where id in ('64c524c9-ab0b-4034-8c60-4dd9ee5dda7b', '262eac0c-b4e1-4ab3-a1aa-a9c8c5955aa4')
        and ativo is false) <> 2 then
    raise exception 'TRAVA: as 2 ausências não estão desativadas -- nada a desfazer';
  end if;
  -- reativar não pode criar sobreposição com outra ausência ativa da mesma loja (o cálculo recusaria o período)
  if exists (select 1 from public.ausencias_analistas b
             where b.ativo and upper(b.loja_coberta) = 'ANALIA FRANCO'
               and b.id not in ('64c524c9-ab0b-4034-8c60-4dd9ee5dda7b', '262eac0c-b4e1-4ab3-a1aa-a9c8c5955aa4')
               and daterange(b.data_inicio, b.data_fim, '[]') && daterange('2026-07-22', '2026-08-23', '[]')) then
    raise exception 'TRAVA: já existe outra ausência ativa cobrindo a Anália Franco entre 22/07 e 23/08';
  end if;
end $$;

update public.ausencias_analistas
   set ativo = true
 where id in ('64c524c9-ab0b-4034-8c60-4dd9ee5dda7b', '262eac0c-b4e1-4ab3-a1aa-a9c8c5955aa4');

insert into public.auditoria (tipo, descricao, base_origem, loja, vendedor, cpf, resolvido)
values ('MASTER_ABSENCE', 'SET_ACTIVE ABSENCE (desfeito o arquivamento das 2 coberturas da Anália Franco, 22/07–23/08/2026)',
        'SQL manual aprovado pelo responsável', 'ANALIA FRANCO', 'Ajuste manual', '', false);

commit;
