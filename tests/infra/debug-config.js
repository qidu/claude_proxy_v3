// Debug config loading
const fs = require('fs');
const path = require('path');

// Load and parse the config
const tomlContent = fs.readFileSync(path.join(__dirname, 'proxy_config.toml'), 'utf8');
console.log('Config file content:');
console.log(tomlContent);

// Simple TOML parser for debugging
function parseSimpleToml(toml) {
  const result = {};
  let currentSection = null;

  const lines = toml.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();

    // Skip comments and empty lines
    if (trimmed.startsWith('#') || trimmed === '') continue;

    // Section header
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      currentSection = trimmed.slice(1, -1);
      if (!result[currentSection]) {
        result[currentSection] = {};
      }
      continue;
    }

    // Key-value pair
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex > 0) {
      const key = trimmed.slice(0, eqIndex).trim();
      let value = trimmed.slice(eqIndex + 1).trim();

      // Remove quotes if present
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      }

      if (currentSection) {
        result[currentSection][key] = value;
      } else {
        result[key] = value;
      }
    }
  }

  return result;
}

const parsed = parseSimpleToml(tomlContent);
console.log('\nParsed config:');
console.log(JSON.stringify(parsed, null, 2));

// Test model matching
const modelsToTest = [
  'gemini-3.1-pro-preview',
  'gemini-3.0-flash-preview',
  'gemini-2.5-flash',
  'deepseek/deepseek-v3.2-251201'
];

console.log('\nModel routing analysis:');
for (const model of modelsToTest) {
  console.log(`\nModel: ${model}`);

  if (model.includes('gemini')) {
    console.log('  Category: gemini');
    console.log('  Expected upstream_mode: gemini-generatecontent');
    console.log('  Expected base_url: https://generativelanguage.googleapis.com');
    console.log('  Expected auth header: x-goog-api-key');
  } else {
    console.log('  Category: default');
    console.log('  Expected upstream_mode: openai-completions');
    console.log('  Expected base_url: https://api.qnaigc.com');
    console.log('  Expected auth header: Authorization: Bearer');
  }
}