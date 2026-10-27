-- CÓPIA SEM DADOS PESSOAIS (repositório público): o CPF real foi trocado por <CPF_DO_NOVO_MASTER>.
-- Versão completa e backup das linhas: repositório privado brabus-banco-estrutura, supabase/cadastro/20261027_cpf_master/.
-- Desfaz aplicar.sql (volta as 3 linhas ao estado do backup_antes.json).
-- Só funciona ANTES de criar o novo Master com este CPF: depois disso o CPF já estará em uso
-- (regra de CPF único) e a trava abaixo impede o desfazer.
begin;

do $$
begin
  if exists (select 1 from public.usuarios where cpf_normalizado = '<CPF_DO_NOVO_MASTER>') then
    raise exception 'TRAVA: o CPF já foi usado por outro cadastro (novo Master criado?) -- desfazer bloqueado';
  end if;
end $$;

update public.usuarios
   set ativo = true, cpf = '<CPF_DO_NOVO_MASTER>', atualizado_em = now()
 where id = '49ba9f49-47b9-49c3-9c6b-a60b468b4c49' and cpf = 'TESTE-DESCARTADO-816';

update public.portal_sellers
   set active = true, updated_at = now()
 where id = '57e1639f-295a-4b30-911a-ab56a7cd906a';

update public.analista_responsavel_loja
   set status = 'ACTIVE', valid_to = null
 where id = '3b2a88e8-cdaf-4cdc-9dd3-94628a4a20bc';

insert into public.auditoria (tipo, descricao, base_origem, vendedor, cpf, loja, resolvido)
values ('AJUSTE_CADASTRO', 'Desfeito o ajuste de 27/10/2026 do cadastro de teste TESTE ANALISTA (voltou ao estado anterior)',
        'SQL manual aprovado pelo responsável', 'TESTE ANALISTA', '<CPF_DO_NOVO_MASTER>', 'REVENDA', true);

commit;
