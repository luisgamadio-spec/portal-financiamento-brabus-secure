// Avaliações de Seminovos — consulta de placa/chassi (Fase 1, 27/10/2026).
//
// Fluxo (a chave do fornecedor só existe aqui, como segredo da função):
//  1) aval_consulta_preparar() com o JWT de quem chama: confere perfil, loja, módulo
//     'avaliacoes', limite diário e cache de 30 dias (a mesma placa não é paga duas vezes);
//  2) consulta o fornecedor (SIMULADO até a cotação fechar) e passa o retorno pela lista
//     fechada de campos do veículo (fornecedor.ts) — nada do proprietário é gravado;
//  3) aval_consulta_registrar() com a chave de serviço grava o retorno já filtrado
//     (o navegador não consegue gravar consultas falsas no cache).
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { consultarReal, consultarSimulado, type Resultado } from "./fornecedor.ts";

const ALLOWED_ORIGINS = new Set([
  "https://luisgamadio-spec.github.io",
  "https://brabus.blistiq.com.br",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
]);

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

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return responde(405, { erro: "Método não permitido." });

  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  const servico = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anon || !servico) return responde(500, { erro: "Função sem configuração." });

  let corpo: { placa?: string; chassi?: string };
  try { corpo = await req.json(); } catch { return responde(400, { erro: "Requisição inválida." }); }

  // 1) autorização, limite e cache — sempre com a identidade de quem chama
  const usuario = createClient(url, anon, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false },
  });
  const prep = await usuario.rpc("aval_consulta_preparar", { p_placa: corpo.placa ?? null, p_chassi: corpo.chassi ?? null });
  if (prep.error) {
    const c = prep.error.code;
    const status = c === "42501" ? 403 : c === "22023" ? 400 : c === "54000" ? 429 : c === "PGRST301" ? 401 : 500;
    return responde(status, { erro: status === 500 ? "Não foi possível consultar agora." : prep.error.message });
  }
  const p = prep.data as Record<string, unknown>;
  if (p.cache) {
    return responde(200, { consulta_id: p.consulta_id, fornecedor: p.fornecedor, simulado: p.simulado,
                           cache: true, consultado_em: p.consultado_em, ...(p.resultado as object) });
  }

  // 2) fornecedor
  const consulta = { placa: (p.placa as string) ?? null, chassi: (p.chassi as string) ?? null };
  const qual = (Deno.env.get("AVAL_FORNECEDOR") ?? "SIMULADO").toUpperCase();
  let r: Resultado;
  try {
    r = qual === "SIMULADO"
      ? consultarSimulado(consulta)
      : await consultarReal(consulta, Deno.env.get("AVAL_FORNECEDOR_CHAVE") ?? "");
  } catch (e) {
    // nunca registrar o retorno do fornecedor; só o tipo da falha
    console.error("avaliacao-consulta-placa: falha no fornecedor", qual, (e as Error).message);
    return responde(502, { erro: "O serviço de consulta de placa não respondeu. Preencha os dados manualmente." });
  }
  if (!r.retorno.versoes.length) {
    return responde(404, { erro: "Nenhuma versão encontrada para esta placa/chassi. Preencha os dados manualmente." });
  }

  // 3) grava o retorno já filtrado (só a chave de serviço executa esta função)
  const admin = createClient(url, servico, { auth: { persistSession: false } });
  const reg = await admin.rpc("aval_consulta_registrar", {
    p_usuario_id: p.usuario_id, p_loja: p.loja ?? null, p_placa: consulta.placa, p_chassi: consulta.chassi,
    p_fornecedor: r.fornecedor, p_simulado: r.simulado, p_resultado: r.retorno, p_custo: r.custo,
  });
  if (reg.error) {
    console.error("avaliacao-consulta-placa: falha ao registrar", reg.error.code);
    return responde(500, { erro: "Não foi possível registrar a consulta." });
  }
  return responde(200, { consulta_id: (reg.data as Record<string, unknown>).consulta_id, fornecedor: r.fornecedor,
                         simulado: r.simulado, cache: false, ...r.retorno });
});
