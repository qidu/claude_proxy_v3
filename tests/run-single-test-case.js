import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const TEST_DIR = './testcases';
const suite = process.argv[2] || '09_composite/composite.test.js';
const PROXY_URL = process.env.PROXY_URL || 'http://localhost:7777';
const API_KEY = process.env.API_KEY || 'sk-test-key';
const TEST_TIMEOUT = process.env.TEST_TIMEOUT || '30000';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'single-test-'));

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

let src = fs.readFileSync(path.join(TEST_DIR, suite), 'utf8');

for (const [hf, dstPath] of Object.entries(helperPaths)) {
  const baseName = hf.replace('.js', '');
  const escaped = dstPath.replace(/\\/g, '\\\\');
  src = src.split(`require('../utils/${baseName}')`).join(`require('${escaped}')`);
  src = src.split(`require("../utils/${baseName}")`).join(`require('${escaped}')`);
}

const tempFile = path.join(tempDir, path.basename(suite).replace('.test.js', '.test.cjs'));
fs.writeFileSync(tempFile, src);

const child = spawn('node', [tempFile], {
  env: { ...process.env, PROXY_URL, API_KEY, TEST_TIMEOUT },
  stdio: 'inherit',
});

child.on('close', (code) => {
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  process.exit(code || 0);
});
