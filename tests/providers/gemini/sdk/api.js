#!/usr/bin/env node
/**
 * Gemini Interactions API Test Suite
 * Tests the Gemini API implementation in claude_proxy_v3
 */

const BASE_URL = 'http://localhost:8788';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-api-key';

// Test results collection
const results = {
  passed: [],
  failed: [],
  skipped: []
};

// Helper function to make requests
async function makeRequest(endpoint, method = 'POST', body = null, headers = {}) {
  const url = `${BASE_URL}${endpoint}`;
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': GEMINI_API_KEY,
      ...headers
    }
  };
  
  if (body) {
    options.body = JSON.stringify(body);
  }
  
  try {
    const response = await fetch(url, options);
    const data = await response.json().catch(() => null);
    return {
      status: response.status,
      ok: response.ok,
      data,
      headers: Object.fromEntries(response.headers.entries())
    };
  } catch (error) {
    return {
      status: 0,
      ok: false,
      error: error.message,
      data: null
    };
  }
}

// Test assertion helper
function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

// Test runner
async function runTest(name, testFn) {
  console.log(`\n🧪 Testing: ${name}`);
  try {
    await testFn();
    results.passed.push(name);
    console.log(`  ✅ PASSED`);
  } catch (error) {
    results.failed.push({ name, error: error.message });
    console.log(`  ❌ FAILED: ${error.message}`);
  }
}

// ==================== TEST CASES ====================

// Test 1: Basic interaction creation with text input
async function testBasicInteraction() {
  const response = await makeRequest('/v1/interactions', 'POST', {
    model: 'gemini-3-flash-preview',
    input: 'Hello, how are you?'
  });
  
  assert(response.ok, `Expected OK response, got ${response.status}`);
  assert(response.data, 'Response should have data');
  assert(response.data.id, 'Response should have an ID');
  assert(response.data.object === 'interaction', 'Response object type should be "interaction"');
  assert(response.data.model, 'Response should have a model');
  assert(Array.isArray(response.data.outputs), 'Response should have outputs array');
  assert(response.data.outputs.length > 0, 'Outputs should not be empty');
  assert(response.data.outputs[0].type === 'text', 'First output should be text');
  assert(response.data.outputs[0].text, 'Text output should have content');
  assert(response.data.usage, 'Response should have usage stats');
  assert(typeof response.data.usage.total_input_tokens === 'number', 'Should have input tokens');
  assert(typeof response.data.usage.total_output_tokens === 'number', 'Should have output tokens');
  
  // Store interaction ID for later tests
  global.testInteractionId = response.data.id;
  console.log(`    📋 Interaction ID: ${response.data.id}`);
  console.log(`    📝 Response: "${response.data.outputs[0].text.substring(0, 100)}..."`);
}

// Test 2: Multi-turn conversation
async function testMultiTurnConversation() {
  const response = await makeRequest('/v1/interactions', 'POST', {
    model: 'gemini-3-flash-preview',
    input: [
      { role: 'user', content: 'Hello!' },
      { role: 'model', content: 'Hi there! How can I help you today?' },
      { role: 'user', content: 'What is the capital of France?' }
    ]
  });
  
  assert(response.ok, `Expected OK response, got ${response.status}`);
  assert(response.data, 'Response should have data');
  assert(response.data.outputs[0].text.toLowerCase().includes('paris'), 
    'Response should mention Paris');
  console.log(`    📝 Response: "${response.data.outputs[0].text}"`);
}

// Test 3: System instruction
async function testSystemInstruction() {
  const response = await makeRequest('/v1/interactions', 'POST', {
    model: 'gemini-3-flash-preview',
    input: 'Who are you?',
    system_instruction: 'You are a helpful coding assistant specialized in Python.'
  });
  
  assert(response.ok, `Expected OK response, got ${response.status}`);
  assert(response.data, 'Response should have data');
  assert(response.data.system_instruction === 'You are a helpful coding assistant specialized in Python.',
    'System instruction should be preserved');
  console.log(`    📝 Response: "${response.data.outputs[0].text.substring(0, 100)}..."`);
}

// Test 4: Generation config (temperature, max tokens)
async function testGenerationConfig() {
  const response = await makeRequest('/v1/interactions', 'POST', {
    model: 'gemini-3-flash-preview',
    input: 'Say hello',
    generation_config: {
      temperature: 0.5,
      max_output_tokens: 50,
      top_p: 0.9
    }
  });
  
  assert(response.ok, `Expected OK response, got ${response.status}`);
  assert(response.data, 'Response should have data');
  console.log(`    📝 Response: "${response.data.outputs[0].text}"`);
}

// Test 5: Tool/Function calling
async function testToolCalling() {
  const response = await makeRequest('/v1/interactions', 'POST', {
    model: 'gemini-3-flash-preview',
    input: 'What is the weather like in Boston, MA?',
    tools: [
      {
        type: 'function',
        name: 'get_weather',
        description: 'Get the current weather in a given location',
        parameters: {
          type: 'object',
          properties: {
            location: {
              type: 'string',
              description: 'The city and state, e.g. San Francisco, CA'
            }
          },
          required: ['location']
        }
      }
    ]
  });
  
  assert(response.ok, `Expected OK response, got ${response.status}`);
  assert(response.data, 'Response should have data');
  // Model might respond with function call or direct answer
  console.log(`    📊 Status: ${response.data.status}`);
  console.log(`    📝 Output type: ${response.data.outputs[0].type}`);
  if (response.data.outputs[0].type === 'function_call') {
    console.log(`    🔧 Function: ${response.data.outputs[0].name}`);
    console.log(`    📥 Arguments: ${JSON.stringify(response.data.outputs[0].arguments)}`);
  } else {
    console.log(`    📝 Response: "${response.data.outputs[0].text.substring(0, 100)}..."`);
  }
}

// Test 6: Response format (JSON mode)
async function testResponseFormat() {
  const response = await makeRequest('/v1/interactions', 'POST', {
    model: 'gemini-3-flash-preview',
    input: 'List 3 colors as a JSON object with a "colors" array',
    response_format: {
      type: 'object',
      properties: {
        colors: {
          type: 'array',
          items: { type: 'string' }
        }
      },
      required: ['colors']
    },
    response_mime_type: 'application/json'
  });
  
  assert(response.ok, `Expected OK response, got ${response.status}`);
  assert(response.data, 'Response should have data');
  console.log(`    📝 Response: "${response.data.outputs[0].text.substring(0, 200)}..."`);
}

// Test 7: Store interaction
async function testStoreInteraction() {
  const response = await makeRequest('/v1/interactions', 'POST', {
    model: 'gemini-3-flash-preview',
    input: 'Remember this: The secret code is 12345',
    store: true
  });
  
  assert(response.ok, `Expected OK response, got ${response.status}`);
  assert(response.data, 'Response should have data');
  global.storedInteractionId = response.data.id;
  console.log(`    📋 Stored Interaction ID: ${response.data.id}`);
}

// Test 8: Get interaction (if we have a stored one)
async function testGetInteraction() {
  if (!global.storedInteractionId) {
    console.log('    ⏭️  Skipping - no stored interaction ID');
    results.skipped.push('Get Interaction');
    return;
  }
  
  const response = await makeRequest(`/v1/interactions/${global.storedInteractionId}`, 'GET');
  
  // This might fail if the backend doesn't support retrieval
  if (response.status === 404) {
    console.log('    ⏭️  Skipping - interaction retrieval not supported (404)');
    results.skipped.push('Get Interaction');
    return;
  }
  
  assert(response.ok, `Expected OK response, got ${response.status}`);
  assert(response.data, 'Response should have data');
  assert(response.data.id === global.storedInteractionId, 'Should return the same interaction');
  console.log(`    📋 Retrieved interaction: ${response.data.id}`);
  console.log(`    📊 Status: ${response.data.status}`);
}

// Test 9: Streaming response
async function testStreamingResponse() {
  const url = `${BASE_URL}/v1/interactions`;
  const body = JSON.stringify({
    model: 'gemini-3-flash-preview',
    input: 'Count from 1 to 5',
    stream: true
  });
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY
      },
      body
    });
    
    assert(response.ok, `Expected OK response, got ${response.status}`);
    assert(response.headers.get('content-type')?.includes('text/event-stream'),
      'Should have SSE content type');
    
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let chunkCount = 0;
    let done = false;
    
    console.log('    📡 Streaming chunks:');
    while (!done && chunkCount < 10) {
      const { value, done: readerDone } = await reader.read();
      done = readerDone;
      if (value) {
        const text = decoder.decode(value, { stream: true });
        const lines = text.split('\n').filter(l => l.startsWith('data: '));
        for (const line of lines) {
          const data = line.substring(6);
          if (data !== '[DONE]') {
            try {
              const parsed = JSON.parse(data);
              chunkCount++;
              if (chunkCount <= 3) {
                console.log(`      Chunk ${chunkCount}: ${JSON.stringify(parsed).substring(0, 100)}...`);
              }
            } catch (e) {
              // Not JSON, might be raw text
            }
          }
        }
      }
    }
    
    console.log(`    ✅ Received ${chunkCount} chunks`);
    assert(chunkCount > 0, 'Should receive at least one chunk');
    
  } catch (error) {
    throw new Error(`Streaming failed: ${error.message}`);
  }
}

// Test 10: Different models
async function testDifferentModels() {
  const models = [
    'gemini-3-flash-preview',
    'gemini-3-pro-preview',
    'gemini-2.5-flash',
    'gemini-2.5-pro'
  ];
  
  for (const model of models) {
    const response = await makeRequest('/v1/interactions', 'POST', {
      model,
      input: 'Hi'
    });
    
    if (response.ok) {
      console.log(`    ✅ ${model}: OK`);
    } else {
      console.log(`    ⚠️  ${model}: ${response.status} (might be expected if model not available)`);
    }
  }
}

// Test 11: Error handling - invalid model
async function testInvalidModel() {
  const response = await makeRequest('/v1/interactions', 'POST', {
    model: 'invalid-model-name',
    input: 'Hello'
  });
  
  // Should either fail with 400/404 or succeed with fallback
  console.log(`    📊 Status: ${response.status}`);
  if (!response.ok) {
    assert(response.data?.error || response.data?.message, 
      'Error response should have error details');
    console.log(`    ✅ Properly returned error: ${response.data.error || response.data.message}`);
  } else {
    console.log(`    ⚠️  Unexpected success - might be using fallback`);
  }
}

// Test 12: Error handling - missing required fields
async function testMissingRequiredFields() {
  const response = await makeRequest('/v1/interactions', 'POST', {
    // Missing both 'model' and 'agent', and 'input'
  });
  
  console.log(`    📊 Status: ${response.status}`);
  assert(!response.ok || response.data?.error, 
    'Should fail or return error for missing required fields');
  console.log(`    ✅ Properly handled missing fields`);
}

// Test 13: Response modalities
async function testResponseModalities() {
  const response = await makeRequest('/v1/interactions', 'POST', {
    model: 'gemini-3-flash-preview',
    input: 'Hello',
    response_modalities: ['text']
  });
  
  assert(response.ok, `Expected OK response, got ${response.status}`);
  assert(response.data, 'Response should have data');
  console.log(`    ✅ Response modalities accepted`);
}

// Test 14: Thinking level configuration
async function testThinkingLevel() {
  const response = await makeRequest('/v1/interactions', 'POST', {
    model: 'gemini-3-flash-preview',
    input: 'Explain quantum computing in simple terms',
    generation_config: {
      thinking_level: 'medium'
    }
  });
  
  assert(response.ok, `Expected OK response, got ${response.status}`);
  assert(response.data, 'Response should have data');
  console.log(`    📝 Response: "${response.data.outputs[0].text.substring(0, 100)}..."`);
  if (response.data.usage?.total_thought_tokens) {
    console.log(`    💭 Thought tokens: ${response.data.usage.total_thought_tokens}`);
  }
}

// ==================== MAIN ====================

async function runAllTests() {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║     Gemini Interactions API Test Suite                 ║');
  console.log('║     claude_proxy_v3 - gemini-interactions branch       ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log(`\n📍 Base URL: ${BASE_URL}`);
  console.log(`🔑 API Key: ${GEMINI_API_KEY.substring(0, 10)}...`);
  
  // Wait a moment for server to be ready
  await new Promise(r => setTimeout(r, 500));
  
  // Run all tests
  await runTest('Basic Interaction Creation', testBasicInteraction);
  await runTest('Multi-turn Conversation', testMultiTurnConversation);
  await runTest('System Instruction', testSystemInstruction);
  await runTest('Generation Config', testGenerationConfig);
  await runTest('Tool/Function Calling', testToolCalling);
  await runTest('Response Format (JSON)', testResponseFormat);
  await runTest('Store Interaction', testStoreInteraction);
  await runTest('Get Interaction', testGetInteraction);
  await runTest('Streaming Response', testStreamingResponse);
  await runTest('Different Models', testDifferentModels);
  await runTest('Error Handling - Invalid Model', testInvalidModel);
  await runTest('Error Handling - Missing Fields', testMissingRequiredFields);
  await runTest('Response Modalities', testResponseModalities);
  await runTest('Thinking Level', testThinkingLevel);
  
  // Print summary
  console.log('\n╔════════════════════════════════════════════════════════╗');
  console.log('║                    TEST SUMMARY                        ║');
  console.log('╚════════════════════════════════════════════════════════╝');
  console.log(`\n✅ Passed: ${results.passed.length}`);
  console.log(`❌ Failed: ${results.failed.length}`);
  console.log(`⏭️  Skipped: ${results.skipped.length}`);
  
  if (results.failed.length > 0) {
    console.log('\nFailed tests:');
    results.failed.forEach(({ name, error }) => {
      console.log(`  ❌ ${name}: ${error}`);
    });
  }
  
  console.log('\n═══════════════════════════════════════════════════════════');
  
  // Return exit code
  process.exit(results.failed.length > 0 ? 1 : 0);
}

// Handle errors
process.on('unhandledRejection', (error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});

// Run tests
runAllTests().catch(error => {
  console.error('Test suite failed:', error);
  process.exit(1);
});
