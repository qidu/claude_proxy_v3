// Test API key flow for streamGenerateContent endpoint
const config = `[upstream]
default_base_url = "https://api.qnaigc.com"

[models.gemini]
upstream_mode = "gemini-generatecontent"
base_url = "https://api.example.com"
"gemini-3.1-pro-preview" = ["", "", ""]
"gemini-3.0-flash-preview" = ["gemini-3-flash-preview", "", ""]

[models.default]
"deepseek/deepseek-v3.2-251201" = ["", "", ""]
upstream_mode = "openai-completions"`;

console.log('Testing API key flow for streamGenerateContent endpoint\n');

// Simulate a request to /v1beta/models/gemini-3.1-pro-preview:streamGenerateContent
const requestPath = '/v1beta/models/gemini-3.1-pro-preview:streamGenerateContent';
console.log(`Request path: ${requestPath}`);

// Extract model from path
const modelMatch = requestPath.match(/\/v1beta\/models\/([^:?]+):(stream)?[Gg]enerateContent/);
if (modelMatch) {
  const modelName = modelMatch[1];
  const isStream = modelMatch[2] === 'stream';
  console.log(`Model: ${modelName}, Is stream: ${isStream}`);

  // Check if model is in gemini category
  if (modelName.includes('gemini')) {
    console.log('Model appears to be a Gemini model');
    console.log('Expected upstream_mode: gemini-generatecontent');
    console.log('Expected auth header: x-goog-api-key');
  } else {
    console.log('Model does not appear to be a Gemini model');
    console.log('Expected upstream_mode: openai-completions');
    console.log('Expected auth header: Authorization: Bearer');
  }
}

console.log('\n--- Config Analysis ---');
console.log('1. [models.gemini] category has base_url = "https://api.example.com"');
console.log('2. Model entries have empty base_url strings, so they use category base_url');
console.log('3. This means requests go to https://api.example.com');
console.log('4. If api.example.com is not a real API, requests will fail');
console.log('\nPossible issues:');
console.log('1. api.example.com might not exist or might not accept the API key format');
console.log('2. The API key might be in wrong format (x-goog-api-key vs Authorization: Bearer)');
console.log('3. The request might be routed to wrong handler');