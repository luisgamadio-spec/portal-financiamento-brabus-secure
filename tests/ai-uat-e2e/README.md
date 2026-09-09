# IA-UAT-02 end-to-end harness

Drives the REAL frontend + REAL `portal-ai-homolog`/
`portal-voice-homolog`/`portal-realtime-homolog` source through a real
browser. Only the Supabase and OpenAI network boundaries are mocked —
see `docs/IA-UAT-02-EVIDENCE.md` for the full architecture and results.

## One-time setup

Playwright's Node package + Chromium aren't installed in the repo
(would risk `node_modules` landing in a commit — `node_modules` isn't
gitignored at the repo root). Install them somewhere outside the repo:

```bash
mkdir -p /path/outside/repo/uat-tools && cd /path/outside/repo/uat-tools
npm init -y
npm install playwright@1.62.1
npx playwright install chromium
```

## Running it

From the repo root, in 4 separate terminals/background jobs (ports are
fixed by convention, not required — adjust the env vars together if
you change one):

```bash
# 1. Mock backend + static frontend (Supabase Auth/REST/RPC + OpenAI mock, all on :8080)
UAT_TEXT_PORT=8801 UAT_VOICE_PORT=8802 UAT_REALTIME_PORT=8803 \
  node tests/ai-uat-e2e/mock-backend.mjs 8080

# 2. Real portal-ai-homolog (unmodified source) on :8801
cd tests/ai-uat-e2e/deno
UAT_LOCAL_PORT=8801 UAT_MOCK_BASE=http://127.0.0.1:8080 \
SUPABASE_URL=http://127.0.0.1:8080 SUPABASE_ANON_KEY=uat-anon-key \
SUPABASE_SERVICE_ROLE_KEY=uat-service-key OPENAI_API_KEY=uat-dummy-openai-key \
  npx --yes deno run --allow-net --allow-env --import-map=import_map.json bootstrap-text.ts

# 3. Real portal-voice-homolog on :8802 (same env vars, UAT_LOCAL_PORT=8802, bootstrap-voice.ts, no import-map)
# 4. Real portal-realtime-homolog on :8803 (same env vars, UAT_LOCAL_PORT=8803, bootstrap-realtime.ts, no import-map)
```

Then, with Playwright installed per above:

```bash
UAT_PLAYWRIGHT_PATH=/path/outside/repo/uat-tools/node_modules/playwright/index.js \
  node tests/ai-uat-e2e/playwright-uat.mjs
```

`selftest-text.mjs` is a faster HTTP-only sanity check of the TEXT
function alone (no browser needed) — useful when iterating on the
mock backend or bootstrap scripts before layering Playwright on top:

```bash
node tests/ai-uat-e2e/selftest-text.mjs http://127.0.0.1:8801
```

## Files

- `mock-backend.mjs` — Node HTTP server: serves the real static
  frontend, mocks Supabase Auth/REST/RPC with disclosed synthetic
  fixtures, mocks OpenAI (a scripted "model" that only picks which
  tool to call for known test prompts and narrates real tool results —
  never computes a financial number itself), and reverse-proxies
  `/functions/v1/<name>` to the 3 real Deno processes.
- `deno/fetch-patch.ts` — monkey-patches `fetch`/`Deno.serve` so the
  real source's OpenAI calls are redirected to the mock and each
  function binds to a harness-chosen port, without touching source.
- `deno/shim-http-server.ts` + `deno/import_map.json` — redirects
  portal-ai-homolog's own `std/http/server.ts` import the same way
  (it uses the older `serve()` helper, not `Deno.serve` directly).
- `deno/bootstrap-{text,voice,realtime}.ts` — one-line loaders that
  apply the patch then `import()` the real, unmodified `index.ts`.
- `selftest-text.mjs` — HTTP-level sanity pass over the TEXT function.
- `playwright-uat.mjs` — the full browser-driven scenario suite.
- `evidence.json` — machine-readable output of the last Playwright run.
