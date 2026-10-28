// Avaliações de Seminovos — fotos da vistoria (Fase 2, 28/10/2026).
//
// O bucket "avaliacoes-fotos" é privado e não tem nenhuma regra de acesso: só esta função
// (chave de serviço) lê e grava nele, sempre depois de o banco conferir o acesso com o JWT
// de quem chama (perfil, loja, módulo 'avaliacoes', avaliação em rascunho).
//
//   POST ?acao=enviar&avaliacao_id=…&foto_id=…[&avaria_id=…]   corpo = a foto em JPEG (já comprimida no celular)
//        1) aval_foto_preparar (JWT do usuário) reserva o caminho <avaliacao>/<foto>.jpg
//        2) grava no bucket (chave de serviço)   3) aval_foto_registrar (chave de serviço) marca ENVIADA
//        Reenviar a mesma foto (mesmo foto_id) não duplica nada.
//   POST ?acao=ver&avaliacao_id=…   → links temporários (10 min) das fotos que essa pessoa pode ver.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGINS = new Set([
  "https://luisgamadio-spec.github.io",
  "https://brabus.blistiq.com.br",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
]);
const BUCKET = "avaliacoes-fotos";
const MAX_BYTES = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// JPEG de verdade: começa com FF D8 FF (não confia no Content-Type do navegador)
export function ehJpeg(b: Uint8Array): boolean {
  return b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

serve(async (req) => {
  const origin = req.headers.get("origin");
  const cors = {
    "Access-Control-Allow-Origin": origin && ALLOWED_ORIGINS.has(origin) ? origin : "",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
  const responde = (status: number, corpo: unknown) =>
    new Response(JSON.stringify(corpo), { status, headers: { ...cors, "Content-Type": "application/json" } });
  const erroBanco = (e: { code?: string; message: string }, padrao: string) => {
    const c = e.code;
    const status = c === "42501" ? 403 : c === "22023" ? 400 : c === "P0002" ? 404 : c === "54000" ? 429 : c === "PGRST301" ? 401 : 500;
    return responde(status, { erro: status === 500 ? padrao : e.message, code: c });
  };

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return responde(405, { erro: "Método não permitido." });

  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  const servico = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anon || !servico) return responde(500, { erro: "Função sem configuração." });

  const p = new URL(req.url).searchParams;
  const acao = p.get("acao");
  const avaliacao = p.get("avaliacao_id") ?? "";
  if (!UUID.test(avaliacao)) return responde(400, { erro: "Avaliação inválida." });

  const usuario = createClient(url, anon, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false },
  });
  const admin = createClient(url, servico, { auth: { persistSession: false } });

  if (acao === "ver") {
    const lista = await usuario.rpc("aval_fotos_listar", { p_id: avaliacao });
    if (lista.error) return erroBanco(lista.error, "Não foi possível carregar as fotos.");
    const fotos = (lista.data ?? []) as { id: string; avaria_id: string | null; caminho: string }[];
    if (!fotos.length) return responde(200, { fotos: [] });
    const links = await admin.storage.from(BUCKET).createSignedUrls(fotos.map((f) => f.caminho), 600);
    if (links.error) return responde(500, { erro: "Não foi possível carregar as fotos." });
    return responde(200, {
      fotos: fotos.map((f, i) => ({ id: f.id, avaria_id: f.avaria_id, url: links.data?.[i]?.signedUrl ?? null })),
    });
  }

  if (acao !== "enviar") return responde(400, { erro: "Ação inválida." });
  const foto = p.get("foto_id") ?? "";
  const avaria = p.get("avaria_id");
  if (!UUID.test(foto) || (avaria && !UUID.test(avaria))) return responde(400, { erro: "Foto inválida." });
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_BYTES) return responde(400, { erro: "Foto vazia ou maior que 2 MB." });
  if (!ehJpeg(bytes)) return responde(400, { erro: "A foto precisa estar em JPEG." });

  // 1) acesso + caminho reservado, sempre com a identidade de quem chama
  const prep = await usuario.rpc("aval_foto_preparar", {
    p_avaliacao: avaliacao, p_avaria: avaria || null, p_foto: foto, p_bytes: bytes.length,
  });
  if (prep.error) return erroBanco(prep.error, "Não foi possível enviar a foto.");
  const r = prep.data as { caminho: string; ja_enviada: boolean };
  if (r.ja_enviada) return responde(200, { id: foto, status: "ENVIADA", repetida: true });

  // 2) arquivo no bucket privado
  const up = await admin.storage.from(BUCKET).upload(r.caminho, bytes, { contentType: "image/jpeg", upsert: true });
  if (up.error) {
    console.error("avaliacao-fotos: falha ao gravar no bucket", up.error.message);
    return responde(502, { erro: "Não foi possível guardar a foto agora. Ela continua no celular e será reenviada." });
  }
  // 3) registro (só a chave de serviço executa)
  const reg = await admin.rpc("aval_foto_registrar", { p_foto: foto, p_bytes: bytes.length });
  if (reg.error) {
    console.error("avaliacao-fotos: falha ao registrar", reg.error.code);
    return responde(500, { erro: "Não foi possível registrar a foto." });
  }
  return responde(200, { id: foto, status: (reg.data as { status: string }).status });
});
