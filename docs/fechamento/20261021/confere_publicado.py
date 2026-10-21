"""Espera o GitHub Pages servir a versão nova e confere os ?v= (sha256[:10] do conteúdo com LF). Uso: python -I confere_publicado.py <clone> <url base>"""
import hashlib, re, sys, time, urllib.request, os
clone, base = sys.argv[1], sys.argv[2].rstrip("/") + "/"
ARQS = sys.argv[3:]
idx_local = open(os.path.join(clone, "index.html"), encoding="utf-8").read()
ref = {a: re.search(re.escape(a) + r"\?v=([0-9a-f]{10})", idx_local).group(1) for a in ARQS}
def get(u): return urllib.request.urlopen(urllib.request.Request(u + ("&" if "?" in u else "?") + "nc=" + str(time.time()), headers={"Cache-Control": "no-cache"}), timeout=30).read()
for n in range(60):
    try:
        idx = get(base + "index.html").decode("utf-8")
        if all(f"{a}?v={ref[a]}" in idx for a in ARQS):
            ok = True
            for a in ARQS:
                h = hashlib.sha256(get(base + a + "?v=" + ref[a]).replace(b"\r\n", b"\n")).hexdigest()[:10]
                print(("OK   " if h == ref[a] else "FALHA"), a, "ref=" + ref[a], "servido=" + h); ok &= h == ref[a]
            print(f"PUBLICADO após {n + 1} tentativa(s)", "— tudo certo" if ok else "— DIVERGENTE"); sys.exit(0 if ok else 1)
    except Exception as e: print("tentativa", n + 1, type(e).__name__)
    time.sleep(20)
print("não publicou em 20 minutos"); sys.exit(2)
