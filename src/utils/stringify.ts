// Stringify utility with configurable alternatives
import safeStableStringify from 'safe-stable-stringify';
import fastSafeStringify from 'fast-safe-stringify';

// Get stringify method from environment variable
const STRINGIFY_METHOD = (process.env.JSON_STRINGIFY_METHOD || '').toLowerCase();

// Select the appropriate stringify function
let stringifyFn: (obj: any) => string = JSON.stringify; // default

switch (STRINGIFY_METHOD) {
  case 'safe-stable':
    // safe-stable-stringify exports: { stringify, configure, default }
    stringifyFn = (safeStableStringify as any).stringify || safeStableStringify;
    break;
  case 'fast-safe':
    // fast-safe-stringify exports: { default, stable, stableStringify }
    // We want the main stringify function which is the default export
    stringifyFn = (fastSafeStringify as any).default || fastSafeStringify;
    break;
  case 'json':
  default:
    // Use built-in JSON.stringify
    break;
}

// Export the selected function
export { stringifyFn as stringify };