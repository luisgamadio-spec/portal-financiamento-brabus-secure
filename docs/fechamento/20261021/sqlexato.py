"""Roda SQL no projeto ligado via arquivo, gravado BYTE A BYTE (sem trocar LF por CRLF). Devolve as linhas ou levanta RuntimeError."""
import json, os, subprocess, tempfile, time
REPO = r"C:\Projetos\brabus-intelligence-v1-local"
def sql(q, timeout=600, tentativas=5):
    fd, f = tempfile.mkstemp(prefix="sqx_", suffix=".sql")
    with os.fdopen(fd, "wb") as fh: fh.write(q.encode("utf-8"))
    try:
        for n in range(tentativas):
            r = subprocess.run(["supabase", "db", "query", "--linked", "--project-ref", "yacqlelpzchcotgngwbh", "--output-format", "json", "-f", f],
                               cwd=REPO, capture_output=True, encoding="utf-8", errors="replace", shell=True, timeout=timeout)
            s = (r.stdout or "") + (r.stderr or "")
            if "LegacyDbConfigConnectTempRole" not in s: break
            time.sleep(4 + 3 * n)
    finally: os.remove(f)
    if '"rows"' not in (r.stdout or ""): raise RuntimeError(s[-3000:])
    out = r.stdout; return json.loads(out[out.index("{"):])["rows"]
