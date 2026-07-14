/**
 * Multi-agent, multi-model COMPOSITE test.
 *
 * Original tests/multi-agents-test.ts runs three agent SDKs (OpenAI Codex,
 * Anthropic Claude, Google Gemini) sequentially on every (task, model) pair
 * and just prints everything to stdout — no judgment, no fusion.
 *
 * This refactor turns the same setup into a COMPOSITE agent:
 *
 *   for each (task, model):
 *     1. Pick a JUDGE SDK and a WORKER PAIR.
 *        - By default, the judge is chosen UNIFORMLY AT RANDOM via a seeded
 *          RNG (mulberry32). Same --seed -> same assignment.
 *        - User can pin the judge via `--judge codex|claude|gemini`. The
 *          remaining two SDKs then become the workers (order from AGENTS).
 *        - The judge SDK never runs as a worker in the same composite —
 *          no conflict of interest.
 *     2. Run the 2 workers CONCURRENTLY against the same prompt + model.
 *     3. Feed both worker outputs to the judge SDK in a single-turn call.
 *     4. Judge returns { winner, reason, confidence }.
 *     5. Winner output becomes the composite answer; other output discarded.
 *
 * Shared tool implementations (Glob, Grep, Read) and CLI selection semantics
 * (M A T args; 0 means "all in that dimension") are preserved from the
 * original. New args:
 *   --json          Emit one JSON object per (task, model) to stdout, plus
 *                   a final summary array. Machine-parseable.
 *   --seed <int>    Override the random shuffle seed (default: derived from
 *                   Date.now()). Same seed → same judge selection.
 *   --model <id>    Override MODELS list with a single model id.
 *   --judge <sdk>   Pin the judge SDK (case-insensitive: codex|claude|gemini).
 *                   The other two become workers. Unknown names throw.
 *
 * TOOL PARITY across the three SDKs (current setup is read-only):
 *   - Codex:  no user-supplied tools array — its tools are the built-in
 *             sandboxed shell. Restricted via sandboxMode: "read-only".
 *   - Claude: built-in tool registry, gated via allowedTools:
 *             ["Glob", "Grep", "Read"].
 *   - Gemini: no built-in tools — Glob/Grep/Read are declared in
 *             GEMINI_TOOLS and implemented locally (toolMap).
 *   Codex searches via its own shell (grep/find), so its search semantics
 *   differ slightly from the shared Glob/Grep implementations.
 *
 *   To enable Edit/Write, each SDK needs a different mechanism:
 *   - Codex:  sandboxMode: "workspace-write" (+ workingDirectory to scope
 *             writes). file_change events are already counted as tool calls.
 *   - Claude: add "Edit"/"Write" to allowedTools, plus
 *             permissionMode: "acceptEdits" for non-interactive runs.
 *   - Gemini: declare Edit/Write in GEMINI_TOOLS and implement executors in
 *             toolMap. NOTE: custom executors have no sandbox — add a
 *             WORK_DIR path guard for parity with Codex's workspace-write.
 *   Caveat: workers run concurrently on the same directory, so write access
 *   lets one worker mutate files mid-run and pollute the other's view.
 *
 * Usage:
 *   should export env KEY for each agent SDK respectively.
 *   export API_KEY=a-valid-key
 *   export CODEX_API_KEY=$API_KEY
 *   export ANTHROPIC_API_KEY=$API_KEY
 *   export GEMINI_API_KEY=$API_KEY
 *
 *   export ANTHROPIC_API_KEY="sk-hi"
 *   npx tsx tests/multi-agents-composite.ts                        # all
 *   npx tsx tests/multi-agents-composite.ts 1 1 1                  # 1st model x 1st task, random pair
 *   npx tsx tests/multi-agents-composite.ts --json                 # JSON verdicts
 *   npx tsx tests/multi-agents-composite.ts --seed 42 0 0 1        # reproducible
 *   npx tsx tests/multi-agents-composite.ts --judge claude         # specify judge
 */

import { GoogleGenAI, Type } from "@google/genai";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PROXY_BASE = process.env.PROXY_BASE || "http://127.0.0.1:8788";
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
// Shared tool implementations  (unchanged from original)
// ---------------------------------------------------------------------------

function toolGlobSync(pattern: string, maxResults = 100): string[] {
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
        if (e.name.startsWith(".")) continue;
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

async function toolGrep(pattern: string, maxResults = 100): Promise<string> {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (e: any) {
    return `Error: invalid regex: ${e.message}`;
  }
  const files = toolGlobSync("**/*", 500);
  const matches: string[] = [];
  for (const file of files) {
    if (matches.length >= maxResults) break;
    let content: string;
    try {
      content = await fs.promises.readFile(file, "utf-8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= maxResults) break;
      if (regex.test(lines[i])) {
        matches.push(`${file}:${i + 1}:${lines[i].slice(0, 300)}`);
      }
    }
  }
  return matches.length > 0 ? matches.join("\n") : "(no matches)";
}

const toolMap: Record<string, (args: any) => Promise<string>> = {
  Glob: async (args: { pattern: string }) => toolGlob(args.pattern),
  Grep: async (args: { pattern: string }) => toolGrep(args.pattern),
  Read: async (args: { path: string }) => toolRead(args.path),
};

// ---------------------------------------------------------------------------
// Agent result type  (NEW — replaces console.log in the original)
// ---------------------------------------------------------------------------

export type AgentResult = {
  sdk: string;          // "Codex" | "Claude" | "Gemini"
  model: string;
  task: string;
  output: string;       // final text answer (concatenated for streamed outputs)
  toolCalls: number;    // how many tool calls the agent made
  elapsedMs: number;
  error?: string;
};

export type JudgeVerdict = {
  winner: string;       // SDK name that produced the winning output
  reason: string;       // one-sentence justification
  confidence: "high" | "medium" | "low";
  raw?: string;         // raw judge response if parse failed
};

export type CompositeResult = {
  task: string;
  model: string;
  workers: [string, string];   // SDK names of the 2 workers
  judge: string;               // SDK name of the judge
  workerResults: [AgentResult, AgentResult];
  verdict: JudgeVerdict;
  winningOutput: string;
  timestamp: string;
};
// ---------------------------------------------------------------------------
// 1. OpenAI Codex Agent
//
// The @openai/codex-sdk does NOT expose a user-supplied tools array —
// tools in Codex are its built-in sandboxed shell + MCP servers.
// So we use runStreamed() and count tool-bearing items from the event stream
// (CommandExecutionItem = Bash, FileChangeItem = Edit/Write, McpToolCallItem
// = MCP server call). This gives an accurate "tool calls" counter even
// though we can't pick *which* tools Codex uses.
// ---------------------------------------------------------------------------

async function runCodexAgent(prompt: string, model: string): Promise<AgentResult> {
  const start = Date.now();
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
  let toolCalls = 0;
  let finalText = "";
  let lastError = "";
  try {
    const codex = new Codex({ apiKey: KEY });
    const thread = codex.startThread({
      model,
      modelReasoningEffort: "low",
      webSearchMode: "disabled",
      webSearchEnabled: false,
      // Codex has no user-supplied tools array; its "tools" are the built-in
      // sandboxed shell. read-only restricts it to the same capability class
      // as the other workers (Glob/Grep/Read — no writes, no edits).
      sandboxMode: "read-only",
    });
    const streamed = await thread.runStreamed(prompt);
    for await (const ev of streamed.events) {
      // Tool-bearing items. Each one represents one tool invocation by Codex.
      if (ev.type === "item.completed") {
        const item = ev.item;
        if (item.type === "command_execution" || item.type === "file_change" || item.type === "mcp_tool_call") {
          toolCalls++;
        }
        if (item.type === "agent_message" && (item as any).text) {
          finalText += (finalText ? "\n" : "") + (item as any).text;
        }
      } else if (ev.type === "error") {
        // Thread-level error event (see ThreadErrorEvent in @openai/codex-sdk).
        lastError = (ev as any).message ?? JSON.stringify(ev);
      } else if (ev.type === "turn.failed") {
        lastError = lastError || JSON.stringify((ev as any).error ?? ev);
      }
    }
    // runStreamed yields a StreamedTurn; the caller discards the handle but we
    // already collected everything we need from the event stream.
    return {
      sdk: "Codex",
      model,
      task: "",
      output: finalText,
      toolCalls,
      elapsedMs: Date.now() - start,
      error: lastError || undefined,
    };
  } catch (error: any) {
    return {
      sdk: "Codex",
      model,
      task: "",
      output: finalText,
      toolCalls,
      elapsedMs: Date.now() - start,
      error: lastError || String(error?.message ?? error),
    };
  }
}

// ---------------------------------------------------------------------------
// 2. Anthropic Claude Agent  (returns AgentResult)
// ---------------------------------------------------------------------------

async function runClaudeAgent(prompt: string, model: string): Promise<AgentResult> {
  const start = Date.now();
  const { query: claudeQuery } = await import("@anthropic-ai/claude-agent-sdk");

  // Capture EVERY message type the SDK emits. The canonical end-of-run
  // signal is `SDKResultMessage` (subtype "success" or "error_*"), NOT
  // the last assistant text block. If we only listen for "assistant"
  // messages, real failures (auth, rate limit, model_not_found, etc.)
  // surface as "timed out after 180000ms" with empty output.
  const textChunks: string[] = [];
  const toolCalls: string[] = [];          // names of tools actually invoked
  let sdkResult: { result?: string; subtype?: string; errors?: string[] } | null = null;
  let authError: string | null = null;
  let initTools: string[] = [];
  let sdkAssistantError: string | null = null;
  let streamEnded = false;

  try {
    const stream = claudeQuery({
      prompt,
      options: {
        model,
        // Match the shared worker toolset (read-only search + read):
        // Glob, Grep, Read are all in the SDK's tool registry
        // (see GlobInput/GrepInput/FileReadInput in sdk-tools.d.ts).
        allowedTools: ["Glob", "Grep", "Read"],
        maxTurns: 30,
        env: {
          ANTHROPIC_BASE_URL: PROXY_BASE,
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || process.env.API_KEY || "sk-fake",
        },
      },
    });

    for await (const msg of stream) {
      const m: any = msg;
      switch (m.type) {
        case "system":
          // SDK initialized. The init subtype lists available tools so we
          // can confirm the SDK accepted our `allowedTools` names.
          if (m.subtype === "init") {
            initTools = m.tools ?? [];
          }
          break;

        case "assistant": {
          // Real assistant response: text + tool_use blocks. Also surface
          // typed errors carried on the assistant message itself.
          const blocks: any[] = m.message?.content ?? [];
          for (const block of blocks) {
            if (block.type === "text" && block.text) {
              textChunks.push(block.text);
            } else if (block.type === "tool_use") {
              toolCalls.push(block.name ?? "unknown");
            }
          }
          if (m.error) sdkAssistantError = String(m.error);
          break;
        }

        case "user":
          // Tool results coming back. Not needed for correctness.
          break;

        case "result":
          // The canonical end-of-run signal.
          sdkResult = {
            result: m.result,
            subtype: m.subtype,
            errors: m.errors,
          };
          streamEnded = true;
          break;

        case "auth_status":
          if (m.error) authError = String(m.error);
          break;

        case "tool_progress":
        case "status":
        case "api_retry":
        case "stream_event":
          // Informational; not needed for correctness.
          break;

        default:
          // Future-proof: don't crash on unknown message types.
          break;
      }

      // If the SDK has emitted a terminal result, we can stop draining
      // — but we still need to let the generator clean up, so don't
      // `break` out (the for-await must complete for cleanup).
      if (streamEnded) {
        // Continue draining silently until the generator returns.
      }
    }

    // Prefer SDKResultMessage.result when present — it's the canonical
    // final answer. Fall back to concatenated text chunks if the run
    // ended without a result (e.g. we hit our outer timeout).
    const finalOutput =
      sdkResult?.result && sdkResult.result.length > 0
        ? sdkResult.result
        : textChunks.join("\n");

    let error: string | undefined;
    if (authError) {
      error = `auth: ${authError}`;
    } else if (sdkResult?.subtype === "error_during_execution") {
      error = `execution: ${sdkResult.errors?.join("; ") ?? "unknown"}`;
    } else if (sdkResult?.subtype === "error_max_turns") {
      error = "max_turns (30) hit";
    } else if (sdkResult?.subtype === "error_max_budget_usd") {
      error = "max_budget_usd hit";
    } else if (sdkResult?.subtype === "error_max_structured_output_retries") {
      error = "structured_output_retries hit";
    } else if (sdkAssistantError) {
      error = `assistant: ${sdkAssistantError}`;
    }

    return {
      sdk: "Claude",
      model,
      task: "",
      output: finalOutput,
      toolCalls: toolCalls.length,
      elapsedMs: Date.now() - start,
      error,
      // Diagnostic fields — not in AgentResult type but useful for debug
      // runs. Cast to any to avoid changing the type signature.
      ...({
        claudeInitTools: initTools,
        claudeToolNames: toolCalls,
        claudeSubtype: sdkResult?.subtype ?? null,
      } as any),
    };
  } catch (error: any) {
    return {
      sdk: "Claude",
      model,
      task: "",
      output: textChunks.join("\n"),
      toolCalls: toolCalls.length,
      elapsedMs: Date.now() - start,
      error: String(error?.message ?? error),
    };
  }
}

// ---------------------------------------------------------------------------
// 3. Gemini Agent  (with tool calling loop, returns AgentResult)
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
        name: "Grep",
        description: "Search file contents under the project root with a JS regex; returns file:line:text matches",
        parameters: {
          type: Type.OBJECT,
          properties: {
            pattern: {
              type: Type.STRING,
              description: 'JavaScript regex, e.g. "curl\\\\s+-X" or "API_KEY"',
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

async function runGeminiAgent(prompt: string, model: string): Promise<AgentResult> {
  const start = Date.now();
  const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY || process.env.API_KEY || "x-proxy-auth",
    httpOptions: { baseUrl: PROXY_BASE },
  });

  const history: { role: string; parts: any[] }[] = [
    { role: "user", parts: [{ text: prompt }] },
  ];
  let toolCalls = 0;
  let finalText = "";
  // Judge prompts expect a direct text (JSON) answer with no tool calls —
  // don't nudge those. Sentinel string comes from buildJudgeUserPrompt.
  const expectsToolUse = !prompt.includes("Return ONLY the JSON verdict.");

  for (let turn = 0; turn < 20; turn++) {
    try {
      const resp = await ai.models.generateContent({
        model,
        contents: history,
        config: { tools: GEMINI_TOOLS },
      });

      const candidate = resp.candidates?.[0];
      const part = candidate?.content?.parts?.[0];
      if (!part) break;

      if (part.functionCall) {
        const fc = part.functionCall;
        const fnName = fc.name as string;
        const fnArgs = fc.args as Record<string, any> | undefined;
        toolCalls++;

        const executor = toolMap[fnName];
        let result: string;
        if (executor) {
          result = await executor(fnArgs ?? {});
        } else {
          result = `Error: unknown tool "${fnName}"`;
        }

        history.push({ role: "model", parts: [{ functionCall: { name: fnName, args: fnArgs ?? {} } }] });
        history.push({ role: "user", parts: [{ functionResponse: { name: fnName, response: { result } } }] });
      } else if (part.text) {
        // A text-only reply before any tool call means the model answered
        // without looking at the codebase (generic non-answer). Nudge it
        // once to actually use the tools instead of accepting it as final.
        if (expectsToolUse && toolCalls === 0 && turn === 0) {
          history.push({ role: "model", parts: [{ text: part.text }] });
          history.push({
            role: "user",
            parts: [{
              text:
                "Do not answer from assumptions. Use the provided tools " +
                "(Glob, Grep, Read) to inspect the actual files under ./tests/ " +
                "first, then give your final answer based on what you find.",
            }],
          });
          continue;
        }
        finalText += (finalText ? "\n" : "") + part.text;
        break;
      } else {
        break;
      }
    } catch (error: any) {
      return {
        sdk: "Gemini",
        model,
        task: "",
        output: finalText,
        toolCalls,
        elapsedMs: Date.now() - start,
        error: String(error?.message ?? error),
      };
    }
  }

  return {
    sdk: "Gemini",
    model,
    task: "",
    output: finalText,
    toolCalls,
    elapsedMs: Date.now() - start,
  };
}

// ---------------------------------------------------------------------------
// Agent registry  (typed run signature: returns AgentResult now)
// ---------------------------------------------------------------------------

type Agent = {
  name: string;
  run: (prompt: string, model: string) => Promise<AgentResult>;
};

const AGENTS: Agent[] = [
  { name: "Codex",  run: runCodexAgent  },
  { name: "Claude", run: runClaudeAgent },
  { name: "Gemini", run: runGeminiAgent },
];

// ---------------------------------------------------------------------------
// Composite: random worker-pair + judge  (deterministic per run via seed)
// ---------------------------------------------------------------------------

/**
 * Seeded RNG (mulberry32) — small, fast, deterministic. Same seed → same
 * shuffle. This is the ONLY randomness in the composite agent, applied
 * ONCE at startup so all (task, model) pairs see the same assignments.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleSeeded<T>(arr: T[], rng: () => number): T[] {
  // Kept for potential future use (e.g. randomized worker order within a fixed
  // worker pair). Not currently called by pickCompositeTeam — random judge
  // selection is enough to vary the team.
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
// void-reference to keep shuffleSeeded from being tree-shaken / flagged unused.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _shuffleSeededAvailable = shuffleSeeded;

/**
 * Pick [workerA, workerB, judge] from 3 SDKs.
 *
 *   - If a judge is specified via CLI (`--judge`), that SDK is the judge and
 *     the remaining two SDKs become the workers (order preserved from AGENTS).
 *   - Otherwise the judge is chosen uniformly at random via a seeded RNG,
 *     and the other two are the workers.
 *
 * Same seed → same assignment. The judge never judges itself.
 */
function pickCompositeTeam(seed: number, judgeOverride: string | null = null): { workers: [Agent, Agent]; judge: Agent } {
  if (judgeOverride) {
    const judgeIdx = AGENTS.findIndex(
      (a) => a.name.toLowerCase() === judgeOverride.toLowerCase(),
    );
    if (judgeIdx < 0) {
      const known = AGENTS.map((a) => a.name).join(", ");
      throw new Error(
        `Unknown --judge "${judgeOverride}". Known SDKs: ${known}.`,
      );
    }
    const workers: [Agent, Agent] = judgeIdx === 0
      ? [AGENTS[1], AGENTS[2]]
      : judgeIdx === 1
      ? [AGENTS[0], AGENTS[2]]
      : [AGENTS[0], AGENTS[1]];
    return { workers, judge: AGENTS[judgeIdx] };
  }

  const rng = mulberry32(seed);
  const judgeIdx = Math.floor(rng() * AGENTS.length);
  const judge = AGENTS[judgeIdx];
  const workers: [Agent, Agent] = (judgeIdx === 0
    ? [AGENTS[1], AGENTS[2]]
    : judgeIdx === 1
    ? [AGENTS[0], AGENTS[2]]
    : [AGENTS[0], AGENTS[1]]) as [Agent, Agent];
  return { workers, judge };
}

// ---------------------------------------------------------------------------
// Judge prompt + verdict parsing
// ---------------------------------------------------------------------------

const JUDGE_SYSTEM_PROMPT = `You are an impartial judge evaluating two AI agent outputs for the same task.

Read the original task and both outputs. Pick the WINNER based on:
  - Accuracy: claims that can be verified against the referenced files
  - Completeness: covers the task's scope
  - Specificity: concrete file paths, line numbers, actionable recommendations
  - Honesty: admits uncertainty rather than fabricating

Respond with ONLY a JSON object, no markdown fencing, no preamble:
{
  "winner": "<Codex|Claude|Gemini>",
  "reason": "<one sentence explaining the choice>",
  "confidence": "high" | "medium" | "low"
}`;

function buildJudgeUserPrompt(task: string, a: AgentResult, b: AgentResult): string {
  return [
    `## Task`,
    task,
    ``,
    `## Output A (${a.sdk}, ${a.toolCalls} tool calls, ${a.elapsedMs}ms)`,
    a.output || `(empty${a.error ? `; error: ${a.error}` : ""})`,
    ``,
    `## Output B (${b.sdk}, ${b.toolCalls} tool calls, ${b.elapsedMs}ms)`,
    b.output || `(empty${b.error ? `; error: ${b.error}` : ""})`,
    ``,
    `Return ONLY the JSON verdict.`,
  ].join("\n");
}

/**
 * Run the judge using the assigned judge SDK. The judge receives the task +
 * both worker outputs and must return a JSON verdict. Falls back to a
 * heuristic if the judge's response can't be parsed.
 *
 * Each SDK call is wrapped in a hard timeout so a flaky upstream can't
 * stall the whole composite. On timeout, returns an empty result so the
 * heuristic fallback can pick a winner.
 */
const SDK_TIMEOUT_MS = process.env.TIMEOUT_MS || 300_000;

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runJudge(
  judge: Agent,
  task: string,
  a: AgentResult,
  b: AgentResult,
  model: string,
): Promise<JudgeVerdict> {
  const userPrompt = buildJudgeUserPrompt(task, a, b);
  const judgePrompt = `${JUDGE_SYSTEM_PROMPT}\n\n---\n\n${userPrompt}`;

  let raw: AgentResult;
  try {
    raw = await withTimeout(judge.run(judgePrompt, model), SDK_TIMEOUT_MS, `judge(${judge.name})`);
  } catch (e: any) {
    raw = {
      sdk: judge.name,
      model,
      task: a.task,
      output: "",
      toolCalls: 0,
      elapsedMs: SDK_TIMEOUT_MS,
      error: String(e?.message ?? e),
    };
  }

  return parseJudgeVerdict(raw, a, b);
}

function parseJudgeVerdict(raw: AgentResult, a: AgentResult, b: AgentResult): JudgeVerdict {
  const text = raw.output.trim();

  // Try to extract a JSON object from the response (handles ```json fences).
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const winnerName =
        parsed.winner === a.sdk ? a.sdk :
        parsed.winner === b.sdk ? b.sdk :
        null;
      if (winnerName) {
        return {
          winner: winnerName,
          reason: String(parsed.reason ?? "").slice(0, 500),
          confidence: ["high", "medium", "low"].includes(parsed.confidence) ? parsed.confidence : "low",
        };
      }
    } catch {
      // fall through to heuristic
    }
  }

  // Heuristic fallback: pick the longer non-error output.
  const aOk = !a.error && a.output.length > 0;
  const bOk = !b.error && b.output.length > 0;
  let fallbackWinner: string;
  let confidence: "high" | "medium" | "low" = "low";
  if (aOk && !bOk) { fallbackWinner = a.sdk; }
  else if (!aOk && bOk) { fallbackWinner = b.sdk; }
  else if (aOk && bOk) {
    fallbackWinner = a.output.length >= b.output.length ? a.sdk : b.sdk;
    confidence = "low";
  } else {
    // Both errored — pick arbitrarily, mark very low confidence.
    fallbackWinner = a.sdk;
  }
  return {
    winner: fallbackWinner,
    reason: `Judge SDK failed to return parseable JSON; fell back to heuristic (longer non-error output). Raw: ${text.slice(0, 200)}`,
    confidence,
    raw: text,
  };
}

// ---------------------------------------------------------------------------
// Composite orchestration
// ---------------------------------------------------------------------------

async function runCompositeFor(
  task: { name: string; prompt: string },
  model: string,
  team: { workers: [Agent, Agent]; judge: Agent },
): Promise<CompositeResult> {
  const [workerA, workerB] = team.workers;
  const prompt = task.prompt;

  // 1. Run both workers concurrently against the same prompt + model,
  //    each guarded by a hard timeout so a flaky upstream can't block
  //    the whole composite.
  const [resA, resB] = await Promise.all([
    withTimeout(workerA.run(prompt, model), SDK_TIMEOUT_MS, `workerA(${workerA.name})`)
      .catch((e: any): AgentResult => ({
        sdk: workerA.name, model, task: task.name, output: "",
        toolCalls: 0, elapsedMs: SDK_TIMEOUT_MS, error: String(e?.message ?? e),
      })),
    withTimeout(workerB.run(prompt, model), SDK_TIMEOUT_MS, `workerB(${workerB.name})`)
      .catch((e: any): AgentResult => ({
        sdk: workerB.name, model, task: task.name, output: "",
        toolCalls: 0, elapsedMs: SDK_TIMEOUT_MS, error: String(e?.message ?? e),
      })),
  ]);

  // 2. Judge picks a winner.
  const verdict = await runJudge(team.judge, prompt, resA, resB, model);

  // 3. Resolve the winning output.
  const winningOutput =
    verdict.winner === resA.sdk ? resA.output :
    verdict.winner === resB.sdk ? resB.output :
    (resA.output.length >= resB.output.length ? resA.output : resB.output);

  return {
    task: task.name,
    model,
    workers: [workerA.name, workerB.name],
    judge: team.judge.name,
    workerResults: [resA, resB],
    verdict,
    winningOutput,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// CLI  (preserves M A T semantics; adds --json and --seed)
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  json: boolean;
  seed: number;
  modelOverride: string | null;
  judgeOverride: string | null;
  positional: string[];
} {
  let json = false;
  let seed = Date.now() & 0xffffffff;
  let modelOverride: string | null = null;
  let judgeOverride: string | null = null;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") json = true;
    else if (a === "--seed") { seed = parseInt(argv[++i], 10) || seed; }
    else if (a === "--model") { modelOverride = argv[++i] ?? null; }
    else if (a === "--judge") { judgeOverride = argv[++i] ?? null; }
    else positional.push(a);
  }
  return { json, seed, modelOverride, judgeOverride, positional };
}

function selectByCli<T>(arr: T[], idx: number | null): T[] {
  if (idx === null) return arr;
  return [arr[((idx - 1) % arr.length + arr.length) % arr.length]];
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
      const preferred = ["deepseek", "minimax", "gemini", "claude", "gpt", "qwen", "moonshot", "z-ai"];
      const selected: string[] = [];
      for (const prefix of preferred) {
        const match = apiIds.find(
          (id: string) => id.startsWith(prefix) || id.toLowerCase().startsWith(prefix),
        );
        if (match) selected.push(match);
        if (selected.length >= 8) break;
      }
      if (selected.length > 0) {
        MODELS.splice(0, MODELS.length, ...selected);
      }
    }
  } catch {
    // fall back to hardcoded list
  }

  const { json, seed, modelOverride, judgeOverride, positional } = parseArgs(process.argv.slice(2));

  // CLI selection: positional[0..2] are M, A, T (1-based; 0 = all in that dim)
  let modelsToRun = MODELS;
  let tasksToRun = USER_TASKS;
  if (modelOverride) {
    modelsToRun = [modelOverride];
  }
  if (positional.length >= 3) {
    const m = parseInt(positional[0], 10);
    const t = parseInt(positional[2], 10);
    if (!modelOverride && Number.isFinite(m) && m > 0) modelsToRun = selectByCli(MODELS, m);
    if (Number.isFinite(t) && t > 0) tasksToRun = selectByCli(USER_TASKS, t);
  }

  // Random judge selection by default; user can pin via --judge.
  // If the pinned SDK is unknown, pickCompositeTeam throws — let it crash
  // loudly so the user sees their typo immediately.
  const team = pickCompositeTeam(seed, judgeOverride);
  const teamSource = judgeOverride
    ? `pinned via --judge=${judgeOverride}`
    : `random (seed=${seed})`;
  console.log(`\n=== Composite team (${teamSource}) ===`);
  console.log(`  workers: ${team.workers[0].name}, ${team.workers[1].name}`);
  console.log(`  judge:   ${team.judge.name}`);

  console.log(
    `\nSelection: ${modelsToRun.length} model(s) x ${tasksToRun.length} task(s)`,
  );
  for (const m of modelsToRun) console.log(`  model: ${m}`);
  for (const t of tasksToRun) console.log(`  task:  ${t.name}`);

  const results: CompositeResult[] = [];

  for (const task of tasksToRun) {
    for (const model of modelsToRun) {
      console.log(
        `\n=========== Task: ${task.name} | Model: ${model} ===========`,
      );
      const result = await runCompositeFor(task, model, team);
      results.push(result);

      if (json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        const [workerResultA, workerResultB] = result.workerResults;
        const losingResult = result.verdict.winner === workerResultA.sdk
          ? workerResultB
          : result.verdict.winner === workerResultB.sdk
          ? workerResultA
          : workerResultA.output.length < workerResultB.output.length
          ? workerResultA
          : workerResultB;

        console.log(`  workers: ${result.workers.join(" + ")}`);
        console.log(`  judge:   ${result.judge}`);
        console.log(`  tool calls: A=${workerResultA.toolCalls}, B=${workerResultB.toolCalls}`);
        console.log(`  elapsed: A=${workerResultA.elapsedMs}ms, B=${workerResultB.elapsedMs}ms`);
        if (workerResultA.error) console.log(`  A error: ${workerResultA.error}`);
        if (workerResultB.error) console.log(`  B error: ${workerResultB.error}`);
        console.log(`  verdict: ${result.verdict.winner} wins (${result.verdict.confidence})`);
        console.log(`  reason:  ${result.verdict.reason}`);
        console.log(`\n--- Winning output (${result.verdict.winner}) ---`);
        console.log(result.winningOutput || "(empty)");
        console.log(`\n--- Losing output (${losingResult.sdk}${losingResult.error ? ", partial" : ""}) ---`);
        console.log(losingResult.output || "(empty)");
      }
    }
  }

  // Summary
  if (json) {
    console.log(JSON.stringify({ summary: results.map(r => ({
      task: r.task,
      model: r.model,
      workers: r.workers,
      judge: r.judge,
      winner: r.verdict.winner,
      confidence: r.verdict.confidence,
      reason: r.verdict.reason,
    })) }, null, 2));
  } else {
    console.log(`\n=========== Summary (${results.length} composite runs) ===========`);
    const winCounts: Record<string, number> = {};
    for (const r of results) {
      winCounts[r.verdict.winner] = (winCounts[r.verdict.winner] ?? 0) + 1;
    }
    console.log(`Worker win counts (across all composite runs):`);
    for (const [sdk, n] of Object.entries(winCounts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${sdk}: ${n}`);
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
