// IA-UAT-02 harness -- monkey-patches the GLOBAL fetch (and, for
// portal-voice-homolog/portal-realtime-homolog, Deno.serve's default
// port) BEFORE dynamically importing the real, unmodified source. Two
// things are redirected, both external-boundary-only (Gate 5):
//
// 1. Any call to https://api.openai.com/* is rewritten to hit the
//    local mock backend's /openai/* routes instead. The real source
//    never knows -- it still calls the exact same OpenAI URLs it
//    calls in production.
// 2. Deno.serve(handler) (used verbatim, no options, in
//    portal-voice-homolog/portal-realtime-homolog) is wrapped so it
//    binds to a harness-controlled port (UAT_LOCAL_PORT) instead of
//    the default 8000, so multiple functions can run side by side
//    without a port collision. portal-ai-homolog uses the OLDER
//    std/http serve() instead, redirected via import_map.json/
//    shim-http-server.ts (a separate mechanism), not this one.
//
// Nothing here touches Supabase URLs -- those are pointed at the mock
// backend simply via the SUPABASE_URL/SUPABASE_ANON_KEY/
// SUPABASE_SERVICE_ROLE_KEY env vars the harness sets before running
// this process, exactly the same knobs the real deployed function
// reads (no patching needed for that boundary).

const MOCK_BASE = Deno.env.get("UAT_MOCK_BASE") || "http://127.0.0.1:8790";

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const originalUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (originalUrl.startsWith("https://api.openai.com/")) {
    const rewritten = MOCK_BASE + "/openai" + originalUrl.slice("https://api.openai.com".length);
    console.log(`[uat-fetch-patch] ${originalUrl} -> ${rewritten}`);
    if (input instanceof Request) {
      return realFetch(new Request(rewritten, input), init);
    }
    return realFetch(rewritten, init);
  }
  return realFetch(input as any, init);
}) as typeof fetch;

const realServe = Deno.serve;
// deno-lint-ignore no-explicit-any
(Deno as any).serve = (...args: any[]) => {
  const port = Number(Deno.env.get("UAT_LOCAL_PORT") || 8000);
  if (args.length === 1 && typeof args[0] === "function") {
    return realServe({ port, hostname: "127.0.0.1", onListen: () => console.log(`[uat-fetch-patch] Deno.serve listening on http://127.0.0.1:${port}`) }, args[0]);
  }
  return realServe(...(args as Parameters<typeof realServe>));
};
