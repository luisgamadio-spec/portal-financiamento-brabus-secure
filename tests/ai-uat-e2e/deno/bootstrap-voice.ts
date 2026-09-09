// IA-UAT-02 -- boots the REAL, unmodified portal-voice-homolog/index.ts
// against the local mock backend. Run with:
//   deno run --allow-net --allow-env bootstrap-voice.ts
import "./fetch-patch.ts";
await import("../../../supabase/functions/portal-voice-homolog/index.ts");
