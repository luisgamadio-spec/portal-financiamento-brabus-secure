-- DESFAZER a utilização da Brabus IA (26/10/2026): remove a tabela, as funções e a configuração novas.
-- ATENÇÃO: (a) apaga os registros de uso gravados depois do deploy da função; (b) o texto das 2 perguntas
-- removido da auditoria NÃO volta, de propósito (decisão do Luis: nunca guardar o texto) — o registro da
-- remoção em public.auditoria também fica. Se a função brabus-intelligence já estiver usando bi_acesso_liberado,
-- volte a função para a versão anterior ANTES de rodar este arquivo.
begin;
drop function if exists public.master_ia_usage_data(date, date);
drop function if exists public.bi_registrar_pergunta(text, text, text[], text, integer);
drop function if exists public.bi_acesso_liberado();
drop function if exists public._bi_tema_ferramenta(text);
drop function if exists public._bi_perfis_liberados();
drop function if exists public._bi_perfil_normalizado(text);
drop table if exists public.bi_uso_perguntas;
delete from public.configuracoes where chave = 'ia_perfis_liberados';
commit;
