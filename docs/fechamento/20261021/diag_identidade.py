"""Quais campos de identidade as fontes da prévia do fechamento devolvem (só nomes de campos e contagens). Só leitura, como Master."""
import io, os, sys
AQUI = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, os.path.join(AQUI, "apoio"))
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
from harness import rpc_real
P = {"p_start": "2026-09-22", "p_end": "2026-10-20"}
for fn in ("operational_commission_metrics", "operational_analyst_commission_metrics_v2", "operational_salary_manager_directory"):
    r = rpc_real(fn, P); b = r["body"]
    rows = b.get("rows") if isinstance(b, dict) else b
    rows = rows or []
    chaves = sorted(rows[0].keys()) if rows else []
    ident = [k for k in chaves if any(x in k for x in ("id", "cpf", "user"))]
    print(fn, "| status", r["status"], "| linhas", len(rows), "| campos de identidade:", ident)
    for k in ident: print(f"    {k}: preenchido em {sum(1 for x in rows if x.get(k) not in (None, ''))}/{len(rows)}")
print("gestor (master_admin_security_data → identidade usada):", "ver loadGestorIdentity: devolve nome + cpf")
