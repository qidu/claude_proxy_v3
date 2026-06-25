/**
 * npm install @openai/codex-sdk @anthropic-ai/claude-agent-sdk @@google/genai
 * export OPENAI_API_KEY="your_openai_key"
 * export ANTHROPIC_API_KEY="your_anthropic_key"
 *
 * process.env.ANTHROPIC_BASE_URL = "https://your-custom-proxy.com";
 * process.env.ANTHROPIC_AUTH_TOKEN = "your_proxy_token";
 *
 * * base url for codex sdk
 * const codex = new Codex({
 *   baseUrl: "https://your-custom-endpoint.com", // Overrides default OpenAI endpoint
 *   apiKey: process.env.OPENAI_API_KEY,
 * });
 *
 *
 *
 */

import { GoogleGenAI } from "@google/genai"; // Official Gemini SDK
// @openai/codex-sdk and @anthropic-ai/claude-agent-sdk are imported lazily
// inside runCodexAgent / runClaudeAgent to avoid hard failures when not installed.

const USER_TASK = "Analyze the codebase file structure in ./tests/ and report layout suggestions.";

/**
 * 1. OpenAI Codex SDK Execution Path
 */
async function runCodexAgent(prompt: string) {
  console.log("=== Launching OpenAI Codex Agent ===");
  const { Codex } = await import("@openai/codex-sdk");
  const KEY = process.env.OPENAI_API_KEY || "sk-hi";
  // Ensure ~/.codex/config.toml points Codex CLI at the local proxy.
  // The @openai/codex-sdk 0.142.2 still passes `--config openai_base_url=...`
  // which codex-cli 0.107.0 silently ignores, so we have to set the
  // model_provider ourselves.
  const fs = await import("fs");
  const os = await import("os");
  const path = await import("path");
  const codexDir = path.join(os.homedir(), ".codex");
  const codexConfig = path.join(codexDir, "config.toml");
  const desired = `model = "deepseek-v4-pro"
model_provider = "localproxy"

[model_providers.localproxy]
name = "Local Proxy"
base_url = "http://127.0.0.1:7777/v1"
env_key = "CODEX_API_KEY"
wire_api = "responses"
`;
  fs.mkdirSync(codexDir, { recursive: true });
  if (!fs.existsSync(codexConfig) || fs.readFileSync(codexConfig, "utf8") !== desired) {
    fs.writeFileSync(codexConfig, desired);
  }
  try {
    // baseUrl is intentionally omitted — the SDK's openai_base_url key is
    // rejected by codex-cli 0.107.0, so routing is handled via config.toml.
    // modelReasoningEffort="none" disables thinking mode, which would
    // otherwise require reasoning_content round-tripping that the
    // proxy's Responses→ChatCompletions converter does not yet implement.
    const codex = new Codex({ apiKey: KEY });
    // Instantiates a local context-aware workspace thread
    const thread = codex.startThread({ modelReasoningEffort: "minimal" });

    // Executes the agent loop inside the local environment repository
    const result = await thread.run(prompt);
    console.log("Codex Final Output:", result.finalResponse ?? result);
  } catch (error) {
    console.error("Codex Execution Failed:", error);
  }
}

/**
 * 2. Anthropic Claude Agent SDK Execution Path
 */
async function runClaudeAgent(prompt: string) {
  console.log("\n=== Launching Anthropic Claude Agent ===");
  const { query: claudeQuery } = await import("@anthropic-ai/claude-agent-sdk");
  try {
    // The query method returns an asynchronous stream tracking internal agent states
    const messageStream = claudeQuery({
      prompt: prompt,
      options: {
        model: "deepseek-v4-pro", // Valid model name in the proxy config
        allowedTools: ["Glob", "Read"], // Enforces rigid workspace constraints
        maxTurns: 30
      }
    });

    for await (const message of messageStream) {
      // Isolates terminal text outputs while ignoring intermediate file edits/tool calls
      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if ("text" in block) {
            console.log(block.text);
          }
        }
      }
      if (message.type === "result") {
        console.log(`Claude Done. Status: ${message.subtype}`);
      }
    }
  } catch (error) {
    console.error("Claude Agent Execution Failed:", error);
  }
}

async function runGemini(prompt: string) {
  console.log("\n=== Launching Gemini Agent ===");
  const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY || "x-proxy-auth",
    httpOptions: { baseUrl: "http://127.0.0.1:7777" },
  });
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
    });
    console.log("Gemini Output:", response.text);
  } catch (error) {
    console.error("Gemini Execution Failed:", error);
  }
}

/**
 * Main orchestration function
 */
async function main() {
  await runCodexAgent(USER_TASK);
  await runClaudeAgent(USER_TASK);
  await runGemini(USER_TASK);
}

main().catch((err) => {
  console.error("Fatal Workflow Error:", err);
});
