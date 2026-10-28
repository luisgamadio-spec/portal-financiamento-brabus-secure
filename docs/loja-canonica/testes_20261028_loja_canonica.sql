-- TESTES 28/10/2026 (loja canônica). Tudo dentro de begin ... rollback: nada fica gravado.
-- Linhas de importação sintéticas (chassi/CPF falsos). Rodar: supabase db query --linked -f <este arquivo>
begin;
set local statement_timeout = '120s';
create temp table t_res (n serial, teste text, ok boolean, detalhe text) on commit drop;
create temp table t_antes on commit drop as select id, store from public.portal_sales where batch_id = '63caf16b-c47d-40e7-a3eb-718aa92dcec3';
create temp table t_lb on commit drop as
  select distinct on (b.source_type) b.id, b.source_type from public.portal_import_batches b
  where b.status='VALIDATED' and b.source_type in ('SALES_CURRENT','SALES_HISTORY')
  order by b.source_type, b.completed_at desc nulls last, b.created_at desc, b.id desc;
create temp table t_fora_antes on commit drop as
  select upper(trim(s.store)) loja, count(*) n from public.portal_sales s join t_lb on t_lb.id = s.batch_id where coalesce(s.seller_user_id, s.seller_id) is not null and nullif(trim(s.store),'') is not null and upper(trim(s.store)) not in ('ABC','ALPHAVILLE','ANALIA FRANCO','BANDEIRANTES','BARRA FUNDA','EUROPA','GASTAO','NACOES','REVENDA') group by 1;

-- ===== migração (mesmo texto do arquivo, sem begin/commit) =====

set local statement_timeout = '60s';

create or replace function public.portal_canoniza_loja(p_loja text)
 returns text
 language sql
 immutable
 set search_path to 'pg_catalog'
as $function$
  select case upper(regexp_replace(trim(coalesce(p_loja,'')), '\s+', ' ', 'g'))
    when 'ABC' then 'ABC' when 'MITSUBISHI | ABC' then 'ABC' when 'MITSUBISHI ABC' then 'ABC'
    when 'ALPHAVILLE' then 'ALPHAVILLE' when 'MITSUBISHI | ALPHAVILLE' then 'ALPHAVILLE' when 'MITSUBISHI ALPHAVILLE' then 'ALPHAVILLE'
    when 'ANALIA FRANCO' then 'ANALIA FRANCO' when 'ANÁLIA FRANCO' then 'ANALIA FRANCO' when 'MITSUBISHI | A. FRANCO' then 'ANALIA FRANCO' when 'MITSUBISHI A FRANCO' then 'ANALIA FRANCO'
    when 'BANDEIRANTES' then 'BANDEIRANTES' when 'MITSUBISHI | BANDEIRANTES' then 'BANDEIRANTES' when 'MITSUBISHI BANDEIRANTES' then 'BANDEIRANTES'
    when 'BARRA FUNDA' then 'BARRA FUNDA' when 'MITSUBISHI | BARRA FUNDA' then 'BARRA FUNDA' when 'MITSUBISHI BARRA FUNDA' then 'BARRA FUNDA'
    when 'EUROPA' then 'EUROPA' when 'MITSUBISHI | EUROPA' then 'EUROPA' when 'MITSUBISHI EUROPA' then 'EUROPA'
    when 'GASTAO' then 'GASTAO' when 'GASTÃO' then 'GASTAO' when 'GASTAO VIDIGAL' then 'GASTAO' when 'GASTÃO VIDIGAL' then 'GASTAO' when 'MITSUBISHI | GASTAO' then 'GASTAO' when 'MITSUBISHI GASTAO' then 'GASTAO'
    when 'NACOES' then 'NACOES' when 'NAÇÕES' then 'NACOES' when 'NACOES UNIDAS' then 'NACOES' when 'NAÇÕES UNIDAS' then 'NACOES' when 'MITSUBISHI | NACOES' then 'NACOES' when 'MITSUBISHI NACOES' then 'NACOES'
    when 'REVENDA' then 'REVENDA'
    else null end
$function$;

revoke all on function public.portal_canoniza_loja(text) from public, anon, authenticated;
grant execute on function public.portal_canoniza_loja(text) to service_role;

CREATE OR REPLACE FUNCTION public.master_operational_import_sales(p_batch_id uuid, p_rows jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_count integer;
  v_source_type text;
begin
  if not public.is_master() then
    raise exception 'Acesso negado.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) <> 'array'
     or jsonb_array_length(p_rows) > 500 then
    raise exception 'Lote deve ser um array de até 500 linhas.'
      using errcode = '22023';
  end if;
  select b.source_type into v_source_type
  from public.portal_import_batches b
  where b.id = p_batch_id
    and b.imported_by = auth.uid()
    and b.source_type in ('SALES_CURRENT', 'SALES_HISTORY')
    and b.status = 'VALIDATING';
  if v_source_type is null then
    raise exception 'Lote de vendas inválido.' using errcode = '42501';
  end if;

  drop table if exists tmp_reconciliacao_vendedor_sales;

  create temp table tmp_reconciliacao_vendedor_sales on commit drop as
  with incoming as (
    select *
    from jsonb_to_recordset(p_rows) as x(
      source_row_number integer,
      sale_date date,
      chassis text,
      chassis_short text,
      seller_cpf text,
      seller_source_name text,
      seller_nbs text,
      store text,
      sale_value numeric,
      department text,
      source_kind text,
      source_transaction text,
      vehicle_model text,
      client_document_normalized text
    )
  ),
  prepared as (
    select
      x.*,
      regexp_replace(coalesce(x.seller_cpf, ''), '\D', '', 'g') as cpf_norm,
      nullif(public.portal_normaliza_nbs(x.seller_nbs), 'NBS') as nbs_norm
    from incoming x
    where x.source_row_number > 0
      and x.sale_date is not null
      and trim(coalesce(x.chassis, '')) <> ''
      and upper(x.department) in ('NOVOS', 'SEMINOVOS')
      and upper(x.source_kind) in ('CURRENT', 'HISTORY')
  ),
  resolved as (
    select
      p.*,
      s.id as resolved_seller_id,
      (p.cpf_norm ~ '^[0-9]{11}$' and p.cpf_norm <> '00000000000') as cpf_valido,
      (
        case when (
          select count(*) from public.usuarios u
          where u.cpf_normalizado = p.cpf_norm and u.ativo = true
            and p.cpf_norm ~ '^[0-9]{11}$' and p.cpf_norm <> '00000000000'
        ) = 1 then (
          select u.id from public.usuarios u
          where u.cpf_normalizado = p.cpf_norm and u.ativo = true
            and p.cpf_norm ~ '^[0-9]{11}$' and p.cpf_norm <> '00000000000'
        ) end
      ) as user_cpf_active,
      (
        select count(*) from public.usuarios u
        where u.cpf_normalizado = p.cpf_norm and u.ativo = true
          and p.cpf_norm ~ '^[0-9]{11}$' and p.cpf_norm <> '00000000000'
      ) as user_cpf_active_count,
      (
        select u.id from public.usuarios u
        where u.cpf_normalizado = p.cpf_norm and u.ativo = false
          and p.cpf_norm ~ '^[0-9]{11}$' and p.cpf_norm <> '00000000000'
        limit 1
      ) as user_cpf_inactive,
      (
        select u.id from public.usuarios u
        where u.login_nbs_normalizado = p.nbs_norm and u.ativo = true
          and p.nbs_norm is not null and p.nbs_norm <> 'NBS'
      ) as user_nbs_active,
      (
        select count(*) from public.usuarios u
        where u.login_nbs_normalizado = p.nbs_norm and u.ativo = true
          and p.nbs_norm is not null and p.nbs_norm <> 'NBS'
      ) as user_nbs_active_count
    from prepared p
    left join public.portal_sellers s
      on s.cpf_normalizado = p.cpf_norm and p.cpf_norm ~ '^[0-9]{11}$'
  ),
  classified as (
    select
      r.*,
      case
        when r.user_cpf_active_count > 1 then 'IDENTIFICADOR_DUPLICADO'
        when r.user_cpf_active is not null and r.user_nbs_active is not null
             and r.user_cpf_active <> r.user_nbs_active then 'CONFLITO'
        when r.user_cpf_active is not null then 'CPF_MATCH'
        when r.user_cpf_inactive is not null then 'CPF_INATIVO'
        when r.user_nbs_active is not null and r.user_nbs_active_count = 1 then 'NBS_FALLBACK'
        when r.nbs_norm is null and not r.cpf_valido then 'SEM_IDENTIFICADOR'
        else 'SEM_MATCH'
      end as classificacao
    from resolved r
  ),
  previous_resolution as (
    select distinct on (s.chassis)
      s.chassis, s.seller_user_id as prev_seller_user_id,
      s.seller_cpf_normalizado as prev_seller_cpf_normalizado,
      s.seller_nbs as prev_seller_nbs
    from public.portal_sales s
    join public.portal_import_batches b on b.id = s.batch_id
    where b.status = 'VALIDATED'
      and b.source_type in ('SALES_CURRENT', 'SALES_HISTORY')
      and s.seller_user_id is not null
      -- Fase 1 (19/10/2026): só os chassis desta parte — o resultado do join abaixo é o mesmo, sem ler o histórico inteiro.
      and s.chassis in (select upper(regexp_replace(p.chassis, '[^A-Za-z0-9]', '', 'g')) from prepared p)
    order by s.chassis, b.completed_at desc nulls last, b.created_at desc, s.id desc
  )
  select
    c.*,
    coalesce(
      case c.classificacao
        when 'CPF_MATCH' then c.user_cpf_active
        when 'NBS_FALLBACK' then c.user_nbs_active
        else null
      end,
      case
        when c.classificacao not in ('IDENTIFICADOR_DUPLICADO', 'CONFLITO')
          and not (
            (c.cpf_valido and pr.prev_seller_cpf_normalizado is not null
              and c.cpf_norm <> pr.prev_seller_cpf_normalizado)
            or
            (c.nbs_norm is not null and pr.prev_seller_nbs is not null
              and c.nbs_norm <> pr.prev_seller_nbs)
          )
          then pr.prev_seller_user_id
        else null
      end
    )::uuid as seller_user_id_final,
    case when c.cpf_valido then 'CPF' when c.nbs_norm is not null then 'NBS' else null end as identificador_alerta_tipo,
    case when c.cpf_valido then c.cpf_norm when c.nbs_norm is not null then c.nbs_norm else null end as identificador_alerta_valor,
    case when c.cpf_valido then c.cpf_norm else pr.prev_seller_cpf_normalizado end as seller_cpf_final
  from classified c
  left join previous_resolution pr
    on pr.chassis = upper(regexp_replace(c.chassis, '[^A-Za-z0-9]', '', 'g'));

  with upserted as (
    insert into public.portal_sales (
      batch_id, source_row_number, sale_date, chassis, chassis_short,
      seller_id, seller_user_id, seller_cpf_normalizado, seller_source_name, seller_nbs, store, sale_value,
      department, source_kind, source_transaction, vehicle_model,
      client_document_match_key
    )
    select
      p_batch_id, source_row_number, sale_date,
      upper(regexp_replace(chassis, '[^A-Za-z0-9]', '', 'g')),
      nullif(upper(trim(coalesce(chassis_short, ''))), ''),
      resolved_seller_id,
      seller_user_id_final,
      seller_cpf_final,
      nullif(trim(coalesce(seller_source_name, '')), ''),
      nullif(upper(trim(coalesce(seller_nbs, ''))), ''),
      -- 28/10/2026 (loja fantasma "NACOES UNIDAS"): loja sempre por public.portal_canoniza_loja.
      -- 1º o texto da planilha traduzido pelo mapa (mantém a loja da data da venda; REVENDA continua REVENDA);
      -- 2º se o texto não for loja conhecida e o vendedor foi identificado, a loja do cadastro (usuarios.loja);
      -- 3º senão, o texto como veio (a guarda acusa loja fora da lista).
      coalesce(
        public.portal_canoniza_loja(store),
        case when seller_user_id_final is not null then public.portal_canoniza_loja((select u.loja from public.usuarios u where u.id = seller_user_id_final)) end,
        nullif(upper(trim(coalesce(store, ''))), '')
      ),
      coalesce(sale_value, 0),
      upper(department), upper(source_kind),
      nullif(upper(trim(coalesce(source_transaction, ''))), ''),
      nullif(upper(trim(coalesce(vehicle_model, ''))), ''),
      public.portal_document_match_key(client_document_normalized)
    from tmp_reconciliacao_vendedor_sales
    on conflict (batch_id, source_row_number) do update
    set
      sale_date = excluded.sale_date,
      chassis = excluded.chassis,
      chassis_short = excluded.chassis_short,
      seller_id = excluded.seller_id,
      seller_user_id = excluded.seller_user_id,
      seller_cpf_normalizado = excluded.seller_cpf_normalizado,
      seller_source_name = excluded.seller_source_name,
      seller_nbs = excluded.seller_nbs,
      store = excluded.store,
      sale_value = excluded.sale_value,
      department = excluded.department,
      source_kind = excluded.source_kind,
      source_transaction = excluded.source_transaction,
      vehicle_model = excluded.vehicle_model,
      client_document_match_key = excluded.client_document_match_key
    returning 1
  )
  select count(*) into v_count from upserted;

  perform public.registrar_alertas_reconciliacao_lote(
    p_batch_id, v_source_type,
    (
      select jsonb_agg(jsonb_build_object(
        'identificador_tipo', f.identificador_alerta_tipo,
        'identificador_valor', f.identificador_alerta_valor,
        'nome_encontrado', f.seller_source_name,
        'login_nbs_encontrado', f.seller_nbs,
        'loja_encontrada', f.store,
        'departamento_encontrado', f.department,
        'tipo', case f.classificacao
          when 'IDENTIFICADOR_DUPLICADO' then 'IDENTIFICADOR_DUPLICADO'
          when 'CONFLITO' then 'CORRESPONDENCIA_INDETERMINADA'
          when 'CPF_INATIVO' then 'USUARIO_INATIVO_COM_PRODUCAO'
          when 'SEM_MATCH' then 'NOVO_CADASTRO_NECESSARIO'
        end,
        'severidade', case when upper(f.source_kind) = 'CURRENT' then 'URGENTE' else 'NORMAL' end
      ))
      from tmp_reconciliacao_vendedor_sales f
      where f.classificacao in ('IDENTIFICADOR_DUPLICADO', 'CONFLITO', 'CPF_INATIVO', 'SEM_MATCH')
    )
  );

  return v_count;
end;
$function$
;

do $x$
declare n integer;
begin
  update public.portal_sales s set store = 'NACOES'
  where s.batch_id = '63caf16b-c47d-40e7-a3eb-718aa92dcec3'
    and s.id in (160123, 160180, 160924, 160872)
    and s.store = 'NACOES UNIDAS';
  get diagnostics n = row_count;
  if n <> 4 then raise exception 'Esperava corrigir 4 linhas; encontrou %', n; end if;
end $x$;


-- ===== fim da migração =====

-- T1 mapa de apelidos
insert into t_res(teste, ok, detalhe)
select 'T1 mapa: ' || coalesce(quote_literal(x), 'NULL') || ' -> ' || coalesce(e, 'NULL'), public.portal_canoniza_loja(x) is not distinct from e,
       coalesce(public.portal_canoniza_loja(x), 'NULL')
from (values ('NACOES UNIDAS'::text, 'NACOES'::text), ('nacoes unidas'::text, 'NACOES'::text), ('  Nações   Unidas '::text, 'NACOES'::text), ('NAÇÕES UNIDAS'::text, 'NACOES'::text), ('MITSUBISHI | NACOES'::text, 'NACOES'::text), ('MITSUBISHI NACOES'::text, 'NACOES'::text), ('NACOES'::text, 'NACOES'::text), ('GASTÃO VIDIGAL'::text, 'GASTAO'::text), ('GASTAO VIDIGAL'::text, 'GASTAO'::text), ('MITSUBISHI | GASTAO'::text, 'GASTAO'::text), ('ANÁLIA FRANCO'::text, 'ANALIA FRANCO'::text), ('MITSUBISHI | A. FRANCO'::text, 'ANALIA FRANCO'::text), ('MITSUBISHI A FRANCO'::text, 'ANALIA FRANCO'::text), ('MITSUBISHI BANDEIRANTES'::text, 'BANDEIRANTES'::text), ('MITSUBISHI | BANDEIRANTES'::text, 'BANDEIRANTES'::text), ('BARRA FUNDA'::text, 'BARRA FUNDA'::text), ('MITSUBISHI | ABC'::text, 'ABC'::text), ('MITSUBISHI | ALPHAVILLE'::text, 'ALPHAVILLE'::text), ('MITSUBISHI | EUROPA'::text, 'EUROPA'::text), ('REVENDA'::text, 'REVENDA'::text), ('revenda'::text, 'REVENDA'::text), ('LOJA DESCONHECIDA'::text, null::text), ('2'::text, null::text), ('MASTER'::text, null::text), (''::text, null::text), (null::text, null::text)) v(x, e);
-- T1b as 20 formas que já existiam nas funções F&I dão o mesmo resultado
insert into t_res(teste, ok, detalhe)
select 'T1b 20 apelidos já usados nas funções F&I', count(*) filter (where public.portal_canoniza_loja(x) = e) = 20,
       count(*) filter (where public.portal_canoniza_loja(x) = e) || '/20'
from (values ('ABC', 'ABC'), ('MITSUBISHI | ABC', 'ABC'), ('ALPHAVILLE', 'ALPHAVILLE'), ('MITSUBISHI | ALPHAVILLE', 'ALPHAVILLE'), ('ANALIA FRANCO', 'ANALIA FRANCO'), ('ANÁLIA FRANCO', 'ANALIA FRANCO'), ('MITSUBISHI | A. FRANCO', 'ANALIA FRANCO'), ('BANDEIRANTES', 'BANDEIRANTES'), ('MITSUBISHI | BANDEIRANTES', 'BANDEIRANTES'), ('MITSUBISHI BANDEIRANTES', 'BANDEIRANTES'), ('BARRA FUNDA', 'BARRA FUNDA'), ('MITSUBISHI | BARRA FUNDA', 'BARRA FUNDA'), ('EUROPA', 'EUROPA'), ('MITSUBISHI | EUROPA', 'EUROPA'), ('GASTAO', 'GASTAO'), ('GASTÃO VIDIGAL', 'GASTAO'), ('MITSUBISHI | GASTAO', 'GASTAO'), ('MITSUBISHI | NACOES', 'NACOES'), ('NACOES', 'NACOES'), ('NAÇÕES UNIDAS', 'NACOES')) v(x, e);

-- T2 permissões do mapa
insert into t_res(teste, ok, detalhe)
select 'T2 visitante e logado sem execução direta do mapa',
  not has_function_privilege('anon', 'public.portal_canoniza_loja(text)', 'execute')
  and not has_function_privilege('authenticated', 'public.portal_canoniza_loja(text)', 'execute'), '';

-- T3 importação com linhas sintéticas, chamada como o Master real
insert into public.portal_import_batches (source_type, original_filename, source_sha256, status, imported_by)
values ('SALES_CURRENT', 'TESTE_LOJA_CANONICA.xlsx', encode(sha256(convert_to('teste-loja-canonica-20261028','UTF8')),'hex'), 'VALIDATING', (select u.auth_user_id from public.usuarios u where upper(u.perfil)='MASTER' and u.ativo and u.auth_user_id is not null order by u.id limit 1));
select set_config('teste.lote', (select id::text from public.portal_import_batches where source_sha256 = encode(sha256(convert_to('teste-loja-canonica-20261028','UTF8')),'hex')), true);
select set_config('teste.nbs', (select u.login_nbs from public.usuarios u where u.id = (select u.id from public.usuarios u where u.ativo and upper(u.perfil)='VENDEDOR' and u.login_nbs_normalizado is not null and public.portal_canoniza_loja(u.loja) in ('ABC','ALPHAVILLE','ANALIA FRANCO','BANDEIRANTES','BARRA FUNDA','EUROPA','GASTAO','NACOES') and (select count(*) from public.usuarios u2 where u2.ativo and u2.login_nbs_normalizado = u.login_nbs_normalizado) = 1 order by u.id limit 1)), true);
select set_config('teste.loja_cad', (select public.portal_canoniza_loja(u.loja) from public.usuarios u where u.id = (select u.id from public.usuarios u where u.ativo and upper(u.perfil)='VENDEDOR' and u.login_nbs_normalizado is not null and public.portal_canoniza_loja(u.loja) in ('ABC','ALPHAVILLE','ANALIA FRANCO','BANDEIRANTES','BARRA FUNDA','EUROPA','GASTAO','NACOES') and (select count(*) from public.usuarios u2 where u2.ativo and u2.login_nbs_normalizado = u.login_nbs_normalizado) = 1 order by u.id limit 1)), true);
select set_config('teste.vend', ((select u.id from public.usuarios u where u.ativo and upper(u.perfil)='VENDEDOR' and u.login_nbs_normalizado is not null and public.portal_canoniza_loja(u.loja) in ('ABC','ALPHAVILLE','ANALIA FRANCO','BANDEIRANTES','BARRA FUNDA','EUROPA','GASTAO','NACOES') and (select count(*) from public.usuarios u2 where u2.ativo and u2.login_nbs_normalizado = u.login_nbs_normalizado) = 1 order by u.id limit 1))::text, true);
do $x$ begin perform set_config('request.jwt.claims', json_build_object('sub', (select u.auth_user_id from public.usuarios u where upper(u.perfil)='MASTER' and u.ativo and u.auth_user_id is not null order by u.id limit 1), 'role','authenticated')::text, true); end $x$;
set local role authenticated;
select public.master_operational_import_sales(current_setting('teste.lote')::uuid, jsonb_build_array(
  jsonb_build_object('source_row_number',1,'sale_date','2026-10-28','chassis','TESTEZZ0000000001','seller_cpf','','seller_nbs','TESTE_SEM_VENDEDOR','store','NACOES UNIDAS','sale_value',1,'department','SEMINOVOS','source_kind','CURRENT'),
  jsonb_build_object('source_row_number',2,'sale_date','2026-10-28','chassis','TESTEZZ0000000002','seller_cpf','','seller_nbs','TESTE_SEM_VENDEDOR','store','GASTÃO VIDIGAL','sale_value',1,'department','NOVOS','source_kind','CURRENT'),
  jsonb_build_object('source_row_number',3,'sale_date','2026-10-28','chassis','TESTEZZ0000000003','seller_cpf','','seller_nbs',current_setting('teste.nbs'),'store','REVENDA','sale_value',1,'department','NOVOS','source_kind','CURRENT'),
  jsonb_build_object('source_row_number',4,'sale_date','2026-10-28','chassis','TESTEZZ0000000004','seller_cpf','','seller_nbs',current_setting('teste.nbs'),'store','LOJA DESCONHECIDA','sale_value',1,'department','NOVOS','source_kind','CURRENT'),
  jsonb_build_object('source_row_number',5,'sale_date','2026-10-28','chassis','TESTEZZ0000000005','seller_cpf','','seller_nbs','TESTE_SEM_VENDEDOR','store','LOJA DESCONHECIDA','sale_value',1,'department','NOVOS','source_kind','CURRENT'),
  jsonb_build_object('source_row_number',6,'sale_date','2026-10-28','chassis','TESTEZZ0000000006','seller_cpf','','seller_nbs','TESTE_SEM_VENDEDOR','store','mitsubishi | europa','sale_value',1,'department','NOVOS','source_kind','CURRENT'),
  jsonb_build_object('source_row_number',7,'sale_date','2026-10-28','chassis','TESTEZZ0000000007','seller_cpf','','seller_nbs',current_setting('teste.nbs'),'store','BARRA FUNDA','sale_value',1,'department','NOVOS','source_kind','CURRENT'),
  jsonb_build_object('source_row_number',8,'sale_date','2026-10-28','chassis','TESTEZZ0000000008','seller_cpf','','seller_nbs','TESTE_SEM_VENDEDOR','store','','sale_value',1,'department','NOVOS','source_kind','CURRENT')
)) importadas;
reset role;
insert into t_res(teste, ok, detalhe)
select 'T3 importação linha ' || s.source_row_number || ': ' || e.caso, s.store is not distinct from e.esperado,
       coalesce(s.store, 'NULL') || ' / esperado ' || coalesce(e.esperado, 'NULL')
from public.portal_sales s
join (values (1, 'NACOES UNIDAS sem vendedor -> NACOES', 'NACOES'),
             (2, 'GASTÃO VIDIGAL -> GASTAO', 'GASTAO'),
             (3, 'REVENDA com vendedor identificado continua REVENDA', 'REVENDA'),
             (4, 'loja desconhecida + vendedor identificado -> loja do cadastro', current_setting('teste.loja_cad')),
             (5, 'loja desconhecida sem vendedor -> texto como veio', 'LOJA DESCONHECIDA'),
             (6, 'minúsculas -> EUROPA', 'EUROPA'),
             (7, 'loja conhecida da planilha prevalece sobre o cadastro', 'BARRA FUNDA'),
             (8, 'vazio sem vendedor continua vazio', null)) e(r, caso, esperado) on e.r = s.source_row_number
where s.batch_id = current_setting('teste.lote')::uuid order by s.source_row_number;
insert into t_res(teste, ok, detalhe)
select 'T3b 8 linhas gravadas; vendedor identificado nas linhas 3, 4 e 7',
  (select count(*) from public.portal_sales where batch_id = current_setting('teste.lote')::uuid) = 8 and count(*) = 3, count(*)::text
from public.portal_sales s where s.batch_id = current_setting('teste.lote')::uuid and s.source_row_number in (3,4,7)
  and s.seller_user_id = current_setting('teste.vend')::uuid;

-- T4 correção das 4 linhas do lote vigente
insert into t_res(teste, ok, detalhe)
select 'T4 as 4 linhas agora em NACOES', count(*) = 4, count(*)::text
from public.portal_sales where batch_id = '63caf16b-c47d-40e7-a3eb-718aa92dcec3' and id in (160123,160180,160924,160872) and store = 'NACOES';
insert into t_res(teste, ok, detalhe)
select 'T4b nenhuma outra linha do lote mudou', count(*) = 0, count(*)::text
from public.portal_sales s join t_antes a on a.id = s.id where s.id not in (160123,160180,160924,160872) and s.store is distinct from a.store;
insert into t_res(teste, ok, detalhe)
select 'T4c mesmo número de linhas no lote', (select count(*) from public.portal_sales where batch_id = '63caf16b-c47d-40e7-a3eb-718aa92dcec3') = (select count(*) from t_antes),
       (select count(*) from t_antes)::text;

-- T5 checagem da guarda
insert into t_res(teste, ok, detalhe)
select 'T5 checagem de loja: antes da correção acusava NACOES UNIDAS', exists (select 1 from t_fora_antes where loja = 'NACOES UNIDAS'),
       coalesce((select string_agg(loja || '=' || n, ', ') from t_fora_antes), '');
insert into t_res(teste, ok, detalhe)
select 'T5b checagem de loja: depois da correção, 0 vendas fora das 8 + REVENDA', count(*) = 0, coalesce(string_agg(distinct upper(trim(s.store)), ', '), '')
from public.portal_sales s join t_lb on t_lb.id = s.batch_id where coalesce(s.seller_user_id, s.seller_id) is not null and nullif(trim(s.store),'') is not null and upper(trim(s.store)) not in ('ABC','ALPHAVILLE','ANALIA FRANCO','BANDEIRANTES','BARRA FUNDA','EUROPA','GASTAO','NACOES','REVENDA');

select n, teste, ok, detalhe from t_res order by n;
rollback;
