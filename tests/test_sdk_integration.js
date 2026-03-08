#!/usr/bin/env node

/**
 * Test SDK integration for Claude Proxy v3
 * Tests that sdk://localhost URLs are handled correctly
 */

import http from 'http';

// Configuration
const PORT = 8788;
const BASE_URL = `http://localhost:${PORT}`;

// Test request for llama model (should use SDK)
const testRequest = {
  model: 'llama',
  messages: [
    { role: 'user', content: 'Hello, how are you?' }
  ],
  stream: false
};

console.log('Testing SDK integration with Claude Proxy v3');
console.log('=============================================');
console.log(`Proxy URL: ${BASE_URL}`);
console.log('Test request:', JSON.stringify(testRequest, null, 2));

// Make request to proxy
const req = http.request(`${BASE_URL}/v1/messages`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer test-key' // Not needed for SDK
  }
}, (res) => {
  console.log(`\nResponse status: ${res.statusCode} ${res.statusMessage}`);

  let data = '';
  res.on('data', (chunk) => {
    data += chunk;
  });

  res.on('end', () => {
    try {
      const response = JSON.parse(data);
      console.log('Response body:', JSON.stringify(response, null, 2));

      if (res.statusCode === 200) {
        console.log('\n✅ SDK integration test PASSED!');
        console.log('The proxy successfully handled the sdk://localhost URL for llama model.');
      } else {
        console.log('\n❌ SDK integration test FAILED!');
        console.log('Expected status 200, got', res.statusCode);
      }
    } catch (error) {
      console.log('\n❌ Failed to parse response:', error.message);
      console.log('Raw response:', data);
    }

    process.exit(res.statusCode === 200 ? 0 : 1);
  });
});

req.on('error', (error) => {
  console.error('\n❌ Request failed:', error.message);
  console.log('\nMake sure the proxy server is running:');
  console.log('  npm run server');
  process.exit(1);
});

req.write(JSON.stringify(testRequest));
req.end();
