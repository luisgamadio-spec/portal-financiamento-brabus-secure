-- Incidente P2: Escopo Operacional Ausente para o Perfil RH
--
-- Causa raiz (drift de autoridade entre duas funcoes de autorizacao):
-- portal_modulos_permitidos() ja resolvia RH/RECURSOS HUMANOS ha tempo
-- (mapeia para 'RH', departamento 'TODOS', consulta permissoes_modulos) e
-- a matriz permissoes_modulos ja concede RH -> comissoes (modulo
-- "Acompanhamento de Salario") = permitido=true, departamento='TODOS' --
-- confirmado ao vivo, somente-leitura, antes deste patch. Porem
-- operational_current_scope() -- a funcao efetivamente chamada por
-- operational_salary_details() e operational_analyst_commission_metrics()
-- (linha 71/77 dessas funcoes) -- nunca recebeu o branch correspondente:
-- seu allowlist de perfis nao incluia RH, entao qualquer chamada com
-- perfil RH levantava SQLSTATE 42501 ("Perfil sem acesso aos dados
-- operacionais."), mesmo apos a concessao explicita de modulo. O proprio
-- comentario historico de portal_modulos_permitidos() ja afirmava
-- (incorretamente, para RH) replicar "a mesma resolucao de perfil/
-- departamento de operational_current_scope()". Reproduzido e confirmado
-- em transacao com ROLLBACK (identidade RH sintetica, sem persistencia)
-- antes deste patch -- ver relatorio do incidente (RH-1/RH-2).
--
-- Decisao de produto (RH-2): RH e' escopo corporativo para os modulos
-- operacionais aos quais ja tem acesso concedido -- ambos os
-- departamentos (NOVOS + SEMINOVOS), sem restricao de loja -- mesma
-- semantica ja expressa pela matriz (departamento='TODOS'). RH
-- explicitamente NAO se torna MASTER, NAO se torna DIRETOR e NAO se
-- torna VENDEDOR: is_master/is_director/is_seller permanecem false para
-- RH (derivados genericamente, sem alteracao necessaria nessas 3
-- linhas). RH nao ganha nenhum modulo novo por este patch -- a
-- autorizacao de MODULO continua exclusivamente em
-- portal_modulos_permitidos()/permissoes_modulos; esta funcao so
-- resolve o escopo de DADOS depois que um modulo ja autorizado chega na
-- camada operacional.
--
-- Mudanca estritamente aditiva: um unico branch novo (RH) inserido entre
-- os branches DIRETOR e o branch generico derivado de status; um unico
-- perfil novo adicionado ao allowlist final. MASTER, DIRETOR NOVOS,
-- DIRETOR SEMINOVOS, ANALISTA, GERENTE e VENDEDOR permanecem
-- byte-identicos -- nenhuma linha dos branches existentes foi alterada.
-- Assinatura, tipo de retorno, SECURITY DEFINER, search_path e contrato
-- de retorno (mesmas 6 chaves) preservados exatamente. Nao altera
-- portal_modulos_permitidos(), permissoes_modulos, RLS, grants, formulas
-- de comissao/salario ou logica de fechamento/periodo. Testado em
-- transacao com ROLLBACK contra os 8 perfis (RH incluido) antes desta
-- promocao -- ver relatorio do incidente.

CREATE OR REPLACE FUNCTION public.operational_current_scope()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare
  v_user public.usuarios%rowtype;
  v_profile text;
  v_status text;
  v_departments text[] := array[]::text[];
begin
  select *
    into v_user
  from public.usuarios
  where auth_user_id = auth.uid()
    and ativo = true
  limit 1;

  if v_user.id is null then
    raise exception 'Conta sem perfil ativo no portal.'
      using errcode = '42501';
  end if;

  v_profile := upper(trim(coalesce(v_user.perfil, '')));
  v_status := upper(trim(coalesce(v_user.status, '')));

  if v_profile = 'MASTER' then
    v_departments := array['NOVOS', 'SEMINOVOS'];
  elsif v_profile in ('DIRETOR NOVOS', 'DIRETOR DE NOVOS') then
    v_departments := array['NOVOS'];
  elsif v_profile in ('DIRETOR SEMINOVOS', 'DIRETOR DE SEMINOVOS') then
    v_departments := array['SEMINOVOS'];
  elsif v_profile in ('RECURSOS HUMANOS', 'RH') then
    -- Incidente P2 RH-Escopo-Operacional: RH e' escopo corporativo
    -- (ambos os departamentos, sem restricao de loja) -- mesma decisao
    -- ja refletida em portal_modulos_permitidos() (RH -> TODOS) e na
    -- matriz permissoes_modulos (RH/TODOS/comissoes=true), nunca antes
    -- propagada para este resolver. Normaliza para o rotulo canonico
    -- 'RH' (mesma normalizacao ja usada por portal_modulos_permitidos())
    -- para que os campos 'profile'/is_master/is_director/is_seller
    -- abaixo e o allowlist final sejam consistentes independente da
    -- grafia armazenada.
    v_profile := 'RH';
    v_departments := array['NOVOS', 'SEMINOVOS'];
  else
    -- "SEMINOVOS" contains the text "NOVOS"; remove it before testing NOVOS.
    if replace(v_status, 'SEMINOVOS', '') like '%NOVOS%' then
      v_departments := array_append(v_departments, 'NOVOS');
    end if;
    if v_status like '%SEMINOVOS%' then
      v_departments := array_append(v_departments, 'SEMINOVOS');
    end if;
  end if;

  if v_profile not in (
    'MASTER', 'DIRETOR NOVOS', 'DIRETOR DE NOVOS',
    'DIRETOR SEMINOVOS', 'DIRETOR DE SEMINOVOS',
    'RH', 'ANALISTA', 'GERENTE', 'VENDEDOR'
  ) then
    raise exception 'Perfil sem acesso aos dados operacionais.'
      using errcode = '42501';
  end if;

  return jsonb_build_object(
    'profile', v_profile,
    'store', nullif(upper(trim(coalesce(v_user.loja, ''))), ''),
    'departments', to_jsonb(v_departments),
    'is_master', v_profile = 'MASTER',
    'is_director', v_profile like 'DIRETOR%',
    'is_seller', v_profile = 'VENDEDOR'
  );
end;
$function$;
