-- DESFAZER a mudança de segurança de 20/10/2026 (volta exatamente ao estado capturado em backup_antes.json)
begin;

create policy "analistas_select_authenticated" on public.analistas_fi as permissive for select to authenticated using ((ativo = true));
create policy "ausencias_insert_master" on public.ausencias_analistas as permissive for insert to authenticated with check (is_master());
create policy "ausencias_select_authenticated" on public.ausencias_analistas as permissive for select to authenticated using (true);
create policy "ausencias_update_master" on public.ausencias_analistas as permissive for update to authenticated using (is_master()) with check (is_master());
create policy "config_insert_master" on public.configuracoes as permissive for insert to authenticated with check (is_master());
create policy "config_select_authenticated" on public.configuracoes as permissive for select to authenticated using (true);
create policy "config_update_master" on public.configuracoes as permissive for update to authenticated using (is_master()) with check (is_master());
create policy "mudancas_insert_master" on public.mudancas_loja_vendedores as permissive for insert to authenticated with check (is_master());
create policy "mudancas_select_authenticated" on public.mudancas_loja_vendedores as permissive for select to authenticated using (true);
create policy "mudancas_update_master" on public.mudancas_loja_vendedores as permissive for update to authenticated using (is_master()) with check (is_master());
create policy "periodos_insert_master" on public.periodos_comissao as permissive for insert to authenticated with check (is_master());
create policy "periodos_select_authenticated" on public.periodos_comissao as permissive for select to authenticated using (true);
create policy "periodos_update_master" on public.periodos_comissao as permissive for update to authenticated using (is_master()) with check (is_master());

CREATE OR REPLACE FUNCTION public.operational_commission_periods()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  select jsonb_build_object(
    'rows',
    coalesce(
      jsonb_agg(to_jsonb(p) order by p.data_inicio desc)
        filter (where p.id is not null),
      '[]'::jsonb
    )
  )
  from public.periodos_comissao p
  where auth.uid() is not null
    and p.ativo is true;
$function$;

CREATE OR REPLACE FUNCTION public.chamar_analista_fi()
 RETURNS TABLE(analista_id uuid, nome text, whatsapp text, teams_link text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_analista public.analistas_fi%rowtype;
begin
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

drop table if exists public.chamar_analista_fi_controle;

commit;
