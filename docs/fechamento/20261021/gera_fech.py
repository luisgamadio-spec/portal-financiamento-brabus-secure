"""Gera a mudança do fechamento (21/10/2026, aprovada pelo Luis) a partir do texto ATUAL de produção:
 1) comissão de cada pessoa arredondada em centavos; total oficial = soma das linhas gravadas;
 2) o fechamento grava quem é cada pessoa (usuario_id) e o CPF do cadastro (por identificador, nunca por nome);
 3) auditoria SPF com código/banco/plano da linha principal do mesmo cliente + "conta na comissão";
 4) analistas: SPF de R$ 1,00 (marcador da importação NBS) deixa de contar, igual aos vendedores.
Só lê o banco. Saídas: fech.sql, fech_rollback.sql (texto EXATO de antes), fech_backup.json.  Uso: python -I gera_fech.py"""
import io, json, os, re, sys
AQUI = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.join(AQUI, "apoio"))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from rpc import sql

FUNCS = ["master_close_commission_period", "master_operational_spf_audit_period", "master_commission_operational_detail",
         "operational_analyst_commission_metrics", "operational_analyst_coverage_metrics", "operational_salary_manager_directory"]
bruto = {r["proname"]: r["d"].rstrip() for r in sql("select p.proname, pg_get_functiondef(p.oid) d from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in (" + ",".join("'" + f + "'" for f in FUNCS) + ")")}
assert set(bruto) == set(FUNCS), set(FUNCS) - set(bruto)
acl = sql("select p.proname, p.proacl::text acl from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in (" + ",".join("'" + f + "'" for f in FUNCS) + ")")
cols = sql("select table_name, column_name from information_schema.columns where table_schema='public' and table_name in ('snapshot_comissoes','snapshot_operational_detail') and column_name in ('usuario_id','conta_na_comissao')")
assert not cols, f"colunas já existem: {cols}"
json.dump({"capturado_em": "2026-10-21", "funcoes": bruto, "acl": acl}, open(os.path.join(AQUI, "fech_backup.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
f = {k: v.replace("\r\n", "\n") for k, v in bruto.items()}

def troca(nome, antigo, novo, n=1):
    assert f[nome].count(antigo) == n, (nome, f[nome].count(antigo), antigo[:80])
    f[nome] = f[nome].replace(antigo, novo)

# ---------------- 1 + 2: master_close_commission_period ----------------
c = "master_close_commission_period"
troca(c, """    comissao, detalhes
  )
  select""", """    comissao, detalhes, usuario_id, cpf
  )
  select""")
troca(c, """    coalesce(r.faixa, 0), coalesce(r.comissao_total, 0),
    jsonb_build_object(
      'comissao_principal', coalesce(r.comissao_principal, 0),
      'comissao_spf', coalesce(r.comissao_spf, 0),
      'comissao_total', coalesce(r.comissao_total, 0)
    )
  from jsonb_to_recordset(p_rows) as r(
    nome text, perfil text, loja text, status text,
    vendidas numeric, financiadas numeric, share numeric, producao numeric,
    retorno numeric, spf_extra numeric, spf_liquido numeric,
    rentabilidade_total numeric, faixa numeric, comissao_principal numeric,
    comissao_spf numeric, comissao_total numeric
  );""", """    coalesce(r.faixa, 0), cent.total,
    jsonb_build_object(
      'comissao_principal', cent.principal,
      'comissao_spf', cent.spf,
      'comissao_total', cent.total
    ),
    pessoa.usuario_id, pessoa.cpf
  from jsonb_to_recordset(p_rows) as r(
    nome text, perfil text, loja text, status text,
    vendidas numeric, financiadas numeric, share numeric, producao numeric,
    retorno numeric, spf_extra numeric, spf_liquido numeric,
    rentabilidade_total numeric, faixa numeric, comissao_principal numeric,
    comissao_spf numeric, comissao_total numeric, usuario_id text
  )
  -- 21/10/2026 (decisão do Luis): a comissão de cada pessoa é gravada em centavos
  -- (round do Postgres = meio centavo para cima, como no Excel). Se principal + SPF
  -- arredondados não fecharem com o total arredondado só por arredondamento (até 1
  -- centavo), o principal absorve o centavo. GERENTE: o total continua sendo só o principal.
  cross join lateral (
    select t.total, t.spf,
      case
        when upper(trim(coalesce(r.perfil, ''))) <> 'GERENTE'
         and round(coalesce(r.comissao_principal, 0), 2) + t.spf <> t.total
         and abs(round(coalesce(r.comissao_principal, 0), 2) + t.spf - t.total) <= 0.01
          then t.total - t.spf
        else round(coalesce(r.comissao_principal, 0), 2)
      end as principal
    from (select round(coalesce(r.comissao_total, 0), 2) as total,
                 round(coalesce(r.comissao_spf, 0), 2) as spf) t
  ) cent
  -- 21/10/2026: quem é a pessoa. Só pelo identificador enviado pela prévia (usuario_id do
  -- cadastro, ou do cadastro de vendedores para quem não tem login) e só se o nome bater
  -- com o cadastro -- nunca procura por nome. Sem identificador confiável: fica vazio.
  left join lateral (
    select u.id as usuario_id,
           nullif(regexp_replace(coalesce(nullif(u.cpf_normalizado, ''), u.cpf, ''), '\\D', '', 'g'), '') as cpf
    from public.usuarios u
    where r.usuario_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and u.id = r.usuario_id::uuid
      and upper(trim(u.nome)) = upper(trim(r.nome))
    union all
    select null::uuid,
           nullif(regexp_replace(coalesce(ps.cpf_normalizado, ''), '\\D', '', 'g'), '')
    from public.portal_sellers ps
    where r.usuario_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      and ps.id = r.usuario_id::uuid
      and upper(trim(ps.name)) = upper(trim(r.nome))
      and not exists (select 1 from public.usuarios u2 where u2.id = r.usuario_id::uuid)
    limit 1
  ) pessoa on true;""")
troca(c, """  if (select count(*) from public.snapshot_comissoes s
      where s.fechamento_id = v_closing_id) <> v_row_count then
    raise exception 'O snapshot não foi gravado integralmente.'
      using errcode = 'P0001';
  end if;
""", """  if (select count(*) from public.snapshot_comissoes s
      where s.fechamento_id = v_closing_id) <> v_row_count then
    raise exception 'O snapshot não foi gravado integralmente.'
      using errcode = 'P0001';
  end if;

  -- 21/10/2026: o total oficial da competência é a SOMA das comissões gravadas acima (em
  -- centavos), não o total calculado pela tela. O valor da tela fica guardado para conferência.
  update public.fechamentos_comissao fc
  set observacao = jsonb_set(
        jsonb_set(fc.observacao::jsonb, '{comissao_total_tela}',
                  coalesce(fc.observacao::jsonb->'comissao_total', '0'::jsonb)),
        '{comissao_total}',
        to_jsonb((select coalesce(sum(s.comissao), 0) from public.snapshot_comissoes s
                  where s.fechamento_id = v_closing_id))
      )::text
  where fc.id = v_closing_id;
""")
troca(c, """    operation_date, chassis_masked, operation_code, bank, finance_code,
    optional_name, spf_bruto, spf_liquido
  )""", """    operation_date, chassis_masked, operation_code, bank, finance_code,
    optional_name, spf_bruto, spf_liquido, conta_na_comissao
  )""")
troca(c, """    coalesce((r->>'spf_bruto')::numeric, 0), coalesce((r->>'spf_liquido')::numeric, 0)
  from jsonb_array_elements(coalesce(v_spf_result->'rows', '[]'::jsonb)) as r;""", """    coalesce((r->>'spf_bruto')::numeric, 0), coalesce((r->>'spf_liquido')::numeric, 0),
    (r->>'conta_na_comissao')::boolean
  from jsonb_array_elements(coalesce(v_spf_result->'rows', '[]'::jsonb)) as r;""")

# ---------------- 3: auditoria SPF ----------------
a = "master_operational_spf_audit_period"
troca(a, """      spf.operation_code,
      spf.bank,
      spf.finance_code,
      spf.optional_name,""", """      -- 21/10/2026: na Base 03 a linha do SPF extra (opcional) não traz código/banco/plano;
      -- eles estão na linha principal da mesma operação do cliente (mesmo lote). Usa a da
      -- própria linha quando houver; senão a principal mais próxima na data.
      coalesce(nullif(trim(spf.operation_code), ''), principal.operation_code) as operation_code,
      coalesce(nullif(trim(spf.bank), ''), principal.bank) as bank,
      coalesce(nullif(trim(spf.finance_code), ''), principal.finance_code) as finance_code,
      spf.optional_name,""")
troca(a, """    join visible_finance vf
      on vf.client_match_key = spf.client_match_key
    where spf.is_spf_extra""", """    join visible_finance vf
      on vf.client_match_key = spf.client_match_key
    left join lateral (
      select nullif(trim(m.operation_code), '') as operation_code,
             nullif(trim(m.bank), '') as bank,
             nullif(trim(m.finance_code), '') as finance_code
      from public.portal_spf_operations m
      where m.batch_id = spf.batch_id
        and m.client_match_key = spf.client_match_key
        and not coalesce(m.is_spf_extra, false)
        and coalesce(nullif(trim(m.operation_code), ''), nullif(trim(m.bank), ''), nullif(trim(m.finance_code), '')) is not null
      order by abs(m.operation_date - spf.operation_date), m.source_row_number, m.id
      limit 1
    ) principal on true
    where spf.is_spf_extra""")
troca(a, """        'spf_liquido', round(d.optional_value * (v_spf_net_percent / 100), 2)
      )""", """        'spf_liquido', round(d.optional_value * (v_spf_net_percent / 100), 2),
        -- 21/10/2026: R$ 1,00 é marcador da importação NBS e não entra na comissão
        -- (mesma regra de vendedores e, a partir de agora, analistas). Continua listado.
        'conta_na_comissao', d.optional_value <> 1
      )""")

# ---------------- detalhe congelado devolvido à exportação ----------------
d_ = "master_commission_operational_detail"
troca(d_, """          'spf_liquido', d.spf_liquido
        )""", """          'spf_liquido', d.spf_liquido,
          'conta_na_comissao', d.conta_na_comissao
        )""")

# ---------------- 4 + identidade: analistas ----------------
m = "operational_analyst_commission_metrics"
troca(m, """     and spf.is_spf_extra
     and coalesce(spf.optional_value, 0) > 0
""", """     and spf.is_spf_extra
     and coalesce(spf.optional_value, 0) > 0
     -- 21/10/2026 (decisão do Luis): SPF de R$ 1,00 é marcador da importação NBS --
     -- não conta para o analista, igual à regra dos vendedores (SECURE-SPF-PLACEHOLDER-FIX-09).
     and spf.optional_value <> 1
""")
troca(m, """      a.nome_analista_substituto as analyst_name,
      bst.store""", """      a.nome_analista_substituto as analyst_name,
      a.cpf_analista_substituto as analyst_cpf,
      bst.store""")
troca(m, """      eaw.analyst_name,
      eaw.covered_start,""", """      eaw.analyst_name,
      eaw.analyst_cpf,
      eaw.covered_start,""")
troca(m, """      null::date as covered_end,
      null::text as coverage_id
    from base_store_totals st""", """      null::date as covered_end,
      null::text as coverage_id,
      -- 21/10/2026: identificador da MESMA pessoa escolhida em analyst_name acima.
      (
        select u.id
        from public.usuarios u
        where u.ativo = true
          and upper(trim(coalesce(u.perfil, ''))) = 'ANALISTA'
          and upper(trim(coalesce(u.loja, ''))) =
              upper(trim(coalesce(st.store, '')))
        order by u.nome
        limit 1
      ) as analyst_user_id
    from base_store_totals st""")
troca(m, """      covered_end,
      id as coverage_id
    from absence_metrics""", """      covered_end,
      id as coverage_id,
      -- 21/10/2026: substituto pelo CPF da ausência (nunca pelo nome).
      (
        select u.id
        from public.usuarios u
        where u.ativo = true
          and nullif(regexp_replace(coalesce(absence_metrics.analyst_cpf, ''), '\\D', '', 'g'), '') is not null
          and regexp_replace(coalesce(nullif(u.cpf_normalizado, ''), u.cpf, ''), '\\D', '', 'g')
              = regexp_replace(coalesce(absence_metrics.analyst_cpf, ''), '\\D', '', 'g')
        limit 1
      ) as analyst_user_id
    from absence_metrics""")
troca(m, """            'coverage_id', coverage_id
          )
          order by store, transfer, covered_start, analyst_name""", """            'coverage_id', coverage_id,
            'analyst_user_id', analyst_user_id
          )
          order by store, transfer, covered_start, analyst_name""")

cv = "operational_analyst_coverage_metrics"
troca(cv, """     and spf.is_spf_extra
     and coalesce(spf.optional_value, 0) > 0
""", """     and spf.is_spf_extra
     and coalesce(spf.optional_value, 0) > 0
     -- 21/10/2026: SPF de R$ 1,00 (marcador NBS) não conta para o analista.
     and spf.optional_value <> 1
""")

# ---------------- identidade: gerentes ----------------
g = "operational_salary_manager_directory"
troca(g, """      string_agg(
        distinct a.manager_name,
        ' / ' order by a.manager_name
      ) as manager_name
    from authorized a""", """      string_agg(
        distinct a.manager_name,
        ' / ' order by a.manager_name
      ) as manager_name,
      -- 21/10/2026: identificador só quando há UM gerente para a loja+departamento.
      case when count(distinct a.id) = 1 then (array_agg(a.id))[1] end as manager_id
    from authorized a""")
troca(g, """        'manager_name', s.manager_name
      ) order by s.store, s.department""", """        'manager_name', s.manager_name,
        'manager_id', s.manager_id
      ) order by s.store, s.department""")

SQL = f"""-- Fechamento de comissão — 21/10/2026 (aprovado pelo Luis), vale a partir do PRÓXIMO fechamento:
-- 1) comissão de cada pessoa em centavos; total oficial = soma das linhas gravadas;
-- 2) o fechamento grava quem é cada pessoa (usuario_id) e o CPF do cadastro (por identificador);
-- 3) auditoria SPF: código/banco/plano da linha principal + "conta na comissão" (R$ 1,00 = Não);
-- 4) analistas: SPF de R$ 1,00 (marcador NBS) deixa de contar, igual aos vendedores.
-- Fechamentos já gravados não mudam.
begin;

alter table public.snapshot_comissoes add column usuario_id uuid;
comment on column public.snapshot_comissoes.usuario_id is 'Quem é a pessoa da linha (usuarios.id), gravado pelo fechamento a partir de 21/10/2026. Vazio em fechamentos anteriores ou sem identificador confiável.';
alter table public.snapshot_operational_detail add column conta_na_comissao boolean;
comment on column public.snapshot_operational_detail.conta_na_comissao is 'Auditoria SPF: false = marcador de R$ 1,00 da importação NBS, listado mas fora da comissão. Vazio em fechamentos anteriores a 21/10/2026.';

""" + "\n\n".join(f[k] + ";" for k in FUNCS) + """

commit;
"""
VOLTA = """-- DESFAZER a mudança do fechamento de 21/10/2026: funções com o texto EXATO de antes (fech_backup.json)
-- e remoção das 2 colunas novas. ATENÇÃO: se algum fechamento já tiver sido feito depois da mudança,
-- remover as colunas apaga a identificação (usuario_id) e o "conta na comissão" gravados nele.
begin;

""" + "\n\n".join(bruto[k] + ";" for k in FUNCS) + """

alter table public.snapshot_comissoes drop column if exists usuario_id;
alter table public.snapshot_operational_detail drop column if exists conta_na_comissao;

commit;
"""
open(os.path.join(AQUI, "fech.sql"), "w", encoding="utf-8", newline="\n").write(SQL)
open(os.path.join(AQUI, "fech_rollback.sql"), "w", encoding="utf-8", newline="").write(VOLTA)
print("ok:", len(SQL), "bytes de SQL;", len(VOLTA), "bytes de desfazer;", {k: ("CRLF" if "\r\n" in v else "LF") for k, v in bruto.items()})
