import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const TEST_DIR = './testcases';
const PROXY_URL = process.env.PROXY_URL || 'http://localhost:8788';
const API_KEY = process.env.API_KEY || 'sk-test-key';
const TEST_TIMEOUT = process.env.TEST_TIMEOUT || '30000';

// Always use an isolated test config so PUT mutations during the run never
// touch the developer's proxy_config.toml.  The prefix is fixed to 'test_'
// so the proxy resolves the path as ./test_proxy_config.toml when it sees
// TEST_CONFIG=test_ in its environment.
const TEST_CONFIG = process.env.TEST_CONFIG || 'test_';
const NORMAL_CONFIG_PATH = './proxy_config.toml';
const CONFIG_PATH = `./${TEST_CONFIG}proxy_config.toml`;

// Copy the normal config into the test config file at startup so the proxy
// gets a valid, complete config to work with.
if (fs.existsSync(NORMAL_CONFIG_PATH)) {
  fs.copyFileSync(NORMAL_CONFIG_PATH, CONFIG_PATH);
  console.log(`[isolation] Copied ${NORMAL_CONFIG_PATH} → ${CONFIG_PATH}`);
} else {
  console.warn(`[isolation] Normal config not found at ${NORMAL_CONFIG_PATH}; ${CONFIG_PATH} may be stale`);
}

// Snapshot the test config so any PUT mutations during the run can be rolled
// back at the end.  Normal config is never read or written here.
let configBackup = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH) : null;

let configRestored = false;
function restoreConfig() {
  if (configRestored) return;
  configRestored = true;
  // Restore test config to its pre-run state (copy of normal config).
  if (configBackup !== null) {
    try {
      fs.writeFileSync(CONFIG_PATH, configBackup);
      console.log(`[isolation] Restored ${CONFIG_PATH}`);
    } catch (err) {
      console.error(`[isolation] Failed to restore ${CONFIG_PATH}: ${err.message}`);
    }
  }
  // Remove the test config file — it was created by this runner, not by the user.
  try {
    fs.rmSync(CONFIG_PATH, { force: true });
    console.log(`[isolation] Removed ${CONFIG_PATH}`);
  } catch (err) {
    console.error(`[isolation] Failed to remove ${CONFIG_PATH}: ${err.message}`);
  }
}
process.on('exit', restoreConfig);
process.on('SIGINT', () => { restoreConfig(); process.exit(130); });
process.on('SIGTERM', () => { restoreConfig(); process.exit(143); });
process.on('uncaughtException', (err) => { console.error(err); restoreConfig(); process.exit(1); });

// Create temp directory
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-proxy-tests-'));

// Copy and convert helper files to .cjs
const helperFiles = ['test_helpers.js', 'model_config.js'];
const helperPaths = {};
for (const hf of helperFiles) {
  const src = path.join(TEST_DIR, 'utils', hf);
  const dst = path.join(tempDir, hf.replace('.js', '.cjs'));
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
    helperPaths[hf] = dst;
  }
}

const suites = [
  '01_endpoints/messages.test.js',
  '01_endpoints/messages_streaming.test.js',
  '01_endpoints/interactions.test.js',
  '01_endpoints/generateContent.test.js',
  '02_features/thinking.test.js',
  '02_features/tool_use.test.js',
  '02_features/image_input.test.js',
  '03_errors/validation.test.js',
  '04_models/models.test.js',
  '05_upstream_modes/upstream_modes.test.js',
  '06_integration/integration.test.js',
  '07_dashboard/dashboard_api.test.js',
  '08_regression/regression.test.js',
  '09_composite/composite.test.js',
  '10_auth/auth_headers.test.js',
  '11_responses/responses_api.test.js',
  '12_config_validation/config_validation.test.js',
  '13_fusion/fusion.test.js',
];

function replaceRequire(src, baseName, dstPath) {
  // Replace require('../utils/test_helpers') with require('/tmp/.../test_helpers.cjs')
  // Handle both single and double quotes
  const escaped = dstPath.replace(/\\/g, '\\\\');
  src = src.split(`require('../utils/${baseName}')`).join(`require('${escaped}')`);
  src = src.split(`require("../utils/${baseName}")`).join(`require('${escaped}')`);
  return src;
}

let passed = 0, failed = 0;

for (const suite of suites) {
  const src = fs.readFileSync(path.join(TEST_DIR, suite), 'utf8');

  let adjusted = src;
  for (const [hf, dstPath] of Object.entries(helperPaths)) {
    const baseName = hf.replace('.js', '');
    adjusted = replaceRequire(adjusted, baseName, dstPath);
  }

  const tempFile = path.join(tempDir, suite.replace('.test.js', '.test.cjs').replace('/', '_'));
  fs.writeFileSync(tempFile, adjusted);

  const child = spawn('node', [tempFile], {
    env: { ...process.env, PROXY_URL, API_KEY, TEST_TIMEOUT, TEST_CONFIG },
    stdio: 'inherit',
  });

  await new Promise((resolve) => child.on('close', (code) => {
    if (code === 0) passed++;
    else failed++;
    resolve();
  }));
}

// Clean up temp directory
try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}

// Restore and remove the test config file, then trigger a proxy reload so its
// in-memory state no longer reflects test mutations.  The proxy was started
// with TEST_CONFIG pointing at the test file; after removal it will fall back
// to the normal config on next reload/restart.
restoreConfig();
try {
  await fetch(`${PROXY_URL}/dashboard/api/config?reload=1`, {
    headers: { 'Authorization': `Bearer ${API_KEY}` },
  });
  console.log('[isolation] Triggered live proxy config reload');
} catch (err) {
  console.error(`[isolation] Could not reload live proxy config: ${err.message}`);
}

console.log(`\n${'='.repeat(60)}`);
console.log(`Total: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);