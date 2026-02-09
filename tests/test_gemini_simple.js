#!/usr/bin/env node
/**
 * Simple debug test for Gemini API
 */

const BASE_URL = 'http://localhost:8788';

async function test() {
  console.log('Testing Gemini API...\n');
  
  try {
    const response = await fetch(`${BASE_URL}/v1/interactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': 'test-key'
      },
      body: JSON.stringify({
        model: 'gemini-3-flash-preview',
        input: 'Hello'
      })
    });
    
    console.log('Response status:', response.status);
    console.log('Response headers:', Object.fromEntries(response.headers.entries()));
    
    const text = await response.text();
    console.log('Response body:', text);
    
    try {
      const json = JSON.parse(text);
      console.log('Parsed JSON:', JSON.stringify(json, null, 2));
    } catch (e) {
      console.log('Not valid JSON');
    }
    
  } catch (error) {
    console.error('Error:', error.message);
    console.error('Stack:', error.stack);
  }
}

test();
