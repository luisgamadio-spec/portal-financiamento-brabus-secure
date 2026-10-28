"""Ensaio da Fase 2 (vistoria) numa transação que termina em ROLLBACK: aplica a migração, faz uma vistoria
completa como Master real (logado) e confere recusas, fotos, checklist, conclusão, tabela de reparos e acessos.
Nada fica gravado. Uso: python -I ensaio_f2.py <pasta do scratchpad com sq.py>"""
import io, json, os, sys, time
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, sys.argv[1])
from sq import q

mig = open(os.path.join(AQUI, "20261028150000_avaliacoes_fase2_vistoria.sql"), encoding="utf-8").read()
mig = mig[mig.index("begin;") + len("begin;"):mig.rindex("commit;")]

def como(perfil):
    sub = f"(select u.auth_user_id from public.usuarios u where upper(u.perfil)='{perfil}' and u.ativo and u.auth_user_id is not null order by u.id limit 1)"
    return ("reset role; do $x$ begin perform set_config('request.jwt.claims', json_build_object('sub', " + sub +
            ", 'role','authenticated')::text, true); end $x$; set local role authenticated; ")

def passo(nome, corpo):
    """corpo plpgsql; o que ele 'retorna' vai em v_res (jsonb). Erro vira 'ERRO código mensagem'."""
    return (f"do $p$ declare v_res jsonb; v_id uuid := (select v::uuid from _v where k = 'av'); begin {corpo} "
            f"insert into _r values ('{nome}', coalesce(v_res::text, 'ok')); "
            f"exception when others then insert into _r values ('{nome}', 'ERRO ' || sqlstate || ' ' || sqlerrm); end $p$; ")

A1, A2, A3, A4 = "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"
F1, F2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
est = lambda avs, chk: json.dumps({"avarias": avs, "checklist": chk}, ensure_ascii=False).replace("'", "''")
av = lambda i, peca, tipo, g, obs=None: {"id": i, "peca": peca, "tipo": tipo, "gravidade": g, "observacao": obs}
CHK_TODO = {"interior": "BOM", "luzes_painel": "NENHUMA", "ar_condicionado": "GELA", "chave_reserva": "TEM", "manual": "NAO_TEM", "revisoes": "PARCIAIS"}

sql = ("begin; " + mig + "\n create temp table _r(passo text, res text) on commit drop; create temp table _v(k text, v text) on commit drop; "
       "grant all on _r, _v to authenticated; " + como("MASTER") +
       passo("cria avaliação", "v_res := public.aval_salvar_identificacao(null, '{\"placa\":\"TST1A23\",\"km\":\"45000\",\"ano_fabricacao\":\"2022\",\"ano_modelo\":\"2023\",\"carroceria\":\"SUV\",\"modelo\":\"ECLIPSE CROSS\",\"versao\":\"HPE-S\",\"loja\":\"NACOES\"}'::jsonb); insert into _v values ('av', v_res->>'id');") +
       passo("vistoria vazia", "v_res := public.aval_vistoria_obter(v_id);") +
       passo("salva 3 avarias + checklist parcial", f"v_res := public.aval_vistoria_salvar(v_id, '{est([av(A1, 'Porta dianteira esquerda', 'Amassado', 'MEDIA'), av(A2, 'Para-brisa', 'Trinca/quebra', 'GRAVE'), av(A3, 'Pneu estepe', 'Desgaste', 'LEVE')], {'interior': 'BOM'})}'::jsonb);") +
       passo("reenvio igual (idempotente)", f"v_res := jsonb_build_object('n', jsonb_array_length((public.aval_vistoria_salvar(v_id, '{est([av(A1, 'Porta dianteira esquerda', 'Amassado', 'MEDIA'), av(A2, 'Para-brisa', 'Trinca/quebra', 'GRAVE'), av(A3, 'Pneu estepe', 'Desgaste', 'LEVE')], {'interior': 'BOM'})}'::jsonb))->'avarias'));") +
       "reset role; " + passo("linhas gravadas depois do reenvio", "v_res := to_jsonb((select count(*) from public.aval_avarias where avaliacao_id = v_id));") + como("MASTER") +
       passo("RECUSA peça inventada", f"v_res := public.aval_vistoria_salvar(v_id, '{est([av(A4, 'Asa traseira', 'Risco', 'LEVE')], {})}'::jsonb);") +
       passo("RECUSA amassado no vidro", f"v_res := public.aval_vistoria_salvar(v_id, '{est([av(A4, 'Para-brisa', 'Amassado', 'LEVE')], {})}'::jsonb);") +
       passo("RECUSA gravidade inválida", f"v_res := public.aval_vistoria_salvar(v_id, '{est([av(A4, 'Capô', 'Risco', 'MEDIO')], {})}'::jsonb);") +
       passo("RECUSA resposta de checklist", f"v_res := public.aval_vistoria_salvar(v_id, '{est([], {'interior': 'OTIMO'})}'::jsonb);") +
       passo("coluna B: tipo de estrutura aceito", f"v_res := public.aval_vistoria_salvar(v_id, '{est([av(A1, 'Porta dianteira esquerda', 'Amassado', 'MEDIA'), av(A2, 'Para-brisa', 'Trinca/quebra', 'GRAVE'), av(A3, 'Pneu estepe', 'Desgaste', 'LEVE'), av(A4, 'Coluna B direita', 'Trinca/solda', 'GRAVE')], {'interior': 'BOM'})}'::jsonb) - 'checklist';") +
       passo("RECUSA concluir com checklist incompleto", "v_res := public.aval_vistoria_concluir(v_id);") +
       passo("checklist completo", f"v_res := public.aval_vistoria_salvar(v_id, '{est([av(A1, 'Porta dianteira esquerda', 'Amassado', 'MEDIA'), av(A2, 'Para-brisa', 'Trinca/quebra', 'GRAVE'), av(A3, 'Pneu estepe', 'Desgaste', 'LEVE'), av(A4, 'Coluna B direita', 'Trinca/solda', 'GRAVE')], CHK_TODO)}'::jsonb) - 'avarias';") +
       passo("RECUSA concluir sem fotos", "v_res := public.aval_vistoria_concluir(v_id);") +
       passo("RECUSA foto de avaria não salva", f"v_res := public.aval_foto_preparar(v_id, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', '{F1}', 250000);") +
       passo("RECUSA foto acima de 2 MB", f"v_res := public.aval_foto_preparar(v_id, '{A1}', '{F1}', 3000000);") +
       passo("prepara foto da porta", f"v_res := public.aval_foto_preparar(v_id, '{A1}', '{F1}', 250000);") +
       passo("prepara de novo (mesmo caminho)", f"v_res := public.aval_foto_preparar(v_id, '{A1}', '{F1}', 250000);") +
       passo("RECUSA logado registrar envio", f"v_res := public.aval_foto_registrar('{F1}', 250000);") +
       "reset role; " + passo("serviço registra envio (porta)", f"v_res := public.aval_foto_registrar('{F1}', 250000);") + como("MASTER") +
       passo("foto do para-brisa e da coluna", f"perform public.aval_foto_preparar(v_id, '{A2}', '{F2}', 300000); perform public.aval_foto_preparar(v_id, '{A4}', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 300000);") +
       "reset role; " + passo("serviço registra (para-brisa e coluna)", f"perform public.aval_foto_registrar('{F2}', 300000); perform public.aval_foto_registrar('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 300000);") + como("MASTER") +
       passo("conclui", "v_res := public.aval_vistoria_concluir(v_id) - 'avarias';") +
       passo("fotos que o logado pode ver", "v_res := public.aval_fotos_listar(v_id);") +
       passo("tabela de reparos v1 (a definir)", "v_res := jsonb_build_object('versoes', jsonb_array_length(public.aval_reparos_listar()), 'porta', public.aval_reparos_listar()->0->'itens'->'Porta');") +
       passo("Master preenche porta/para-brisa/pneu/coluna", "v_res := public.aval_master_salvar_reparos('{\"Porta\":{\"LEVE\":\"350\",\"MEDIA\":\"900\",\"GRAVE\":\"2500\"},\"Para-brisa\":{\"GRAVE\":\"1800\"},\"Pneu\":{\"LEVE\":\"0\"},\"Coluna\":{\"GRAVE\":\"4000\"},\"Inventado\":{\"LEVE\":\"1\"}}'::jsonb, 'teste') - 'itens';") +
       passo("total com tudo definido", "v_res := public.aval_vistoria_obter(v_id) - 'avarias' - 'checklist';") +
       passo("RECUSA valor negativo na tabela", "v_res := public.aval_master_salvar_reparos('{\"Porta\":{\"LEVE\":\"-5\"}}'::jsonb, '');") +
       passo("tira a avaria do pneu: reabre", f"v_res := public.aval_vistoria_salvar(v_id, '{est([av(A1, 'Porta dianteira esquerda', 'Amassado', 'MEDIA'), av(A2, 'Para-brisa', 'Trinca/quebra', 'GRAVE'), av(A4, 'Coluna B direita', 'Trinca/solda', 'GRAVE')], CHK_TODO)}'::jsonb) - 'avarias' - 'checklist';") +
       passo("tira a porta", f"perform public.aval_vistoria_salvar(v_id, '{est([av(A2, 'Para-brisa', 'Trinca/quebra', 'GRAVE'), av(A4, 'Coluna B direita', 'Trinca/solda', 'GRAVE')], CHK_TODO)}'::jsonb);") +
       "reset role; " + passo("fotos depois de tirar a porta", "v_res := (select jsonb_object_agg(id, status) from public.aval_fotos where avaliacao_id = v_id);") +
       passo("eventos", "v_res := (select jsonb_agg(tipo order by id) from public.aval_eventos where avaliacao_id = v_id);") +
       como("VENDEDOR") +
       passo("RECUSA vendedor obter vistoria", "v_res := public.aval_vistoria_obter(v_id);") +
       passo("RECUSA vendedor ler aval_avarias direto", "v_res := to_jsonb((select count(*) from public.aval_avarias));") +
       passo("RECUSA vendedor ler storage do bucket", "v_res := to_jsonb((select count(*) from storage.objects where bucket_id = 'avaliacoes-fotos'));") +
       "reset role; " +
       "insert into _r select 'anon executa vistoria_obter / foto_registrar', has_function_privilege('anon', 'public.aval_vistoria_obter(uuid)', 'execute')::text || ' / ' || has_function_privilege('authenticated', 'public.aval_foto_registrar(uuid,integer)', 'execute')::text; "
       "insert into _r select 'bucket', (select jsonb_build_object('public', public, 'limite', file_size_limit, 'mime', allowed_mime_types)::text from storage.buckets where id = 'avaliacoes-fotos'); "
       "insert into _r select 'tabelas fechadas', (select jsonb_object_agg(relname, jsonb_build_object('rls', relrowsecurity, 'api', has_table_privilege('authenticated', oid, 'select,insert,update,delete'))) from pg_class where relnamespace = 'public'::regnamespace and relname in ('aval_tabela_reparos','aval_vistorias','aval_avarias','aval_fotos'))::text; "
       "select passo, res from _r; rollback;")

for i in range(5):
    try: rows = q(sql); break
    except RuntimeError as e:
        if "emp" in str(e).lower() and i < 4: time.sleep(4); continue
        raise
for r in rows:
    print(f"- {r['passo']}: {r['res'][:600]}")
print("\nconferência depois do ROLLBACK (tudo deve ser 0):",
      q("select (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relname like 'aval_%' and relname in ('aval_tabela_reparos','aval_vistorias','aval_avarias','aval_fotos')) tabelas, "
        "(select count(*) from storage.buckets where id = 'avaliacoes-fotos') bucket, "
        "(select count(*) from public.aval_avaliacoes where placa = 'TST1A23') avaliacao_teste")[0])
