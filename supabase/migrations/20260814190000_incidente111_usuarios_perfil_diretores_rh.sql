-- Incidente 11.1 — corrige usuarios_perfil_check, que estava fora de
-- sincronia com o restante do sistema (master_convidar_usuario(),
-- operational_current_scope(), portal_modulos_permitidos() já
-- validavam/esperavam DIRETOR NOVOS/DIRETOR SEMINOVOS/RH havia tempo,
-- mas a constraint nunca permitiu essas linhas existirem de fato).
--
-- Alteração puramente aditiva: nenhum valor existente (VENDEDOR,
-- GERENTE, ANALISTA, MASTER) foi removido. Nenhuma linha de
-- public.usuarios foi alterada por esta migration — confirmado antes
-- e depois (94 usuários, 91 ativos, 3 inativos, idêntico).
--
-- Validado com transação de teste (INSERT + ROLLBACK, zero linha
-- persistida) que perfil = 'DIRETOR NOVOS' passa a satisfazer a
-- constraint.

BEGIN;

ALTER TABLE public.usuarios DROP CONSTRAINT usuarios_perfil_check;

ALTER TABLE public.usuarios ADD CONSTRAINT usuarios_perfil_check
  CHECK (perfil = ANY (ARRAY[
    'VENDEDOR', 'GERENTE', 'ANALISTA', 'MASTER',
    'DIRETOR NOVOS', 'DIRETOR SEMINOVOS',
    'RECURSOS HUMANOS', 'RH'
  ]));

COMMIT;
