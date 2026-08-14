-- Incidente 13.2 — reenvio seguro de convite para contas Auth já
-- criadas e ainda não confirmadas.
--
-- Achado do Incidente 13.1 (Checkpoint 7): admin-invite-user recusa
-- deliberadamente reenviar quando usuarios.auth_user_id já existe,
-- pois inviteUserByEmail() falha com "already registered" — limitação
-- documentada do próprio Supabase (github.com/supabase/auth/issues/2180).
--
-- Solução: nova Edge Function admin-resend-user-invite usa
-- auth.admin.generateLink({type:'invite'}) em vez de
-- inviteUserByEmail() para o mesmo e-mail — testado empiricamente
-- (Incidente 13.2 Parte A, contra identidade sintética descartável,
-- nunca contra usuário real) e comprovado que: preserva auth.users.id,
-- não altera email_confirmed_at, gera novo invited_at/token, e o
-- clique no link resultante dispara SIGNED_IN (não PASSWORD_RECOVERY)
-- em primeiro-acesso.html — logo aciona corretamente
-- concluir_convite_usuario() ao concluir, igual ao convite original.
--
-- Esta migration só estende master_listar_convites() para expor os
-- campos de elegibilidade (usuario_auth_user_id/ativo/primeiro_acesso)
-- que o Painel Master usa para decidir qual botão mostrar por linha:
-- "Reenviar" (mecanismo antigo, sem Auth ainda) ou "Reenviar convite"
-- (mecanismo novo, Auth existente e não confirmada). Usuário já ativo
-- nunca recebe nenhum botão de reenvio.
--
-- Assinatura muda de "returns setof convites_usuario" para
-- "returns table(...)" — Postgres não permite CREATE OR REPLACE
-- trocar o tipo de retorno, por isso DROP + CREATE. Grants reemitidos
-- idênticos aos que a função já tinha.

drop function public.master_listar_convites();

create function public.master_listar_convites()
returns table (
  id uuid, usuario_id uuid, cpf text, nome text, perfil text, loja text,
  email text, nbs text, status text, convidado_por uuid, convidado_em timestamptz,
  atualizado_em timestamptz, tentativas_envio integer, aceito_em timestamptz, erro_mensagem text,
  usuario_auth_user_id uuid, usuario_ativo boolean, usuario_primeiro_acesso boolean
)
language sql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
  select c.id, c.usuario_id, c.cpf, c.nome, c.perfil, c.loja, c.email, c.nbs, c.status,
         c.convidado_por, c.convidado_em, c.atualizado_em, c.tentativas_envio, c.aceito_em, c.erro_mensagem,
         u.auth_user_id as usuario_auth_user_id, u.ativo as usuario_ativo, u.primeiro_acesso as usuario_primeiro_acesso
  from public.convites_usuario c
  left join public.usuarios u on u.id = c.usuario_id
  where public.is_master()
  order by c.convidado_em desc;
$function$;

grant execute on function public.master_listar_convites() to PUBLIC, postgres, anon, authenticated, service_role;
