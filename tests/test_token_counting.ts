/**
 * Token Counting Test Suite for model_proxy_v3
 * 
 * Tests local token counting functionality with various models and content types.
 * 
 * Usage:
 *   npm run test:token-counting
 *   npx tsx tests/test_token_counting.ts
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Configuration
const PORT = 8788;
const PROXY_ENDPOINT = `http://localhost:${PORT}/v1/messages`;
const COUNT_TOKENS_ENDPOINT = `http://localhost:${PORT}/v1/messages/count_tokens`;
const API_KEY = "sk-17ac71ed56aee29a57519861d09ab147407fbe0ed010d3f48f9156ea8a9eb3c9";

interface TestResult {
  model: string;
  file?: string;
  inputTokens: number;
  countingMethod?: string;
}

interface TestSuite {
  name: string;
  results: TestResult[];
}

// Test data
const SHORT_TEXT = "Hello, how are you today?";
const DOC_CONTENT = fs.readFileSync(path.join(__dirname, '../docs/claude-api-reference.md'), 'utf-8');
const STANDARD_TEXT = `The quick brown fox jumps over the lazy dog. This is a sample sentence for testing tokenization across different AI models. Artificial intelligence has rapidly transformed from a speculative concept to a practical reality.`;

// Models to test
const MODELS = [
  "deepseek/deepseek-v3.2-251201",
  "minimax/minimax-m2.5",
  "moonshotai/kimi-k2.5",
  "z-ai/glm-5",
  "claude-sonnet-4-20250514"
];

const MAIN_MODELS = [
  "deepseek/deepseek-v3.2-251201",
  "minimax/minimax-m2.5",
  "moonshotai/kimi-k2.5",
  "z-ai/glm-5"
];

// Helper function to make API requests
async function countTokens(model: string, content: string): Promise<TestResult> {
  try {
    const response = await fetch(COUNT_TOKENS_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": API_KEY
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content }],
        max_tokens: 1024
      })
    });

    const data = await response.json();
    return { model, inputTokens: data.input_tokens || 0 };
  } catch (error) {
    console.error(`Error counting tokens for ${model}:`, error);
    return { model, inputTokens: -1 };
  }
}

// Get all .ts files in src directory
function getSrcFiles(): string[] {
  const files: string[] = [];
  const srcDir = path.join(__dirname, '../src');
  
  function walkDir(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.includes('node_modules')) {
        walkDir(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        files.push(fullPath);
      }
    }
  }
  
  walkDir(srcDir);
  return files.sort();
}

// Test Suite 1: Short Text Token Counting
async function testShortText(): Promise<TestSuite> {
  console.log("\n=== Test Suite: Short Text Token Counting ===\n");
  
  const results: TestResult[] = [];
  console.log("| Model | Input Tokens |");
  console.log("|-------|-------------|");
  
  for (const model of MAIN_MODELS) {
    const result = await countTokens(model, SHORT_TEXT);
    results.push(result);
    console.log(`| ${model} | ${result.inputTokens} |`);
  }
  
  return { name: "Short Text Token Counting", results };
}

// Test Suite 2: Documentation Content Token Counting
async function testDocContent(): Promise<TestSuite> {
  console.log("\n=== Test Suite: Documentation Content Token Counting ===\n");
  
  const results: TestResult[] = [];
  console.log("| Model | Input Tokens | Counting Method |");
  console.log("|-------|-------------|-----------------|");
  
  // Get counting method header
  const methodResponse = await fetch(COUNT_TOKENS_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": API_KEY
    },
    body: JSON.stringify({
      model: MODELS[0],
      messages: [{ role: "user", content: "test" }],
      max_tokens: 1024
    })
  });
  const method = methodResponse.headers.get("x-token-counting") || "unknown";
  
  for (const model of MODELS) {
    const result = await countTokens(model, DOC_CONTENT);
    results.push({ ...result, countingMethod: method });
    console.log(`| ${model} | ${result.inputTokens} | ${method} |`);
  }
  
  return { name: "Documentation Content Token Counting", results };
}

// Test Suite 3: Model Comparison (Same Input)
async function testModelComparison(): Promise<TestSuite> {
  console.log("\n=== Test Suite: Model Comparison (Same Input) ===\n");
  
  const results: TestResult[] = [];
  console.log("| Model | Input Tokens |");
  console.log("|-------|-------------|");
  
  for (const model of MODELS) {
    const result = await countTokens(model, STANDARD_TEXT);
    results.push(result);
    console.log(`| ${model} | ${result.inputTokens} |`);
  }
  
  return { name: "Model Comparison", results };
}

// Test Suite 4: Source Files Token Counting
async function testSrcFiles(): Promise<TestSuite> {
  console.log("\n=== Test Suite: Source Files Token Counting ===\n");
  console.log("Model: deepseek/deepseek-v3.2-251201\n");
  
  const files = getSrcFiles();
  const results: TestResult[] = [];
  
  console.log("| File | Input Tokens |");
  console.log("|-------|-------------|");
  
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf-8');
    const relativePath = path.relative(path.join(__dirname, '../..'), file);
    const result = await countTokens("deepseek/deepseek-v3.2-251201", content);
    results.push({ ...result, file: relativePath });
    console.log(`| ${relativePath} | ${result.inputTokens} |`);
  }
  
  // Sort by tokens descending
  results.sort((a, b) => b.inputTokens - a.inputTokens);
  
  console.log(`\n**Total files:** ${files.length}`);
  console.log(`**Total tokens:** ${results.reduce((sum, r) => sum + r.inputTokens, 0)}`);
  console.log(`**Largest file:** ${results[0]?.file} (${results[0]?.inputTokens} tokens)`);
  console.log(`**Smallest file:** ${results[results.length - 1]?.file} (${results[results.length - 1]?.inputTokens} tokens)`);
  
  return { name: "Source Files Token Counting", results };
}

// Main function
async function main() {
  console.log("=".repeat(50));
  console.log("     Token Counting Test Results");
  console.log("=".repeat(50));
  console.log(`\nProxy: ${PROXY_ENDPOINT}`);
  console.log(`API Key: ***${API_KEY.substring(32, API_KEY.length)}`);
  
  // Verify proxy is running
  try {
    const healthCheck = await fetch(`http://localhost:${PORT}/`);
    if (!healthCheck.ok) {
      throw new Error("Proxy not responding correctly");
    }
  } catch (error) {
    console.error("\nError: Proxy is not running at", PROXY_ENDPOINT);
    console.error("Please start the proxy first with:");
    console.error("  LOCAL_TOKEN_COUNTING=true node dist/server.js");
    process.exit(1);
  }
  
  const allResults: TestSuite[] = [];
  
  // Run all test suites
  allResults.push(await testShortText());
  allResults.push(await testDocContent());
  allResults.push(await testModelComparison());
  allResults.push(await testSrcFiles());
  
  console.log("\n" + "=".repeat(50));
  console.log("     All Tests Completed!");
  console.log("=".repeat(50));
  
  // Export results to JSON
  const exportPath = path.join(__dirname, 'test_token_counting_results.json');
  fs.writeFileSync(exportPath, JSON.stringify(allResults, null, 2));
  console.log(`\nResults exported to: ${exportPath}`);
}

// Run tests
main().catch(console.error);
