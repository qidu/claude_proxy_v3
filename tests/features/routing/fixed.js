// Test routing logic directly
const fs = require('fs');
const path = require('path');

// Create a simple test environment
const testCases = [
  '/https/api.qnaigc.com/v1/models',
  '/https/api.qnaigc.com/v1/messages',
  '/https/api.qnaigc.com/v1/messages/count_tokens',
  '/https/api.openai.com/v1/models',
  '/https/api.openai.com/v1/chat/completions',
];

console.log('Testing parseDynamicRoute logic...\n');

// Manually implement the logic to test it
function parseDynamicRoute(url) {
  // Remove leading slash if present
  let path = url.startsWith('/') ? url.slice(1) : url;

  // Split by forward slashes
  const parts = path.split('/');

  if (parts.length < 4) {
    throw new Error(`Invalid URL format: ${url}. Expected format: /{protocol}{host}{path_prefix}/{model_id?}/{claude_endpoint}`);
  }

  // First part is the protocol (http or https)
  const protocol = parts[0];
  if (protocol !== 'http' && protocol !== 'https') {
    throw new Error(`Invalid protocol: ${protocol}. Must be 'http' or 'https'`);
  }

  // Second part is the host (e.g., api.groq.com)
  let host = parts[1];

  // Find where the target API path ends and Claude endpoint begins
  // We look for known Claude endpoints: v1/models, v1/messages, v1/messages/count_tokens
  let targetPathEndIndex = -1;
  let claudeEndpointStartIndex = -1;

  // Look for Claude endpoint patterns from the end
  for (let i = parts.length - 1; i >= 2; i--) {
    if (parts[i] === 'v1') {
      // Check if this is a Claude endpoint
      const nextPart = i + 1 < parts.length ? parts[i + 1] : null;
      const twoPartsAhead = i + 2 < parts.length ? parts[i + 2] : null;

      if (nextPart === 'models' || nextPart === 'messages') {
        // Found a potential Claude endpoint
        targetPathEndIndex = i - 1;
        claudeEndpointStartIndex = i;
        break;
      }

      if (nextPart === 'messages' && twoPartsAhead === 'count_tokens') {
        // Found token counting endpoint
        targetPathEndIndex = i - 1;
        claudeEndpointStartIndex = i;
        break;
      }
    }
  }

  if (targetPathEndIndex === -1 || claudeEndpointStartIndex === -1) {
    throw new Error(`Could not locate Claude endpoint in URL: ${url}`);
  }

  // Extract Claude endpoint path
  const claudeEndpointPath = parts.slice(claudeEndpointStartIndex).join('/');

  // Determine if there's a model ID between target path and Claude endpoint
  let modelId = undefined;
  const betweenParts = parts.slice(targetPathEndIndex + 1, claudeEndpointStartIndex);
  if (betweenParts.length === 1) {
    // Likely a model ID
    modelId = betweenParts[0];
  } else if (betweenParts.length > 1) {
    // This might be part of the target path, adjust accordingly
    targetPathEndIndex = claudeEndpointStartIndex - 1;
    modelId = undefined;

    // Recalculate
    const newTargetPathPrefix = parts.slice(2, targetPathEndIndex + 1).join('/');
    throw new Error(`Unclear URL structure. Between target path '${newTargetPathPrefix}' and Claude endpoint '${claudeEndpointPath}' found: ${betweenParts.join('/')}`);
  } else if (betweenParts.length === 0) {
    // Check if the last element of target path prefix might be a model ID
    // Model IDs typically don't contain slashes and aren't common API path segments
    const targetPathParts = parts.slice(2, targetPathEndIndex + 1);
    if (targetPathParts.length > 0) {
      const lastPart = targetPathParts[targetPathParts.length - 1];
      // Check if last part looks like a model ID (not a common API path segment)
      const commonPathSegments = ['v1', 'v2', 'models', 'messages', 'completions', 'chat', 'openai', 'api'];
      if (!commonPathSegments.includes(lastPart) &&
          !lastPart.includes('/') &&
          lastPart.length > 0) {
        // This might be a model ID, extract it
        modelId = lastPart;
        // Adjust target path prefix to exclude the model ID
        targetPathEndIndex = targetPathEndIndex - 1;
      }
    }
  }

  // Recalculate target path prefix in case we adjusted for model ID
  const finalTargetPathPrefix = parts.slice(2, targetPathEndIndex + 1).join('/');

  const targetConfig = {
    targetUrl: `${protocol}://${host}`,
    targetPathPrefix: finalTargetPathPrefix ? `/${finalTargetPathPrefix}` : '',
  };

  return {
    targetConfig,
    claudeEndpoint: claudeEndpointPath,
    modelId,
  };
}

// Test each case
for (const testUrl of testCases) {
  console.log(`Testing: ${testUrl}`);
  try {
    const result = parseDynamicRoute(testUrl);
    console.log(`  Protocol: ${result.targetConfig.targetUrl}`);
    console.log(`  Target Path Prefix: ${result.targetConfig.targetPathPrefix}`);
    console.log(`  Model ID: ${result.modelId || '(none)'}`);
    console.log(`  Claude Endpoint: ${result.claudeEndpoint}`);
    console.log();
  } catch (error) {
    console.log(`  ❌ Error: ${error.message}`);
    console.log();
  }
}
