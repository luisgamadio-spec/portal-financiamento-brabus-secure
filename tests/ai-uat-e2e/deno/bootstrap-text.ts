// IA-UAT-02 -- boots the REAL, unmodified portal-ai-homolog/index.ts
// against the local mock backend. Run with:
//   deno run --allow-net --allow-env --import-map=import_map.json bootstrap-text.ts
// Required env vars (set by the harness launcher, not hardcoded here):
//   UAT_LOCAL_PORT, UAT_MOCK_BASE, SUPABASE_URL, SUPABASE_ANON_KEY,
//   SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY
import "./fetch-patch.ts";
await import("../../../supabase/functions/portal-ai-homolog/index.ts");
