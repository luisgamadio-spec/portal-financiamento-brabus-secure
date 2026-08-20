-- Fase 21.8D — Integridade temporal das mudancas de alocacao (loja +
-- departamento). Fecha o gap encontrado na 21.8C: master_admin_manage
-- so validava contra data_fim_origem, nunca contra o periodo de
-- destino (aberto a partir de data_inicio_destino) de uma mudanca ja
-- ativa do mesmo vendedor.
--
-- Regra adotada (comprovada sem disrupcao contra os 7 registros reais
-- ativos hoje: todos os 7 ja tem data_inicio_destino = data_fim_origem
-- + 1 dia, exatamente):
--
-- 1) Toda mudanca precisa ter data_inicio_destino = data_fim_origem+1
--    (sem lacuna, sem sobreposicao dentro do proprio registro).
-- 2) Se o vendedor ja tem uma mudanca ativa, a nova SO e aceita se
--    encadear corretamente com a mais recente (por data_inicio_destino):
--    loja_origem da nova = loja_destino da existente; origem da nova
--    comeca no mesmo dia ou depois do destino da existente entrar em
--    vigor; destino da nova comeca estritamente depois do destino da
--    existente. Departamento so e cobrado quando ambos os lados tem
--    dado preenchido (Parte P — nao bloquear so por falta de dado).
--    A mudanca antiga NAO e desativada — ambas ficam ativo=true, e o
--    resolver (ja existente desde a 21.8B) escolhe corretamente pela
--    data_inicio_destino mais recente aplicavel.
--
-- Achado durante os testes desta fase, corrigido na mesma migration:
-- resolve_store_temporal/resolve_department_temporal (21.8B) tinham o
-- ramo de ORIGEM sem limite inferior (so checava
-- "p_data <= data_fim_origem", nunca "p_data >= data_inicio_origem").
-- Isso so se manifestava com 2+ mudancas ativas para o mesmo vendedor
-- (situacao que so passou a ser possivel de criar corretamente com
-- esta fase) — uma mudanca mais recente podia "vazar" seu loja_origem
-- para datas anteriores ao seu proprio inicio_origem, sombreando a
-- mudanca mais antiga. Corrigido adicionando o limite inferior.
-- Tambem adicionado desempate deterministico por id (Parte L).
--
-- Populacao real (7 registros, nenhum tem mudanca encadeada hoje) e
-- Jose Carlos/Erica confirmados byte-identicos antes/depois via teste
-- em transacao com ROLLBACK. Nenhum fato bruto, snapshot, usuario ou
-- Auth alterado.

create or replace function public.resolve_store_temporal(p_usuario_id uuid, p_data date, p_fallback text)
 returns text
 language sql
 stable
 set search_path to 'pg_catalog', 'public'
as $function$
  select coalesce(
    (
      select v.valor from (
        select 1 as prioridade, m.data_inicio_destino as marco, m.id as desempate, m.loja_destino as valor
        from public.mudancas_loja_vendedores m
        where m.usuario_id = p_usuario_id and m.ativo = true
          and p_data >= m.data_inicio_destino
        union all
        select 2 as prioridade, coalesce(m.data_fim_origem, m.data_inicio_destino) as marco, m.id as desempate, m.loja_origem as valor
        from public.mudancas_loja_vendedores m
        where m.usuario_id = p_usuario_id and m.ativo = true
          and p_data >= m.data_inicio_origem
          and (m.data_fim_origem is null or p_data <= m.data_fim_origem)
          and m.loja_origem is not null
      ) v
      order by v.prioridade, v.marco desc, v.desempate desc
      limit 1
    ),
    p_fallback
  );
$function$;

create or replace function public.resolve_department_temporal(p_usuario_id uuid, p_data date, p_fallback text)
 returns text
 language sql
 stable
 set search_path to 'pg_catalog', 'public'
as $function$
  select coalesce(
    (
      select v.valor from (
        select 1 as prioridade, m.data_inicio_destino as marco, m.id as desempate, m.departamento_destino as valor
        from public.mudancas_loja_vendedores m
        where m.usuario_id = p_usuario_id and m.ativo = true
          and p_data >= m.data_inicio_destino
          and m.departamento_destino is not null
        union all
        select 2 as prioridade, coalesce(m.data_fim_origem, m.data_inicio_destino) as marco, m.id as desempate, m.departamento_origem as valor
        from public.mudancas_loja_vendedores m
        where m.usuario_id = p_usuario_id and m.ativo = true
          and p_data >= m.data_inicio_origem
          and (m.data_fim_origem is null or p_data <= m.data_fim_origem)
          and m.departamento_origem is not null
      ) v
      order by v.prioridade, v.marco desc, v.desempate desc
      limit 1
    ),
    p_fallback
  );
$function$;

revoke execute on function public.resolve_store_temporal(uuid, date, text) from anon, authenticated;
revoke execute on function public.resolve_department_temporal(uuid, date, text) from anon, authenticated;

CREATE OR REPLACE FUNCTION public.master_admin_manage(p_entity text, p_action text, p_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_entity text := upper(trim(coalesce(p_entity, '')));
  v_action text := upper(trim(coalesce(p_action, '')));
  v_id uuid;
  v_actor public.usuarios;
  v_row jsonb;
  v_start date;
  v_end date;
  v_current boolean;
  v_active boolean;
  v_name text;
  v_store text;
  v_target text;
  v_usuario_id uuid;
  v_dest_start date;
  v_chain_loja text;
  v_chain_depto text;
  v_chain_data date;
begin
  select u.* into v_actor
  from public.usuarios u
  where u.auth_user_id = auth.uid()
    and u.ativo is true
    and upper(trim(coalesce(u.perfil, ''))) = 'MASTER'
  limit 1;

  if v_actor.id is null then
    raise exception 'Acesso exclusivo do perfil Master.'
      using errcode = '42501';
  end if;

  if v_action not in (
    'CREATE', 'SET_CURRENT', 'SET_ACTIVE', 'SET_STATUS', 'ARCHIVE', 'SET_DEPARTMENTS'
  ) then
    raise exception 'Ação administrativa inválida.'
      using errcode = '22023';
  end if;

  if v_action <> 'CREATE' then
    begin
      v_id := nullif(p_payload->>'id', '')::uuid;
    exception when others then
      raise exception 'Identificador inválido.' using errcode = '22023';
    end;
    if v_id is null then
      raise exception 'Identificador obrigatório.' using errcode = '22023';
    end if;
  end if;

  if v_entity = 'PERIOD' then
    if v_action = 'CREATE' then
      v_name := trim(coalesce(p_payload->>'name', ''));
      v_start := nullif(p_payload->>'start_date', '')::date;
      v_end := nullif(p_payload->>'end_date', '')::date;
      if v_name = '' or v_start is null or v_end is null then
        raise exception 'Nome e datas são obrigatórios.' using errcode = '22023';
      end if;
      if v_end < v_start then
        raise exception 'Data final não pode ser anterior à inicial.'
          using errcode = '22023';
      end if;
      insert into public.periodos_comissao (
        nome, data_inicio, data_fim, status, periodo_atual, ativo, criado_por
      ) values (
        v_name, v_start, v_end, 'ABERTO', false, true, v_actor.cpf
      )
      returning to_jsonb(periodos_comissao.*), id
      into v_row, v_id;

    elsif v_action = 'SET_CURRENT' then
      update public.periodos_comissao set periodo_atual = false where periodo_atual = true;
      update public.periodos_comissao
      set periodo_atual = true, ativo = true
      where id = v_id
      returning to_jsonb(periodos_comissao.*) into v_row;

    elsif v_action in ('SET_ACTIVE', 'ARCHIVE') then
      v_active := case
        when v_action = 'ARCHIVE' then false
        else coalesce((p_payload->>'active')::boolean, false)
      end;
      update public.periodos_comissao
      set ativo = v_active,
          periodo_atual = case when v_active then periodo_atual else false end
      where id = v_id
      returning to_jsonb(periodos_comissao.*) into v_row;

    elsif v_action = 'SET_STATUS' then
      v_target := upper(trim(coalesce(p_payload->>'status', '')));
      if v_target not in (
        'ABERTO', 'EM CONFERÊNCIA', 'EM CONFERENCIA', 'FECHADO'
      ) then
        raise exception 'Status de período inválido.' using errcode = '22023';
      end if;
      update public.periodos_comissao
      set status = case
        when v_target = 'EM CONFERENCIA' then 'EM CONFERÊNCIA'
        else v_target
      end
      where id = v_id
      returning to_jsonb(periodos_comissao.*) into v_row;
    end if;

  elsif v_entity = 'ABSENCE' then
    if v_action = 'CREATE' then
      v_start := nullif(p_payload->>'start_date', '')::date;
      v_end := nullif(p_payload->>'end_date', '')::date;
      if trim(coalesce(p_payload->>'absent_name', '')) = ''
         or trim(coalesce(p_payload->>'substitute_name', '')) = ''
         or v_start is null or v_end is null then
        raise exception 'Analista ausente, substituto e datas são obrigatórios.'
          using errcode = '22023';
      end if;
      if v_end < v_start then
        raise exception 'Data final não pode ser anterior à inicial.'
          using errcode = '22023';
      end if;

      insert into public.ausencias_analistas (
        cpf_analista_ausente, nome_analista_ausente, loja_origem,
        cpf_analista_substituto, nome_analista_substituto,
        loja_coberta, data_inicio, data_fim, motivo,
        ativo, criado_por
      ) values (
        nullif(regexp_replace(coalesce(p_payload->>'absent_cpf', ''), '\D', '', 'g'), ''),
        trim(p_payload->>'absent_name'),
        nullif(trim(coalesce(p_payload->>'origin_store', '')), ''),
        nullif(regexp_replace(coalesce(p_payload->>'substitute_cpf', ''), '\D', '', 'g'), ''),
        trim(p_payload->>'substitute_name'),
        nullif(trim(coalesce(p_payload->>'covered_store', '')), ''),
        v_start, v_end,
        nullif(trim(coalesce(p_payload->>'reason', '')), ''),
        true, v_actor.cpf
      )
      returning to_jsonb(ausencias_analistas.*), id
      into v_row, v_id;

    elsif v_action in ('SET_ACTIVE', 'ARCHIVE') then
      v_active := case
        when v_action = 'ARCHIVE' then false
        else coalesce((p_payload->>'active')::boolean, false)
      end;
      update public.ausencias_analistas
      set ativo = v_active
      where id = v_id
      returning to_jsonb(ausencias_analistas.*) into v_row;
    else
      raise exception 'Ação inválida para ausência.' using errcode = '22023';
    end if;

  elsif v_entity = 'STORE_CHANGE' then
    if v_action = 'CREATE' then
      v_start := nullif(p_payload->>'origin_start', '')::date;
      v_end := nullif(p_payload->>'origin_end', '')::date;
      v_target := trim(coalesce(p_payload->>'destination_store', ''));
      if trim(coalesce(p_payload->>'seller_name', '')) = ''
         or v_target = ''
         or v_start is null or v_end is null
         or nullif(p_payload->>'destination_start', '') is null then
        raise exception 'Vendedor, lojas e datas são obrigatórios.'
          using errcode = '22023';
      end if;
      if v_end < v_start then
        raise exception 'A data final da origem não pode ser anterior à inicial.'
          using errcode = '22023';
      end if;
      if upper(trim(coalesce(p_payload->>'origin_store', ''))) = upper(v_target) then
        raise exception 'As lojas de origem e destino devem ser diferentes.'
          using errcode = '22023';
      end if;
      v_dest_start := (p_payload->>'destination_start')::date;

      if v_dest_start <> v_end + 1 then
        raise exception 'A data de início do destino deve ser exatamente o dia seguinte ao fim da origem (sem lacuna nem sobreposição).'
          using errcode = '22023';
      end if;

      select m.loja_destino, m.departamento_destino, m.data_inicio_destino
        into v_chain_loja, v_chain_depto, v_chain_data
      from public.mudancas_loja_vendedores m
      where m.ativo is true
        and (
          (nullif(p_payload->>'seller_cpf', '') is not null
           and regexp_replace(coalesce(m.cpf_vendedor, ''), '\D', '', 'g')
               = regexp_replace(p_payload->>'seller_cpf', '\D', '', 'g'))
          or upper(trim(m.nome_vendedor))
             = upper(trim(p_payload->>'seller_name'))
        )
      order by m.data_inicio_destino desc
      limit 1;

      if v_chain_data is not null then
        if upper(trim(coalesce(p_payload->>'origin_store', ''))) <> upper(trim(v_chain_loja)) then
          raise exception 'Existe uma mudança de alocação que conflita com este período: a loja de origem deve ser igual à loja de destino da transferência ativa mais recente deste vendedor (%).', v_chain_loja
            using errcode = '23P01';
        end if;
        if v_start < v_chain_data then
          raise exception 'Existe uma mudança de alocação que conflita com este período: a origem não pode começar antes da transferência ativa mais recente deste vendedor entrar em vigor.'
            using errcode = '23P01';
        end if;
        if v_dest_start <= v_chain_data then
          raise exception 'Existe uma mudança de alocação que conflita com este período: o destino desta transferência deve começar depois da transferência ativa mais recente deste vendedor.'
            using errcode = '23P01';
        end if;
        if v_chain_depto is not null
           and nullif(trim(upper(coalesce(p_payload->>'origin_department', ''))), '') is not null
           and nullif(trim(upper(coalesce(p_payload->>'origin_department', ''))), '') <> v_chain_depto then
          raise exception 'Existe uma mudança de alocação que conflita com este período: o departamento de origem deve ser igual ao departamento de destino da transferência ativa mais recente deste vendedor.'
            using errcode = '23P01';
        end if;
      end if;

      v_usuario_id := (
        select u.id from public.usuarios u
        where u.cpf_normalizado = nullif(regexp_replace(coalesce(p_payload->>'seller_cpf', ''), '\D', '', 'g'), '')
        limit 1
      );

      insert into public.mudancas_loja_vendedores (
        cpf_vendedor, login_vendedor, nome_vendedor,
        loja_origem, loja_destino, data_inicio_origem,
        data_fim_origem, data_inicio_destino, observacao,
        usuario_id, departamento_origem, departamento_destino,
        ativo, criado_por
      ) values (
        nullif(regexp_replace(coalesce(p_payload->>'seller_cpf', ''), '\D', '', 'g'), ''),
        nullif(trim(coalesce(p_payload->>'seller_login', '')), ''),
        trim(p_payload->>'seller_name'),
        nullif(trim(coalesce(p_payload->>'origin_store', '')), ''),
        v_target, v_start, v_end,
        (p_payload->>'destination_start')::date,
        nullif(trim(coalesce(p_payload->>'notes', '')), ''),
        v_usuario_id,
        nullif(trim(coalesce(p_payload->>'origin_department', '')), ''),
        nullif(trim(coalesce(p_payload->>'destination_department', '')), ''),
        true, v_actor.cpf
      )
      returning to_jsonb(mudancas_loja_vendedores.*), id
      into v_row, v_id;

    elsif v_action = 'SET_DEPARTMENTS' then
      if nullif(trim(upper(coalesce(p_payload->>'origin_department', ''))), '') is not null
         and nullif(trim(upper(coalesce(p_payload->>'origin_department', ''))), '') not in ('NOVOS','SEMINOVOS') then
        raise exception 'Departamento origem inválido.' using errcode = '22023';
      end if;

      if nullif(trim(upper(coalesce(p_payload->>'destination_department', ''))), '') is not null
         and nullif(trim(upper(coalesce(p_payload->>'destination_department', ''))), '') not in ('NOVOS','SEMINOVOS') then
        raise exception 'Departamento destino inválido.' using errcode = '22023';
      end if;

      update public.mudancas_loja_vendedores
      set departamento_origem = nullif(trim(upper(coalesce(p_payload->>'origin_department', ''))), ''),
          departamento_destino = nullif(trim(upper(coalesce(p_payload->>'destination_department', ''))), '')
      where id = v_id
      returning to_jsonb(mudancas_loja_vendedores.*) into v_row;

    elsif v_action in ('SET_ACTIVE', 'ARCHIVE') then
      v_active := case
        when v_action = 'ARCHIVE' then false
        else coalesce((p_payload->>'active')::boolean, false)
      end;
      update public.mudancas_loja_vendedores
      set ativo = v_active
      where id = v_id
      returning to_jsonb(mudancas_loja_vendedores.*) into v_row;
    else
      raise exception 'Ação inválida para mudança de loja.'
        using errcode = '22023';
    end if;
  else
    raise exception 'Entidade administrativa inválida.'
      using errcode = '22023';
  end if;

  if v_row is null then
    raise exception 'Registro administrativo não encontrado.'
      using errcode = 'P0002';
  end if;

  insert into public.auditoria (
    tipo, descricao, base_origem, loja, vendedor, cpf, resolvido
  ) values (
    'MASTER_' || v_entity,
    v_action || ' ' || v_entity,
    'RPC master_admin_manage',
    coalesce(v_store, p_payload->>'destination_store', ''),
    v_actor.nome,
    coalesce(p_payload->>'seller_cpf', p_payload->>'absent_cpf', ''),
    false
  );

  return jsonb_build_object('status', 'OK', 'entity', v_entity, 'row', v_row);
end;
$function$
;
