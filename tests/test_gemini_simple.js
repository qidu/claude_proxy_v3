#!/usr/bin/env node
/**
 * Simple debug test for Gemini API
 *
 * Note: This test uses native Gemini format (input field)
 * For OpenAI-compatible format, use test_gemini_openai_compatible.js
 */

const BASE_URL = 'http://localhost:8787';

async function test() {
  console.log('Testing Gemini API...\n');
  console.log('Note: This test uses native Gemini format (input field)');
  console.log('For OpenAI-compatible format, use test_gemini_openai_compatible.js\n');

  try {
    const response = await fetch(`${BASE_URL}/v1/interactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': 'YOUR_GEMINI_API_KEY'  // Replace with actual key
      },
      body: JSON.stringify({
        model: 'gemini-2.0-flash-lite',
        input: 'Hello'
      })
    });

    console.log('Response status:', response.status);
    console.log('Response headers:', Object.fromEntries(response.headers.entries()));

    const text = await response.text();
    console.log('Response body length:', text.length);

    try {
      const json = JSON.parse(text);
      console.log('Parsed JSON keys:', Object.keys(json));
      console.log('Has id:', !!json1.id);
      console.log('Has content:', !!json1.content);
    } catch (e) {
      console.log('Not valid JSON:', e.message);
    }

  } catch (error) {
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
  }
}

// Check endpoint type configuration
if (process.env.GEMINI_ENDPOINT_TYPE === 'openai-compatible') {
  console.warn('⚠️  Warning: GEMINI_ENDPOINT_TYPE is set to "openai-compatible"');
  console.warn('   This test uses native Gemini format (input field)');
  console.warn('   For OpenAI-compatible format, use test_gemini_openai_compatible.js');
  console.warn('   Or set GEMINI_ENDPOINT_TYPE=native');
}

test();
