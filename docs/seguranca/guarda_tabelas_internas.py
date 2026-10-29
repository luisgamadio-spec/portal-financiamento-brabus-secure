"""GUARDA (item 2, 20/10/2026) — rodar depois de TODA mudança no banco e de toda publicação do portal.
Confere que nenhum logado ou visitante consegue ler/gravar direto as tabelas internas.
Só leitura: cada teste prático roda em transação READ ONLY + ROLLBACK. Não imprime dados, só sim/não e contagens.

Cada verificação termina em um de três estados (ajuste de 26/10/2026, pedido do Luis):
  OK     — conferido e certo;
  FALHA  — conferido e ERRADO (ex.: um perfil conseguiu ler uma tabela, regra de RLS para logado, erro inesperado do banco);
  NÃO FOI POSSÍVEL CONFERIR — o banco não respondeu (erro de conexão/API, ex.: 502, tempo esgotado) mesmo depois de
         repetir a consulta até 3 vezes. Erro de conexão NUNCA conta como acesso negado nem como acesso liberado.
Toda execução grava um registro com o detalhe de cada falha (tentativas, código, trecho da mensagem) em
docs/seguranca/registros/guarda_AAAAMMDD_HHMMSS.txt (ou na pasta da variável GUARDA_REGISTROS).
Saída: 0 = tudo OK; 1 = alguma FALHA; 2 = sem falha, mas alguma verificação não pôde ser conferida.
Uso: python -I guarda_tabelas_internas.py [pasta de um clone ligado ao projeto; padrão = a pasta deste repositório]
Teste dos caminhos de erro (não use no dia a dia): GUARDA_TESTE=conexao:N (as N primeiras consultas falham por conexão),
GUARDA_TESTE=conexao:sempre, GUARDA_TESTE=liberado:<tabela> (finge que a leitura direta dessa tabela devolveu linhas)."""
import io, json, os, re, subprocess, sys, tempfile, time
from datetime import datetime
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
PROJETO = "yacqlelpzchcotgngwbh"
AQUI = os.path.dirname(os.path.abspath(__file__))
CWD = sys.argv[1] if len(sys.argv) > 1 else AQUI
TABELAS = ["configuracoes", "periodos_comissao", "ausencias_analistas", "mudancas_loja_vendedores", "analistas_fi", "chamar_analista_fi_controle",
           "bi_uso_perguntas",  # 26/10/2026: utilização da Brabus IA (só o Master lê, via master_ia_usage_data)
           # 27/10/2026: Avaliações de Seminovos (só pelas funções aval_*; consultas gravadas só pela Edge Function)
           "aval_avaliacoes", "aval_eventos", "aval_consultas_veiculo", "aval_regras_margem", "fipe_precos",
           # 28/10/2026: vistoria (Fase 2) — só pelas funções aval_vistoria_*/aval_foto_*; fotos só pela Edge Function avaliacao-fotos
           "aval_tabela_reparos", "aval_vistorias", "aval_avarias", "aval_fotos"]
PAPEIS = ("anon", "authenticated")
REPETICOES = 3                     # repetições depois da 1ª tentativa, só para erro de conexão
ESPERA = (5, 10, 20)               # segundos antes de cada repetição
if os.environ.get("GUARDA_ESPERA_S"): ESPERA = tuple([float(os.environ["GUARDA_ESPERA_S"])] * 3)  # só para teste
repeticoes_log = []   # toda tentativa que falhou por conexão, mesmo quando a repetição deu certo
TESTE = os.environ.get("GUARDA_TESTE", "")
_chamadas = [0]

def q(sql):
    """Roda a consulta. Devolve dict: tipo = 'linhas' (rows) | 'erro_banco' (codigo, msg) | 'conexao' (msg), com as tentativas."""
    tentativas = []
    for n in range(REPETICOES + 1):
        if n: time.sleep(ESPERA[n - 1])
        _chamadas[0] += 1
        if TESTE == "conexao:sempre" or (TESTE.startswith("conexao:") and TESTE[8:].isdigit() and _chamadas[0] <= int(TESTE[8:])):
            out = '{"_tag":"Error","error":{"message":"unexpected status 502: Bad gateway (SIMULADO por GUARDA_TESTE)"}}'
        else:
            fd, f = tempfile.mkstemp(prefix="guarda_", suffix=".sql")
            with os.fdopen(fd, "wb") as h: h.write(sql.encode("utf-8"))
            try:
                r = subprocess.run(["supabase", "db", "query", "--linked", "--project-ref", PROJETO, "--output-format", "json", "-f", f],
                                   cwd=CWD, capture_output=True, encoding="utf-8", errors="replace", shell=(os.name == "nt"), timeout=300)
                out = (r.stdout or "") + (r.stderr or "")
            except subprocess.TimeoutExpired:
                out = "tempo esgotado (300 s) esperando o banco"
            finally:
                os.remove(f)
        try:
            j = json.loads(out[out.index("{"):out.rindex("}") + 1])
            if isinstance(j, dict) and isinstance(j.get("rows"), list):
                if n: repeticoes_log.append(f"chamada nº {_chamadas[0]}: respondeu na tentativa {n + 1}")
                return {"tipo": "linhas", "rows": j["rows"], "tentativas": n + 1}
        except ValueError:
            pass
        m = re.search(r"ERROR:\s+([0-9A-Z]{5}):\s*([^\\\n\"]{0,200})", out)
        if m:  # o banco respondeu: é um resultado, não se repete
            if n: repeticoes_log.append(f"chamada nº {_chamadas[0]}: respondeu na tentativa {n + 1}")
            return {"tipo": "erro_banco", "codigo": m.group(1), "msg": m.group(2).strip(), "tentativas": n + 1}
        tentativas.append(" ".join(out.split())[-300:])
        repeticoes_log.append(f"chamada nº {_chamadas[0]}, tentativa {n + 1}: erro de conexão — {tentativas[-1]}")
    return {"tipo": "conexao", "msg": tentativas[-1] if tentativas else "", "tentativas": REPETICOES + 1, "historico": tentativas}

resultados = []   # (estado, nome, resumo, detalhe)
def registra(estado, nome, resumo="", detalhe=""):
    resultados.append((estado, nome, resumo, detalhe))
    rot = {"OK": "OK    ", "FALHA": "FALHA ", "NC": "NÃO FOI POSSÍVEL CONFERIR "}[estado]
    print(rot + nome + (f"  [{resumo}]" if resumo != "" else ""))
def det_conexao(r): return f"erro de conexão em {r['tentativas']} tentativa(s); última: {r['msg']}"

lista = ", ".join("'" + t + "'" for t in TABELAS)
est = q(f"""select c.relname,
  c.relrowsecurity rls,
  {" or ".join(f"has_table_privilege('{p}', c.oid, 'select,insert,update,delete,truncate,references,trigger')" for p in PAPEIS)} acesso_api,
  (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname
     and p.roles && array['anon','authenticated','public']::name[]) regras_api
from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname in ({lista}) order by 1""")
achadas = {}
if est["tipo"] == "linhas":
    achadas = {l["relname"]: l for l in est["rows"]}
    for t in TABELAS:
        l = achadas.get(t)
        if l is None: registra("FALHA", f"{t}: existe", "tabela não encontrada", "a consulta de estrutura não devolveu a tabela"); continue
        certo = l["acesso_api"] is False and l["rls"] is True and l["regras_api"] == 0
        resumo = f"acesso={l['acesso_api']} rls={l['rls']} regras={l['regras_api']}"
        registra("OK" if certo else "FALHA", f"{t}: sem permissão para visitante/logado, RLS ligada, nenhuma regra para eles", resumo, "" if certo else resumo)
else:
    d = det_conexao(est) if est["tipo"] == "conexao" else f"erro do banco {est['codigo']}: {est['msg']}"
    for t in TABELAS:
        registra("NC" if est["tipo"] == "conexao" else "FALHA", f"{t}: sem permissão para visitante/logado, RLS ligada, nenhuma regra para eles", "consulta de estrutura não respondeu" if est["tipo"] == "conexao" else "erro do banco", d)

f = q("select has_function_privilege('anon', 'public.chamar_analista_fi()', 'execute') anon_chama, "
      "has_function_privilege('authenticated', 'public.chamar_analista_fi()', 'execute') logado_chama")
nome = "chamar_analista_fi: visitante não chama; logado chama"
if f["tipo"] == "linhas":
    certo = bool(f["rows"]) and f["rows"][0]["anon_chama"] is False and f["rows"][0]["logado_chama"] is True
    registra("OK" if certo else "FALHA", nome, f["rows"], "" if certo else json.dumps(f["rows"]))
elif f["tipo"] == "conexao": registra("NC", nome, "o banco não respondeu", det_conexao(f))
else: registra("FALHA", nome, "erro do banco", f"{f['codigo']}: {f['msg']}")

tabs = TABELAS if est["tipo"] != "linhas" else [x for x in TABELAS if x in achadas]
for perfil in ("VENDEDOR", "ANALISTA", "MASTER"):
    sub = f"(select u.auth_user_id from public.usuarios u where upper(u.perfil)='{perfil}' and u.ativo and u.auth_user_id is not null order by u.id limit 1)"
    negadas, liberadas, outros, sem_resposta = [], [], [], []
    for t in tabs:
        r = q("begin; set transaction read only; "
              "do $x$ begin perform set_config('request.jwt.claims', json_build_object('sub', " + sub + ", 'role','authenticated')::text, true); end $x$; "
              f"set local role authenticated; select count(*) n from public.{t}; rollback;")
        if TESTE == f"liberado:{t}": r = {"tipo": "linhas", "rows": [{"n": 1}], "tentativas": 1}
        if r["tipo"] == "erro_banco" and r["codigo"] == "42501": negadas.append(t)
        elif r["tipo"] == "linhas": liberadas.append(t)
        elif r["tipo"] == "erro_banco": outros.append(f"{t}: erro do banco {r['codigo']} ({r['msg']})")
        else: sem_resposta.append(f"{t}: {det_conexao(r)}")
    nome = f"{perfil} real: leitura direta negada nas {len(tabs)} tabelas"
    if liberadas or outros:
        registra("FALHA", nome, f"negadas {len(negadas)}/{len(tabs)}", "; ".join([f"{t}: LEITURA LIBERADA" for t in liberadas] + outros + sem_resposta))
    elif sem_resposta:
        registra("NC", nome, f"negadas {len(negadas)}/{len(tabs)}, sem resposta em {len(sem_resposta)}", "; ".join(sem_resposta))
    else:
        registra("OK", f"{perfil} real: leitura direta negada em {len(negadas)}/{len(tabs)} tabelas")

# 28/10/2026 (loja fantasma "NACOES UNIDAS", pedido do Luis): nenhum nome de loja fora das 8 oficiais (+ REVENDA)
# nos lotes vigentes de vendas e financiamentos (só linhas com vendedor ligado), no cadastro de vendedores ativos
# e nas mudanças de loja ativas. Mostra só o nome da loja e a contagem.
LOJAS_OFICIAIS = ("ABC", "ALPHAVILLE", "ANALIA FRANCO", "BANDEIRANTES", "BARRA FUNDA", "EUROPA", "GASTAO", "NACOES", "REVENDA")
_ofi = ", ".join("'" + x + "'" for x in LOJAS_OFICIAIS)
lj = q(f"""with lb as (
  select distinct on (b.source_type) b.id, b.source_type from public.portal_import_batches b
  where b.status = 'VALIDATED' and b.source_type in ('SALES_CURRENT','SALES_HISTORY','FINANCE_CURRENT','FINANCE_HISTORY')
  order by b.source_type, b.completed_at desc nulls last, b.created_at desc, b.id desc)
select 'vendas' fonte, upper(trim(s.store)) loja, count(*) n from public.portal_sales s join lb on lb.id = s.batch_id
  where coalesce(s.seller_user_id, s.seller_id) is not null and nullif(trim(s.store), '') is not null and upper(trim(s.store)) not in ({_ofi}) group by 2
union all
select 'financiamentos', upper(trim(f.store)), count(*) from public.portal_finance_operations f join lb on lb.id = f.batch_id
  where coalesce(f.seller_user_id, f.seller_id) is not null and nullif(trim(f.store), '') is not null and upper(trim(f.store)) not in ({_ofi}) group by 2
union all
select 'cadastro de vendedores ativos', coalesce(upper(trim(u.loja)), '(sem loja)'), count(*) from public.usuarios u
  where u.ativo and upper(trim(coalesce(u.perfil, ''))) = 'VENDEDOR' and (nullif(trim(u.loja), '') is null or upper(trim(u.loja)) not in ({_ofi})) group by 2
union all
select 'mudanças de loja ativas', upper(trim(x.loja)), count(*) from public.mudancas_loja_vendedores m
  cross join lateral (values (m.loja_destino), (m.loja_origem)) x(loja)
  where m.ativo and nullif(trim(x.loja), '') is not null and upper(trim(x.loja)) not in ({_ofi}) group by 2
order by 1, 2""")
nome = "lojas: nenhum nome fora das 8 oficiais (+ REVENDA) em vendas, financiamentos, cadastro e mudanças de loja"
if lj["tipo"] == "linhas":
    fora = "; ".join(f"{r['fonte']}: {r['loja']} ({r['n']})" for r in lj["rows"])
    registra("OK" if not lj["rows"] else "FALHA", nome, "0 linhas" if not lj["rows"] else fora, fora)
elif lj["tipo"] == "conexao": registra("NC", nome, "o banco não respondeu", det_conexao(lj))
else: registra("FALHA", nome, "erro do banco", f"{lj['codigo']}: {lj['msg']}")

n_ok = sum(1 for r in resultados if r[0] == "OK"); n_f = sum(1 for r in resultados if r[0] == "FALHA"); n_nc = sum(1 for r in resultados if r[0] == "NC")
resumo = f"{n_ok}/{len(resultados)} verificações OK" + (f" | {n_f} FALHA(S)" if n_f else "") + (f" | {n_nc} NÃO FOI POSSÍVEL CONFERIR" if n_nc else "") \
    + (f" (tentativas com erro de conexão: {sum(1 for x in repeticoes_log if 'erro de conexão' in x)})" if repeticoes_log else "")
print("\n" + resumo)

pasta = os.environ.get("GUARDA_REGISTROS") or os.path.join(AQUI, "registros")
os.makedirs(pasta, exist_ok=True)
agora = datetime.now()
arq = os.path.join(pasta, "guarda_" + agora.strftime("%Y%m%d_%H%M%S") + ".txt")
with open(arq, "w", encoding="utf-8", newline="\n") as h:
    h.write(f"Guarda das tabelas internas — {agora.strftime('%d/%m/%Y %H:%M:%S')} (horário local)\nProjeto: {PROJETO}\n"
            + (f"MODO DE TESTE: GUARDA_TESTE={TESTE}\n" if TESTE else "") + f"Resultado: {resumo}\n\n")
    for estado, nome, rs, dt in resultados:
        h.write({"OK": "OK", "FALHA": "FALHA", "NC": "NÃO FOI POSSÍVEL CONFERIR"}[estado] + f" — {nome}" + (f" [{rs}]" if rs != "" else "") + "\n")
        if dt: h.write(f"    detalhe: {dt}\n")
    h.write("\nRepetições por erro de conexão: " + (str(len(repeticoes_log)) if repeticoes_log else "nenhuma") + "\n")
    for linha in repeticoes_log: h.write(f"    {linha}\n")
print("registro:", arq)
sys.exit(1 if n_f else (2 if n_nc else 0))
