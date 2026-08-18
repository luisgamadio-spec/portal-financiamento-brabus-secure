-- Fase 21.2 -- Fundacao dos alertas e excecoes cadastrais.
--
-- Contexto (Fase 21.0/21.1): a nova arquitetura de reconciliacao (usuarios
-- como fonte operacional atual, Bases 01/02/03 como fatos, portal_sellers
-- como historico/legado) precisa de uma camada de governanca ANTES de
-- qualquer integracao real com os importadores. Esta migration cria SOMENTE
-- essa fundacao: schema + RPCs administrativas MASTER-only + auditoria.
--
-- Explicitamente FORA de escopo nesta fase (ver Fase 21.3+): integracao com
-- master_operational_import_sales/finance/sellers, populacao de
-- seller_user_id, geracao de qualquer alerta real, UI no Painel Master.
-- As duas tabelas abaixo ficam vazias ao final desta migration por desenho.
--
-- Nota de seguranca: table-level GRANT a anon/authenticated e explicitamente
-- revogado (nao apenas confiar em RLS) -- ver PARTE M do prompt original e
-- o padrao ja usado em portal_import_rejections. Acesso exclusivamente via
-- RPC SECURITY DEFINER com is_master() interno.

-- =========================================================================
-- PARTE B/C/D/E/F -- tabela portal_cadastro_alertas
-- =========================================================================

create table public.portal_cadastro_alertas (
  id uuid primary key default gen_random_uuid(),
  tipo text not null,
  severidade text not null,
  status text not null default 'PENDENTE',
  origem_base text null,
  import_batch_id uuid null references public.portal_import_batches(id),
  identificador_tipo text null,
  identificador_valor text null,
  nome_encontrado text null,
  login_nbs_encontrado text null,
  loja_encontrada text null,
  departamento_encontrado text null,
  usuario_candidato_id uuid null references public.usuarios(id),
  motivo text null,
  primeira_ocorrencia_em timestamptz not null default now(),
  ultima_ocorrencia_em timestamptz not null default now(),
  quantidade_ocorrencias integer not null default 1,
  resolvido_por uuid null references public.usuarios(id) on delete set null,
  resolvido_em timestamptz null,
  ignorado_por uuid null references public.usuarios(id) on delete set null,
  ignorado_em timestamptz null,
  excluido_por uuid null references public.usuarios(id) on delete set null,
  excluido_em timestamptz null,
  motivo_acao text null,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  constraint portal_cadastro_alertas_tipo_check check (tipo in (
    'NOVO_CADASTRO_NECESSARIO', 'ATUALIZACAO_CADASTRAL_NECESSARIA',
    'CORRESPONDENCIA_INDETERMINADA', 'NBS_DIVERGENTE', 'LOJA_DIVERGENTE',
    'DEPARTAMENTO_DIVERGENTE', 'IDENTIFICADOR_DUPLICADO',
    'USUARIO_INATIVO_COM_PRODUCAO', 'FATO_SEM_VENDEDOR_ATRIBUIDO', 'OUTRO'
  )),
  constraint portal_cadastro_alertas_severidade_check check (
    severidade in ('URGENTE', 'ATENCAO', 'INFORMATIVO')
  ),
  constraint portal_cadastro_alertas_status_check check (
    status in ('PENDENTE', 'RESOLVIDO', 'IGNORADO', 'EXCLUIDO')
  ),
  constraint portal_cadastro_alertas_quantidade_check check (
    quantidade_ocorrencias >= 1
  )
);

comment on table public.portal_cadastro_alertas is
  'Fase 21.2 - governanca cadastral. Populada pelos importadores a partir da Fase 21.3. Vazia por desenho ate la.';

create index portal_cadastro_alertas_status_idx
  on public.portal_cadastro_alertas (status);
create index portal_cadastro_alertas_severidade_idx
  on public.portal_cadastro_alertas (severidade);
create index portal_cadastro_alertas_tipo_idx
  on public.portal_cadastro_alertas (tipo);
create index portal_cadastro_alertas_batch_idx
  on public.portal_cadastro_alertas (import_batch_id);
create index portal_cadastro_alertas_identificador_idx
  on public.portal_cadastro_alertas (identificador_tipo, identificador_valor, status);

-- Dedup (Parte K): no maximo 1 alerta PENDENTE por tipo+origem+identificador.
-- So se aplica quando ha identificador real -- casos sem identificador
-- (ex: CORRESPONDENCIA_INDETERMINADA sem nenhum dado aproveitavel) nao
-- deduplicam entre si automaticamente, propositalmente.
create unique index portal_cadastro_alertas_pendente_uk
  on public.portal_cadastro_alertas (
    tipo, coalesce(origem_base, ''), identificador_tipo, identificador_valor
  )
  where status = 'PENDENTE' and identificador_valor is not null;

alter table public.portal_cadastro_alertas enable row level security;

revoke all on public.portal_cadastro_alertas from public, anon, authenticated;
grant all on public.portal_cadastro_alertas to service_role;

-- =========================================================================
-- PARTE G/H/I/J -- tabela portal_cadastro_excecoes
-- =========================================================================

create table public.portal_cadastro_excecoes (
  id uuid primary key default gen_random_uuid(),
  identificador_tipo text not null,
  identificador_valor text not null,
  motivo text not null,
  ativo boolean not null default true,
  observacao text null,
  ocorrencias_suprimidas integer not null default 0,
  ultima_ocorrencia_suprimida_em timestamptz null,
  criado_por uuid null references public.usuarios(id) on delete set null,
  criado_em timestamptz not null default now(),
  revogado_por uuid null references public.usuarios(id) on delete set null,
  revogado_em timestamptz null,
  atualizado_em timestamptz not null default now(),
  constraint portal_cadastro_excecoes_identificador_tipo_check check (
    identificador_tipo in ('CPF', 'NBS')
  ),
  constraint portal_cadastro_excecoes_motivo_check check (
    motivo in (
      'FROTA', 'REVENDA', 'ATACADO', 'COLABORADOR_DESLIGADO',
      'FORA_DO_ESCOPO', 'TESTE', 'OUTRO'
    )
  ),
  constraint portal_cadastro_excecoes_ocorrencias_check check (
    ocorrencias_suprimidas >= 0
  )
);

comment on table public.portal_cadastro_excecoes is
  'Fase 21.2 - excecoes permanentes de reconciliacao (frota/revenda/etc). Identificador forte apenas (CPF/NBS), nunca nome. Vazia por desenho ate a Fase 21.3+.';

-- criado_por nullable + ON DELETE SET NULL (nao NOT NULL como sugerido no
-- prompt original): preserva o registro da excecao mesmo no caso extremo de
-- o usuarios.id do criador ser removido, priorizando "nunca perder
-- historico" (Parte AI) sobre a integridade referencial estrita. A RPC de
-- criacao sempre popula este campo a partir de auth.uid() -- a
-- nulabilidade e so uma salvaguarda de schema, nunca um caminho normal.

create unique index portal_cadastro_excecoes_ativa_uk
  on public.portal_cadastro_excecoes (identificador_tipo, identificador_valor)
  where ativo = true;

alter table public.portal_cadastro_excecoes enable row level security;

revoke all on public.portal_cadastro_excecoes from public, anon, authenticated;
grant all on public.portal_cadastro_excecoes to service_role;

-- =========================================================================
-- PARTE O/P -- RPC: listar alertas
-- =========================================================================

create or replace function public.master_cadastro_alertas_listar(
  p_status text default null,
  p_severidade text default null,
  p_tipo text default null,
  p_origem_base text default null,
  p_busca text default null,
  p_limit integer default 200,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 200), 1), 500);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_total integer;
  v_rows jsonb;
begin
  if not public.is_master() then
    raise exception 'Acesso exclusivo do perfil Master.' using errcode = '42501';
  end if;

  with filtrado as (
    select a.*
    from public.portal_cadastro_alertas a
    where (p_status is null or a.status = p_status)
      and (p_severidade is null or a.severidade = p_severidade)
      and (p_tipo is null or a.tipo = p_tipo)
      and (p_origem_base is null or a.origem_base = p_origem_base)
      and (
        p_busca is null or trim(p_busca) = ''
        or a.nome_encontrado ilike '%' || trim(p_busca) || '%'
        or a.login_nbs_encontrado ilike '%' || trim(p_busca) || '%'
      )
  )
  select count(*) into v_total from filtrado;

  with filtrado as (
    select a.*
    from public.portal_cadastro_alertas a
    where (p_status is null or a.status = p_status)
      and (p_severidade is null or a.severidade = p_severidade)
      and (p_tipo is null or a.tipo = p_tipo)
      and (p_origem_base is null or a.origem_base = p_origem_base)
      and (
        p_busca is null or trim(p_busca) = ''
        or a.nome_encontrado ilike '%' || trim(p_busca) || '%'
        or a.login_nbs_encontrado ilike '%' || trim(p_busca) || '%'
      )
    order by
      case a.severidade
        when 'URGENTE' then 1 when 'ATENCAO' then 2 else 3
      end,
      a.ultima_ocorrencia_em desc
    limit v_limit offset v_offset
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', f.id,
    'tipo', f.tipo,
    'severidade', f.severidade,
    'status', f.status,
    'origem_base', f.origem_base,
    'import_batch_id', f.import_batch_id,
    'identificador_tipo', f.identificador_tipo,
    'identificador_mascarado', case
      when f.identificador_valor is null then null
      when length(f.identificador_valor) <= 4 then repeat('*', length(f.identificador_valor))
      else repeat('*', length(f.identificador_valor) - 4) || right(f.identificador_valor, 4)
    end,
    'nome_encontrado', f.nome_encontrado,
    'login_nbs_encontrado', f.login_nbs_encontrado,
    'loja_encontrada', f.loja_encontrada,
    'departamento_encontrado', f.departamento_encontrado,
    'usuario_candidato_id', f.usuario_candidato_id,
    'nome_usuario_candidato', uc.nome,
    'motivo', f.motivo,
    'primeira_ocorrencia_em', f.primeira_ocorrencia_em,
    'ultima_ocorrencia_em', f.ultima_ocorrencia_em,
    'quantidade_ocorrencias', f.quantidade_ocorrencias,
    'motivo_acao', f.motivo_acao,
    'resolvido_em', f.resolvido_em,
    'ignorado_em', f.ignorado_em,
    'excluido_em', f.excluido_em,
    'criado_em', f.criado_em
  ) order by
      case f.severidade when 'URGENTE' then 1 when 'ATENCAO' then 2 else 3 end,
      f.ultima_ocorrencia_em desc
    ), '[]'::jsonb)
  into v_rows
  from filtrado f
  left join public.usuarios uc on uc.id = f.usuario_candidato_id;

  return jsonb_build_object(
    'rows', v_rows,
    'total', v_total,
    'limit', v_limit,
    'offset', v_offset
  );
end;
$function$;

-- =========================================================================
-- PARTE Q/R -- RPC: ignorar alerta (+ excecao opcional)
-- =========================================================================

create or replace function public.master_cadastro_alerta_ignorar(
  p_alerta_id uuid,
  p_motivo text,
  p_observacao text default null,
  p_criar_excecao boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_actor public.usuarios%rowtype;
  v_alerta public.portal_cadastro_alertas%rowtype;
  v_motivos_validos constant text[] := array[
    'FROTA', 'REVENDA', 'ATACADO', 'COLABORADOR_DESLIGADO',
    'FORA_DO_ESCOPO', 'TESTE', 'OUTRO'
  ];
  v_updated integer;
  v_excecao_id uuid;
begin
  select u.* into v_actor
  from public.usuarios u
  where u.auth_user_id = auth.uid() and u.ativo is true
    and upper(trim(coalesce(u.perfil, ''))) = 'MASTER'
  limit 1;
  if v_actor.id is null then
    raise exception 'Acesso exclusivo do perfil Master.' using errcode = '42501';
  end if;

  if p_motivo is null or not (upper(trim(p_motivo)) = any(v_motivos_validos)) then
    return jsonb_build_object('ok', false, 'codigo', 'MOTIVO_INVALIDO');
  end if;

  select * into v_alerta from public.portal_cadastro_alertas where id = p_alerta_id;
  if v_alerta.id is null then
    return jsonb_build_object('ok', false, 'codigo', 'ALERTA_NAO_ENCONTRADO');
  end if;

  -- Idempotencia (Parte Z): ja IGNORADO -> ok, sem no-op silencioso enganoso.
  if v_alerta.status = 'IGNORADO' then
    return jsonb_build_object('ok', true, 'codigo', 'JA_IGNORADO', 'alerta_id', v_alerta.id);
  end if;
  -- Maquina de estados (Parte AB): so PENDENTE -> IGNORADO e valido nesta
  -- fase. RESOLVIDO e EXCLUIDO sao terminais aqui -- reabertura fica para
  -- fase futura, nao implementada ainda (regra explicita da Parte AB/AC).
  if v_alerta.status <> 'PENDENTE' then
    return jsonb_build_object('ok', false, 'codigo', 'STATUS_INCOMPATIVEL', 'status_atual', v_alerta.status);
  end if;

  update public.portal_cadastro_alertas
  set status = 'IGNORADO',
      ignorado_por = v_actor.id,
      ignorado_em = now(),
      motivo_acao = upper(trim(p_motivo)) || coalesce(': ' || nullif(trim(p_observacao), ''), ''),
      atualizado_em = now()
  where id = p_alerta_id and status = v_alerta.status;
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    return jsonb_build_object('ok', false, 'codigo', 'CONFLITO_CONCORRENCIA');
  end if;

  if p_criar_excecao then
    if v_alerta.identificador_tipo is null or v_alerta.identificador_valor is null
       or v_alerta.identificador_tipo not in ('CPF', 'NBS') then
      return jsonb_build_object(
        'ok', true, 'codigo', 'IGNORADO_SEM_EXCECAO',
        'alerta_id', v_alerta.id,
        'excecao_erro', 'IDENTIFICADOR_NAO_ELEGIVEL_PARA_EXCECAO'
      );
    end if;

    insert into public.portal_cadastro_excecoes (
      identificador_tipo, identificador_valor, motivo, observacao, criado_por
    ) values (
      v_alerta.identificador_tipo,
      case when v_alerta.identificador_tipo = 'CPF'
        then public.normalizar_cpf(v_alerta.identificador_valor)
        else upper(trim(v_alerta.identificador_valor))
      end,
      upper(trim(p_motivo)),
      nullif(trim(p_observacao), ''),
      v_actor.id
    )
    on conflict do nothing
    returning id into v_excecao_id;

    if v_excecao_id is null then
      select id into v_excecao_id from public.portal_cadastro_excecoes
      where identificador_tipo = v_alerta.identificador_tipo
        and identificador_valor = case when v_alerta.identificador_tipo = 'CPF'
          then public.normalizar_cpf(v_alerta.identificador_valor)
          else upper(trim(v_alerta.identificador_valor))
        end
        and ativo = true
      limit 1;
    end if;

    insert into public.auditoria (tipo, descricao, base_origem, resolvido, resolvido_por, resolvido_em)
    values (
      'EXCECAO_CADASTRAL_CRIADA',
      format('Master %s criou excecao %s para identificador %s (motivo: %s) a partir do alerta %s',
        v_actor.nome, v_alerta.identificador_tipo, public.mascarar_identificador_cadastro(v_alerta.identificador_valor),
        upper(trim(p_motivo)), v_alerta.id),
      'Painel Master', true, v_actor.id, now()
    );

    return jsonb_build_object(
      'ok', true, 'codigo', 'IGNORADO_COM_EXCECAO',
      'alerta_id', v_alerta.id, 'excecao_id', v_excecao_id
    );
  end if;

  insert into public.auditoria (tipo, descricao, base_origem, resolvido, resolvido_por, resolvido_em)
  values (
    'ALERTA_IGNORADO',
    format('Master %s ignorou alerta %s (tipo: %s, motivo: %s)',
      v_actor.nome, v_alerta.id, v_alerta.tipo, upper(trim(p_motivo))),
    'Painel Master', true, v_actor.id, now()
  );

  return jsonb_build_object('ok', true, 'codigo', 'IGNORADO', 'alerta_id', v_alerta.id);
end;
$function$;

-- =========================================================================
-- PARTE S -- RPC: excluir alerta (soft-delete)
-- =========================================================================

create or replace function public.master_cadastro_alerta_excluir(
  p_alerta_id uuid,
  p_motivo text
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_actor public.usuarios%rowtype;
  v_alerta public.portal_cadastro_alertas%rowtype;
  v_updated integer;
begin
  select u.* into v_actor
  from public.usuarios u
  where u.auth_user_id = auth.uid() and u.ativo is true
    and upper(trim(coalesce(u.perfil, ''))) = 'MASTER'
  limit 1;
  if v_actor.id is null then
    raise exception 'Acesso exclusivo do perfil Master.' using errcode = '42501';
  end if;

  if nullif(trim(coalesce(p_motivo, '')), '') is null then
    return jsonb_build_object('ok', false, 'codigo', 'MOTIVO_OBRIGATORIO');
  end if;

  select * into v_alerta from public.portal_cadastro_alertas where id = p_alerta_id;
  if v_alerta.id is null then
    return jsonb_build_object('ok', false, 'codigo', 'ALERTA_NAO_ENCONTRADO');
  end if;

  if v_alerta.status = 'EXCLUIDO' then
    return jsonb_build_object('ok', true, 'codigo', 'JA_EXCLUIDO', 'alerta_id', v_alerta.id);
  end if;

  update public.portal_cadastro_alertas
  set status = 'EXCLUIDO',
      excluido_por = v_actor.id,
      excluido_em = now(),
      motivo_acao = trim(p_motivo),
      atualizado_em = now()
  where id = p_alerta_id and status = v_alerta.status;
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    return jsonb_build_object('ok', false, 'codigo', 'CONFLITO_CONCORRENCIA');
  end if;

  insert into public.auditoria (tipo, descricao, base_origem, resolvido, resolvido_por, resolvido_em)
  values (
    'ALERTA_EXCLUIDO',
    format('Master %s excluiu (soft-delete) alerta %s (tipo: %s, motivo: %s)',
      v_actor.nome, v_alerta.id, v_alerta.tipo, trim(p_motivo)),
    'Painel Master', true, v_actor.id, now()
  );

  return jsonb_build_object('ok', true, 'codigo', 'EXCLUIDO', 'alerta_id', v_alerta.id);
end;
$function$;

-- =========================================================================
-- PARTE T -- RPC: resolver alerta (apenas marca -- nao executa acao)
-- =========================================================================

create or replace function public.master_cadastro_alerta_resolver(
  p_alerta_id uuid,
  p_motivo text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_actor public.usuarios%rowtype;
  v_alerta public.portal_cadastro_alertas%rowtype;
  v_updated integer;
begin
  select u.* into v_actor
  from public.usuarios u
  where u.auth_user_id = auth.uid() and u.ativo is true
    and upper(trim(coalesce(u.perfil, ''))) = 'MASTER'
  limit 1;
  if v_actor.id is null then
    raise exception 'Acesso exclusivo do perfil Master.' using errcode = '42501';
  end if;

  select * into v_alerta from public.portal_cadastro_alertas where id = p_alerta_id;
  if v_alerta.id is null then
    return jsonb_build_object('ok', false, 'codigo', 'ALERTA_NAO_ENCONTRADO');
  end if;

  if v_alerta.status = 'RESOLVIDO' then
    return jsonb_build_object('ok', true, 'codigo', 'JA_RESOLVIDO', 'alerta_id', v_alerta.id);
  end if;
  if v_alerta.status = 'EXCLUIDO' then
    return jsonb_build_object('ok', false, 'codigo', 'STATUS_INCOMPATIVEL', 'status_atual', v_alerta.status);
  end if;

  -- Fase 21.2: esta RPC NAO cria/atualiza usuario nem altera cadastro. So
  -- registra que o problema foi resolvido por um processo externo (manual
  -- ou de outra fase). Integracao de workflow fica para a Fase 21.5+.
  update public.portal_cadastro_alertas
  set status = 'RESOLVIDO',
      resolvido_por = v_actor.id,
      resolvido_em = now(),
      motivo_acao = nullif(trim(p_motivo), ''),
      atualizado_em = now()
  where id = p_alerta_id and status = v_alerta.status;
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    return jsonb_build_object('ok', false, 'codigo', 'CONFLITO_CONCORRENCIA');
  end if;

  insert into public.auditoria (tipo, descricao, base_origem, resolvido, resolvido_por, resolvido_em)
  values (
    'ALERTA_RESOLVIDO',
    format('Master %s marcou alerta %s como resolvido (tipo: %s)%s',
      v_actor.nome, v_alerta.id, v_alerta.tipo,
      coalesce(' - ' || nullif(trim(p_motivo), ''), '')),
    'Painel Master', true, v_actor.id, now()
  );

  return jsonb_build_object('ok', true, 'codigo', 'RESOLVIDO', 'alerta_id', v_alerta.id);
end;
$function$;

-- =========================================================================
-- PARTE U -- RPC: criar excecao manual
-- =========================================================================

create or replace function public.master_cadastro_excecao_criar(
  p_identificador_tipo text,
  p_identificador_valor text,
  p_motivo text,
  p_observacao text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_actor public.usuarios%rowtype;
  v_tipo text := upper(trim(coalesce(p_identificador_tipo, '')));
  v_valor text;
  v_motivos_validos constant text[] := array[
    'FROTA', 'REVENDA', 'ATACADO', 'COLABORADOR_DESLIGADO',
    'FORA_DO_ESCOPO', 'TESTE', 'OUTRO'
  ];
  v_excecao_id uuid;
begin
  select u.* into v_actor
  from public.usuarios u
  where u.auth_user_id = auth.uid() and u.ativo is true
    and upper(trim(coalesce(u.perfil, ''))) = 'MASTER'
  limit 1;
  if v_actor.id is null then
    raise exception 'Acesso exclusivo do perfil Master.' using errcode = '42501';
  end if;

  if v_tipo not in ('CPF', 'NBS') then
    return jsonb_build_object('ok', false, 'codigo', 'IDENTIFICADOR_TIPO_INVALIDO');
  end if;
  if p_motivo is null or not (upper(trim(p_motivo)) = any(v_motivos_validos)) then
    return jsonb_build_object('ok', false, 'codigo', 'MOTIVO_INVALIDO');
  end if;

  v_valor := case
    when v_tipo = 'CPF' then public.normalizar_cpf(p_identificador_valor)
    else upper(trim(coalesce(p_identificador_valor, '')))
  end;
  if v_valor is null or v_valor = '' or (v_tipo = 'CPF' and v_valor = '00000000000') then
    return jsonb_build_object('ok', false, 'codigo', 'IDENTIFICADOR_VALOR_INVALIDO');
  end if;

  if exists (
    select 1 from public.portal_cadastro_excecoes
    where identificador_tipo = v_tipo and identificador_valor = v_valor and ativo = true
  ) then
    return jsonb_build_object('ok', false, 'codigo', 'EXCECAO_JA_ATIVA');
  end if;

  insert into public.portal_cadastro_excecoes (
    identificador_tipo, identificador_valor, motivo, observacao, criado_por
  ) values (
    v_tipo, v_valor, upper(trim(p_motivo)), nullif(trim(p_observacao), ''), v_actor.id
  )
  returning id into v_excecao_id;

  insert into public.auditoria (tipo, descricao, base_origem, resolvido, resolvido_por, resolvido_em)
  values (
    'EXCECAO_CADASTRAL_CRIADA',
    format('Master %s criou excecao manual %s para identificador %s (motivo: %s)',
      v_actor.nome, v_tipo, public.mascarar_identificador_cadastro(v_valor), upper(trim(p_motivo))),
    'Painel Master', true, v_actor.id, now()
  );

  return jsonb_build_object('ok', true, 'codigo', 'CRIADA', 'excecao_id', v_excecao_id);
end;
$function$;

-- =========================================================================
-- PARTE V -- RPC: revogar excecao
-- =========================================================================

create or replace function public.master_cadastro_excecao_revogar(
  p_excecao_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_actor public.usuarios%rowtype;
  v_excecao public.portal_cadastro_excecoes%rowtype;
  v_updated integer;
begin
  select u.* into v_actor
  from public.usuarios u
  where u.auth_user_id = auth.uid() and u.ativo is true
    and upper(trim(coalesce(u.perfil, ''))) = 'MASTER'
  limit 1;
  if v_actor.id is null then
    raise exception 'Acesso exclusivo do perfil Master.' using errcode = '42501';
  end if;

  select * into v_excecao from public.portal_cadastro_excecoes where id = p_excecao_id;
  if v_excecao.id is null then
    return jsonb_build_object('ok', false, 'codigo', 'EXCECAO_NAO_ENCONTRADA');
  end if;

  if v_excecao.ativo = false then
    return jsonb_build_object('ok', true, 'codigo', 'JA_REVOGADA', 'excecao_id', v_excecao.id);
  end if;

  update public.portal_cadastro_excecoes
  set ativo = false,
      revogado_por = v_actor.id,
      revogado_em = now(),
      atualizado_em = now()
  where id = p_excecao_id and ativo = true;
  get diagnostics v_updated = row_count;
  if v_updated <> 1 then
    return jsonb_build_object('ok', false, 'codigo', 'CONFLITO_CONCORRENCIA');
  end if;

  insert into public.auditoria (tipo, descricao, base_origem, resolvido, resolvido_por, resolvido_em)
  values (
    'EXCECAO_CADASTRAL_REVOGADA',
    format('Master %s revogou excecao %s (identificador %s: %s)',
      v_actor.nome, v_excecao.id, v_excecao.identificador_tipo,
      public.mascarar_identificador_cadastro(v_excecao.identificador_valor)),
    'Painel Master', true, v_actor.id, now()
  );

  return jsonb_build_object('ok', true, 'codigo', 'REVOGADA', 'excecao_id', v_excecao.id);
end;
$function$;

-- =========================================================================
-- PARTE W -- RPC: listar excecoes
-- =========================================================================

create or replace function public.master_cadastro_excecoes_listar(
  p_ativo boolean default null,
  p_identificador_tipo text default null,
  p_limit integer default 200,
  p_offset integer default 0
)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'pg_catalog', 'public'
as $function$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 200), 1), 500);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_total integer;
  v_rows jsonb;
begin
  if not public.is_master() then
    raise exception 'Acesso exclusivo do perfil Master.' using errcode = '42501';
  end if;

  with filtrado as (
    select e.*
    from public.portal_cadastro_excecoes e
    where (p_ativo is null or e.ativo = p_ativo)
      and (p_identificador_tipo is null or e.identificador_tipo = p_identificador_tipo)
  )
  select count(*) into v_total from filtrado;

  with filtrado as (
    select e.*
    from public.portal_cadastro_excecoes e
    where (p_ativo is null or e.ativo = p_ativo)
      and (p_identificador_tipo is null or e.identificador_tipo = p_identificador_tipo)
    order by e.criado_em desc
    limit v_limit offset v_offset
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', f.id,
    'identificador_tipo', f.identificador_tipo,
    'identificador_mascarado', public.mascarar_identificador_cadastro(f.identificador_valor),
    'motivo', f.motivo,
    'ativo', f.ativo,
    'observacao', f.observacao,
    'ocorrencias_suprimidas', f.ocorrencias_suprimidas,
    'ultima_ocorrencia_suprimida_em', f.ultima_ocorrencia_suprimida_em,
    'criado_por_nome', cu.nome,
    'criado_em', f.criado_em,
    'revogado_por_nome', ru.nome,
    'revogado_em', f.revogado_em
  ) order by f.criado_em desc), '[]'::jsonb)
  into v_rows
  from filtrado f
  left join public.usuarios cu on cu.id = f.criado_por
  left join public.usuarios ru on ru.id = f.revogado_por;

  return jsonb_build_object(
    'rows', v_rows,
    'total', v_total,
    'limit', v_limit,
    'offset', v_offset
  );
end;
$function$;

-- =========================================================================
-- Helper de mascaramento (Parte P/Y) -- usado nas RPCs acima e na auditoria.
-- =========================================================================

create or replace function public.mascarar_identificador_cadastro(p_valor text)
returns text
language sql
immutable
set search_path to 'pg_catalog', 'public'
as $function$
  select case
    when p_valor is null then null
    when length(p_valor) <= 4 then repeat('*', length(p_valor))
    else repeat('*', length(p_valor) - 4) || right(p_valor, 4)
  end;
$function$;

-- =========================================================================
-- Grants das RPCs (Parte M/AM) -- authenticated + service_role, nunca anon/PUBLIC.
-- MASTER-only e garantido pelo is_master()/checagem interna em cada corpo.
-- =========================================================================

revoke all on function public.master_cadastro_alertas_listar(text, text, text, text, text, integer, integer) from public, anon;
revoke all on function public.master_cadastro_alerta_ignorar(uuid, text, text, boolean) from public, anon;
revoke all on function public.master_cadastro_alerta_excluir(uuid, text) from public, anon;
revoke all on function public.master_cadastro_alerta_resolver(uuid, text) from public, anon;
revoke all on function public.master_cadastro_excecao_criar(text, text, text, text) from public, anon;
revoke all on function public.master_cadastro_excecao_revogar(uuid) from public, anon;
revoke all on function public.master_cadastro_excecoes_listar(boolean, text, integer, integer) from public, anon;
revoke all on function public.mascarar_identificador_cadastro(text) from public, anon;

grant execute on function public.master_cadastro_alertas_listar(text, text, text, text, text, integer, integer) to authenticated, service_role;
grant execute on function public.master_cadastro_alerta_ignorar(uuid, text, text, boolean) to authenticated, service_role;
grant execute on function public.master_cadastro_alerta_excluir(uuid, text) to authenticated, service_role;
grant execute on function public.master_cadastro_alerta_resolver(uuid, text) to authenticated, service_role;
grant execute on function public.master_cadastro_excecao_criar(text, text, text, text) to authenticated, service_role;
grant execute on function public.master_cadastro_excecao_revogar(uuid) to authenticated, service_role;
grant execute on function public.master_cadastro_excecoes_listar(boolean, text, integer, integer) to authenticated, service_role;
grant execute on function public.mascarar_identificador_cadastro(text) to authenticated, service_role;
