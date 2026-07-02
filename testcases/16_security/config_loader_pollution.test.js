/**
 * Config-Loader Prototype-Pollution Rejection Tests
 * Tests src/utils/config-loader.ts directly against dist/utils/config-loader.js
 * — exercises applyDashboardConfigUpdate's defense-in-depth denylist
 * (DANGEROUS_KEYS = ['__proto__', 'constructor', 'prototype']) at all
 * relevant injection points, plus a live PUT /dashboard/api/config
 * cross-check against the running proxy.
 *
 * Background:
 *   Per docs/security-review-2.md (M4, marked FIXED) and the comment at
 *   src/utils/config-loader.ts:1699 explaining the DANGEROUS_KEYS denylist,
 *   the loader rejects the three magic keys via assertSafeKey() rather
 *   than relying solely on Object.prototype staying unpolluted — defense
 *   in depth in case the code is ever refactored into a generic/recursive
 *   merge that could reintroduce the issue.
 *
 * Test methodology note (important):
 *   JS object-literal syntax `{ '__proto__': x }` invokes the actual
 *   Object.prototype.__proto__ setter and does NOT create an own enumerable
 *   property — so Object.entries() would never even see the key. Real HTTP
 *   request bodies, however, always arrive via JSON.parse(), which DOES
 *   create a genuine own, enumerable '__proto__' property. Therefore every
 *   payload in this file is constructed via JSON.parse() of a JSON string,
 *   matching how the live proxy actually parses incoming bodies. Verified
 *   empirically that all three keys produce own, enumerable entries under
 *   JSON.parse.
 *
 * Coverage:
 * - TC2501: __proto__ rejected as a composite alias name (composite.__proto__)
 * - TC2502: constructor rejected as a composite alias name
 * - TC2503: prototype rejected as a composite alias name
 * - TC2504: __proto__ rejected as a composite target key (composite.X.__proto__)
 * - TC2505: constructor rejected as a composite target key
 * - TC2506: prototype rejected as a composite target key
 * - TC2507: __proto__ rejected as a models category name (models.__proto__)
 * - TC2508: constructor rejected as a models category name
 * - TC2509: prototype rejected as a models category name
 * - TC2510: __proto__ rejected as a models entry key (models.X.__proto__)
 * - TC2511: constructor rejected as a models entry key
 * - TC2512: prototype rejected as a models entry key
 * - TC2513 (control): a well-formed payload with neither models nor composite
 *           using any dangerous key is accepted normally
 * - TC2514 (live PUT): a real /dashboard/api/config PUT body containing a
 *           __proto__ alias returns HTTP 400 with the matching assertSafeKey
 *           error message (cross-validates dist-import behavior against the
 *           actual running server's request-body parsing path)
 * - TC2515 (live PUT): models category __proto__ via real PUT also returns 400
 *
 * Reference: src/utils/config-loader.ts (DANGEROUS_KEYS / assertSafeKey /
 *            applyDashboardConfigUpdate / validateAndNormalizeComposite /
 *            validateAndNormalizeDashboardModels),
 *            docs/security-review-2.md (M4, prototype-pollution-adjacent).
 */

const path = require('path');
const {
  assert,
  runTestSuite,
} = require('../utils/test_helpers');

let applyDashboardConfigUpdate;

async function loadModule() {
  const mod = await import(path.join(process.cwd(), 'dist/utils/config-loader.js'));
  applyDashboardConfigUpdate = mod.applyDashboardConfigUpdate;
}

const BASE_STATE = { composite: {}, models: {} };

// All payloads below are constructed via JSON.parse so that '__proto__' becomes
// a genuine own, enumerable property (matching how real HTTP request bodies
// arrive at the server), instead of triggering the Object.prototype.__proto__
// setter the way a JS object literal would.
function makeCompositeAliasDangerousPayload(key) {
  return JSON.parse(JSON.stringify({ models: {}, composite: JSON.parse(`{${JSON.stringify(key)}:{"a":{"role":"synth"}}}`) }));
}
function makeCompositeTargetDangerousPayload(key) {
  return JSON.parse(JSON.stringify({
    models: {},
    composite: { myalias: JSON.parse(`{${JSON.stringify(key)}:{"role":"synth"}}`) },
  }));
}
function makeModelsCategoryDangerousPayload(key) {
  return JSON.parse(JSON.stringify({
    models: JSON.parse(`{${JSON.stringify(key)}:{"upstream_mode":"openai-completions"}}`),
    composite: {},
  }));
}
function makeModelsEntryDangerousPayload(key) {
  return JSON.parse(JSON.stringify({
    models: { mycat: JSON.parse(`{${JSON.stringify(key)}:"polluted"}`) },
    composite: {},
  }));
}

async function testCompositeAliasProto() {
  const payload = makeCompositeAliasDangerousPayload('__proto__');
  let threw = null;
  try {
    await applyDashboardConfigUpdate(BASE_STATE, payload, '/tmp/_bak_TC2501');
  } catch (e) { threw = e; }
  assert(threw !== null, 'should throw on __proto__ composite alias');
  assert(/Invalid key '__proto__' in composite alias/.test(threw.message),
    `expected assertSafeKey error message, got: ${threw && threw.message}`);
  assert(({}).polluted === undefined, 'Object.prototype must not be polluted');
}

async function testCompositeAliasConstructor() {
  const payload = makeCompositeAliasDangerousPayload('constructor');
  let threw = null;
  try {
    await applyDashboardConfigUpdate(BASE_STATE, payload, '/tmp/_bak_TC2502');
  } catch (e) { threw = e; }
  assert(threw !== null, 'should throw on constructor composite alias');
  assert(/Invalid key 'constructor' in composite alias/.test(threw.message),
    `expected assertSafeKey error message, got: ${threw && threw.message}`);
}

async function testCompositeAliasPrototype() {
  const payload = makeCompositeAliasDangerousPayload('prototype');
  let threw = null;
  try {
    await applyDashboardConfigUpdate(BASE_STATE, payload, '/tmp/_bak_TC2503');
  } catch (e) { threw = e; }
  assert(threw !== null, 'should throw on prototype composite alias');
  assert(/Invalid key 'prototype' in composite alias/.test(threw.message),
    `expected assertSafeKey error message, got: ${threw && threw.message}`);
}

async function testCompositeTargetProto() {
  const payload = makeCompositeTargetDangerousPayload('__proto__');
  let threw = null;
  try {
    await applyDashboardConfigUpdate(BASE_STATE, payload, '/tmp/_bak_TC2504');
  } catch (e) { threw = e; }
  assert(threw !== null, 'should throw on __proto__ composite target key');
  assert(/Invalid key '__proto__' in composite\.myalias/.test(threw.message),
    `expected assertSafeKey error message, got: ${threw && threw.message}`);
}

async function testCompositeTargetConstructor() {
  const payload = makeCompositeTargetDangerousPayload('constructor');
  let threw = null;
  try {
    await applyDashboardConfigUpdate(BASE_STATE, payload, '/tmp/_bak_TC2505');
  } catch (e) { threw = e; }
  assert(threw !== null, 'should throw on constructor composite target key');
  assert(/Invalid key 'constructor' in composite\.myalias/.test(threw.message),
    `expected assertSafeKey error message, got: ${threw && threw.message}`);
}

async function testCompositeTargetPrototype() {
  const payload = makeCompositeTargetDangerousPayload('prototype');
  let threw = null;
  try {
    await applyDashboardConfigUpdate(BASE_STATE, payload, '/tmp/_bak_TC2506');
  } catch (e) { threw = e; }
  assert(threw !== null, 'should throw on prototype composite target key');
  assert(/Invalid key 'prototype' in composite\.myalias/.test(threw.message),
    `expected assertSafeKey error message, got: ${threw && threw.message}`);
}

async function testModelsCategoryProto() {
  const payload = makeModelsCategoryDangerousPayload('__proto__');
  let threw = null;
  try {
    await applyDashboardConfigUpdate(BASE_STATE, payload, '/tmp/_bak_TC2507');
  } catch (e) { threw = e; }
  assert(threw !== null, 'should throw on __proto__ models category');
  assert(/Invalid key '__proto__' in models category/.test(threw.message),
    `expected assertSafeKey error message, got: ${threw && threw.message}`);
}

async function testModelsCategoryConstructor() {
  const payload = makeModelsCategoryDangerousPayload('constructor');
  let threw = null;
  try {
    await applyDashboardConfigUpdate(BASE_STATE, payload, '/tmp/_bak_TC2508');
  } catch (e) { threw = e; }
  assert(threw !== null, 'should throw on constructor models category');
  assert(/Invalid key 'constructor' in models category/.test(threw.message),
    `expected assertSafeKey error message, got: ${threw && threw.message}`);
}

async function testModelsCategoryPrototype() {
  const payload = makeModelsCategoryDangerousPayload('prototype');
  let threw = null;
  try {
    await applyDashboardConfigUpdate(BASE_STATE, payload, '/tmp/_bak_TC2509');
  } catch (e) { threw = e; }
  assert(threw !== null, 'should throw on prototype models category');
  assert(/Invalid key 'prototype' in models category/.test(threw.message),
    `expected assertSafeKey error message, got: ${threw && threw.message}`);
}

async function testModelsEntryProto() {
  const payload = makeModelsEntryDangerousPayload('__proto__');
  let threw = null;
  try {
    await applyDashboardConfigUpdate(BASE_STATE, payload, '/tmp/_bak_TC2510');
  } catch (e) { threw = e; }
  assert(threw !== null, 'should throw on __proto__ models entry');
  assert(/Invalid key '__proto__' in models\.mycat/.test(threw.message),
    `expected assertSafeKey error message, got: ${threw && threw.message}`);
}

async function testModelsEntryConstructor() {
  const payload = makeModelsEntryDangerousPayload('constructor');
  let threw = null;
  try {
    await applyDashboardConfigUpdate(BASE_STATE, payload, '/tmp/_bak_TC2511');
  } catch (e) { threw = e; }
  assert(threw !== null, 'should throw on constructor models entry');
  assert(/Invalid key 'constructor' in models\.mycat/.test(threw.message),
    `expected assertSafeKey error message, got: ${threw && threw.message}`);
}

async function testModelsEntryPrototype() {
  const payload = makeModelsEntryDangerousPayload('prototype');
  let threw = null;
  try {
    await applyDashboardConfigUpdate(BASE_STATE, payload, '/tmp/_bak_TC2512');
  } catch (e) { threw = e; }
  assert(threw !== null, 'should throw on prototype models entry');
  assert(/Invalid key 'prototype' in models\.mycat/.test(threw.message),
    `expected assertSafeKey error message, got: ${threw && threw.message}`);
}

async function testControlValidPayloadAccepted() {
  const payload = JSON.parse(JSON.stringify({
    models: { goodcat: { upstream_mode: 'openai-completions', base_url: 'https://example.com' } },
    composite: { myalias: { s1: { role: 'synth' }, s2: { role: 'judge' } } },
  }));
  const result = await applyDashboardConfigUpdate(BASE_STATE, payload, '/tmp/_bak_TC2513');
  assert(Object.keys(result.composite).includes('myalias'), 'control: myalias should be in result.composite');
  assert(Object.keys(result.models).includes('goodcat'), 'control: goodcat should be in result.models');
}

async function testLivePutProtoAliasRejected() {
  // CRITICAL: construct body as a raw JSON string so __proto__ is a genuine
  // JSON key. A JS object literal { __proto__: x } uses the setter path and
  // JSON.stringify drops it — creating an empty composite the server accepts.
  // This matches how real HTTP request bodies arrive (runtime JSON.parses them).
  const url = `${process.env.PROXY_URL || 'http://localhost:7777'}/dashboard/api/config`;
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.API_KEY || 'sk-test-key'}`,
    },
    body: '{"models":{},"composite":{"__proto__":{"p1":{"fusion":1}}}}',
  });
  const text = await response.text();
  assert(response.status === 400, `expected 400, got ${response.status}: ${text}`);
  assert(/Invalid key '__proto__' in composite alias/.test(text),
    `expected assertSafeKey error in response, got: ${text}`);
}

async function testLivePutModelsCategoryProtoRejected() {
  const url = `${process.env.PROXY_URL || 'http://localhost:7777'}/dashboard/api/config`;
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.API_KEY || 'sk-test-key'}`,
    },
    body: '{"models":{"__proto__":{"upstream_mode":"openai-completions"}},"composite":{}}',
  });
  const text = await response.text();
  assert(response.status === 400, `expected 400, got ${response.status}: ${text}`);
  assert(/Invalid key '__proto__' in models category/.test(text),
    `expected assertSafeKey error in response, got: ${text}`);
}

module.exports = {
  testCompositeAliasProto,
  testCompositeAliasConstructor,
  testCompositeAliasPrototype,
  testCompositeTargetProto,
  testCompositeTargetConstructor,
  testCompositeTargetPrototype,
  testModelsCategoryProto,
  testModelsCategoryConstructor,
  testModelsCategoryPrototype,
  testModelsEntryProto,
  testModelsEntryConstructor,
  testModelsEntryPrototype,
  testControlValidPayloadAccepted,
  testLivePutProtoAliasRejected,
  testLivePutModelsCategoryProtoRejected,
};

if (require.main === module) {
  loadModule().then(() =>
    runTestSuite('Config-Loader Prototype-Pollution Rejection Tests', [
      { name: 'TC2501 - composite alias __proto__ rejected', fn: testCompositeAliasProto },
      { name: 'TC2502 - composite alias constructor rejected', fn: testCompositeAliasConstructor },
      { name: 'TC2503 - composite alias prototype rejected', fn: testCompositeAliasPrototype },
      { name: 'TC2504 - composite target __proto__ rejected', fn: testCompositeTargetProto },
      { name: 'TC2505 - composite target constructor rejected', fn: testCompositeTargetConstructor },
      { name: 'TC2506 - composite target prototype rejected', fn: testCompositeTargetPrototype },
      { name: 'TC2507 - models category __proto__ rejected', fn: testModelsCategoryProto },
      { name: 'TC2508 - models category constructor rejected', fn: testModelsCategoryConstructor },
      { name: 'TC2509 - models category prototype rejected', fn: testModelsCategoryPrototype },
      { name: 'TC2510 - models entry __proto__ rejected', fn: testModelsEntryProto },
      { name: 'TC2511 - models entry constructor rejected', fn: testModelsEntryConstructor },
      { name: 'TC2512 - models entry prototype rejected', fn: testModelsEntryPrototype },
      { name: 'TC2513 - control: valid payload accepted', fn: testControlValidPayloadAccepted },
      { name: 'TC2514 - live PUT __proto__ composite alias → 400', fn: testLivePutProtoAliasRejected },
      { name: 'TC2515 - live PUT __proto__ models category → 400', fn: testLivePutModelsCategoryProtoRejected },
    ])
  );
}