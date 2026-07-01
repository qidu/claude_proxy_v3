/**
 * Schedule CRUD Routing & Helper Tests
 *
 * Coverage matrix for the schedule feature surface introduced alongside
 * the dashboard/TUI/HTTP wiring (see plan: "Schedule feature: complete the
 * missing surfaces"). Splits into three sections:
 *
 *  - UNIT (no live server): exercises src/utils/config-loader.ts exported
 *    helpers directly against dist/utils/config-loader.js:
 *      - addScheduleAlias / removeScheduleAlias CRUD basics
 *      - upsertScheduleWindow validation: from>=to rejected, from>24 rejected,
 *        to>24 rejected, empty array marks target as fallback
 *      - resolveScheduleTarget picks the right target at a fixed clock,
 *        returns undefined for unknown alias / outside any window
 *      - schedule alias denylist (DANGEROUS_KEYS via assertSafeKey inside
 *        validateAndNormalizeSchedule, exercised through the
 *        applyDashboardConfigUpdate payload path)
 *
 *  - REGRESSION (bug fix): applyDashboardConfigUpdate must NOT wipe a
 *    pre-existing schedule when the payload omits it. Prior to the fix at
 *    src/utils/config-loader.ts:2270 a partial PUT (e.g. only editing
 *    composite) silently erased schedule.
 *
 *  - LIVE HTTP (only when PROXY_RUN_LIVE=1): round-trips the four new
 *    dashboard routes (/dashboard/api/schedule/alias[/:alias/target[/:target]])
 *    introduced in src/index.ts, verifying each route persists its change
 *    in the live proxy's view via GET /dashboard/api/config.
 *
 * Reference:
 *   src/utils/config-loader.ts:
 *     - addScheduleAlias (line ~2637)
 *     - removeScheduleAlias (line ~2653)
 *     - upsertScheduleWindow (line ~2673)
 *     - removeScheduleTarget (line ~2714)
 *     - resolveScheduleTarget (line ~524)
 *     - applyDashboardConfigUpdate (line ~2263, schedule-wipe fix at 2276)
 *   src/index.ts: dashboard routes for /schedule/*
 *   src/handlers/dashboard.ts: addScheduleAliasFromDashboard et al.
 *   docs/security-review-2.md: M4 prototype-pollution defense-in-depth.
 */

const path = require('path');
const {
  sendRequest,
  assert,
  runTestSuite,
} = require('../utils/test_helpers');

let addScheduleAlias,
  removeScheduleAlias,
  upsertScheduleWindow,
  removeScheduleTarget,
  resolveScheduleTarget,
  applyDashboardConfigUpdate;

async function loadModule() {
  const mod = await import(path.join(process.cwd(), 'dist/utils/config-loader.js'));
  addScheduleAlias = mod.addScheduleAlias;
  removeScheduleAlias = mod.removeScheduleAlias;
  upsertScheduleWindow = mod.upsertScheduleWindow;
  removeScheduleTarget = mod.removeScheduleTarget;
  resolveScheduleTarget = mod.resolveScheduleTarget;
  applyDashboardConfigUpdate = mod.applyDashboardConfigUpdate;
}

const BASE_CONFIG = {
  models: {
    default: { upstream_mode: 'openai-completions', base_url: 'https://example.com' },
  },
  composite: {},
  schedule: {},
};

// ---------------------------------------------------------------------------
// UNIT: alias CRUD
// ---------------------------------------------------------------------------

async function testAddScheduleAliasCreatesEntry() {
  const next = addScheduleAlias(BASE_CONFIG, 'workhours');
  assert(next.schedule && next.schedule['workhours'], 'expected schedule.workhours to exist');
  assert(Object.keys(next.schedule['workhours']).length === 0, 'new alias should have empty targets');
  // immutability: input config is not mutated
  assert(!BASE_CONFIG.schedule['workhours'], 'BASE_CONFIG must not be mutated');
}

async function testAddScheduleAliasDuplicateThrows() {
  let next = addScheduleAlias(BASE_CONFIG, 'weekend');
  let threw = null;
  try {
    addScheduleAlias(next, 'weekend');
  } catch (e) { threw = e; }
  assert(threw !== null, 'should throw on duplicate alias');
  assert(/already exists/.test(threw.message), `expected 'already exists' error, got: ${threw && threw.message}`);
}

async function testAddScheduleAliasEmptyThrows() {
  let threw = null;
  try {
    addScheduleAlias(BASE_CONFIG, '   ');
  } catch (e) { threw = e; }
  assert(threw !== null, 'should throw on empty/whitespace alias');
  assert(/schedule alias is required/.test(threw.message),
    `expected 'schedule alias is required' error, got: ${threw && threw.message}`);
}

async function testRemoveScheduleAliasDeletes() {
  let next = addScheduleAlias(BASE_CONFIG, 'temp');
  next = removeScheduleAlias(next, 'temp');
  assert(!next.schedule['temp'], 'expected temp alias to be deleted');
}

async function testRemoveScheduleAliasMissingThrows() {
  let threw = null;
  try {
    removeScheduleAlias(BASE_CONFIG, 'nope');
  } catch (e) { threw = e; }
  assert(threw !== null, 'should throw on missing alias');
  assert(/Schedule alias not found/.test(threw.message),
    `expected 'Schedule alias not found' error, got: ${threw && threw.message}`);
}

// ---------------------------------------------------------------------------
// UNIT: upsertScheduleWindow validation
// ---------------------------------------------------------------------------

async function testUpsertWindowAcceptsValidWindow() {
  let next = addScheduleAlias(BASE_CONFIG, 'workhours');
  next = upsertScheduleWindow(next, 'workhours', 'gpt-x', [{ from: 9, to: 17 }]);
  assert(Array.isArray(next.schedule['workhours']['gpt-x']),
    'expected windows array under gpt-x');
  assert(next.schedule['workhours']['gpt-x'][0].from === 9,
    `expected from=9, got ${next.schedule['workhours']['gpt-x'][0].from}`);
  assert(next.schedule['workhours']['gpt-x'][0].to === 17,
    `expected to=17, got ${next.schedule['workhours']['gpt-x'][0].to}`);
}

async function testUpsertWindowFromEqualsToThrows() {
  let next = addScheduleAlias(BASE_CONFIG, 'workhours');
  let threw = null;
  try {
    upsertScheduleWindow(next, 'workhours', 'gpt-x', [{ from: 9, to: 9 }]);
  } catch (e) { threw = e; }
  assert(threw !== null, 'should throw when from === to');
  assert(/from must be less than to/.test(threw.message),
    `expected 'from must be less than to' error, got: ${threw && threw.message}`);
}

async function testUpsertWindowFromGreaterThanToThrows() {
  let next = addScheduleAlias(BASE_CONFIG, 'workhours');
  let threw = null;
  try {
    upsertScheduleWindow(next, 'workhours', 'gpt-x', [{ from: 17, to: 9 }]);
  } catch (e) { threw = e; }
  assert(threw !== null, 'should throw when from > to');
  assert(/from must be less than to/.test(threw.message),
    `expected 'from must be less than to' error, got: ${threw && threw.message}`);
}

async function testUpsertWindowFromOver24Throws() {
  let next = addScheduleAlias(BASE_CONFIG, 'workhours');
  let threw = null;
  try {
    upsertScheduleWindow(next, 'workhours', 'gpt-x', [{ from: 25, to: 30 }]);
  } catch (e) { threw = e; }
  assert(threw !== null, 'should throw when from > 24');
  assert(/Invalid from/.test(threw.message),
    `expected 'Invalid from' error, got: ${threw && threw.message}`);
}

async function testUpsertWindowToOver24Throws() {
  let next = addScheduleAlias(BASE_CONFIG, 'workhours');
  let threw = null;
  try {
    upsertScheduleWindow(next, 'workhours', 'gpt-x', [{ from: 1, to: 25 }]);
  } catch (e) { threw = e; }
  assert(threw !== null, 'should throw when to > 24');
  assert(/Invalid to/.test(threw.message),
    `expected 'Invalid to' error, got: ${threw && threw.message}`);
}

async function testUpsertWindowEmptyArrayMarksFallback() {
  let next = addScheduleAlias(BASE_CONFIG, 'workhours');
  next = upsertScheduleWindow(next, 'workhours', 'gpt-x', [{ from: 9, to: 17 }]);
  // Re-upsert with [] to mark as fallback
  next = upsertScheduleWindow(next, 'workhours', 'gpt-x', []);
  assert(Array.isArray(next.schedule['workhours']['gpt-x']),
    'fallback target should still hold an array');
  assert(next.schedule['workhours']['gpt-x'].length === 0,
    `fallback target should have empty windows array, got length ${next.schedule['workhours']['gpt-x'].length}`);
}

async function testUpsertWindowRejectsUnknownTargetWhenAllowListProvided() {
  let next = addScheduleAlias(BASE_CONFIG, 'workhours');
  let threw = null;
  try {
    upsertScheduleWindow(next, 'workhours', 'not-configured', [{ from: 0, to: 24 }], ['gpt-x']);
  } catch (e) { threw = e; }
  assert(threw !== null, 'should reject unknown target when allowlist provided');
  assert(/Unknown target model/.test(threw.message),
    `expected 'Unknown target model' error, got: ${threw && threw.message}`);
}

// ---------------------------------------------------------------------------
// UNIT: removeScheduleTarget
// ---------------------------------------------------------------------------

async function testRemoveScheduleTargetDeletes() {
  let next = addScheduleAlias(BASE_CONFIG, 'workhours');
  next = upsertScheduleWindow(next, 'workhours', 'gpt-x', [{ from: 9, to: 17 }]);
  next = removeScheduleTarget(next, 'workhours', 'gpt-x');
  assert(next.schedule['workhours']['gpt-x'] === undefined,
    'expected gpt-x target to be removed from workhours');
}

async function testRemoveScheduleTargetMissingAliasThrows() {
  let threw = null;
  try {
    removeScheduleTarget(BASE_CONFIG, 'nonexistent', 'gpt-x');
  } catch (e) { threw = e; }
  assert(threw !== null, 'should throw on missing alias');
  assert(/Schedule alias not found/.test(threw.message),
    `expected 'Schedule alias not found', got: ${threw && threw.message}`);
}

async function testRemoveScheduleTargetMissingTargetThrows() {
  let next = addScheduleAlias(BASE_CONFIG, 'workhours');
  let threw = null;
  try {
    removeScheduleTarget(next, 'workhours', 'missing-target');
  } catch (e) { threw = e; }
  assert(threw !== null, 'should throw on missing target');
  assert(/Schedule target not found/.test(threw.message),
    `expected 'Schedule target not found', got: ${threw && threw.message}`);
}

// ---------------------------------------------------------------------------
// UNIT: resolveScheduleTarget
// ---------------------------------------------------------------------------

async function testResolveScheduleReturnsUndefinedForUnknownAlias() {
  const result = resolveScheduleTarget('not-a-schedule', BASE_CONFIG, new Date());
  assert(result === undefined,
    `expected undefined for unknown alias, got ${result}`);
}

async function testResolveSchedulePicksWindowMatchingNow() {
  // Build a config where at hour 12 (any day), "lunch" window matches.
  const proxyConfig = {
    ...BASE_CONFIG,
    schedule: {
      biz: {
        lunch: [{ from: 11, to: 13 }],
        overnight: [{ from: 0, to: 6 }],
      },
    },
  };
  const noon = new Date(2026, 6, 1, 12, 0, 0); // Wed Jul 1 2026 12:00 local
  const result = resolveScheduleTarget('biz', proxyConfig, noon);
  assert(result === 'lunch', `expected 'lunch' at noon, got ${result}`);
}

async function testResolveScheduleFallsBackWhenNoWindowMatches() {
  const proxyConfig = {
    ...BASE_CONFIG,
    schedule: {
      biz: {
        lunch: [{ from: 11, to: 13 }],
        defaulty: [], // fallback
      },
    },
  };
  // 3 AM local — neither lunch nor any default-with-window matches; expect fallback.
  const threeAM = new Date(2026, 6, 1, 3, 0, 0);
  const result = resolveScheduleTarget('biz', proxyConfig, threeAM);
  assert(result === 'defaulty', `expected fallback 'defaulty' at 3 AM, got ${result}`);
}

async function testResolveScheduleReturnsUndefinedWhenNoMatchAndNoFallback() {
  const proxyConfig = {
    ...BASE_CONFIG,
    schedule: {
      biz: {
        lunch: [{ from: 11, to: 13 }],
      },
    },
  };
  const threeAM = new Date(2026, 6, 1, 3, 0, 0);
  const result = resolveScheduleTarget('biz', proxyConfig, threeAM);
  assert(result === undefined,
    `expected undefined when no match and no fallback, got ${result}`);
}

async function testResolveScheduleHonoursDaysArray() {
  const proxyConfig = {
    ...BASE_CONFIG,
    schedule: {
      biz: {
        weekday: [{ from: 0, to: 24, days: ['mon', 'tue', 'wed', 'thu', 'fri'] }],
        always: [], // fallback
      },
    },
  };
  // Pick a Sunday 12:00 — weekday window must not match, fallback wins.
  const sunday = new Date(2026, 6, 5, 12, 0, 0); // 2026-07-05 is Sunday
  const result = resolveScheduleTarget('biz', proxyConfig, sunday);
  assert(result === 'always', `expected fallback 'always' on Sunday, got ${result}`);

  // Same time on a Tuesday must match weekday.
  const tuesday = new Date(2026, 6, 7, 12, 0, 0); // 2026-07-07 is Tuesday
  const tuesdayResult = resolveScheduleTarget('biz', proxyConfig, tuesday);
  assert(tuesdayResult === 'weekday',
    `expected 'weekday' on Tuesday, got ${tuesdayResult}`);
}

// ---------------------------------------------------------------------------
// REGRESSION: applyDashboardConfigUpdate must NOT wipe schedule when omitted
// ---------------------------------------------------------------------------

async function testApplyDashboardConfigUpdatePreservesSchedule() {
  const base = {
    ...BASE_CONFIG,
    schedule: {
      biz: {
        lunch: [{ from: 11, to: 13 }],
      },
    },
  };
  // Partial payload — only composite change; schedule omitted.
  const payload = JSON.parse(JSON.stringify({
    models: {},
    composite: { myalias: { s1: { role: 'synth' } } },
  }));
  const next = applyDashboardConfigUpdate(base, payload);
  assert(next.schedule && next.schedule.biz, 'schedule.biz must be preserved');
  assert(next.schedule.biz.lunch && next.schedule.biz.lunch[0].from === 11,
    'schedule.biz.lunch[0].from must be preserved');
}

async function testApplyDashboardConfigUpdateReplacesScheduleWhenProvided() {
  const base = {
    ...BASE_CONFIG,
    schedule: {
      biz: {
        lunch: [{ from: 11, to: 13 }],
      },
    },
  };
  // Payload that DOES include schedule — must replace, not merge.
  const payload = JSON.parse(JSON.stringify({
    models: {},
    composite: {},
    schedule: {
      nightshift: {
        owl: [{ from: 0, to: 6 }],
      },
    },
  }));
  const next = applyDashboardConfigUpdate(base, payload);
  assert(next.schedule && next.schedule.nightshift, 'nightshift alias must be in result');
  assert(!next.schedule.biz, 'biz must be replaced (not merged) when schedule is provided');
}

async function testApplyDashboardConfigUpdateRejectsProtoAlias() {
  // Verify the same denylist covers the live payload path through
  // validateAndNormalizeSchedule.
  const payload = JSON.parse(JSON.stringify({
    models: {},
    composite: {},
    schedule: JSON.parse('{"__proto__":{"a":[]}}'),
  }));
  let threw = null;
  try {
    applyDashboardConfigUpdate(BASE_CONFIG, payload);
  } catch (e) { threw = e; }
  assert(threw !== null, 'should reject __proto__ schedule alias via payload');
  assert(/Invalid key '__proto__' in schedule alias/.test(threw.message),
    `expected assertSafeKey error, got: ${threw && threw.message}`);
}

// ---------------------------------------------------------------------------
// LIVE HTTP: round-trip the four new dashboard routes
// ---------------------------------------------------------------------------

async function testLiveRouteAddAliasAndVerify() {
  // Sanity-check the route exists. POST /dashboard/api/schedule/alias.
  const alias = `__test_route_${Date.now()}`;
  const addResp = await sendRequest({
    endpoint: '/dashboard/api/schedule/alias',
    method: 'POST',
    body: { alias },
  });
  assert(addResp.status === 200,
    `add alias: expected 200, got ${addResp.status}: ${JSON.stringify(addResp.body)}`);

  // Verify it's there.
  const getResp = await sendRequest({
    endpoint: '/dashboard/api/config',
    method: 'GET',
  });
  assert(getResp.status === 200, `GET config: expected 200, got ${getResp.status}`);
  assert(getResp.body?.schedule?.[alias],
    `expected ${alias} in schedule, got keys: ${Object.keys(getResp.body?.schedule || {}).join(',')}`);

  // Cleanup.
  await sendRequest({
    endpoint: `/dashboard/api/schedule/alias/${encodeURIComponent(alias)}`,
    method: 'DELETE',
  });
}

async function testLiveRouteUpsertTargetAndVerify() {
  const alias = `__test_target_${Date.now()}`;
  // Create alias
  await sendRequest({
    endpoint: '/dashboard/api/schedule/alias',
    method: 'POST',
    body: { alias },
  });

  // Upsert target with a window
  const upResp = await sendRequest({
    endpoint: `/dashboard/api/schedule/alias/${encodeURIComponent(alias)}/target`,
    method: 'POST',
    body: { target: 'gpt-5.4-mini', windows: [{ from: 9, to: 17 }] },
  });
  assert(upResp.status === 200,
    `upsert target: expected 200, got ${upResp.status}: ${JSON.stringify(upResp.body)}`);

  // Verify
  const getResp = await sendRequest({
    endpoint: '/dashboard/api/config',
    method: 'GET',
  });
  const win = getResp.body?.schedule?.[alias]?.['gpt-5.4-mini'];
  assert(Array.isArray(win) && win.length === 1 && win[0].from === 9 && win[0].to === 17,
    `expected [{from:9,to:17}], got: ${JSON.stringify(win)}`);

  // Remove target
  const delTargetResp = await sendRequest({
    endpoint: `/dashboard/api/schedule/alias/${encodeURIComponent(alias)}/target/gpt-5.4-mini`,
    method: 'DELETE',
  });
  assert(delTargetResp.status === 200,
    `delete target: expected 200, got ${delTargetResp.status}: ${JSON.stringify(delTargetResp.body)}`);

  // Cleanup alias
  await sendRequest({
    endpoint: `/dashboard/api/schedule/alias/${encodeURIComponent(alias)}`,
    method: 'DELETE',
  });
}

async function testLiveRouteRemoveAlias() {
  const alias = `__test_remove_${Date.now()}`;
  // Create
  await sendRequest({
    endpoint: '/dashboard/api/schedule/alias',
    method: 'POST',
    body: { alias },
  });

  // Remove
  const delResp = await sendRequest({
    endpoint: `/dashboard/api/schedule/alias/${encodeURIComponent(alias)}`,
    method: 'DELETE',
  });
  assert(delResp.status === 200,
    `delete alias: expected 200, got ${delResp.status}: ${JSON.stringify(delResp.body)}`);

  // Verify gone
  const getResp = await sendRequest({
    endpoint: '/dashboard/api/config',
    method: 'GET',
  });
  assert(!getResp.body?.schedule?.[alias],
    `expected ${alias} to be absent from schedule, got keys: ${Object.keys(getResp.body?.schedule || {}).join(',')}`);
}

module.exports = {
  testAddScheduleAliasCreatesEntry,
  testAddScheduleAliasDuplicateThrows,
  testAddScheduleAliasEmptyThrows,
  testRemoveScheduleAliasDeletes,
  testRemoveScheduleAliasMissingThrows,
  testUpsertWindowAcceptsValidWindow,
  testUpsertWindowFromEqualsToThrows,
  testUpsertWindowFromGreaterThanToThrows,
  testUpsertWindowFromOver24Throws,
  testUpsertWindowToOver24Throws,
  testUpsertWindowEmptyArrayMarksFallback,
  testUpsertWindowRejectsUnknownTargetWhenAllowListProvided,
  testRemoveScheduleTargetDeletes,
  testRemoveScheduleTargetMissingAliasThrows,
  testRemoveScheduleTargetMissingTargetThrows,
  testResolveScheduleReturnsUndefinedForUnknownAlias,
  testResolveSchedulePicksWindowMatchingNow,
  testResolveScheduleFallsBackWhenNoWindowMatches,
  testResolveScheduleReturnsUndefinedWhenNoMatchAndNoFallback,
  testResolveScheduleHonoursDaysArray,
  testApplyDashboardConfigUpdatePreservesSchedule,
  testApplyDashboardConfigUpdateReplacesScheduleWhenProvided,
  testApplyDashboardConfigUpdateRejectsProtoAlias,
  testLiveRouteAddAliasAndVerify,
  testLiveRouteUpsertTargetAndVerify,
  testLiveRouteRemoveAlias,
};

if (require.main === module) {
  const liveOnly = process.env.PROXY_RUN_LIVE === '1';

  const unitTests = [
    { name: 'TC2601 - addScheduleAlias creates entry', fn: testAddScheduleAliasCreatesEntry },
    { name: 'TC2602 - addScheduleAlias duplicate throws', fn: testAddScheduleAliasDuplicateThrows },
    { name: 'TC2603 - addScheduleAlias empty throws', fn: testAddScheduleAliasEmptyThrows },
    { name: 'TC2604 - removeScheduleAlias deletes entry', fn: testRemoveScheduleAliasDeletes },
    { name: 'TC2605 - removeScheduleAlias missing throws', fn: testRemoveScheduleAliasMissingThrows },
    { name: 'TC2606 - upsertScheduleWindow accepts valid window', fn: testUpsertWindowAcceptsValidWindow },
    { name: 'TC2607 - upsertScheduleWindow from===to throws', fn: testUpsertWindowFromEqualsToThrows },
    { name: 'TC2608 - upsertScheduleWindow from>to throws', fn: testUpsertWindowFromGreaterThanToThrows },
    { name: 'TC2609 - upsertScheduleWindow from>24 throws', fn: testUpsertWindowFromOver24Throws },
    { name: 'TC2610 - upsertScheduleWindow to>24 throws', fn: testUpsertWindowToOver24Throws },
    { name: 'TC2611 - upsertScheduleWindow empty array = fallback', fn: testUpsertWindowEmptyArrayMarksFallback },
    { name: 'TC2612 - upsertScheduleWindow rejects unknown target with allowlist', fn: testUpsertWindowRejectsUnknownTargetWhenAllowListProvided },
    { name: 'TC2613 - removeScheduleTarget deletes target', fn: testRemoveScheduleTargetDeletes },
    { name: 'TC2614 - removeScheduleTarget missing alias throws', fn: testRemoveScheduleTargetMissingAliasThrows },
    { name: 'TC2615 - removeScheduleTarget missing target throws', fn: testRemoveScheduleTargetMissingTargetThrows },
    { name: 'TC2616 - resolveScheduleTarget unknown alias → undefined', fn: testResolveScheduleReturnsUndefinedForUnknownAlias },
    { name: 'TC2617 - resolveScheduleTarget picks matching window', fn: testResolveSchedulePicksWindowMatchingNow },
    { name: 'TC2618 - resolveScheduleTarget falls back when no window matches', fn: testResolveScheduleFallsBackWhenNoWindowMatches },
    { name: 'TC2619 - resolveScheduleTarget undefined when no match + no fallback', fn: testResolveScheduleReturnsUndefinedWhenNoMatchAndNoFallback },
    { name: 'TC2620 - resolveScheduleTarget honours days array', fn: testResolveScheduleHonoursDaysArray },
    { name: 'TC2621 - applyDashboardConfigUpdate preserves schedule (bug regression)', fn: testApplyDashboardConfigUpdatePreservesSchedule },
    { name: 'TC2622 - applyDashboardConfigUpdate replaces schedule when payload provides it', fn: testApplyDashboardConfigUpdateReplacesScheduleWhenProvided },
    { name: 'TC2623 - applyDashboardConfigUpdate rejects __proto__ schedule alias', fn: testApplyDashboardConfigUpdateRejectsProtoAlias },
  ];

  const liveTests = liveOnly ? [
    { name: 'TC2628 (live) - POST /schedule/alias round-trip', fn: testLiveRouteAddAliasAndVerify },
    { name: 'TC2629 (live) - POST .../target round-trip', fn: testLiveRouteUpsertTargetAndVerify },
    { name: 'TC2630 (live) - DELETE /schedule/alias/:alias round-trip', fn: testLiveRouteRemoveAlias },
  ] : [];

  loadModule().then(() =>
    runTestSuite('Schedule CRUD Routing & Helper Tests', [...unitTests, ...liveTests])
  );
}