/**
 * Multi-SDK proxy test.
 *
 * Configures EVERY installed agent SDK to talk to the local proxy at
 * 127.0.0.1:7777 as its base URL, then runs:
 *
 *   Mode A — simple smoke: every model × SDK × prompt from
 *            docs/random_prompts.json (10 tasks × 2 langs = 20 prompts).
 *            Exercises wiring only (no tools / reasoning / multi-turn).
 *
 *   Mode B — Vercel AI SDK feature matrix: for every model, runs four
 *            sub-tests through the proxy-as-customProvider pattern:
 *              1. plain text Q&A
 *              2. tools / functions
 *              3. reasoning / thinking
 *              4. multi-role / multi-turn
 *
 * SDKs covered (each wired to PROXY_BASE in its own idiomatic way):
 *   1. Vercel AI SDK   `ai` + `@ai-sdk/anthropic`     — customProvider wrap
 *   2. Claude Agent    `@anthropic-ai/claude-agent-sdk` — ANTHROPIC_BASE_URL env
 *   3. Gemini          `@google/genai`                — httpOptions.baseUrl
 *   4. Codex           `@openai/codex-sdk`            — ~/.codex/config.toml base_url
 *   5. Pi              `@earendil-works/pi-agent-core` — provider.baseUrl
 *
 * Why @ai-sdk/anthropic as the Vercel transport:
 *   The proxy's universal endpoint is POST /v1/messages (Anthropic shape) —
 *   any registered model is reachable there with any non-empty api key.
 *   /v1/chat/completions is served by default (no flag needed); it may need a
 *   dedicated upstream key, so we route through the Anthropic provider for breadth.
 *
 * Prerequisites:
 *   - `ai`, `@ai-sdk/anthropic` installed (NOT in package.json — write imports
 *     only, the user installs separately).
 *   - Proxy running on PORT=7777 with DEV_NO_KEY=true.
 *   - For Codex / OpenCode, the matching CLI binaries (`codex`, `pi`)
 *     must be on PATH.
 *
 * Usage:
 *   export API_KEY=sk-hi
 *   npx tsx tests/multi-sdk-test.ts                   # list; do not run
 *   npx tsx tests/multi-sdk-test.ts --all             # simple smoke: all models x all SDKs x all prompts
 *   npx tsx tests/multi-sdk-test.ts --features        # Vercel AI feature matrix (all models x all features)
 *   npx tsx tests/multi-sdk-test.ts 1 0               # simple smoke: model 1, all SDKs, all prompts
 *   npx tsx tests/multi-sdk-test.ts 0 3               # simple smoke: all models, SDK #3 (Gemini), all prompts
 *   npx tsx tests/multi-sdk-test.ts 0 0 5             # simple smoke: all models, all SDKs, prompt #5 only
 *   npx tsx tests/multi-sdk-test.ts 2 0 --features    # feature matrix: model 2, all features
 *
 *   SDK order (simple smoke): 1=vercel-ai 2=claude 3=gemini 4=codex 5=pi
 *   Prompt order: see `npx tsx tests/multi-sdk-test.ts` (lists all 20 from random_prompts.json)
 *   Feature order (matrix):   1=plain 2=tools 3=reasoning 4=multiturn
 */

import { customProvider, generateText, tool, wrapLanguageModel } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { GoogleGenAI } from "@google/genai";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PROXY_BASE = process.env.PROXY_BASE || "http://127.0.0.1:7777";
const API_KEY = process.env.API_KEY || "sk-hi";

// Used directly as the model list — no /v1/models discovery. Override by
// editing this array (or pass indices via CLI as usual).
const DEFAULT_MODELS = ["glm-5.2-anth", "glm-5.2-comp"];

// One-shot question used only by the Vercel AI SDK feature matrix
// (single-token probes from random_prompts.json do not fit the tools /
// reasoning / multiturn features). The simple smoke mode uses PROMPTS below.
const ONE_QUESTION = "In one short sentence, what does this model do best?";

// ---------------------------------------------------------------------------
// Prompt battery — loaded from docs/random_prompts.json
//
// Source: "One Token Is Enough" fingerprinting probe battery
// (arXiv:2607.10252). 10 tasks × 2 languages (en, zh) = 20 single-token
// prompts. Each entry carries the normalization `type` (and `range` for
// int_bounded) so downstream analysis can validate / bucket raw answers.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_FILE = path.resolve(__dirname, "../docs/random_prompts.json");

type Prompt = {
  id: string;        // `${task}/${lang}` — stable identifier for logs
  task: string;      // e.g. "number_1_100"
  lang: "en" | "zh";
  type: string;      // "int_bounded" | "int_open" | "letter" | "coin" | "text"
  range?: [number, number];
  prompt: string;
};

function loadPrompts(): Prompt[] {
  const raw = JSON.parse(fs.readFileSync(PROMPTS_FILE, "utf-8"));
  const langs: string[] = raw.languages ?? ["en"];
  const tasks = raw.tasks ?? {};
  const out: Prompt[] = [];
  for (const [taskName, taskDefRaw] of Object.entries(tasks)) {
    const taskDef = taskDefRaw as any;
    for (const lang of langs) {
      const p = taskDef.prompts?.[lang];
      if (!p) continue;
      out.push({
        id: `${taskName}/${lang}`,
        task: taskName,
        lang: lang as "en" | "zh",
        type: taskDef.type,
        range: taskDef.range,
        prompt: p,
      });
    }
  }
  return out;
}

const PROMPTS = loadPrompts();

// Unmask Vercel AI SDK errors. APICallError wraps the real cause in `.cause`
// (e.g. "Failed to process successful response" / "Invalid JSON response")
// and carries `responseBody` / `url` — surface them so the underlying failure
// is visible instead of the generic wrapper message.
function describeError(e: any): string {
  if (!(e instanceof Error)) return String(e);
  const parts: string[] = [e.message];
  const anyE = e as any;
  if (anyE.cause instanceof Error && anyE.cause !== e) {
    parts.push(`cause: ${anyE.cause.message}`);
    const deepCause = (anyE.cause as any).cause;
    if (deepCause instanceof Error && deepCause !== anyE.cause) {
      parts.push(`deep cause: ${deepCause.message}`);
    }
  }
  if (typeof anyE.responseBody === "string" && anyE.responseBody.length > 0) {
    parts.push(`responseBody: ${anyE.responseBody.slice(0, 1000)}`);
  }
  if (typeof anyE.url === "string") parts.push(`url: ${anyE.url}`);
  if (typeof anyE.statusCode === "number") parts.push(`status: ${anyE.statusCode}`);
  return parts.join("\n  ");
}

// ===========================================================================
// SDK 1 — Vercel AI SDK  (ai + @ai-sdk/anthropic)
//
// Wraps the proxy as a customProvider so each model id is addressable
// directly. Mirrors the user's example shape (customProvider +
// wrapLanguageModel). Used both for the simple smoke and the feature matrix.
// ===========================================================================

function buildProxyProvider(modelIds: string[]) {
  // @ai-sdk/anthropic v4 appends "/messages" (NOT "/v1/messages") to baseURL.
  // The proxy listens on /v1/messages, so we tack /v1 onto the baseURL.
  const base = createAnthropic({
    baseURL: `${PROXY_BASE}/v1`,
    apiKey: API_KEY,
    headers: {
      "x-api-key": API_KEY,
      Authorization: `Bearer ${API_KEY}`,
    },
  });

  const languageModels: Record<string, ReturnType<typeof base.languageModel>> = {};
  for (const id of modelIds) {
    // Direct wrap (no middleware) — per-call providerOptions always win.
    // The user's example used wrapLanguageModel + defaultSettingsMiddleware;
    // we keep the customProvider shape but skip the middleware to avoid
    // v7 middleware signature drift.
    languageModels[id] = base(id);
  }
  return customProvider({ languageModels, fallbackProvider: base });
}

async function runVercelAISimple(model: string, prompt: string) {
  const provider = buildProxyProvider([model]);
  // glm-5.2 (and other thinking-mode models) emit `thinking` content blocks
  // even when the client didn't request thinking. @ai-sdk/anthropic's response
  // schema rejects unrequested thinking blocks as "Invalid JSON response"
  // (TypeValidationError). Explicitly enabling thinking makes the schema
  // accept them; non-thinking models just return text and are unaffected.
  const result = await generateText({
    model: provider.languageModel(model),
    messages: [{ role: "user", content: prompt }],
    maxOutputTokens: 64_000,
    providerOptions: {
      anthropic: { thinking: { type: "enabled", budgetTokens: 1024 } },
    },
  });
  console.log(`  answer (${result.usage?.totalTokens ?? "?"} tokens): ${result.text}`);
}

// Vercel AI SDK feature matrix ----------------------------------------------

async function runVercelFeature(model: string, feature: string) {
  const provider = buildProxyProvider([model]);
  const lm = provider.languageModel(model);

  if (feature === "plain") {
    const r = await generateText({
      model: lm,
      messages: [{ role: "user", content: ONE_QUESTION }],
      maxOutputTokens: 64_000,
    });
    console.log(`  text: ${r.text}`);
    return;
  }
  if (feature === "tools") {
    const dateTool = tool({
      description: "Get the current ISO date.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      } as any,
      execute: async () => ({ iso: new Date().toISOString() }),
    });
    const r = await generateText({
      model: lm,
      messages: [{ role: "user", content: "What is today's date? Use the tool, then answer in one sentence." }],
      maxOutputTokens: 64_000,
      tools: { currentDate: dateTool },
    });
    console.log(`  tool_calls=${r.toolCalls?.length ?? 0} steps=${r.steps?.length ?? 0}`);
    for (const c of r.toolCalls ?? []) console.log(`    - ${c.toolName}(${JSON.stringify(c.args)})`);
    console.log(`  text: ${r.text || "(empty)"}`);
    return;
  }
  if (feature === "reasoning") {
    const r = await generateText({
      model: lm,
      messages: [{ role: "user", content: "Explain why a CDN reduces latency. Think step by step, then answer in two sentences." }],
      maxOutputTokens: 64_000,
      providerOptions: { anthropic: { thinking: { type: "enabled", budgetTokens: 1024 } } },
    }).catch((e: any) => {
      // Not all upstreams support thinking — report and move on (rule 8).
      console.log(`  reasoning error: ${e?.message ?? e}`);
      return null;
    });
    if (!r) return;
    const reasoning = (r as any).reasoning ?? (r as any).reasoningDetails;
    console.log(`  reasoning_chunks=${Array.isArray(reasoning) ? reasoning.length : (reasoning ? 1 : 0)}`);
    console.log(`  text: ${r.text || "(empty)"}`);
    return;
  }
  if (feature === "multiturn") {
    const r = await generateText({
      model: lm,
      system: "You are a terse teacher. Answer in <= 12 words.",
      maxOutputTokens: 64_000,
      messages: [
        { role: "user", content: "Define 'cache'." },
        { role: "assistant", content: "A fast store in front of a slow one." },
        { role: "user", content: "Give one example with the word 'browser'." },
      ],
    });
    console.log(`  answer: ${r.text}`);
    return;
  }
  throw new Error(`unknown feature: ${feature}`);
}

// ===========================================================================
// SDK 2 — Anthropic Claude Agent SDK  (@anthropic-ai/claude-agent-sdk)
//
// The claude-agent-sdk reads its base URL from ANTHROPIC_BASE_URL via the
// `env` option on `query()`. No tools / maxTurns=1 → single assistant turn.
// ===========================================================================

async function runClaudeSimple(model: string, prompt: string) {
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const stream = query({
    prompt,
    options: {
      model,
      maxTurns: 1,
      env: {
        ANTHROPIC_BASE_URL: PROXY_BASE,
        ANTHROPIC_API_KEY: API_KEY,
      },
    },
  });
  let text = "";
  for await (const msg of stream) {
    if (msg.type === "assistant") {
      for (const block of msg.message.content) {
        if ("text" in block) {
          process.stdout.write(block.text);
          text += block.text;
        }
      }
    }
    if (msg.type === "result") console.log(`  (claude status=${msg.subtype})`);
  }
  if (!text) console.log("  (no text)");
}

// ===========================================================================
// SDK 3 — Google Gemini SDK  (@google/genai)
//
// httpOptions.baseUrl points the SDK at the proxy. contents as a plain
// string → single-turn GenerateContent. No tools configured → no tool loop.
// ===========================================================================

async function runGeminiSimple(model: string, prompt: string) {
  const ai = new GoogleGenAI({
    apiKey: API_KEY,
    httpOptions: { baseUrl: PROXY_BASE },
  });
  const resp = await ai.models.generateContent({ model, contents: prompt });
  const parts = resp.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((p: any) => p.text ?? "").join("");
  console.log(`  answer: ${text || "(empty)"}`);
}

// ===========================================================================
// SDK 4 — OpenAI Codex SDK  (@openai/codex-sdk)
//
// Codex reads provider config from ~/.codex/config.toml. We write a minimal
// config pointing model_provider.localproxy.base_url at PROXY_BASE/v1 with
// wire_api = "responses" (the /v1/responses shape is what codex uses).
// ===========================================================================

async function runCodexSimple(model: string, prompt: string) {
  const { Codex } = await import("@openai/codex-sdk");

  const codexDir = path.join(os.homedir(), ".codex");
  const codexConfig = path.join(codexDir, "config.toml");
  const configBody = `model = "${model}"
model_provider = "localproxy"

[model_providers.localproxy]
name = "Local Proxy"
base_url = "${PROXY_BASE}/v1"
env_key = "CODEX_API_KEY"
wire_api = "responses"
`;
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(codexConfig, configBody);

  const codex = new Codex({ apiKey: process.env.CODEX_API_KEY || API_KEY });
  const thread = codex.startThread({ model });
  const result: any = await thread.run(prompt);
  const text = result?.finalResponse?.text ?? result?.finalResponse ?? "(no output)";
  console.log(`  answer: ${typeof text === "string" ? text : JSON.stringify(text)}`);
}

// ===========================================================================
// SDK 5 — Earendil Works Pi Agent Core  (@earendil-works/pi-agent-core)
//
// Pi's anthropic-messages client appends "/v1/messages" to baseUrl, so
// baseUrl is the proxy origin WITHOUT /v1. thinkingLevel "off" + no tools →
// single assistant turn.
// ===========================================================================

async function runPiSimple(model: string, prompt: string) {
  const { Agent } = await import("@earendil-works/pi-agent-core");
  const { createModels, createProvider, envApiKeyAuth } = await import("@earendil-works/pi-ai");
  const { anthropicMessagesApi } = await import(
    "@earendil-works/pi-ai/api/anthropic-messages.lazy"
  );

  const provider = createProvider({
    id: "anthropic",
    name: "Local Proxy (/v1/messages)",
    baseUrl: PROXY_BASE,
    auth: { apiKey: envApiKeyAuth("Pi key", ["PI_API_KEY", "API_KEY"]) },
    models: [
      {
        id: model,
        name: model,
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: PROXY_BASE,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 64_000,
      },
    ],
    api: anthropicMessagesApi(),
  });

  const models = createModels();
  models.setProvider(provider);
  const piModel = models.getModel("anthropic", model);
  if (!piModel) throw new Error(`Pi: model "${model}" not registered`);

  const agent = new Agent({
    initialState: {
      systemPrompt: "Answer briefly.",
      model: piModel,
      thinkingLevel: "off",
    },
    streamFn: models.streamSimple.bind(models),
    getApiKey: async () => process.env.PI_API_KEY || API_KEY,
  });

  let text = "";
  agent.subscribe((event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      process.stdout.write(event.assistantMessageEvent.delta);
      text += event.assistantMessageEvent.delta;
    }
  });

  await agent.prompt(prompt);
  if (process.stdout.writableLength === 0) console.log("");
  if (!text) console.log("  (no text)");
}


// ===========================================================================
// SDK + feature registries
// ===========================================================================

const SDKS: { name: string; run: (model: string, prompt: string) => Promise<void> }[] = [
  { name: "vercel-ai", run: runVercelAISimple },
  { name: "claude",    run: runClaudeSimple    },
  { name: "gemini",    run: runGeminiSimple    },
  { name: "codex",     run: runCodexSimple     },
  { name: "pi",        run: runPiSimple        },
];

const FEATURES = ["plain", "tools", "reasoning", "multiturn"] as const;
type Feature = (typeof FEATURES)[number];

// ===========================================================================
// Main / CLI
// ===========================================================================

async function main() {
  const MODELS = DEFAULT_MODELS;
  const argv = process.argv.slice(2);

  const featuresFlag = argv.includes("--features") || argv.includes("-f");
  const nonFlagArgs = argv.filter((a) => !a.startsWith("--"));
  const runFlag = nonFlagArgs.length === 0 && (argv.includes("--all") || argv.includes("-a") || argv.includes("--run") || argv.includes("-r"));
  // Simple smoke accepts up to 3 numeric selectors: M S P (model, sdk, prompt)
  const numericArgs = nonFlagArgs.length >= 2 && nonFlagArgs.slice(0, 2).every((a) => /^-?\d+$/.test(a));

  // List mode ----------------------------------------------------------------
  if (argv.length === 0) {
    console.log("Proxy base:", PROXY_BASE);
    console.log("\nAvailable models:");
    MODELS.forEach((m, i) => console.log(`  ${i + 1}. ${m}`));
    console.log("\nSDKs (simple smoke):");
    SDKS.forEach((s, i) => console.log(`  ${i + 1}. ${s.name}`));
    console.log("\nPrompts (simple smoke):");
    PROMPTS.forEach((p, i) => console.log(`  ${i + 1}. ${p.id} [${p.type}]`));
    console.log("\nFeatures (Vercel AI SDK only):");
    FEATURES.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
    console.log("\nRun:");
    console.log("  --all / -a               simple smoke: all models x all SDKs x all prompts");
    console.log("  --features / -f          Vercel AI feature matrix across all models x all features");
    console.log("  M S [P]                  simple smoke: model M, sdk S [, prompt P] (1-based; 0 = all)");
    console.log("  M F --features / -f      feature matrix: model M, feature F (1-based; 0 = all)");
    return;
  }

  // Feature matrix mode ------------------------------------------------------
  if (featuresFlag) {
    let modelsToRun = MODELS;
    let featuresToRun = FEATURES.slice() as Feature[];
    if (numericArgs) {
      const m = parseInt(nonFlagArgs[0], 10);
      const f = parseInt(nonFlagArgs[1], 10);
      if (m > 0) modelsToRun = [MODELS[(m - 1) % MODELS.length]];
      if (f > 0) featuresToRun = [FEATURES[(f - 1) % FEATURES.length]];
    }

    console.log(
      `Feature matrix: ${modelsToRun.length} model(s) x ${featuresToRun.length} feature(s) via Vercel AI SDK`,
    );
    for (const m of modelsToRun) console.log(`  model:   ${m}`);
    for (const f of featuresToRun) console.log(`  feature: ${f}`);

    for (const model of modelsToRun) {
      for (const feature of featuresToRun) {
        console.log(`\n=========== Model: ${model} | Feature: ${feature} ===========`);
        try {
          await runVercelFeature(model, feature);
        } catch (e: any) {
          console.error(`Feature ${feature} failed for ${model}:\n  ${describeError(e)}`);
        }
      }
    }
    return;
  }

  // Simple smoke mode --------------------------------------------------------
  let modelsToRun = MODELS;
  let sdksToRun = SDKS;
  let promptsToRun = PROMPTS;
  if (numericArgs) {
    const m = parseInt(nonFlagArgs[0], 10);
    const s = parseInt(nonFlagArgs[1], 10);
    const p = nonFlagArgs[2] ? parseInt(nonFlagArgs[2], 10) : 0;
    if (m > 0) modelsToRun = [MODELS[(m - 1) % MODELS.length]];
    if (s > 0) sdksToRun = [SDKS[(s - 1) % SDKS.length]];
    if (p > 0) promptsToRun = [PROMPTS[(p - 1) % PROMPTS.length]];
  }
  // runFlag uses all defaults (all models x all SDKs x all prompts)

  console.log(
    `Simple smoke: ${modelsToRun.length} model(s) x ${sdksToRun.length} SDK(s) x ${promptsToRun.length} prompt(s) at ${PROXY_BASE}`,
  );
  for (const m of modelsToRun) console.log(`  model:  ${m}`);
  for (const s of sdksToRun) console.log(`  sdk:    ${s.name}`);
  for (const p of promptsToRun) console.log(`  prompt: ${p.id}`);

  for (const model of modelsToRun) {
    for (const sdk of sdksToRun) {
      for (const p of promptsToRun) {
        console.log(
          `\n=========== Model: ${model} | SDK: ${sdk.name} | Prompt: ${p.id} ===========`,
        );
        console.log(`  Q (${p.type}${p.range ? ` ${JSON.stringify(p.range)}` : ""}): ${p.prompt}`);
        try {
          await sdk.run(model, p.prompt);
        } catch (e: any) {
          // Per-SDK failures are reported, not swallowed; loop continues (rule 8).
          console.error(`SDK ${sdk.name} failed for ${model} on ${p.id}:\n  ${describeError(e)}`);
        }
      }
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
