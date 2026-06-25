#!/usr/bin/env node
/**
 * Test Gemini Interactions API
 * This test requires GEMINI_ENDPOINT_TYPE=interactions
 */

const BASE_URL = 'http://localhost:8787';

async function testNativeGemini() {
    console.log('Testing Gemini Interactions API...\n');

    try {
        // Test 1: Create interaction with Claude format
        console.log('Test 1: Create interaction with Claude format');
        const response1 = await fetch(`${BASE_URL}/v1/interactions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': 'YOUR_GEMINI_API_KEY'  // Replace with actual key
            },
            body: JSON.stringify({
                model: 'gemini-2.0-flash-lite',
                messages: [
                    { role: 'user', content: 'Hello, how are you?' }
                ],
                stream: false
            })
        });

        console.log('Response status:', response1.status);
        console.log('Response headers:', Object.fromEntries(response1.headers.entries()));

        const text1 = await response1.text();
        console.log('Response body length:', text1.length);

        try {
            const json1 = JSON.parse(text1);
            console.log('Parsed JSON keys:', Object.keys(json1));
            console.log('Has id:', !!json1.id);
            console.log('Has content:', !!json1.content);
        } catch (e) {
            console.log('Not valid JSON:', e.message);
        }

        // Test 2: Create interaction with Gemini format
        console.log('\nTest2: Create interaction with Gemini format');
        const response2 = await fetch(`${BASE_URL}/v1/interactions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': 'YOUR_GEMINI_API_KEY'  // Replace with actual key
            },
            body: JSON.stringify({
                model: 'gemini-2.0-flash-lite',
                input: 'Hello, how are you?',
                stream: false
            })
        });

        console.log('Response status:', response2.status);
        const text2 = await response2.text();
        console.log('Response body length:', text2.length);

        // Test 3: Streaming response
        console.log('\nTest3: Streaming response');
        const response3 = await fetch(`${BASE_URL}/v1/interactions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-goog-api-key': 'YOUR_GEMINI_API_KEY'  // Replace with actual key

            },
            body: JSON.stringify({
                model: 'gemini-2.0-flash-lite',
                input: 'Hello, how are you?',
                stream: true
            })
        });

        console.log('Response status:', response3.status);
        console.log('Content-Type:', response3.headers.get('content-type'));

        // Read streaming response
        const reader = response3.body?.getReader();
        if (reader) {
            let receivedChunks = 0;
            let fullResponse = '';
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                receivedChunks++;
                const chunk = new TextDecoder().decode(value);
                fullResponse += chunk;
                console.log(`Received chunk ${receivedChunks}: ${chunk.length} bytes`);
            }
            console.log(`Total chunks received: ${receivedChunks}`);
            console.log(`Full response length: ${fullResponse.length}`);
        }

        console.log('\n✅ Native Gemini API tests completed');

    } catch (error) {
        console.error('❌ Error:', error.message);
        console.error('Stack:', error.stack);
    }
}

// Check if endpoint type is set to interactions
if (process.env.GEMINI_ENDPOINT_TYPE !== 'interactions') {
    console.warn('⚠️  Warning: GEMINI_ENDPOINT_TYPE is not set to "interactions"');
    console.warn('   Set environment variable: export GEMINI_ENDPOINT_TYPE=interactions');
    console.warn('   Or update wrangler.toml: GEMINI_ENDPOINT_TYPE = "interactions"');
}

testNativeGemini();