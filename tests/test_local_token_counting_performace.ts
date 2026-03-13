/**
 * Performance test for js-tiktoken token counting
 * Run: npx tsx tests/test_local_token_counting.ts
 */

import { Tiktoken } from 'js-tiktoken/lite';
import o200k_base from 'js-tiktoken/ranks/o200k_base';
import cl100k_base from 'js-tiktoken/ranks/cl100k_base';
import p50k_base from 'js-tiktoken/ranks/p50k_base';
import p50k_edit from 'js-tiktoken/ranks/p50k_edit';
import r50k_base from 'js-tiktoken/ranks/r50k_base';

// Mapping of model names to encodings
const ENCODINGS: Record<string, Uint8Array> = {
  'o200k_base': o200k_base,
  'cl100k_base': cl100k_base,
  'p50k_base': p50k_base,
  'p50k_edit': p50k_edit,
  'r50k_base': r50k_base,
};

interface TokenizerCache {
  tokenizer: Tiktoken | null;
  modelName: string;
}

const cache: TokenizerCache = {
  tokenizer: null,
  modelName: '',
};

function getTokenizer(modelName: string = 'o200k_base'): Tiktoken {
  if (cache.tokenizer && cache.modelName === modelName) {
    return cache.tokenizer;
  }

  const encoding = ENCODINGS[modelName] || o200k_base;
  cache.tokenizer = new Tiktoken(encoding);
  cache.modelName = modelName;
  return cache.tokenizer;
}

function countTokens(text: string, modelName: string = 'o200k_base'): number {
  const tokenizer = getTokenizer(modelName);
  const tokens = tokenizer.encode(text);
  return tokens.length;
}

function estimateTokenCount(text: string, charactersPerToken: number = 4): number {
  return Math.ceil(text.length / charactersPerToken);
}

// Test data: various text types
const testCases = [
  { name: 'Short English', text: 'Hello, world!' },
  { name: 'Medium English', text: 'The quick brown fox jumps over the lazy dog. This is a sample sentence for testing tokenization.' },
  { name: 'Long English', text: `
    Artificial intelligence (AI) has rapidly transformed from a speculative concept to a practical reality that impacts nearly every aspect of modern life.
    From healthcare diagnostics to autonomous vehicles, from recommendation algorithms to natural language processing, AI systems are increasingly embedded in our daily experiences.
    Machine learning, a subset of AI, enables computers to learn patterns from data without being explicitly programmed for every possible scenario.
    Deep learning, with its neural networks inspired by the human brain, has achieved remarkable breakthroughs in image recognition, speech synthesis, and strategic games.
    However, AI also raises important questions about bias, transparency, job displacement, and the ethical use of powerful computational systems.
    As we continue to develop more sophisticated AI technologies, it becomes crucial to ensure these systems are designed and deployed responsibly.
    Researchers, policymakers, and industry leaders must collaborate to establish guidelines that maximize benefits while minimizing potential harms.
    The future of AI holds tremendous promise for solving complex global challenges, from climate change to disease prevention, if we approach its development thoughtfully.
  `.trim() },
  { name: 'Chinese', text: '人工智能正在快速改变我们的世界，从医疗保健到自动驾驶汽车，从推荐系统到自然语言处理。' },
  { name: 'Code - TypeScript', text: `
    function calculateFactorial(n: number): number {
      if (n <= 1) return 1;
      return n * calculateFactorial(n - 1);
    }

    interface User {
      id: number;
      name: string;
      email: string;
    }

    class UserService {
      private users: User[] = [];

      async createUser(user: Omit<User, 'id'>): Promise<User> {
        const newUser = { ...user, id: Date.now() };
        this.users.push(newUser);
        return newUser;
      }
    }
  `.trim() },
  { name: 'JSON Data', text: JSON.stringify({ users: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }] }, null, 2) },
  { name: 'System Prompt', text: 'You are a helpful, harmless, and honest AI assistant. You always think step by step before answering. Your responses should be clear, concise, and accurate.' },
];

const models = ['o200k_base', 'cl100k_base'];

interface BenchmarkResult {
  encoding: string;
  testCase: string;
  textLength: number;
  tokenCount: number;
  timeMs: number;
}

const results: BenchmarkResult[] = [];

async function runBenchmarks() {
  console.log('=== js-tiktoken Performance Test ===\n');

  for (const model of models) {
    console.log(`Testing encoding: ${model}\n`);
    console.log('| Test Case | Chars | Tokens | Est. Tokens | Error % | Time (ms) |');
    console.log('|-----------|-------|--------|-------------|---------|----------|');

    for (const testCase of testCases) {
      const text = testCase.text;
      const textLength = text.length;

      // Warm up
      countTokens(text.slice(0, 100), model);

      // Benchmark
      const iterations = 1000;
      const start = performance.now();
      for (let i = 0; i < iterations; i++) {
        countTokens(text, model);
      }
      const end = performance.now();

      const tokenCount = countTokens(text, model);
      const estimatedTokens = estimateTokenCount(text);
      const errorPercent = ((tokenCount - estimatedTokens) / estimatedTokens * 100).toFixed(1);
      const timeMs = ((end - start) / iterations).toFixed(3);

      console.log(`| ${testCase.name} | ${textLength} | ${tokenCount} | ${estimatedTokens} | ${errorPercent}% | ${timeMs} |`);

      results.push({
        encoding: model,
        testCase: testCase.name,
        textLength,
        tokenCount,
        timeMs: parseFloat(timeMs),
      });
    }
    console.log('');
  }

  // Summary
  console.log('=== Summary ===\n');
  console.log('Average time per token (lower is better):\n');

  for (const model of models) {
    const modelResults = results.filter(r => r.encoding === model);
    const totalTime = modelResults.reduce((sum, r) => sum + r.timeMs, 0);
    const totalTokens = modelResults.reduce((sum, r) => sum + r.tokenCount, 0);
    const avgTimePerToken = (totalTime / totalTokens * 1000).toFixed(4);

    console.log(`${model}: ${avgTimePerToken} ms per token`);
  }

  // Token density analysis
  console.log('\nToken density (tokens per character):\n');
  for (const model of models) {
    const modelResults = results.filter(r => r.encoding === model);
    const avgDensity = modelResults.reduce((sum, r) => sum + r.tokenCount / r.textLength, 0) / modelResults.length;
    console.log(`${model}: ${(avgDensity * 100).toFixed(1)}% (1 token per ${(1 / avgDensity).toFixed(1)} chars)`);
  }

  console.log('\n=== Test Complete ===');
}

runBenchmarks().catch(console.error);