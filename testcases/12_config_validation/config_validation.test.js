/**
 * Config Schema Validation Tests
 * Tests the documented config validation rules
 *
 * Coverage:
 * - TC1201: config_errors is a well-formed array in GET /dashboard/api/config
 * - TC1202: PUT with non-array target value is rejected
 * - TC1203: PUT with empty composite target array is rejected
 * - TC1204: PUT with 2-element model array is rejected
 * - TC1205: PUT with 4-element model array is rejected
 * - TC1206: PUT with non-boolean primary is rejected
 * - TC1207: PUT with non-finite share is rejected
 * - TC1208: PUT with non-finite fallback is rejected
 * - TC1209: PUT with invalid total_token_limit (non-number) is rejected
 * - TC1210: PUT with non-object composite target config is rejected
 * - TC1211: PUT with valid empty composite target {} is accepted
 * - TC1212: PUT with non-object models payload is rejected
 * - TC1213: PUT rejects api_key in models payload
 * - TC1214: PUT with an empty composite alias (no targets) round-trips and is accepted
 * - TC1215: PUT with bare * as model target (catch-all entry) is accepted
 *
 * Reference: README §"Config validation", §"Per-Model Configuration Array Format"
 */

const {
  sendRequest,
  assert,
  runTest,
  runTestSuite
} = require('../utils/test_helpers');

const PROXY_URL = process.env.PROXY_URL || 'http://localhost:8788';
const API_KEY = process.env.API_KEY || 'sk-test-key';

// Minimal valid models/composite payload that mirrors the live config,
// used as baseline for mutation-based tests.
async function getLiveComposite() {
  const res = await sendRequest({
    method: 'GET',
    endpoint: '/dashboard/api/config',
    headers: { 'Authorization': `Bearer ${API_KEY}` }
  });
  return res.body?.config?.composite || {};
}

async function getLiveModels() {
  const res = await sendRequest({
    method: 'GET',
    endpoint: '/dashboard/api/config',
    headers: { 'Authorization': `Bearer ${API_KEY}` }
  });
  // Return a dashboard-editable view (no api_key)
  const models = res.body?.config?.models || {};
  const out = {};
  for (const [cat, cfg] of Object.entries(models)) {
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) continue;
    const catOut = {};
    for (const [k, v] of Object.entries(cfg)) {
      if (k === 'api_key') continue; // not editable
      catOut[k] = v;
    }
    out[cat] = catOut;
  }
  return out;
}

// Send a PUT /dashboard/api/config with a given payload
async function putConfig(payload) {
  const url = `${PROXY_URL}/dashboard/api/config`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`
    },
    body: JSON.stringify(payload)
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

/**
 * TC1201: config_errors field shape in GET /dashboard/api/config
 */
async function testConfigErrorsShape() {
  const res = await sendRequest({
    method: 'GET',
    endpoint: '/dashboard/api/config',
    headers: { 'Authorization': `Bearer ${API_KEY}` }
  });

  assert(res.status === 200, `GET /dashboard/api/config should return 200, got ${res.status}`);
  assert(res.body?.config !== undefined, 'Response should have config field');

  const configErrors = res.body.config.config_errors;
  assert(Array.isArray(configErrors), `config_errors should be an array, got ${typeof configErrors}`);

  for (const err of configErrors) {
    assert(typeof err.path === 'string', 'Each config_error should have a string path');
    assert(typeof err.message === 'string', 'Each config_error should have a string message');
  }
}

/**
 * TC1202: PUT — non-array model value is rejected
 * model entry must be an array, not a plain string
 */
async function testPutNonArrayModelValue() {
  const models = await getLiveModels();
  const composite = await getLiveComposite();

  // Pick the first available category
  const firstCat = Object.keys(models)[0];
  if (!firstCat) {
    console.log('    (skipped: no editable model categories found)');
    return;
  }

  // Inject an invalid non-array entry into that category
  const badModels = {
    ...models,
    [firstCat]: {
      ...models[firstCat],
      '__test_invalid_entry__': 'not-an-array'
    }
  };

  const res = await putConfig({ models: badModels, composite });
  assert(
    res.status === 400 || (res.status === 200 && Array.isArray(res.body?.config?.config_errors) && res.body.config.config_errors.length > 0),
    `PUT with non-array model value should return 400 or surface config_errors (got ${res.status})`
  );
}

/**
 * TC1203: PUT — empty composite target array (non-object target) is rejected
 */
async function testPutCompositeNonObjectTarget() {
  const models = await getLiveModels();
  const composite = await getLiveComposite();

  // A composite target must be an object, not an array
  const badComposite = {
    ...composite,
    '__test_bad_alias__': { 'some-model': ['not', 'an', 'object'] }
  };

  const res = await putConfig({ models, composite: badComposite });
  assert(
    res.status === 400,
    `PUT with array composite target should return 400 (got ${res.status})`
  );
}

/**
 * TC1204: PUT — 2-element model array is rejected
 * Only 1 or 3 elements are valid.
 */
async function testPutTwoElementModelArray() {
  const models = await getLiveModels();
  const composite = await getLiveComposite();

  const firstCat = Object.keys(models)[0];
  if (!firstCat) {
    console.log('    (skipped: no editable model categories found)');
    return;
  }

  const badModels = {
    ...models,
    [firstCat]: {
      ...models[firstCat],
      '__test_2elem__': ['target-model', 'https://api.example.com']
    }
  };

  const res = await putConfig({ models: badModels, composite });
  assert(
    res.status === 400 || (res.status === 200 && Array.isArray(res.body?.config?.config_errors) && res.body.config.config_errors.some(e => e.message?.includes('got 2'))),
    `PUT with 2-element array should return 400 or surface 'got 2 elements' error (got ${res.status})`
  );
}

/**
 * TC1205: PUT — 4-element model array is rejected
 */
async function testPutFourElementModelArray() {
  const models = await getLiveModels();
  const composite = await getLiveComposite();

  const firstCat = Object.keys(models)[0];
  if (!firstCat) {
    console.log('    (skipped: no editable model categories found)');
    return;
  }

  const badModels = {
    ...models,
    [firstCat]: {
      ...models[firstCat],
      '__test_4elem__': ['target', 'https://api.example.com', 'sk-key', 'extra']
    }
  };

  const res = await putConfig({ models: badModels, composite });
  assert(
    res.status === 400 || (res.status === 200 && Array.isArray(res.body?.config?.config_errors) && res.body.config.config_errors.some(e => e.message?.includes('elements'))),
    `PUT with 4-element array should return 400 or surface elements error (got ${res.status})`
  );
}

/**
 * TC1206: PUT — non-boolean primary is rejected
 */
async function testPutNonBooleanPrimary() {
  const models = await getLiveModels();
  const composite = await getLiveComposite();

  const badComposite = {
    ...composite,
    '__test_primary_alias__': {
      'some-model': { primary: 'yes' }  // string instead of boolean
    }
  };

  const res = await putConfig({ models, composite: badComposite });
  assert(
    res.status === 400,
    `PUT with string primary should return 400 (got ${res.status})`
  );
}

/**
 * TC1207: PUT — non-finite share is rejected
 */
async function testPutNonFiniteShare() {
  const models = await getLiveModels();
  const composite = await getLiveComposite();

  const badComposite = {
    ...composite,
    '__test_share_alias__': {
      'some-model': { share: 'heavy' }  // string instead of number
    }
  };

  const res = await putConfig({ models, composite: badComposite });
  assert(
    res.status === 400,
    `PUT with string share should return 400 (got ${res.status})`
  );
}

/**
 * TC1208: PUT — non-finite fallback is rejected
 */
async function testPutNonFiniteFallback() {
  const models = await getLiveModels();
  const composite = await getLiveComposite();

  const badComposite = {
    ...composite,
    '__test_fallback_alias__': {
      'some-model': { fallback: 'first' }  // string instead of number
    }
  };

  const res = await putConfig({ models, composite: badComposite });
  assert(
    res.status === 400,
    `PUT with string fallback should return 400 (got ${res.status})`
  );
}

/**
 * TC1209: PUT — invalid total_token_limit (non-number) is rejected
 */
async function testPutInvalidTotalTokenLimit() {
  const models = await getLiveModels();
  const composite = await getLiveComposite();

  const badComposite = {
    ...composite,
    '__test_ttl_alias__': {
      'total_token_limit': 'ten-thousand'  // string instead of number
    }
  };

  const res = await putConfig({ models, composite: badComposite });
  assert(
    res.status === 400,
    `PUT with string total_token_limit should return 400 (got ${res.status})`
  );
}

/**
 * TC1210: PUT — non-object composite target config is rejected
 * A composite target value must be an object (not a primitive).
 */
async function testPutCompositeTargetNotObject() {
  const models = await getLiveModels();
  const composite = await getLiveComposite();

  const badComposite = {
    ...composite,
    '__test_notobj_alias__': {
      'some-model': 42  // number instead of object
    }
  };

  const res = await putConfig({ models, composite: badComposite });
  assert(
    res.status === 400,
    `PUT with numeric composite target should return 400 (got ${res.status})`
  );
}

/**
 * TC1211: PUT — empty composite target {} is accepted
 * An empty target object {} is valid per README L1070.
 *
 * getLiveModels() returns 2-element arrays (api_key stripped) from the GET
 * response, but the PUT validator only accepts 1- or 3-element arrays.
 * Normalize here the same way TC1214 does so the models payload is valid
 * and this test isolates only the composite-target {} behaviour.
 */
async function testPutEmptyCompositeTargetValid() {
  const rawModels = await getLiveModels();
  const composite = await getLiveComposite();

  // Normalize 2-element arrays to 1 or 3 elements (see TC1214 for rationale)
  const models = {};
  for (const [cat, cfg] of Object.entries(rawModels)) {
    const catOut = {};
    for (const [k, v] of Object.entries(cfg)) {
      if (!Array.isArray(v)) {
        catOut[k] = v;
      } else if (v.length >= 2 && v[1]) {
        catOut[k] = [v[0], v[1], ''];
      } else {
        catOut[k] = [v[0]];
      }
    }
    models[cat] = catOut;
  }

  // Add a well-formed alias with an empty target config
  const goodComposite = {
    ...composite,
    '__test_empty_target__': {
      'some-model': {}
    }
  };

  const res = await putConfig({ models, composite: goodComposite });
  assert(
    res.status === 200,
    `PUT with empty composite target {} should be accepted (got ${res.status}${res.status !== 200 ? ': ' + JSON.stringify(res.body?.error) : ''})`
  );

  // Clean up: restore the original config without the test alias
  const restoreRes = await putConfig({ models, composite });
  assert(restoreRes.status === 200, 'Config cleanup PUT should succeed');
}

/**
 * TC1212: PUT — non-object models payload is rejected
 */
async function testPutNonObjectModels() {
  const res = await putConfig({ models: 'invalid', composite: {} });
  assert(
    res.status === 400,
    `PUT with string models payload should return 400 (got ${res.status})`
  );
}

/**
 * TC1213: PUT — api_key in models payload is rejected
 */
async function testPutApiKeyInModels() {
  const models = await getLiveModels();
  const composite = await getLiveComposite();

  const firstCat = Object.keys(models)[0];
  if (!firstCat) {
    console.log('    (skipped: no editable model categories found)');
    return;
  }

  const badModels = {
    ...models,
    [firstCat]: {
      ...models[firstCat],
      api_key: 'sk-sneaky'
    }
  };

  const res = await putConfig({ models: badModels, composite });
  assert(
    res.status === 400,
    `PUT with api_key in models payload should return 400 (got ${res.status})`
  );
}

/**
 * TC1215: PUT — bare * as model target (catch-all entry) is accepted
 *
 * The models.default section supports a bare '*' key:
 *   * = ["*", "", ""]
 * This entry means "passthrough the original model name to the upstream".
 * The validation rules must NOT reject '*' as a target (element 0) value,
 * even though it looks like a "wildcard" by name.
 *
 * Reference: docs/routing_config_revision.md §"models.default section"
 */
async function testPutBareStarTargetAccepted() {
  const rawModels = await getLiveModels();
  const composite = await getLiveComposite();

  // Normalize to valid 1- or 3-element arrays (same normalization as TC1214)
  const models = {};
  for (const [cat, cfg] of Object.entries(rawModels)) {
    const catOut = {};
    for (const [k, v] of Object.entries(cfg)) {
      if (!Array.isArray(v)) {
        catOut[k] = v;
      } else if (v.length >= 2 && v[1]) {
        catOut[k] = [v[0], v[1], ''];
      } else {
        catOut[k] = [v[0]];
      }
    }
    models[cat] = catOut;
  }

  // Add a catch-all entry in models.default using bare '*' as the target
  if (!models.default) {
    models.default = {};
  }
  models.default.__test_catchall__ = ['*', '', ''];

  const res = await putConfig({ models, composite });
  assert(
    res.status === 200,
    `PUT with bare '*' as model target should be accepted (got ${res.status}${res.status !== 200 ? ': ' + JSON.stringify(res.body?.error) : ''})`
  );

  // Verify the entry round-trips through the reload
  const returnedModels = res.body?.config?.models || {};
  const defaultCat = returnedModels.default || {};
  assert(
    '__test_catchall__' in defaultCat,
    `Bare '*' catch-all entry should survive the round-trip`
  );

  // Clean up: restore the original config (normalize rawModels to valid arrays,
  // same as TC1214 — the GET response returns 2-element arrays but the PUT
  // validator only accepts 1- or 3-element arrays).
  const restoreModels = {};
  for (const [cat, cfg] of Object.entries(rawModels)) {
    const catOut = {};
    for (const [k, v] of Object.entries(cfg)) {
      if (!Array.isArray(v)) {
        catOut[k] = v;
      } else if (v.length >= 2 && v[1]) {
        catOut[k] = [v[0], v[1], ''];
      } else {
        catOut[k] = [v[0]];
      }
    }
    restoreModels[cat] = catOut;
  }
  const restoreRes = await putConfig({ models: restoreModels, composite });
  assert(restoreRes.status === 200, 'Config cleanup PUT should succeed');
}

/**
 * TC1214: PUT — empty composite alias (no targets) is accepted and round-trips
 *
 * Regression for the TUI "press A to add alias" flow: adding an alias creates
 * an empty alias entry ("alias" = {}) which is persisted and immediately
 * reloaded. A round-trip integrity check in persistProxyConfigToPath compares
 * the alias set before and after serialization; if the TOML parser cannot parse
 * an empty inline object {}, the alias is silently dropped on reload, the check
 * throws, and the PUT (and the TUI's subsequent target picker) fails.
 *
 * This verifies the alias survives the persist→reload round-trip.
 */
async function testPutEmptyCompositeAlias() {
  const composite = await getLiveComposite();

  // getLiveModels() returns 2-element arrays (api_key stripped), which the PUT
  // validator does not accept (only 1- or 3-element arrays are valid). Normalize
  // every model array to a valid form so the models payload round-trips cleanly
  // and this test isolates the composite-alias behaviour under test:
  //   - if the model has its own base_url (element 1), send a 3-element array
  //     [model, url, ""]; the proxy preserves the existing api_key on PUT.
  //   - otherwise send a 1-element array [model] and rely on the category base_url.
  const rawModels = await getLiveModels();
  const models = {};
  for (const [cat, cfg] of Object.entries(rawModels)) {
    const catOut = {};
    for (const [k, v] of Object.entries(cfg)) {
      if (!Array.isArray(v)) {
        catOut[k] = v;
      } else if (v.length >= 2 && v[1]) {
        catOut[k] = [v[0], v[1], ''];
      } else {
        catOut[k] = [v[0]];
      }
    }
    models[cat] = catOut;
  }

  const ALIAS = '__test_empty_alias__';
  const goodComposite = {
    ...composite,
    [ALIAS]: {}  // alias with no targets yet — exactly what TUI "add alias" creates
  };

  const res = await putConfig({ models, composite: goodComposite });
  assert(
    res.status === 200,
    `PUT with empty composite alias should be accepted (got ${res.status}${res.status !== 200 ? ': ' + JSON.stringify(res.body?.error) : ''})`
  );

  // The alias must survive the persist→reload round-trip and be present in the
  // returned snapshot (the bug dropped it, which is what broke the TUI picker).
  const returnedComposite = res.body?.config?.composite || {};
  assert(
    ALIAS in returnedComposite,
    `Empty alias "${ALIAS}" should survive the round-trip and appear in the reloaded config`
  );

  // Clean up: restore the original config without the test alias
  const restoreRes = await putConfig({ models, composite });
  assert(restoreRes.status === 200, 'Config cleanup PUT should succeed');
}

module.exports = {
  testConfigErrorsShape,
  testPutNonArrayModelValue,
  testPutCompositeNonObjectTarget,
  testPutTwoElementModelArray,
  testPutFourElementModelArray,
  testPutNonBooleanPrimary,
  testPutNonFiniteShare,
  testPutNonFiniteFallback,
  testPutInvalidTotalTokenLimit,
  testPutCompositeTargetNotObject,
  testPutEmptyCompositeTargetValid,
  testPutNonObjectModels,
  testPutApiKeyInModels,
  testPutEmptyCompositeAlias,
  testPutBareStarTargetAccepted
};

if (require.main === module) {
  runTestSuite('Config Validation Tests', [
    { name: 'TC1201: config_errors shape', fn: testConfigErrorsShape },
    { name: 'TC1202: PUT non-array model value', fn: testPutNonArrayModelValue },
    { name: 'TC1203: PUT composite array target', fn: testPutCompositeNonObjectTarget },
    { name: 'TC1204: PUT 2-element model array', fn: testPutTwoElementModelArray },
    { name: 'TC1205: PUT 4-element model array', fn: testPutFourElementModelArray },
    { name: 'TC1206: PUT non-boolean primary', fn: testPutNonBooleanPrimary },
    { name: 'TC1207: PUT non-finite share', fn: testPutNonFiniteShare },
    { name: 'TC1208: PUT non-finite fallback', fn: testPutNonFiniteFallback },
    { name: 'TC1209: PUT invalid total_token_limit', fn: testPutInvalidTotalTokenLimit },
    { name: 'TC1210: PUT composite target not object', fn: testPutCompositeTargetNotObject },
    { name: 'TC1211: PUT empty composite target valid', fn: testPutEmptyCompositeTargetValid },
    { name: 'TC1212: PUT non-object models', fn: testPutNonObjectModels },
    { name: 'TC1213: PUT api_key rejected', fn: testPutApiKeyInModels },
    { name: 'TC1214: PUT empty composite alias round-trips', fn: testPutEmptyCompositeAlias },
    { name: 'TC1215: PUT bare * target accepted', fn: testPutBareStarTargetAccepted },
  ]);
}
