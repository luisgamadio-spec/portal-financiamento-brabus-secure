"""Roda um .sql no projeto ligado e devolve as linhas (JSON). Uso: from sq import q; q(sql) ou python sq.py arquivo.sql"""
import json, os, subprocess, sys, tempfile
REPO = r"C:\Projetos\brabus-intelligence-v1-local"

def q(sql):
    fd, f = tempfile.mkstemp(prefix="sq_", suffix=".sql")  # nome único: nunca colide com outra sessão/processo
    with os.fdopen(fd, "w", encoding="utf-8") as fh: fh.write(sql)
    r = subprocess.run(["supabase", "db", "query", "--linked", "--project-ref", "yacqlelpzchcotgngwbh", "--output-format", "json", "-f", f],
                       cwd=REPO, capture_output=True, text=True, encoding="utf-8", shell=True)
    try: os.remove(f)
    except OSError: pass
    out = r.stdout
    if '"rows"' not in out:
        raise RuntimeError(((r.stderr or "") + out)[-3000:])
    return json.loads(out[out.index("{"):])["rows"]

if __name__ == "__main__":
    sys.stdout = __import__("io").TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    print(json.dumps(q(open(sys.argv[1], encoding="utf-8").read()), ensure_ascii=False, indent=1))

