// Debug test to trace the error
const requestBody = {
  model: "gemini-3-flash-preview",
  input: "Hello"
};

// Check isNativeGeminiRequest logic
function isNativeGeminiRequest(body) {
  return 'input' in body && !('messages' in body);
}

console.log('isNativeGeminiRequest:', isNativeGeminiRequest(requestBody));
console.log('Has input:', 'input' in requestBody);
console.log('Has messages:', 'messages' in requestBody);
console.log('Input value:', requestBody.input);
console.log('Input type:', typeof requestBody.input);
console.log('Input length:', requestBody.input?.length);
