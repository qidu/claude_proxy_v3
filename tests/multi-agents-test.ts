/**
 * Multi-agent, multi-model test.
 *
 * Runs three agent SDKs (OpenAI Codex, Anthropic Claude, Google Gemini) against
 * eight models with diverse prefixes through the local proxy (127.0.0.1:7777).
 *
 * Usage:
 *   export ANTHROPIC_API_KEY="sk-hi"
 *   npx tsx tests/multi-agents-test.ts
 *   
 *   Set keys for each agent sdk:
 *   // await runCodexAgent(task, model);  // export CODEX_API_KEY=a-valid-key
 *   // await runClaudeAgent(task, model); // export ANTHROPIC_API_KEY=a-valid-key
 *   // await runGeminiAgent(task, model); // export GEMINI_API_KEY=a-valid-key
 */

import { GoogleGenAI, Type } from "@google/genai";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PROXY_BASE = "http://127.0.0.1:7777";
const WORK_DIR = "./tests/";

const MODELS = [
  "minimax/minimax-m3",             // minimax
  "deepseek/deepseek-v4-flash",       // deepseek
  "google/gemini-3.1-flash-lite",   // gemini
  "claude-4.5-haiku",               // claude
  "openai/gpt-5.4-mini",            // gpt
  "qwen3-max-preview",              // qwen3
  "moonshotai/kimi-k2.7-code",      // moonshot-kimi
  "z-ai/glm-5.2",                   // z-ai-glm
];

const USER_TASK =
  "Analyze the codebase file structure in ./tests/ and report layout suggestions.";

// ---------------------------------------------------------------------------
// Shared tool implementations
// ---------------------------------------------------------------------------

function toolGlobSync(pattern: string, maxResults = 100): string[] {
  // Convert glob to regex: ** → everything, * → non-separator, ? → single char
  const regexStr =
    "^" +
    pattern
      .replace(/\*\*/g, "☃")
      .replace(/\*/g, "[^/]*")
      .replace(/☃/g, ".*")
      .replace(/\?/g, ".") +
    "$";
  const regex = new RegExp(regexStr);
  const results: string[] = [];

  function walk(dir: string) {
    if (results.length >= maxResults) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (results.length >= maxResults) break;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith(".")) continue; // skip hidden
        walk(full);
      } else if (e.isFile() || e.isSymbolicLink()) {
        if (regex.test(full)) results.push(full);
      }
    }
  }

  walk(WORK_DIR);
  return results.slice(0, maxResults);
}

async function toolGlob(pattern: string): Promise<string> {
  return JSON.stringify(toolGlobSync(pattern), null, 2);
}

async function toolRead(filePath: string): Promise<string> {
  try {
    return await fs.promises.readFile(filePath, "utf-8");
  } catch (e: any) {
    return `Error: ${e.message}`;
  }
}

const toolMap: Record<string, (args: any) => Promise<string>> = {
  Glob: async (args: { pattern: string }) => toolGlob(args.pattern),
  Read: async (args: { path: string }) => toolRead(args.path),
};

// ---------------------------------------------------------------------------
// 1. OpenAI Codex Agent
// ---------------------------------------------------------------------------

async function runCodexAgent(prompt: string, model: string) {
  console.log(`\n--- Codex Agent | model=${model} ---`);
  const { Codex } = await import("@openai/codex-sdk");

  // Write config.toml so codex-cli points at the local proxy
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

  const KEY = process.env.CODEX_API_KEY || "sk-hi";
  try {
    const codex = new Codex({ apiKey: KEY });
    const thread = codex.startThread({
      model,
      modelReasoningEffort: "minimal",
    });
    const result = await thread.run(prompt);
    console.log("Codex result:", result.finalResponse ?? result);
  } catch (error) {
    console.error("Codex failed:", error);
  }
}

// ---------------------------------------------------------------------------
// 2. Anthropic Claude Agent
// ---------------------------------------------------------------------------

async function runClaudeAgent(prompt: string, model: string) {
  console.log(`\n--- Claude Agent | model=${model} ---`);
  const { query: claudeQuery } = await import("@anthropic-ai/claude-agent-sdk");
  try {
    const stream = claudeQuery({
      prompt,
      options: {
        model,
        allowedTools: ["Glob", "Read"],
        maxTurns: 30,
        env: {
          ANTHROPIC_BASE_URL: PROXY_BASE,
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "sk-fake-56db1e204bf4597e71bb921fc74f464bf771a009cb9971ba8fd2a2331ae13145",
        },
      },
    });

    for await (const msg of stream) {
      if (msg.type === "assistant") {
        for (const block of msg.message.content) {
          if ("text" in block) console.log(block.text);
        }
      }
      if (msg.type === "result") {
        console.log(`Claude done. status=${msg.subtype}`);
      }
    }
  } catch (error) {
    console.error("Claude agent failed:", error);
  }
}

// ---------------------------------------------------------------------------
// 3. Gemini Agent  (with tool calling loop)
// ---------------------------------------------------------------------------

const GEMINI_TOOLS: Record<string, any>[] = [
  {
    functionDeclarations: [
      {
        name: "Glob",
        description: "List files matching a glob pattern under the project root",
        parameters: {
          type: Type.OBJECT,
          properties: {
            pattern: {
              type: Type.STRING,
              description: 'e.g. "tests/**/*.ts" or "src/**/*.{ts,js}"',
            },
          },
          required: ["pattern"],
        },
      },
      {
        name: "Read",
        description: "Read the full contents of a file",
        parameters: {
          type: Type.OBJECT,
          properties: {
            path: {
              type: Type.STRING,
              description: "Absolute file path",
            },
          },
          required: ["path"],
        },
      },
    ],
  },
];

async function runGeminiAgent(prompt: string, model: string) {
  console.log(`\n--- Gemini Agent | model=${model} ---`);
  const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY || "x-proxy-auth",
    httpOptions: { baseUrl: PROXY_BASE },
  });

  // SAFETY: the proxy returns function calls for ANY model, but only Gemini
  // models will produce semantically meaningful function calls. For others,
  // this loop degrades gracefully: the model returns a text answer directly
  // after the first turn (no tool calls).

  const history: { role: string; parts: any[] }[] = [
    { role: "user", parts: [{ text: prompt }] },
  ];

  for (let turn = 0; turn < 20; turn++) {
    const resp = await ai.models.generateContent({
      model,
      contents: history,
      config: {
        tools: GEMINI_TOOLS,
      },
    });

    const candidate = resp.candidates?.[0];
    const part = candidate?.content?.parts?.[0];
    if (!part) {
      console.log("Gemini: no candidate / empty response");
      break;
    }

    if (part.functionCall) {
      const fc = part.functionCall;
      const fnName = fc.name as string;
      const fnArgs = fc.args as Record<string, any> | undefined;

      console.log(`  Tool call: ${fnName}(${JSON.stringify(fnArgs ?? {})})`);

      const executor = toolMap[fnName];
      let result: string;
      if (executor) {
        result = await executor(fnArgs ?? {});
      } else {
        result = `Error: unknown tool "${fnName}"`;
      }

      const fcPart = { functionCall: { name: fnName, args: fnArgs ?? {} } };
      const frPart = {
        functionResponse: {
          name: fnName,
          response: { result },
        },
      };
      history.push({ role: "model", parts: [fcPart] });
      history.push({ role: "user", parts: [frPart] });
    } else if (part.text) {
      console.log("Gemini output:");
      console.log(part.text);
      break;
    } else {
      console.log("Gemini: unexpected part type", JSON.stringify(part));
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Attempt to fetch models from the proxy; fall back to hardcoded list.
  try {
    const resp = await fetch(`${PROXY_BASE}/v1/models`, {
      headers: { "x-api-key": "sk-hi" },
    });
    const data: any = await resp.json();
    const apiIds: string[] = (data.data ?? []).map((m: any) => m.id);
    if (apiIds.length > 0) {
      const preferred = [
        "deepseek",
        "minimax",
        "gemini",
        "claude",
        "gpt",
        "qwen",
        "moonshot",
        "z-ai",
      ];
      const selected: string[] = [];
      for (const prefix of preferred) {
        const match = apiIds.find(
          (id: string) =>
            id.startsWith(prefix) || id.toLowerCase().startsWith(prefix),
        );
        if (match) selected.push(match);
        if (selected.length >= 8) break;
      }
      if (selected.length > 10) {
        console.log(`Using ${selected.length} models from proxy API.`);
        for (const m of selected) console.log(`  ${m}`);
        // Replace MODELS with the dynamically fetched list
        MODELS.splice(0, MODELS.length, ...selected);
      }
    }
  } catch {
    console.log("Could not fetch models from proxy; using fallback list.");
  }

  for (const model of MODELS) {
    console.log(`\n=============== Model: ${model} ===============`);
    const task = USER_TASK;

    await runCodexAgent(task, model);   // export CODEX_API_KEY=a-valid-key
    // await runClaudeAgent(task, model); // export ANTHROPIC_API_KEY=a-valid-key
    // await runGeminiAgent(task, model); // export GEMINI_API_KEY=a-valid-key
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
