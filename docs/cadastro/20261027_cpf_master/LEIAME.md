# Ajuste de cadastro — liberar CPF de um cadastro de teste para um novo Master (27/10/2026)

Um cadastro de teste ("TESTE ANALISTA", perfil Analista, loja REVENDA) usava o CPF de uma pessoa que vai receber
perfil Master. A criação de convite (`master_convidar_usuario`) recusa qualquer CPF já existente em `usuarios`
(ativo ou não; há também regra de CPF único), então o novo cadastro era bloqueado com "Usuário já existe".

O que `aplicar.sql` faz (uma transação, com travas que conferem o estado antes de mudar):
1. encerra o vínculo de analista responsável da REVENDA desse cadastro de teste (status SUPERSEDED);
2. desativa o cadastro de teste e troca o CPF dele por uma marca que não é CPF, liberando o CPF real;
3. desativa o vendedor de teste importado, mantendo o CPF (a importação de colaboradores faz upsert por CPF e
   não reativa; trocar o CPF faria a próxima importação criar um vendedor novo e ativo);
4. registra na auditoria.

Não altera: as ausências de analista antigas (ativo=true nelas é o estado correto de cobertura válida),
o Supabase Auth, registros antigos de login/auditoria, telas.

`desfazer.sql` só funciona antes de o CPF ser usado pelo novo cadastro (trava de CPF em uso).
Esta pasta é a cópia SEM dados pessoais; a versão completa e o backup ficam no repositório privado.
