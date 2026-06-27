/**
 * Multi-agent, multi-model test.
 *
 * Runs three agent SDKs (OpenAI Codex, Anthropic Claude, Google Gemini) against
 * eight models with diverse prefixes through the local proxy (127.0.0.1:7777).
 *
 * Each agent receives every task in `USER_TASKS`, and every model is exercised
 * against every task, producing `len(USER_TASKS) * len(MODELS) * 3` total runs
 * (modulated by the CLI selection below).
 *
 * Usage:
 *   export ANTHROPIC_API_KEY="sk-hi"
 *   npx tsx tests/multi-agents-test.ts              # all models x all tasks x all agents
 *   npx tsx tests/multi-agents-test.ts 1 1 1        # first model, first agent, first task
 *   npx tsx tests/multi-agents-test.ts 2 3 1        # 2nd model, 3rd agent, 1st task
 *   npx tsx tests/multi-agents-test.ts 0 0 2        # all models, all agents, 2nd task
 *   npx tsx tests/multi-agents-test.ts 9 4 0        # MODELS[(9-1) % len], AGENTS[(4-1) % 3], all tasks
 *
 *   Set keys for each agent sdk:
 *   // await runCodexAgent(task, model);  // export CODEX_API_KEY=a-valid-key
 *   // await runClaudeAgent(task, model); // export ANTHROPIC_API_KEY=a-valid-key
 *   // await runGeminiAgent(task, model); // export GEMINI_API_KEY=a-valid-key
 *
 *   // or export API_KEY=a-valid-key for all them three.
 *
 *   CLI selection semantics (three args: model agent task):
 *     - no args                                -> all models x all agents x all tasks
 *     - "0 0 0"                                -> same as no args
 *     - M A T with M,A,T > 0                   -> MODELS[(M-1) % MODELS.length],
 *                                                AGENTS[(A-1) % AGENTS.length],
 *                                                USER_TASKS[(T-1) % USER_TASKS.length]
 *                                                (1-based; out-of-range values wrap with %)
 *     - 0 in any position                      -> that dimension runs all entries
 *                                                (e.g. "0 1 0" = all models, first agent, all tasks)
 *
 *   Agent order:  1=Codex, 2=Claude, 3=Gemini
 *
 *   To restrict the static task list, comment entries in USER_TASKS below.
 */

import { GoogleGenAI, Type } from "@google/genai";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PROXY_BASE = "http://127.0.0.1:8788";
const WORK_DIR = "./tests/";

const MODELS = [
  "deepseek/deepseek-v4-flash",     // deepseek
  "minimax/minimax-m3",             // minimax
  "google/gemini-3.1-flash-lite",   // gemini
  "claude-4.5-haiku",               // claude
  "openai/gpt-5.4-mini",            // gpt
  "qwen3-max-preview",              // qwen3
  "moonshotai/kimi-k2.7-code",      // moonshot-kimi
  "z-ai/glm-5.2",                   // z-ai-glm
];

// Each task targets a different AI-coding / agent capability so model
// differences surface clearly. All tasks operate against ./tests/ (WORK_DIR).
// Tasks are tuned to require real tool use (multi-glob + multi-read) rather
// than a single guess.
const USER_TASKS: { name: string; prompt: string }[] = [
  {
    name: "codebase_layout",
    prompt:
      "Analyze the codebase file structure in ./tests/ and report layout suggestions. " +
      "Group files by purpose (api handlers, fixtures, scripts, feature suites, etc.) " +
      "and flag anything that looks misplaced.",
  },
  {
    name: "duplicate_helpers",
    prompt:
      "Search ./tests/ for helper functions that are duplicated across multiple test files " +
      "(e.g. identical curl wrappers, retry loops, or auth-header builders). Read the " +
      "suspected duplicates and confirm whether they are truly identical or only superficially " +
      "similar. Report a deduplication plan naming the files involved.",
  },
  {
    name: "stale_or_dead_tests",
    prompt:
      "Audit ./tests/ for stale or dead test cases: shell scripts with hard-coded absolute " +
      "paths that no longer exist, files referencing removed endpoints, or commented-out " +
      "test blocks left behind. Report each finding with the file path and a one-line " +
      "recommendation (delete / fix / keep).",
  },
  {
    name: "coverage_matrix",
    prompt:
      "Build a coverage matrix: for each test file under ./tests/, list which endpoint or " +
      "feature it covers (e.g. /v1/messages, streaming, routing). Group similar files and " +
      "call out obvious coverage gaps — features mentioned in README.md that have no test " +
      "file backing them.",
  },
  {
    name: "hardcoded_credentials",
    prompt:
      "Security review: scan ./tests/ for hard-coded credentials, API keys, tokens, or " +
      "secrets that should not be committed to source control. List each finding with file " +
      "path, line context, and severity (high if it looks like a real key, low if it is " +
      "clearly a placeholder like 'sk-test' or 'YOUR_API_KEY').",
  },
  {
    name: "extract_shared_utilities",
    prompt:
      "Read a representative sample of test files under ./tests/ and identify utilities that " +
      "should be extracted into a shared module (e.g. proxy startup helpers, curl wrappers, " +
      "JSON assertion helpers). Propose a small refactor: which functions move, where they " +
      "live, and which call sites get simplified.",
  },
  {
    name: "convention_violations",
    prompt:
      "Review naming and structural conventions in ./tests/: file naming (snake_case vs " +
      "kebab-case vs camelCase), script header style (shebang + cd / export), and how " +
      "test setup is performed. Report inconsistencies grouped by convention type, with " +
      "a recommended standard for each.",
  },
  {
    name: "dependency_audit",
    prompt:
      "Find every external package or CLI tool referenced from test scripts under ./tests/ " +
      "(e.g. curl, jq, node, npm, tsx). For each, note whether the test assumes a specific " +
      "version or path, and flag any that look fragile or undocumented.",
  },
];

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

  const KEY = process.env.CODEX_API_KEY || process.env.API_KEY || "sk-hi";
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
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || process.env.API_KEY || "sk-fake",
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
    apiKey: process.env.GEMINI_API_KEY || process.env.API_KEY || "x-proxy-auth",
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
// Agent registry (drives the CLI `agent` selector)
// ---------------------------------------------------------------------------

const AGENTS: { name: string; run: (prompt: string, model: string) => Promise<void> }[] = [
  { name: "Codex",  run: runCodexAgent  },
  { name: "Claude", run: runClaudeAgent },
  { name: "Gemini", run: runGeminiAgent },
];

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

  // CLI selection (three args: model agent task):
  //   no args            -> run all models x all agents x all tasks
  //   "0 0 0"            -> same as no args
  //   M A T with all>0   -> pick MODELS[(M-1) % MODELS.length],
  //                          AGENTS[(A-1) % AGENTS.length],
  //                          USER_TASKS[(T-1) % USER_TASKS.length]
  //                          (1-based; values beyond array size wrap with %)
  //   0 in any position  -> that dimension runs all entries
  const argv = process.argv.slice(2);
  let modelsToRun: string[] = MODELS;
  let agentsToRun = AGENTS;
  let tasksToRun = USER_TASKS;
  if (argv.length >= 3) {
    const m = parseInt(argv[0], 10);
    const a = parseInt(argv[1], 10);
    const t = parseInt(argv[2], 10);
    if (Number.isFinite(m) && m > 0) {
      modelsToRun = [MODELS[(m - 1) % MODELS.length]];
    }
    if (Number.isFinite(a) && a > 0) {
      agentsToRun = [AGENTS[(a - 1) % AGENTS.length]];
    }
    if (Number.isFinite(t) && t > 0) {
      tasksToRun = [USER_TASKS[(t - 1) % USER_TASKS.length]];
    }
  }
  console.log(
    `Selection: ${modelsToRun.length} model(s) x ${agentsToRun.length} agent(s) x ${tasksToRun.length} task(s)`,
  );
  for (const m of modelsToRun) console.log(`  model:  ${m}`);
  for (const ag of agentsToRun) console.log(`  agent:  ${ag.name}`);
  for (const t of tasksToRun) console.log(`  task:   ${t.name}`);

  for (const task of tasksToRun) {
    for (const model of modelsToRun) {
      console.log(
        `\n=========== Task: ${task.name} | Model: ${model} ===========`,
      );
      const prompt = task.prompt;

      for (const agent of agentsToRun) {
        await agent.run(prompt, model);
      }
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
