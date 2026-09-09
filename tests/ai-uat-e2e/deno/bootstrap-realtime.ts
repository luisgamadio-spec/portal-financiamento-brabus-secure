// IA-UAT-02 -- boots the REAL, unmodified portal-realtime-homolog/index.ts
// against the local mock backend. Run with:
//   deno run --allow-net --allow-env bootstrap-realtime.ts
import "./fetch-patch.ts";
await import("../../../supabase/functions/portal-realtime-homolog/index.ts");
