-- Segurança das tabelas internas e do "Falar com um Analista" — 20/10/2026 (aprovado pelo Luis: itens 1, 3 e 4)
-- 1) Remove as 13 regras de RLS sem efeito (as 5 tabelas não têm permissão para anon/authenticated; se a permissão
--    voltasse por engano, a regra "qualquer logado lê tudo" passaria a valer). RLS continua LIGADA, sem regra = ninguém
--    além do dono (postgres, usado pelas funções do portal) e da service_role.
-- 3) operational_commission_periods deixa de devolver criado_por (CPF de quem criou o período).
-- 4) chamar_analista_fi: só perfis com acesso ao Simulador + 1 minuto entre chamadas do mesmo usuário.
begin;

drop policy if exists "analistas_select_authenticated" on public.analistas_fi;
drop policy if exists "ausencias_insert_master" on public.ausencias_analistas;
drop policy if exists "ausencias_select_authenticated" on public.ausencias_analistas;
drop policy if exists "ausencias_update_master" on public.ausencias_analistas;
drop policy if exists "config_insert_master" on public.configuracoes;
drop policy if exists "config_select_authenticated" on public.configuracoes;
drop policy if exists "config_update_master" on public.configuracoes;
drop policy if exists "mudancas_insert_master" on public.mudancas_loja_vendedores;
drop policy if exists "mudancas_select_authenticated" on public.mudancas_loja_vendedores;
drop policy if exists "mudancas_update_master" on public.mudancas_loja_vendedores;
drop policy if exists "periodos_insert_master" on public.periodos_comissao;
drop policy if exists "periodos_select_authenticated" on public.periodos_comissao;
drop policy if exists "periodos_update_master" on public.periodos_comissao;
revoke all on table public.configuracoes, public.periodos_comissao, public.ausencias_analistas, public.mudancas_loja_vendedores, public.analistas_fi from anon, authenticated;

CREATE OR REPLACE FUNCTION public.operational_commission_periods()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  select jsonb_build_object(
    'rows',
    coalesce(
      jsonb_agg(to_jsonb(p) - 'criado_por' order by p.data_inicio desc)
        filter (where p.id is not null),
      '[]'::jsonb
    )
  )
  from public.periodos_comissao p
  where auth.uid() is not null
    and p.ativo is true;
$function$;

create table public.chamar_analista_fi_controle (
  usuario_id uuid primary key references public.usuarios(id) on delete cascade,
  ultima_chamada timestamptz not null
);
comment on table public.chamar_analista_fi_controle is 'Última chamada atendida de "Falar com um Analista" por usuário (intervalo mínimo de 1 minuto). Só a função chamar_analista_fi grava.';
alter table public.chamar_analista_fi_controle enable row level security;
revoke all on table public.chamar_analista_fi_controle from anon, authenticated;

CREATE OR REPLACE FUNCTION public.chamar_analista_fi()
 RETURNS TABLE(analista_id uuid, nome text, whatsapp text, teams_link text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_analista public.analistas_fi%rowtype;
  v_usuario_id uuid;
  v_liberado boolean;
begin
  -- 20/10/2026: só quem pode abrir um Simulador chama analista (mesma regra do menu do portal:
  -- portal_modulos_permitidos, que já cobre Master e a matriz de permissões por perfil/departamento).
  if not (coalesce(public.portal_modulos_permitidos(), '[]'::jsonb) ?| array['simuladorCompleto', 'simuladorSeminovos']) then
    raise exception 'Seu perfil não tem acesso ao atendimento do Simulador.'
      using errcode = '42501', hint = 'PERFIL_SEM_SIMULADOR';
  end if;

  select u.id into v_usuario_id
  from public.usuarios u
  where u.auth_user_id = auth.uid() and u.ativo = true
  limit 1;

  select *
  into v_analista
  from public.analistas_fi
  where ativo = true
    and coalesce(online, false) = true
    and coalesce(ocupado, false) = false
    and status = 'ONLINE'
  order by ordem_fila asc, ultimo_atendimento asc nulls first
  limit 1;

  if not found then
    return;
  end if;

  -- 20/10/2026: intervalo mínimo de 1 minuto entre chamadas atendidas do mesmo usuário.
  -- Só conta quando um analista foi entregue (sem analista disponível, pode tentar de novo na hora).
  -- O INSERT ... ON CONFLICT trava a linha do usuário: dois cliques simultâneos não passam juntos.
  insert into public.chamar_analista_fi_controle as c (usuario_id, ultima_chamada)
  values (v_usuario_id, now())
  on conflict (usuario_id) do update set ultima_chamada = excluded.ultima_chamada
    where c.ultima_chamada <= now() - interval '1 minute'
  returning true into v_liberado;

  if v_liberado is null then
    raise exception 'Aguarde um instante para chamar de novo.'
      using errcode = 'P0001', hint = 'AGUARDE_CHAMAR_ANALISTA';
  end if;

  insert into public.atendimentos_fi (
    analista_id,
    nome_analista,
    canal,
    origem,
    status
  )
  values (
    v_analista.id,
    v_analista.nome,
    'WHATSAPP',
    'SIMULADOR_FI',
    'ABERTO'
  );

  insert into public.historico_atendimentos_fi (
    analista_id,
    cpf_analista,
    nome_analista,
    canal,
    origem,
    status_atendimento
  )
  values (
    v_analista.id,
    v_analista.cpf_normalizado,
    v_analista.nome,
    'WHATSAPP',
    'SIMULADOR_FI',
    'ABERTO'
  );

  update public.analistas_fi
  set
    ultimo_atendimento = now(),
    atendimentos_hoje = coalesce(atendimentos_hoje, 0) + 1,
    ordem_fila = (
      select coalesce(max(ordem_fila), 0) + 1
      from public.analistas_fi
    )
  where id = v_analista.id;

  return query
  select
    v_analista.id,
    v_analista.nome,
    v_analista.whatsapp,
    v_analista.teams_link;
end;
$function$;

commit;
