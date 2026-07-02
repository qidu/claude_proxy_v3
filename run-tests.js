import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Start testing proxy server WITH PORT=7777
// NEVER use 'pkill', use 'lsof -ni :7777' alternatively to find the process id (pid), then use 'kill -p ${pid}'
const PROXY_URL = process.env.PROXY_URL || 'http://localhost:7777';
const API_KEY = process.env.API_KEY || 'sk-***13145'; // set a testing api_key for models at `default_base_url`
const TEST_TIMEOUT = process.env.TEST_TIMEOUT || '30000';

// TEST_CONFIG is the prefix for the isolated test config file.
// The proxy (src/server.ts:34) reads this env var and loads
// ./${TEST_CONFIG}proxy_config.toml instead of ./proxy_config.toml.
const TEST_CONFIG = process.env.TEST_CONFIG || 'test_';
const CONFIG_PATH = `./${TEST_CONFIG}proxy_config.toml`;
const NORMAL_CONFIG_PATH = './proxy_config.toml';
const TEST_DIR = './testcases';

// -------------------------------------------------------------------
// Config isolation
// -------------------------------------------------------------------
// Copy the developer's config into the test config slot at startup.
// PUT mutations during the run stay in the test config; the original
// proxy_config.toml is never touched.
if (fs.existsSync(NORMAL_CONFIG_PATH)) {
  fs.copyFileSync(NORMAL_CONFIG_PATH, CONFIG_PATH);
  console.log(`[isolation] ${NORMAL_CONFIG_PATH} → ${CONFIG_PATH}`);
} else {
  console.warn(`[isolation] ${NORMAL_CONFIG_PATH} not found; ${CONFIG_PATH} may be stale`);
}

let configBackup = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH) : null;

function restoreConfig() {
  if (configBackup !== null) {
    try {
      fs.writeFileSync(CONFIG_PATH, configBackup);
      console.log(`[isolation] Restored ${CONFIG_PATH}`);
    } catch (err) {
      console.error(`[isolation] Failed to restore: ${err.message}`);
    }
  }
  try {
    fs.rmSync(CONFIG_PATH, { force: true });
    console.log(`[isolation] Removed ${CONFIG_PATH}`);
  } catch (err) {
    console.error(`[isolation] Failed to remove: ${err.message}`);
  }
}
process.on('exit', restoreConfig);
process.on('SIGINT', () => { restoreConfig(); process.exit(130); });
process.on('SIGTERM', () => { restoreConfig(); process.exit(143); });
process.on('uncaughtException', (err) => { console.error(err); restoreConfig(); process.exit(1); });

// -------------------------------------------------------------------
// Spawn the proxy server with TEST_CONFIG so it loads the isolated config
// -------------------------------------------------------------------
console.log('[proxy] Starting proxy server...');
const proxyEnv = {
  ...process.env,
  TEST_CONFIG,
  PORT: '7777',
  PROXY_URL,
  API_KEY,
  TEST_TIMEOUT,
};

const proxy = spawn('node', ['dist/server.js'], {
  env: proxyEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let proxyReady = false;
let proxyFailed = false;

// Pipe proxy stdout/stderr to this process so the user can see startup logs
proxy.stdout.on('data', (d) => process.stdout.write(d));
proxy.stderr.on('data', (d) => process.stderr.write(d));

proxy.on('error', (err) => {
  console.error(`[proxy] Failed to start: ${err.message}`);
  proxyFailed = true;
});

proxy.on('close', (code) => {
  if (code !== 0 && !proxyReady) {
    console.error(`[proxy] Exited unexpectedly with code ${code} before tests ran`);
    proxyFailed = true;
  }
});

// Poll until the proxy is ready (HTTP 200 on /v1/models or /dashboard/api/config)
async function waitForProxy(maxAttempts = 30, interval = 1000) {
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      const res = await fetch(`${PROXY_URL}/v1/models`, {
        headers: { 'Authorization': `Bearer ${API_KEY}` },
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        console.log(`[proxy] Ready after ${i} attempt(s) (${PROXY_URL})`);
        return true;
      }
    } catch {}
    if (i < maxAttempts) await new Promise(r => setTimeout(r, interval));
  }
  return false;
}

const proxyUp = await waitForProxy();
if (!proxyUp) {
  console.error('[proxy] Timed out waiting for proxy to start');
  proxy.kill();
  restoreConfig();
  process.exit(1);
}
proxyReady = true;

// -------------------------------------------------------------------
// Set up temp directory and helpers
// -------------------------------------------------------------------
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-proxy-tests-'));

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
  '14_routing/routing.test.js',
  '15_config_parse/config_parse.test.js',
  '16_security/ssrf_dynamic_route.test.js',
  '16_security/privacy_filter.test.js',
  '16_security/kompress.test.js',
  '16_security/conversation_store.test.js',
  '16_security/free_fanout.test.js',
  '16_security/config_loader_pollution.test.js',
  '16_security/schedule_routing.test.js',
];

function replaceRequire(src, baseName, dstPath) {
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

// -------------------------------------------------------------------
// Tear down
// -------------------------------------------------------------------
try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}

// Trigger a config reload in the proxy so its in-memory state clears
// test mutations, then stop the proxy.
try {
  await fetch(`${PROXY_URL}/dashboard/api/config?reload=1`, {
    headers: { 'Authorization': `Bearer ${API_KEY}` },
  });
  console.log('[proxy] Triggered config reload');
} catch (err) {
  console.error(`[proxy] Could not reload: ${err.message}`);
}

console.log('[proxy] Stopping proxy server...');
proxy.kill('SIGTERM');

// Wait up to 5s for the proxy to exit cleanly
await new Promise((resolve) => {
  const timer = setTimeout(resolve, 5000);
  proxy.once('close', () => { clearTimeout(timer); resolve(); });
});

// Restore / remove the test config file.
restoreConfig();

console.log(`\n${'='.repeat(60)}`);
console.log(`Total: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

// -------------------------------------------------------------------
// Logs
// -------------------------------------------------------------------
// Record testing results in file `test_results_at_<date>-<time>.md` to directory `./tests/logs/results/`.
