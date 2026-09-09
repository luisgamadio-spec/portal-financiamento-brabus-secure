// IA-UAT-02 harness shim -- redirects portal-ai-homolog/index.ts's
// own `import { serve } from "https://deno.land/std@0.168.0/http/server.ts"`
// (via --import-map) to this file, so the real, UNMODIFIED source can
// bind to a harness-controlled local port instead of std's hardcoded
// default (port 8000, which would collide with the other 2 functions
// when running all three side by side). Behavior is otherwise
// identical to the real std serve(): same handler signature, same
// semantics -- only the bind port/hostname is sourced from an env var
// instead of being omitted.
export async function serve(
  handler: (req: Request) => Response | Promise<Response>,
  _options?: { port?: number; hostname?: string }
): Promise<void> {
  const port = Number(Deno.env.get("UAT_LOCAL_PORT") || 8000);
  const server = Deno.serve({ port, hostname: "127.0.0.1", onListen: () => {
    console.log(`[uat-shim] listening on http://127.0.0.1:${port}`);
  } }, handler);
  await server.finished;
}
