import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = './testcases';
const TESTS_OUT_DIR = './tests';

const TEST_CONFIG = process.env.TEST_CONFIG || 'test_';
const NORMAL_CONFIG_PATH = './proxy_config.toml';
const CONFIG_PATH = `./${TEST_CONFIG}proxy_config.toml`;

// Copy the normal config into the test config file so the proxy gets a valid
// starting point.  Normal config is never modified by the test run.
if (fs.existsSync(NORMAL_CONFIG_PATH)) {
  fs.copyFileSync(NORMAL_CONFIG_PATH, CONFIG_PATH);
  console.log(`[loop-wrapper] Copied ${NORMAL_CONFIG_PATH} → ${CONFIG_PATH}`);
} else {
  console.warn(`[loop-wrapper] Normal config not found at ${NORMAL_CONFIG_PATH}; ${CONFIG_PATH} may be stale`);
}

let configBackup = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH) : null;

let configRestored = false;
function restoreConfig() {
  if (configRestored) return;
  configRestored = true;
  if (configBackup !== null) {
    try {
      fs.writeFileSync(CONFIG_PATH, configBackup);
      console.log(`[loop-wrapper] Restored ${CONFIG_PATH}`);
    } catch (err) {
      console.error(`[loop-wrapper] Failed to restore: ${err.message}`);
    }
  }
  try {
    fs.rmSync(CONFIG_PATH, { force: true });
    console.log(`[loop-wrapper] Removed ${CONFIG_PATH}`);
  } catch (err) {
    console.error(`[loop-wrapper] Failed to remove ${CONFIG_PATH}: ${err.message}`);
  }
}
process.on('exit', restoreConfig);
process.on('SIGINT', () => { restoreConfig(); process.exit(130); });
process.on('SIGTERM', () => { restoreConfig(); process.exit(143); });
process.on('uncaughtException', (err) => { console.error(err); restoreConfig(); process.exit(1); });

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-proxy-loop-tests-'));

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
  const escaped = dstPath.replace(/\\/g, '\\\\');
  src = src.split(`require('../utils/${baseName}')`).join(`require('${escaped}')`);
  src = src.split(`require("../utils/${baseName}")`).join(`require('${escaped}')`);
  return src;
}

const allOutput = [];
let suiteResults = [];
let passed = 0, failed = 0;
let casesPassed = 0, casesFailed = 0;

const PROXY_URL = process.env.PROXY_URL || 'http://localhost:7777';
const API_KEY = process.env.API_KEY || 'sk-test-key';
const TEST_TIMEOUT = process.env.TEST_TIMEOUT || '30000';

function log(...args) {
  const line = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
  allOutput.push(line);
  console.log(line);
}

log(`\n${'='.repeat(60)}`);
log(`Test run started: ${new Date().toISOString()}`);
log(`${'='.repeat(60)}`);

for (const suite of suites) {
  const suiteName = suite.replace('.test.js', '').replace(/\//g, ' / ');
  log(`\n--- ${suiteName} ---`);

  const src = fs.readFileSync(path.join(TEST_DIR, suite), 'utf8');
  let adjusted = src;
  for (const [hf, dstPath] of Object.entries(helperPaths)) {
    adjusted = replaceRequire(adjusted, hf.replace('.js', ''), dstPath);
  }

  const tempFile = path.join(tempDir, suite.replace('.test.js', '.test.cjs').replace(/\//g, '_'));
  fs.writeFileSync(tempFile, adjusted);

  const startTime = Date.now();
  let suitePassed = 0, suiteFailed = 0;

  const child = spawn('node', [tempFile], {
    env: { ...process.env, PROXY_URL, API_KEY, TEST_TIMEOUT, TEST_CONFIG },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  await new Promise((resolve) => {
    child.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        allOutput.push(line);
        console.log(line);
        // Parse per-case counts from "Results: X passed, Y failed"
        const m = line.match(/^Results:\s*(\d+)\s+passed,\s*(\d+)\s+failed/);
        if (m) {
          suitePassed = parseInt(m[1], 10);
          suiteFailed = parseInt(m[2], 10);
          casesPassed += suitePassed;
          casesFailed += suiteFailed;
        }
      }
    });
    child.stderr.on('data', (data) => {
      const lines = data.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        allOutput.push(line);
        console.error(line);
      }
    });
    child.on('close', (code) => {
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);
      if (suiteFailed === 0 && code === 0) {
        passed++;
        log(`  ✓ PASSED (${duration}s)`);
      } else {
        failed++;
        log(`  ✗ FAILED exit code ${code} (${duration}s)`);
      }
      suiteResults.push({ suite, passed: suitePassed, failed: suiteFailed, duration });
      resolve();
    });
  });
}

// Clean up temp directory
try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}

// Restore config — but DO NOT reload into live proxy (per loop request)
restoreConfig();

log(`\n${'='.repeat(60)}`);
log(`Test run completed: ${new Date().toISOString()}`);
log(`Total suites: ${suites.length}`);
log(`Passed: ${passed}, Failed: ${failed}`);
log(`Cases: ${casesPassed} passed, ${casesFailed} failed`);
log(`${'='.repeat(60)}`);

// Write results file
const now = new Date();
const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '-'); // HH-MM-SS
const resultFile = path.join(TESTS_OUT_DIR, `test_results_at_${dateStr}_${timeStr}.md`);

const md = `# Test Results — ${now.toISOString()}

## Summary
- **Total suites**: ${suites.length}
- **Suites passed**: ${passed}
- **Suites failed**: ${failed}
- **Cases passed**: ${casesPassed}
- **Cases failed**: ${casesFailed}
- **Status**: ${casesFailed === 0 ? '✅ ALL PASSING' : '❌ FAILURES DETECTED'}

## Suite Results
${suiteResults.map(s => `- **${s.suite}**: ${s.passed} passed, ${s.failed} failed`).join('\n')}

## Full Output
\`\`\`
${allOutput.join('\n')}
\`\`\`
`;

fs.writeFileSync(resultFile, md);
console.log(`\n[loop-wrapper] Results written to: ${resultFile}`);

process.exit(casesFailed > 0 ? 1 : 0);
