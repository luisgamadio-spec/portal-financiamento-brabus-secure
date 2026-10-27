-- CÓPIA SEM DADOS PESSOAIS (repositório público): o CPF real foi trocado por <CPF_DO_NOVO_MASTER>.
-- Versão completa e backup das linhas: repositório privado brabus-banco-estrutura, supabase/cadastro/20261027_cpf_master/.
-- Libera o CPF do cadastro de teste "TESTE ANALISTA" para o novo cadastro Master (pedido do responsável pelo portal, 27/10/2026).
-- Só 3 linhas mudam; as 2 ausências antigas NÃO são alteradas (ativo=true nelas é o estado correto de uma
-- cobertura válida; desativar mudaria a comissão de analista da Giovanna e da Denise).
-- Backup das linhas: backup_antes.json. Desfazer: desfazer.sql.
begin;

do $$
begin
  -- travas: só segue se o banco estiver exatamente como no diagnóstico
  if not exists (select 1 from public.usuarios
                 where id = '49ba9f49-47b9-49c3-9c6b-a60b468b4c49' and nome = 'TESTE ANALISTA'
                   and cpf_normalizado = '<CPF_DO_NOVO_MASTER>' and ativo is true) then
    raise exception 'TRAVA: cadastro de teste não está no estado esperado';
  end if;
  if not exists (select 1 from public.portal_sellers
                 where id = '57e1639f-295a-4b30-911a-ab56a7cd906a' and cpf_normalizado = '<CPF_DO_NOVO_MASTER>' and active is true) then
    raise exception 'TRAVA: vendedor de teste não está no estado esperado';
  end if;
  if not exists (select 1 from public.analista_responsavel_loja
                 where id = '3b2a88e8-cdaf-4cdc-9dd3-94628a4a20bc' and status = 'ACTIVE' and valid_to is null
                   and analista_usuario_id = '49ba9f49-47b9-49c3-9c6b-a60b468b4c49') then
    raise exception 'TRAVA: vínculo de analista responsável da REVENDA não está no estado esperado';
  end if;
  if exists (select 1 from public.usuarios where cpf = 'TESTE-DESCARTADO-816' or cpf_normalizado = '00000000816') then
    raise exception 'TRAVA: a marca TESTE-DESCARTADO-816 já está em uso';
  end if;
end $$;

-- 1) encerra o vínculo "analista responsável da REVENDA" do cadastro de teste
update public.analista_responsavel_loja
   set status = 'SUPERSEDED', valid_to = current_date
 where id = '3b2a88e8-cdaf-4cdc-9dd3-94628a4a20bc';

-- 2) desativa o cadastro de teste e troca o CPF por uma marca que não é CPF (libera o CPF real)
update public.usuarios
   set ativo = false, cpf = 'TESTE-DESCARTADO-816', atualizado_em = now()
 where id = '49ba9f49-47b9-49c3-9c6b-a60b468b4c49';

-- 3) desativa o vendedor de teste importado, MANTENDO o CPF: uma nova importação de colaboradores só
--    atualiza nome/loja/perfil (on conflict) e não reativa; trocar o CPF faria a importação criar outro ativo
update public.portal_sellers
   set active = false, updated_at = now()
 where id = '57e1639f-295a-4b30-911a-ab56a7cd906a';

-- registro na auditoria
insert into public.auditoria (tipo, descricao, base_origem, vendedor, cpf, loja, resolvido)
values ('AJUSTE_CADASTRO',
        'Cadastro de teste TESTE ANALISTA desativado; CPF liberado para novo cadastro Master; vendedor de teste desativado; vínculo de analista responsável da REVENDA encerrado (pedido do responsável pelo portal em 27/10/2026)',
        'SQL manual aprovado pelo responsável', 'TESTE ANALISTA', '<CPF_DO_NOVO_MASTER>', 'REVENDA', true);

-- conferência (deve mostrar: CPF livre = 0 linhas; teste inativo; vendedor inativo; vínculo SUPERSEDED)
select 'cpf_livre' item, count(*)::text valor from public.usuarios where cpf_normalizado = '<CPF_DO_NOVO_MASTER>'
union all select 'teste_ativo', ativo::text from public.usuarios where id = '49ba9f49-47b9-49c3-9c6b-a60b468b4c49'
union all select 'vendedor_ativo', active::text from public.portal_sellers where id = '57e1639f-295a-4b30-911a-ab56a7cd906a'
union all select 'vinculo_revenda', status || ' ate ' || valid_to::text from public.analista_responsavel_loja where id = '3b2a88e8-cdaf-4cdc-9dd3-94628a4a20bc';

commit;
