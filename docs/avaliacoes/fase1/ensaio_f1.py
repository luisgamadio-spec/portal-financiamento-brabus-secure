"""Ensaio SÓ LEITURA (ROLLBACK) da Fase 1 das Avaliações: aplica a migração dentro de uma transação, roda os testes
como usuários reais simulados (JWT) e termina em ROLLBACK. Nada fica gravado. Não imprime dados pessoais.
Uso: python -I ensaio_f1.py [migracao.sql] [desfazer.sql]"""
import json, os, sys, time
sys.stdout = __import__("io").TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from sq import q

AQUI = os.path.dirname(os.path.abspath(__file__))
MIG = open(sys.argv[1] if len(sys.argv) > 1 else os.path.join(AQUI, "saida", "20261027190000_avaliacoes_fase1.sql"), encoding="utf-8").read()
DESF = open(sys.argv[2] if len(sys.argv) > 2 else os.path.join(AQUI, "saida", "avaliacoes_fase1_desfazer.sql"), encoding="utf-8").read()
assert MIG.rstrip().endswith("commit;")
CORPO = MIG.rstrip()[:-len("commit;")]           # migração sem o commit final
CORPO = CORPO.replace("begin;\n", "", 1)          # o ensaio abre a própria transação

def uid(perfil, extra=""):
    return (f"(select u.auth_user_id::text from public.usuarios u where upper(u.perfil)='{perfil}' and u.ativo "
            f"and u.auth_user_id is not null {extra} order by u.id limit 1)")

COMO = lambda sub: ("do $x$ begin perform set_config('request.jwt.claims', json_build_object('sub', " + sub +
                    ", 'role','authenticated')::text, true); end $x$; set local role authenticated; ")

def bloco(nome, sql_expr):
    """roda a expressão e grava resultado ou erro (código + mensagem) em _t"""
    s = sql_expr.replace("$q$", "")
    nq = "$n$" + nome + "$n$"
    return (f"do $b$ declare r text; begin begin r := ({s})::text; insert into _t(nome, ok, valor) values ({nq}, true, left(r, 1500)); "
            f"exception when others then insert into _t(nome, ok, valor) values ({nq}, false, sqlstate || ' ' || sqlerrm); end; end $b$; ")

def roda(titulo, sql):
    for i in range(6):
        try:
            rows = q(sql); break
        except RuntimeError as e:
            if "emp" in str(e).lower() and i < 5: time.sleep(4); continue
            print("ERRO no ensaio", titulo, str(e)[-1500:]); return []
    print(f"\n=== {titulo} ===")
    for r in rows:
        print(("OK  " if r["ok"] else "ERR ") + r["nome"] + " -> " + str(r["valor"])[:700])
    return rows

PRE = ("begin; create temp table _t(n serial, nome text, ok boolean, valor text) on commit drop; "
       "create temp table _ids(k text, id uuid) on commit drop; grant select on _ids to authenticated; "
       "grant all on _t to authenticated, service_role; grant all on sequence _t_n_seq to authenticated, service_role; ")
FIM = " reset role; select nome, ok, valor from _t order by n; rollback;"

# --- 1) antes x depois da matriz de módulos para perfis existentes + Master ------------------------------
antes_depois = PRE
for p, extra in [("VENDEDOR", ""), ("GERENTE", "and u.status ilike '%SEMINOVOS%'"), ("ANALISTA", ""), ("MASTER", "")]:
    antes_depois += COMO(uid(p, extra)) + bloco(f"antes {p} modulos", "public.portal_modulos_permitidos()") + "reset role; "
antes_depois += CORPO
for p, extra in [("VENDEDOR", ""), ("GERENTE", "and u.status ilike '%SEMINOVOS%'"), ("ANALISTA", ""), ("MASTER", "")]:
    antes_depois += COMO(uid(p, extra)) + bloco(f"depois {p} modulos", "public.portal_modulos_permitidos()") + \
                    bloco(f"depois {p} aval_contexto", "(public.aval_contexto() - 'nome')") + "reset role; "
SEC = sys.argv[3] if len(sys.argv) > 3 else "1234"
r1 = "1" in SEC and roda("matriz de módulos antes x depois (só 'avaliacoes' pode aparecer a mais, e só no Master)", antes_depois + FIM)

# --- 2) fluxo do Master: regra, prévia, consulta simulada, avaliação, referências -------------------------
MOCK = json.dumps({"versoes": [
    {"marca": "MITSUBISHI", "modelo": "ECLIPSE CROSS", "versao": "HPE-S 1.5 TURBO S-AWC", "fipe_codigo": "SIM-0001", "fipe_valor": 128900,
     "fipe_mes_ref": "2026-10", "ano_modelo": 2023, "combustivel": "GASOLINA", "chassi": None},
    {"marca": "MITSUBISHI", "modelo": "ECLIPSE CROSS", "versao": "HPE 1.5 TURBO CVT", "fipe_codigo": "SIM-0002", "fipe_valor": 119500,
     "fipe_mes_ref": "2026-10", "ano_modelo": 2023, "combustivel": "GASOLINA", "chassi": None}],
    "restricoes": {"gravame": False, "leilao": False, "sinistro": False}, "ano_fabricacao": 2022, "cor": "BRANCO"})
m = PRE + CORPO + COMO(uid("MASTER"))
m += bloco("regras_listar v1", "public.aval_regras_listar()")
m += bloco("previa v1 (100.000, prep 1.500)", "public.aval_previa_calculo(100000, 1500, 0)")
m += bloco("previa v1 venda 50.000 (margem mínima 10.000)", "public.aval_previa_calculo(50000, 0, 0)")
m += bloco("salvar regra repasse MENOR que loja (deve recusar)", "public.aval_master_salvar_regra('{\"impostos_pct\":4,\"margem_loja_pct\":12,\"margem_loja_min\":10000,\"margem_repasse_pct\":10,\"margem_repasse_min\":10000}'::jsonb, 'teste')")
m += bloco("salvar regra v2 completa", "public.aval_master_salvar_regra('{\"impostos_pct\":4,\"margem_loja_pct\":12,\"margem_loja_min\":10000,\"preparacao_padrao\":1500,\"margem_repasse_pct\":15,\"margem_repasse_min\":12000,\"desconto_restricao_pct\":10,\"desconto_reprovado_pct\":25}'::jsonb, 'ensaio')")
m += bloco("previa v2 (100.000, prep padrão)", "public.aval_previa_calculo(100000, null, 2000)")
m += bloco("preparar consulta placa nova", "public.aval_consulta_preparar('abc-1d23', null)")
m += bloco("preparar placa inválida", "public.aval_consulta_preparar('AB12', null)")
m += "reset role; set local role service_role; "
m += bloco("registrar consulta (service_role)", f"public.aval_consulta_registrar({uid('MASTER').replace('auth_user_id', 'id')}::uuid, null, 'ABC1D23', null, 'SIMULADO', true, $j${MOCK}$j$::jsonb, 0)")
m += "reset role; insert into _ids select 'consulta', id from public.aval_consultas_veiculo order by criado_em desc limit 1; " + COMO(uid("MASTER"))
m += bloco("registrar consulta direto como logado (deve negar)", f"public.aval_consulta_registrar(null, null, 'ABC1D23', null, 'X', true, '{{\"versoes\":[]}}'::jsonb, 0)")
m += bloco("preparar mesma placa (cache)", "(public.aval_consulta_preparar('ABC1D23', null) - 'resultado')")
m += bloco("salvar sem loja (Master tem que escolher)", "public.aval_salvar_identificacao(null, '{\"placa\":\"ABC1D23\",\"km\":\"35000\",\"ano_fabricacao\":2022,\"ano_modelo\":2023,\"carroceria\":\"SUV\",\"modelo\":\"X\"}'::jsonb)")
m += bloco("salvar com versão fora da consulta (deve recusar)", "public.aval_salvar_identificacao(null, jsonb_build_object('loja','GASTAO','placa','ABC1D23','km','35000','ano_fabricacao',2022,'ano_modelo',2023,'carroceria','SUV','consulta_id',(select id from _ids where k='consulta'),'fipe_codigo','NAO-EXISTE'))")
m += bloco("salvar avaliação GASTAO", "public.aval_salvar_identificacao(null, jsonb_build_object('loja','GASTAO','placa','ABC1D23','km','35.000','ano_fabricacao',2022,'ano_modelo',2023,'carroceria','SUV','cor','branco','consulta_id',(select id from _ids where k='consulta'),'fipe_codigo','SIM-0001','ano_modelo_fipe','2023'))")
m += "reset role; insert into _ids select 'aval', id from public.aval_avaliacoes order by criado_em desc limit 1; " + COMO(uid("MASTER"))
m += bloco("listar", "(select jsonb_agg(x - 'id' - 'criado_em' - 'atualizado_em' - 'avaliador') from jsonb_array_elements(public.aval_listar()) x)")
m += bloco("obter", "(select public.aval_obter(id) - 'id' - 'consulta_id' - 'avaliador_id' - 'avaliador' - 'criado_em' - 'atualizado_em' from _ids where k='aval')")
m += bloco("referencias termo padrão (modelo)", "(select (public.aval_referencias(id, null) - 'ultimas_vendas') from _ids where k='aval')")
m += bloco("referencias termo 'ECLIPSE CROSS HPE'", "(select (public.aval_referencias(id, 'eclipse cross hpe') - 'ultimas_vendas') from _ids where k='aval')")
m += bloco("ultimas vendas (3 primeiras, sem pessoas)", "(select jsonb_path_query_array(public.aval_referencias(id, null), '$.ultimas_vendas[0 to 2]') from _ids where k='aval')")
m += bloco("descartar", "(select public.aval_descartar(id, 'ensaio') - 'id' from _ids where k='aval')")
m += bloco("listar depois de descartar (vazio)", "public.aval_listar()")
m += bloco("convidar AVALIADOR sem loja (deve recusar)", "public.master_convidar_usuario('00000000272', 'Teste Avaliador', 'AVALIADOR', null, 'teste.avaliador@exemplo.invalido')")
m += bloco("convidar AVALIADOR com loja", "(public.master_convidar_usuario('00000000272', 'Teste Avaliador', 'AVALIADOR', 'NACOES', 'teste.avaliador@exemplo.invalido') - 'convite_id' - 'usuario_id' - 'email')")
r2 = "2" in SEC and roda("fluxo do Master", m + FIM)

# --- 3) Avaliador (vendedor promovido SÓ dentro da transação) e Gerente com o módulo ligado ----------------
a = PRE + CORPO
a += "create temp table _av on commit drop as select id, auth_user_id, loja from public.usuarios where upper(perfil)='VENDEDOR' and ativo and auth_user_id is not null and loja is not null order by id limit 1; "
a += "grant select on _av to authenticated; "
a += "update public.usuarios set perfil='AVALIADOR', status='SEMINOVOS' where id = (select id from _av); "
A = "(select auth_user_id::text from _av)"
a += COMO(A)
a += bloco("avaliador módulos", "public.portal_modulos_permitidos()")
a += bloco("avaliador contexto", "(public.aval_contexto() - 'nome' - 'loja')")
a += bloco("avaliador regras (deve negar)", "public.aval_regras_listar()")
a += bloco("avaliador salva na PRÓPRIA loja (ignora loja pedida)", "public.aval_salvar_identificacao(null, '{\"loja\":\"ABC\",\"placa\":\"QWE4R56\",\"km\":\"80000\",\"ano_fabricacao\":2019,\"ano_modelo\":2020,\"carroceria\":\"PICKUP\",\"modelo\":\"L200 TRITON\"}'::jsonb) - 'id'")
a += bloco("avaliador lista", "jsonb_array_length(public.aval_listar())")
a += "reset role; "
# avaliação de OUTRA loja, criada pelo Master, não pode aparecer para o avaliador
a += COMO(uid("MASTER")) + bloco("master cria em outra loja", "public.aval_salvar_identificacao(null, jsonb_build_object('loja', (select case when loja='ABC' then 'EUROPA' else 'ABC' end from _av),'placa','ZZZ9Z99','km','10','ano_fabricacao',2024,'ano_modelo',2025,'carroceria','HATCH','modelo','ONIX')) - 'id'") + "reset role; "
a += "insert into _ids select 'outra', id from public.aval_avaliacoes where placa='ZZZ9Z99'; "
a += bloco("loja gravada = loja do avaliador", "(select (a.loja = (select loja from _av))::text from public.aval_avaliacoes a where placa='QWE4R56')")
a += COMO(A)
a += bloco("avaliador lista (continua 1)", "jsonb_array_length(public.aval_listar())")
a += bloco("avaliador abre a de outra loja (deve negar)", "public.aval_obter((select id from _ids where k='outra'))")
a += bloco("avaliador lê tabela direto (deve negar)", "(select count(*) from public.aval_avaliacoes)")
a += bloco("avaliador lê consultas direto (deve negar)", "(select count(*) from public.aval_consultas_veiculo)")
a += "reset role; "
a += COMO(uid("VENDEDOR")) + bloco("vendedor aval_listar (deve negar)", "public.aval_listar()") + "reset role; "
a += "update public.permissoes_modulos set permitido = true where modulo_id='avaliacoes' and perfil='GERENTE'; "
a += COMO(uid("GERENTE", "and u.status ilike '%SEMINOVOS%' and u.loja is not null")) + \
     bloco("gerente seminovos (módulo ligado) contexto", "(public.aval_contexto() - 'nome' - 'loja')") + "reset role; "
a += COMO(uid("GERENTE", "and u.status not ilike '%SEMINOVOS%'")) + \
     bloco("gerente só novos (deve negar)", "public.aval_contexto()") + "reset role; "
r3 = "3" in SEC and roda("Avaliador, Vendedor e Gerente", a + FIM)

# --- 4) desfazer depois da migração, na mesma transação ------------------------------------------------
DCORPO = DESF.replace("begin;\n", "", 1).rstrip()
assert DCORPO.endswith("commit;"); DCORPO = DCORPO[:-len("commit;")]
d = PRE + CORPO + DCORPO
d += bloco("depois do desfazer: tabelas aval", "(select count(*) from pg_class where relname like 'aval\\_%' and relnamespace='public'::regnamespace)")
d += bloco("depois do desfazer: módulo", "(select count(*) from public.modulos_portal where id='avaliacoes')")
d += bloco("depois do desfazer: funções iguais ao backup", "(select string_agg(p.proname || '=' || md5(pg_get_functiondef(p.oid)), ' ') from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('master_convidar_usuario','master_atualizar_autorizacao_usuario','master_provisionar_usuario','portal_modulos_permitidos'))")
d += bloco("depois do desfazer: constraint", "(select pg_get_constraintdef(oid) from pg_constraint where conname='usuarios_perfil_check')")
r4 = "4" in SEC and roda("desfazer", d + FIM)

estado = q("select (select count(*) from pg_class where relname like 'aval\\_%' and relnamespace='public'::regnamespace) tabelas_aval, "
           "(select count(*) from public.modulos_portal where id='avaliacoes') modulo")
print("\nestado real depois do ensaio (esperado 0 e 0):", estado)
