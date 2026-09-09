// IA-UAT-02 -- real browser automation against the REAL, unmodified
// reconciled frontend (index.html + assets/js/portal-ai-ui.js etc.),
// served same-origin with the mock Supabase/OpenAI backend (see
// mock-backend.mjs), which itself proxies to the REAL, unmodified
// portal-ai-homolog Deno process. Nothing about the financial engine,
// tool dispatch, or structured-block rendering is mocked -- only the
// two external boundaries (Supabase, OpenAI) are.
//
// Prereqs (see run-all.mjs for full orchestration):
//   - mock-backend.mjs running on port 8080 (serves static + mock API)
//   - bootstrap-text.ts running on port 8801 (proxied at /functions/v1/portal-ai-homolog)
//
// Run: node tests/ai-uat-e2e/playwright-uat.mjs

const PLAYWRIGHT_PATH = process.env.UAT_PLAYWRIGHT_PATH;
const pwMod = await import("file://" + PLAYWRIGHT_PATH);
const chromium = pwMod.chromium || pwMod.default.chromium;

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BASE_URL = "http://127.0.0.1:8080/index.html";
const SCREENSHOT_DIR = "C:/Projetos/ia-reconciliation-v2-local/tests/screenshots/ia-uat-02";
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const evidence = { scenarios: [], consoleErrors: [], networkErrors: [], mobile: {} };
let shotIndex = 0;
function shotName(label) {
  shotIndex++;
  return String(shotIndex).padStart(2, "0") + "-" + label.replace(/[^a-z0-9]+/gi, "-").toLowerCase() + ".png";
}

async function login(page) {
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.fill("#cpfInput", "uat-master@local.test");
  await page.fill("#senhaInput", "any-password");
  await page.click("#loginForm button[type=submit]");
  await page.waitForSelector("#brabusAiBtn", { timeout: 15000 });
}

async function openDrawer(page) {
  await page.click("#brabusAiBtn");
  await page.waitForSelector("#brabusAiOverlay.show", { timeout: 5000 });
}

async function sendAndWait(page, text, timeoutMs = 20000) {
  await page.fill("#brabusAiInput", text);
  await page.click("#brabusAiSendBtn");
  await page.waitForSelector(".brabusAiBubbleLoading", { state: "attached", timeout: 5000 }).catch(() => {});
  await page.waitForSelector(".brabusAiBubbleLoading", { state: "detached", timeout: timeoutMs });
  await page.waitForTimeout(200); // let DOM settle after the loading bubble is removed
}

async function readLastResponse(page) {
  const bubbles = page.locator("#brabusAiBody .brabusAiBubble");
  const count = await bubbles.count();
  const lastText = count > 0 ? (await bubbles.nth(count - 1).innerText()) : null;
  const blockPanels = page.locator("#brabusAiBody .brabusAiBlockPanel");
  const blockCount = await blockPanels.count();
  const blocks = [];
  for (let i = 0; i < blockCount; i++) {
    blocks.push(await blockPanels.nth(i).innerText());
  }
  return { lastText, blockCount, blocks };
}

// IA-UAT-02 finding (disclosed, not fixed -- Gate 32: a CSP change is
// a security-relevant surface, out of this phase's unilateral-fix
// authority): the frontend's own CSP has no `media-src` directive, so
// `default-src 'self'` applies -- and blob: audio URLs (used to
// autoplay the TTS reply after every message) are NOT same-origin
// under CSP source matching, so every autoplay attempt is blocked.
// This reproduces in a real browser regardless of mock vs. production
// backend -- it is a genuine frontend gap, not a harness artifact.
// Tracked SEPARATELY from financial/tool-dispatch correctness below so
// one doesn't mask the other.
const CSP_MEDIA_BLOB_ERROR = /violates the following Content Security Policy directive: "default-src 'self'"/;

async function runScenario(page, { id, label, prompt, expectBlock }) {
  const consoleErrorsBefore = evidence.consoleErrors.length;
  await sendAndWait(page, prompt);
  const result = await readLastResponse(page);
  const shot = shotName(id);
  await page.screenshot({ path: join(SCREENSHOT_DIR, shot), fullPage: false });
  const newConsoleErrors = evidence.consoleErrors.slice(consoleErrorsBefore);
  const audioCspErrors = newConsoleErrors.filter((e) => CSP_MEDIA_BLOB_ERROR.test(e.text));
  const otherConsoleErrors = newConsoleErrors.filter((e) => !CSP_MEDIA_BLOB_ERROR.test(e.text));
  if (audioCspErrors.length > 0) evidence.audioCspFindingCount = (evidence.audioCspFindingCount || 0) + audioCspErrors.length;
  const record = {
    id, label, prompt,
    responseText: result.lastText,
    blockCount: result.blockCount,
    blocks: result.blocks,
    screenshot: shot,
    audioCspErrorsDuring: audioCspErrors.length,
    otherConsoleErrorsDuring: otherConsoleErrors,
    pass: (expectBlock ? result.blockCount > 0 : true) && otherConsoleErrors.length === 0
  };
  evidence.scenarios.push(record);
  console.log(`[${record.pass ? "PASS" : "FAIL"}] ${label} (blocks=${result.blockCount}, audioCspBlocked=${audioCspErrors.length > 0})`);
  return record;
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
page.on("console", (msg) => { if (msg.type() === "error") evidence.consoleErrors.push({ text: msg.text(), url: page.url() }); });
page.on("pageerror", (err) => evidence.consoleErrors.push({ text: "pageerror: " + err.message, url: page.url() }));
page.on("response", (resp) => {
  if (resp.status() >= 400 && !resp.url().includes("__uat")) {
    evidence.networkErrors.push({ url: resp.url(), status: resp.status() });
  }
});

console.log("Logging in...");
await login(page);
await page.screenshot({ path: join(SCREENSHOT_DIR, shotName("initial-dashboard")), fullPage: false });

console.log("Opening AI drawer...");
await openDrawer(page);
await page.screenshot({ path: join(SCREENSHOT_DIR, shotName("ai-drawer-opened")), fullPage: false });

// ---- Core scenarios (Desktop, 1366x768) ----
await runScenario(page, { id: "test01-text-basic", label: "Basic TEXT question", prompt: "Qual foi o resultado do mês passado?", expectBlock: true });
const linearRecord = await runScenario(page, { id: "test02-linear", label: "Financiamento Linear", prompt: "Simula um financiamento linear de um veículo novo de R$ 120.000, com R$ 30.000 de entrada, em 36 meses.", expectBlock: true });
await runScenario(page, { id: "test03-balao", label: "Balão", prompt: "Simula um financiamento com balão de R$ 40.000 num veículo de R$ 150.000, entrada de R$ 30.000, em 36 meses.", expectBlock: true });
await runScenario(page, { id: "test04-coparticipado", label: "Coparticipado", prompt: "Quero simular Coparticipado para a L200 Triton, R$ 200.000, entrada R$ 120.000, 24 meses.", expectBlock: true });
await runScenario(page, { id: "test05-subsidiado", label: "Taxas Subsidiadas", prompt: "Quais as condições de Taxas Subsidiadas para um bem de R$ 90.000 com entrada de R$ 50.000?", expectBlock: true });
await runScenario(page, { id: "test06-taxa-implicita", label: "Taxa Implícita", prompt: "Um cliente financiou R$ 100.000 em 36x de R$ 4.485,75. Qual a taxa implícita desse contrato?", expectBlock: true });
await runScenario(page, { id: "test07-antecipacao", label: "Antecipação (sem due date)", prompt: "Quero simular a antecipação de um contrato com saldo de R$ 50.000, sem informar a data da próxima parcela.", expectBlock: true });
await runScenario(page, { id: "test08-cash-conversion", label: "Cash Conversion basic", prompt: "Vale mais a pena o cliente pagar à vista R$ 50.000 ou financiar e deixar o dinheiro aplicado por 12 meses?", expectBlock: true });
await runScenario(page, { id: "test09-cash-conversion-custom-rate", label: "Cash Conversion custom rate", prompt: "E se a taxa de aplicação fosse 2% ao mês em vez da taxa oficial?", expectBlock: true });
await runScenario(page, { id: "test11-negative-truth", label: "Negative/ineligible scenario", prompt: "Simula uma Taxas Subsidiadas para um bem de R$ 50.000 com entrada de R$ 10.000", expectBlock: true });

// ---- Error handling (Gate 22): simulated upstream OpenAI failure ----
{
  const before = evidence.consoleErrors.length;
  await sendAndWait(page, "__UAT_TRIGGER_UPSTREAM_ERROR__");
  const errorBubble = page.locator("#brabusAiBody .brabusAiBubbleError");
  const errorText = (await errorBubble.count()) > 0 ? await errorBubble.last().innerText() : null;
  const shot = shotName("test13-error-handling");
  await page.screenshot({ path: join(SCREENSHOT_DIR, shot), fullPage: false });
  // The 502 itself is the deliberately-triggered condition under test
  // -- Chromium's routine "Failed to load resource: 502" console log
  // for THAT expected request is not a defect, only a genuinely
  // unexpected error (anything else) would be.
  const newErrors = evidence.consoleErrors.slice(before).filter((e) => !CSP_MEDIA_BLOB_ERROR.test(e.text) && !/502/.test(e.text));
  const record = {
    id: "test13-error-handling", label: "Error handling (simulated upstream failure)",
    prompt: "__UAT_TRIGGER_UPSTREAM_ERROR__", errorBubbleText: errorText, screenshot: shot,
    pass: !!errorText && !/stack|Error:|at Object|TypeError/.test(errorText) && newErrors.length === 0,
    otherConsoleErrorsDuring: newErrors
  };
  evidence.scenarios.push(record);
  console.log(`[${record.pass ? "PASS" : "FAIL"}] ${record.label} -- shown: "${errorText}"`);
}

// ---- Multi-turn (reuses the Linear scenario's context) ----
const multiTurn = await runScenario(page, { id: "test10-multiturn", label: "Multi-turn follow-up (48 meses)", prompt: "E se fosse 48 meses em vez de 36?", expectBlock: true });
evidence.multiTurn = {
  vehicleValueReused: multiTurn.blocks.some((b) => b.includes("120.000") || b.includes("120000")),
  note: "checked whether the R$ 120.000 vehicle value from the earlier Linear scenario reappears without being retyped"
};

// ---- Novo Cliente reset ----
const resetRecord = await runScenario(page, { id: "test12-novo-cliente", label: "Novo Cliente reset trigger", prompt: "Beleza, agora é outro cliente, esquece esse", expectBlock: false });
const followUp = await runScenario(page, { id: "test12b-post-reset-check", label: "Post-reset: ask for the old vehicle value", prompt: "Qual era o valor do veículo que a gente tinha calculado?", expectBlock: false });
evidence.novoCliente = {
  resetConfirmedInReply: /começamos do zero|novo cliente|zero/i.test(resetRecord.responseText || ""),
  oldValueNotEchoedBack: !/120\.?000/.test(followUp.responseText || ""),
  followUpReply: followUp.responseText
};

await page.screenshot({ path: join(SCREENSHOT_DIR, shotName("conversation-full-scroll")), fullPage: false });

// ---- Mobile viewport pass ----
console.log("Switching to mobile viewport (390x844)...");
const mobilePage = await browser.newPage({ viewport: { width: 390, height: 844 } });
mobilePage.on("console", (msg) => { if (msg.type() === "error") evidence.consoleErrors.push({ text: "[mobile] " + msg.text(), url: mobilePage.url() }); });
await login(mobilePage);
await mobilePage.screenshot({ path: join(SCREENSHOT_DIR, shotName("mobile-dashboard")) });
await openDrawer(mobilePage);
await mobilePage.screenshot({ path: join(SCREENSHOT_DIR, shotName("mobile-ai-drawer")) });
await sendAndWait(mobilePage, "Qual foi o resultado do mês passado?");
await mobilePage.screenshot({ path: join(SCREENSHOT_DIR, shotName("mobile-ai-response")) });
const overflow = await mobilePage.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
evidence.mobile = { ...overflow, horizontalOverflow: overflow.scrollWidth - overflow.clientWidth };
console.log("Mobile overflow (scrollWidth - clientWidth):", evidence.mobile.horizontalOverflow);
await mobilePage.close();

await browser.close();

// Excludes both the disclosed audio-CSP finding and the ONE
// deliberately-triggered 502 from the error-handling scenario (Gate
// 22) -- both are known, intentional, already accounted for above.
const otherConsoleErrorsTotal = evidence.consoleErrors.filter((e) => !CSP_MEDIA_BLOB_ERROR.test(e.text) && !/502/.test(e.text)).length;
const audioCspErrorsTotal = evidence.consoleErrors.length - otherConsoleErrorsTotal;
writeFileSync(join(SCREENSHOT_DIR, "..", "..", "ai-uat-e2e", "evidence.json"), JSON.stringify(evidence, null, 2));
console.log("\n=== Playwright UAT run complete ===");
console.log(`Scenarios: ${evidence.scenarios.length}, all PASS: ${evidence.scenarios.every((s) => s.pass)}`);
console.log(`Console errors (excl. known audio-CSP finding): ${otherConsoleErrorsTotal}`);
console.log(`Audio-CSP blob findings (disclosed, not counted as scenario failures): ${audioCspErrorsTotal}`);
console.log(`Network errors total: ${evidence.networkErrors.length}`);
console.log(`Mobile horizontal overflow: ${evidence.mobile.horizontalOverflow}`);
process.exit(evidence.scenarios.every((s) => s.pass) && otherConsoleErrorsTotal === 0 ? 0 : 1);
