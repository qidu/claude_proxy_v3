/**
 * Performance benchmark for the model proxy backend modules.
 * Tests converters, token counting, and stringify methods in isolation.
 * Run: npx tsx tests/test_performance_benchmark.ts
 */

import { createHash } from 'crypto';

// ---------------------------------------------------------------------------
// 1. Stringify method comparison
// ---------------------------------------------------------------------------
async function benchmarkStringify() {
  console.log('\n=== 1. stringify() method comparison ===\n');

  const testPayloads = [
    { name: 'small object', obj: { a: 1, b: 2, c: 3 } },
    { name: 'nested object', obj: { level1: { level2: { level3: { level4: { value: 'deep' } } } } } },
    { name: 'array of objects', obj: Array.from({ length: 100 }, (_, i) => ({ id: i, name: `item-${i}`, data: { x: i * 2, y: i * 3 } })) },
    { name: 'large flat object', obj: Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`key${i}`, `value${i}`])) },
    { name: 'message payload', obj: {
      model: 'claude-3-5-sonnet-20241022',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: Array(500).fill('Hello world. ').join('') }
      ],
      max_tokens: 1024,
      stream: false,
      temperature: 0.7
    }},
  ];

  const { stringify: safeStable } = await import('safe-stable-stringify');
  const fastSafe = (await import('fast-safe-stringify')).default;

  for (const { name, obj } of testPayloads) {
    const iterations = 5000;

    // JSON.stringify
    const startJ = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) { JSON.stringify(obj); }
    const endJ = process.hrtime.bigint();
    const timeJson = Number(endJ - startJ) / iterations / 1000;

    // safe-stable-stringify
    const startS = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) { safeStable(obj); }
    const endS = process.hrtime.bigint();
    const timeSafe = Number(endS - startS) / iterations / 1000;

    // fast-safe-stringify
    const startF = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) { fastSafe(obj); }
    const endF = process.hrtime.bigint();
    const timeFast = Number(endF - startF) / iterations / 1000;

    console.log(`  ${name}:`);
    console.log(`    JSON.stringify:          ${timeJson.toFixed(3)} µs/op`);
    console.log(`    safe-stable-stringify:   ${timeSafe.toFixed(3)} µs/op  (${(timeSafe / timeJson * 100).toFixed(0)}% vs JSON)`);
    console.log(`    fast-safe-stringify:     ${timeFast.toFixed(3)} µs/op  (${(timeFast / timeJson * 100).toFixed(0)}% vs JSON)`);
  }
}

// ---------------------------------------------------------------------------
// 2. Claude → OpenAI converter benchmark
// ---------------------------------------------------------------------------
async function benchmarkClaudeToOpenai() {
  console.log('\n=== 2. claude-to-openai converter ===\n');

  const { convertClaudeToOpenAIRequest } = await import('../src/converters/claude-to-openai.js');

  const buildMessages = (n: number) => [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: Array(n).fill('Hello. ').join('') },
    { role: 'assistant', content: Array(n).fill('Hi there! ').join('') },
    { role: 'user', content: Array(n).fill('Tell me more. ').join('') },
  ];

  const payloads = [
    { name: 'tiny (10 words)',    messages: buildMessages(2) },
    { name: 'small (200 words)',  messages: buildMessages(50) },
    { name: 'medium (2k words)',  messages: buildMessages(500) },
  ];

  for (const { name, messages } of payloads) {
    const request = { model: 'gpt-4', messages, max_tokens: 100, stream: false };
    const iterations = 1000;

    for (let i = 0; i < 5; i++) convertClaudeToOpenAIRequest(request as any, 'gpt-4');

    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) { convertClaudeToOpenAIRequest(request as any, 'gpt-4'); }
    const end = process.hrtime.bigint();
    const timePerOp = Number(end - start) / iterations / 1000;

    console.log(`  ${name}: ${timePerOp.toFixed(2)} µs/op`);
  }
}

// ---------------------------------------------------------------------------
// 3. OpenAI → Claude response converter benchmark
// ---------------------------------------------------------------------------
async function benchmarkOpenaiToClaude() {
  console.log('\n=== 3. openai-to-claude converter ===\n');

  const { convertOpenAIToClaudeResponse } = await import('../src/converters/openai-to-claude.js');

  const payloads = [
    {
      name: 'simple text',
      response: {
        id: 'chatcmpl-123',
        choices: [{ message: { role: 'assistant', content: 'Hello! How can I help you today?' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 8, total_tokens: 13 }
      }
    },
    {
      name: 'long text',
      response: {
        id: 'chatcmpl-456',
        choices: [{ message: { role: 'assistant', content: Array(500).fill('This is a long response. ').join('') }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 50, completion_tokens: 500, total_tokens: 550 }
      }
    },
    {
      name: 'with tool calls',
      response: {
        id: 'chatcmpl-789',
        choices: [{
          message: {
            role: 'assistant',
            content: null,
            tool_calls: Array.from({ length: 5 }, (_, i) => ({
              id: `call_${i}`,
              type: 'function',
              function: { name: `func${i}`, arguments: JSON.stringify({ param: `value${i}` }) }
            }))
          },
          finish_reason: 'tool_calls'
        }],
        usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 }
      }
    },
  ];

  for (const { name, response } of payloads) {
    const iterations = 500;

    for (let i = 0; i < 5; i++) await convertOpenAIToClaudeResponse(response as any, 'claude-sonnet-4', 'req-1');

    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) { await convertOpenAIToClaudeResponse(response as any, 'claude-sonnet-4', 'req-2'); }
    const end = process.hrtime.bigint();
    const timePerOp = Number(end - start) / iterations / 1000;

    console.log(`  ${name}: ${timePerOp.toFixed(2)} µs/op`);
  }
}

// ---------------------------------------------------------------------------
// 4. Token counting benchmark
// ---------------------------------------------------------------------------
async function benchmarkTokenCounting() {
  console.log('\n=== 4. Token counting ===\n');

  const { countTokensWithTiktoken } = await import('../src/utils/token-counting.js');

  const texts = [
    { name: 'short English', text: 'Hello world!' },
    { name: 'medium English', text: Array(100).fill('The quick brown fox jumps over the lazy dog. ').join('') },
    { name: 'long English', text: Array(1000).fill('This is a sample text for token counting performance benchmark. ').join('') },
    { name: 'mixed Chinese+English', text: 'Hello世界' + Array(200).fill('人工智能机器学习深度学习自然语言处理').join('') },
    { name: 'code', text: Array(50).fill(`
function fibonacci(n: number): number {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}
    `).join('\n') },
  ];

  for (const { name, text } of texts) {
    const iterations = 200;

    for (let i = 0; i < 3; i++) countTokensWithTiktoken(text);

    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) { countTokensWithTiktoken(text); }
    const end = process.hrtime.bigint();
    const timePerOp = Number(end - start) / iterations / 1000;

    console.log(`  ${name} (${text.length} chars): ${timePerOp.toFixed(2)} µs/op`);
  }
}

// ---------------------------------------------------------------------------
// 5. End-to-end round-trip (converter there-and-back)
// ---------------------------------------------------------------------------
async function benchmarkEndToEnd() {
  console.log('\n=== 5. End-to-end request/response conversion throughput ===\n');

  const { convertClaudeToOpenAIRequest } = await import('../src/converters/claude-to-openai.js');
  const { convertOpenAIToClaudeResponse } = await import('../src/converters/openai-to-claude.js');

  const claudeRequest = {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'Explain the theory of relativity in simple terms.' }]
  };

  const iterations = 5000;

  for (let i = 0; i < 10; i++) {
    const oai = convertClaudeToOpenAIRequest(claudeRequest as any, 'gpt-4');
    await convertOpenAIToClaudeResponse(oai as any, 'claude-sonnet-4', 'warmup');
  }

  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) {
    const oai = convertClaudeToOpenAIRequest(claudeRequest as any, 'gpt-4');
    await convertOpenAIToClaudeResponse(oai as any, 'claude-sonnet-4', `req-${i}`);
  }
  const end = process.hrtime.bigint();
  const timePerOp = Number(end - start) / iterations / 1000;

  console.log(`  Claude→OpenAI + OpenAI→Claude round-trip:`);
  console.log(`  ${iterations} iterations, ${timePerOp.toFixed(2)} µs/op (${(1000000 / timePerOp).toFixed(0)} ops/sec)`);
}

// ---------------------------------------------------------------------------
// 6. Routine completion (dashboard stats overhead)
// ---------------------------------------------------------------------------
function benchmarkStats() {
  console.log('\n=== 6. Dashboard stats overhead ===\n');

  const iterations = 1000000;
  const endpoint = '/v1/messages';
  const elapsedMs = 1234;

  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) {
    // Simulate what happens per-request: 6 lightweight map operations
    const h = createHash('sha256');
    h.update(endpoint + i).digest('hex').slice(0, 8); // placeholder "lookup"
  }
  const end = process.hrtime.bigint();
  const timePerOp = Number(end - start) / iterations / 1000;

  console.log(`  ${iterations.toLocaleString()} iterations`);
  console.log(`  ~${timePerOp.toFixed(6)} µs per hash+map operation`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('#');
  console.log('# Model Proxy Performance Benchmark');
  console.log('#');
  console.log(`# Date: ${new Date().toISOString()}`);
  console.log(`# Node: ${process.version}`);
  console.log(`# Platform: ${process.platform} ${process.arch}`);
  console.log('#');

  await benchmarkStringify();
  await benchmarkClaudeToOpenai();
  await benchmarkOpenaiToClaude();
  await benchmarkTokenCounting();
  await benchmarkEndToEnd();
  benchmarkStats();

  console.log('\n=== Benchmark Complete ===');
}

main().catch(console.error);