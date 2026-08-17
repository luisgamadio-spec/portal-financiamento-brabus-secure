-- Fase 16.5 — adiciona ao dataset do Painel Master a última tentativa de
-- migração legado -> BLISTIQ de cada usuário (tabela ativacoes_acesso_usuario,
-- Fase 4.2), permitindo ao frontend classificar corretamente a dimensão
-- ACESSO BLISTIQ (Não iniciado / Em andamento / Concluído) sem depender de
-- ativo/primeiro_acesso, que a Fase 16.3 provou não serem confiáveis para
-- contas legadas. Extensão puramente aditiva — nenhum campo removido.
create or replace function public.master_admin_security_data()
returns jsonb
language plpgsql
stable security definer
set search_path to 'pg_catalog', 'public'
as $function$
begin
  if not public.is_master() then
    raise exception 'Acesso exclusivo do perfil Master.'
      using errcode = '42501';
  end if;

  return jsonb_build_object(
    'users', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', u.id,
          'cpf', u.cpf,
          'cpf_normalizado', u.cpf_normalizado,
          'nome', u.nome,
          'perfil', u.perfil,
          'loja', u.loja,
          'status', u.status,
          'ativo', u.ativo,
          'primeiro_acesso', u.primeiro_acesso,
          'ultimo_login', u.ultimo_login,
          'email_auth', u.email_auth,
          'tem_auth', (u.auth_user_id is not null),
          'email_divergente', (
            u.auth_user_id is not null
            and exists (
              select 1 from auth.users au
              where au.id = u.auth_user_id
                and lower(au.email) is distinct from lower(u.email_auth)
            )
          ),
          'ativacao_legado', (
            select jsonb_build_object(
              'status', a.status,
              'email_novo', a.email_novo,
              'criado_em', a.criado_em,
              'ultimo_envio_em', a.ultimo_envio_em,
              'expira_em', a.expira_em,
              'verificado_em', a.verificado_em,
              'concluido_em', a.concluido_em
            )
            from public.ativacoes_acesso_usuario a
            where a.usuario_id = u.id
            order by a.criado_em desc
            limit 1
          )
        )
        order by u.nome
      )
      from public.usuarios u
    ), '[]'::jsonb),
    'configurations', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'chave', c.chave,
          'valor', c.valor,
          'descricao', c.descricao,
          'atualizado_em', c.atualizado_em
        )
        order by c.chave
      )
      from public.configuracoes c
      where c.chave = any (array[
        'share_minimo',
        'spf_liquido_percentual',
        'bonus_spf_analista',
        'limite_retorno_novos',
        'limite_retorno_seminovos',
        'vendedor_faixa_baixo_share_baixo',
        'vendedor_faixa_baixo_share_alto',
        'vendedor_faixa_alto_share_baixo',
        'vendedor_faixa_alto_share_alto',
        'gerente_faixa_share_baixo',
        'gerente_faixa_share_alto',
        'analista_faixa_share_baixo',
        'analista_faixa_share_alto'
      ])
    ), '[]'::jsonb),
    'audit', coalesce((
      select jsonb_agg(to_jsonb(a) order by a.criado_em desc)
      from (
        select id, tipo, descricao, base_origem, loja, vendedor, cpf,
               resolvido, resolvido_por, resolvido_em, criado_em
        from public.auditoria
        order by criado_em desc
        limit 100
      ) a
    ), '[]'::jsonb)
  );
end;
$function$;
