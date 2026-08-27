/**
 * Unit tests for key-store.ts (system keychain api-key store)
 *
 * Covers: store pass (keychain accounts per target/category/default_upstream),
 * file rewrite (sentinel replacement + .bak backup + comment preservation),
 * resolve pass (sentinel → key, missing entry fatal), no-op when flag off.
 *
 * Run with: npx tsx --test tests/unit/key-store.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  KEY_STORE_SERVICE,
  STORE_KEY_IN_SYSTEM,
  applySystemKeyStore,
  findSentinelApiKeys,
  keychainAccount,
  type KeytarLike,
} from '../../src/utils/key-store.js';
import { parseSimpleToml, serializeProxyConfigToml, toDashboardConfigPayload } from '../../src/utils/config-loader.js';

/** In-memory keytar mock recording every call. */
function makeMockKeytar(store = new Map<string, string>()): KeytarLike & {
  calls: Array<{ op: string; service: string; account: string; password?: string }>;
} {
  const calls: Array<{ op: string; service: string; account: string; password?: string }> = [];
  return {
    calls,
    async getPassword(service, account) {
      calls.push({ op: 'get', service, account });
      return store.get(`${service}/${account}`) ?? null;
    },
    async setPassword(service, account, password) {
      calls.push({ op: 'set', service, account, password });
      store.set(`${service}/${account}`, password);
    },
    async findCredentials(service) {
      calls.push({ op: 'find', service, account: '*' });
      return [...store.entries()]
        .filter(([k]) => k.startsWith(`${service}/`))
        .map(([k, password]) => ({ account: k.slice(service.length + 1), password }));
    },
  };
}

const SAMPLE_TOML = `# top comment
[general]
store_key_in_system = true

[default_upstream]
default_base_url = "https://api.default.dev"
default_api_key = "sk-default-000"

[models.claude]
upstream_mode = "anthropic-messages"
base_url = "https://api.claude.dev"
api_key = "sk-cat-111"

[models.gpt]
base_url = "https://api.gpt.dev"
"claude-opus" = ["claude-opus-4", "https://override.gpt.dev", "sk-entry-222"]
`;

function writeTempConfig(content: string): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'key-store-test-'));
  const path = join(dir, 'proxy_config.toml');
  writeFileSync(path, content);
  return { path, dir };
}

describe('findSentinelApiKeys', () => {
  it('returns locations of sentinel slots only', () => {
    const toml = SAMPLE_TOML.replace('sk-cat-111', STORE_KEY_IN_SYSTEM); // category key → sentinel
    const config = parseSimpleToml(toml);
    assert.deepEqual(findSentinelApiKeys(config), ['models.claude.api_key']);
  });

  it('returns empty when all keys are plaintext', () => {
    assert.deepEqual(findSentinelApiKeys(parseSimpleToml(SAMPLE_TOML)), []);
  });
});

// ---------------------------------------------------------------------------

describe('keychainAccount', () => {
  it('formats <target_model_id>/<base_url>', () => {
    assert.equal(keychainAccount('claude-opus-4', 'https://api.gpt.dev'), 'claude-opus-4/https://api.gpt.dev');
  });
});

describe('applySystemKeyStore', () => {
  it('is a no-op when store_key_in_system is not true', async () => {
    const keytar = makeMockKeytar();
    const config = parseSimpleToml(SAMPLE_TOML.replace('store_key_in_system = true', ''));
    const result = await applySystemKeyStore(config, { keytarImpl: keytar });
    assert.equal(keytar.calls.length, 0);
    assert.equal(result.models?.claude && !Array.isArray(result.models.claude) ? result.models.claude.api_key : '', 'sk-cat-111');
  });

  it('stores every plaintext key under <target>/<base_url> accounts', async () => {
    const keytar = makeMockKeytar();
    const { path } = writeTempConfig(SAMPLE_TOML);
    const config = parseSimpleToml(SAMPLE_TOML);

    await applySystemKeyStore(config, { configPath: path, keytarImpl: keytar });

    const setCalls = keytar.calls.filter((c) => c.op === 'set');
    assert.deepEqual(
      setCalls.map((c) => `${c.account}=${c.password}`).sort(),
      [
        'claude-opus-4/https://override.gpt.dev=sk-entry-222',
        'claude/https://api.claude.dev=sk-cat-111',
        'default_upstream/https://api.default.dev=sk-default-000',
      ],
    );
    for (const c of setCalls) assert.equal(c.service, KEY_STORE_SERVICE);
  });

  it('rewrites the config file to sentinels, preserving comments, and writes .bak', async () => {
    const keytar = makeMockKeytar();
    const { path } = writeTempConfig(SAMPLE_TOML);
    const config = parseSimpleToml(SAMPLE_TOML);

    await applySystemKeyStore(config, { configPath: path, keytarImpl: keytar });

    const rewritten = readFileSync(path, 'utf-8');
    assert.ok(rewritten.startsWith('# top comment'), 'comments preserved');
    assert.ok(!rewritten.includes('sk-cat-111'));
    assert.ok(!rewritten.includes('sk-entry-222'));
    assert.ok(!rewritten.includes('sk-default-000'));
    assert.ok(rewritten.includes(`api_key = "${STORE_KEY_IN_SYSTEM}"`));
    assert.ok(rewritten.includes(`"${STORE_KEY_IN_SYSTEM}"`)); // entry inline form
    assert.ok(existsSync(`${path}.bak`));
    assert.equal(readFileSync(`${path}.bak`, 'utf-8'), SAMPLE_TOML);
  });

  it('does not rewrite the file when no plaintext keys exist (already sentinels)', async () => {
    const sentinelToml = SAMPLE_TOML
      .replace('sk-default-000', STORE_KEY_IN_SYSTEM)
      .replace('sk-cat-111', STORE_KEY_IN_SYSTEM)
      .replace('sk-entry-222', STORE_KEY_IN_SYSTEM);
    const keytar = makeMockKeytar(new Map([
      [`${KEY_STORE_SERVICE}/claude/https://api.claude.dev`, 'sk-cat-111'],
      [`${KEY_STORE_SERVICE}/claude-opus-4/https://override.gpt.dev`, 'sk-entry-222'],
      [`${KEY_STORE_SERVICE}/default_upstream/https://api.default.dev`, 'sk-default-000'],
    ]));
    const { path } = writeTempConfig(sentinelToml);
    const config = parseSimpleToml(sentinelToml);

    await applySystemKeyStore(config, { configPath: path, keytarImpl: keytar });

    assert.equal(readFileSync(path, 'utf-8'), sentinelToml, 'file untouched');
    assert.ok(!existsSync(`${path}.bak`));
    assert.equal(keytar.calls.filter((c) => c.op === 'set').length, 0);
  });

  it('resolves sentinel values in-memory from the keychain', async () => {
    const sentinelToml = SAMPLE_TOML
      .replace('sk-default-000', STORE_KEY_IN_SYSTEM)
      .replace('sk-cat-111', STORE_KEY_IN_SYSTEM)
      .replace('sk-entry-222', STORE_KEY_IN_SYSTEM);
    const keytar = makeMockKeytar(new Map([
      [`${KEY_STORE_SERVICE}/claude/https://api.claude.dev`, 'sk-cat-111'],
      [`${KEY_STORE_SERVICE}/claude-opus-4/https://override.gpt.dev`, 'sk-entry-222'],
      [`${KEY_STORE_SERVICE}/default_upstream/https://api.default.dev`, 'sk-default-000'],
    ]));
    const config = parseSimpleToml(sentinelToml);

    await applySystemKeyStore(config, { keytarImpl: keytar });

    const claude = config.models!.claude as { api_key?: string };
    assert.equal(claude.api_key, 'sk-cat-111');
    const gpt = config.models!.gpt as { 'claude-opus'?: string[] };
    assert.equal(gpt['claude-opus']![2], 'sk-entry-222');
    assert.equal(config.default_upstream!.default_api_key, 'sk-default-000');
  });

  it('falls back to a best-effort base_url match when the exact account is missing', async () => {
    // Config wants glm-5.3-anth on .../api/anthropic; keychain only has the
    // shorter glm-5.3 account on .../api — same key provider, similar base_url.
    const toml = `[general]
store_key_in_system = true

[models.glm]
base_url = "https://open.bigmodel.cn/api/anthropic"
"glm-5.3-anth" = ["glm-5.3-anth", "", "${STORE_KEY_IN_SYSTEM}"]
`;
    const keytar = makeMockKeytar(new Map([
      [`${KEY_STORE_SERVICE}/glm-5.3/https://open.bigmodel.cn/api`, 'sk-glm-KEY'],
    ]));
    const config = parseSimpleToml(toml);

    await applySystemKeyStore(config, { keytarImpl: keytar });

    const glm = config.models!.glm as { 'glm-5.3-anth'?: string[] };
    assert.equal(glm['glm-5.3-anth']![2], 'sk-glm-KEY');
  });

  it('prefers exact base_url and target when multiple best-effort candidates exist', async () => {
    const toml = `[general]
store_key_in_system = true

[models.glm]
base_url = "https://open.bigmodel.cn/api/anthropic"
"glm-5.3-anth" = ["glm-5.3-anth", "", "${STORE_KEY_IN_SYSTEM}"]
`;
    const keytar = makeMockKeytar(new Map([
      // Same base_url, unrelated target — must beat the shorter-base candidate
      // with the similar target below (base_url dominates the score).
      [`${KEY_STORE_SERVICE}/other-model/https://open.bigmodel.cn/api/anthropic`, 'sk-exact-base-KEY'],
      [`${KEY_STORE_SERVICE}/glm-5.3/https://open.bigmodel.cn/api`, 'sk-short-base-KEY'],
    ]));
    const config = parseSimpleToml(toml);

    await applySystemKeyStore(config, { keytarImpl: keytar });

    const glm = config.models!.glm as { 'glm-5.3-anth'?: string[] };
    assert.equal(glm['glm-5.3-anth']![2], 'sk-exact-base-KEY');
  });

  it('still fails loud when no similar base_url exists in the keychain', async () => {
    const toml = `[general]
store_key_in_system = true

[models.glm]
base_url = "https://open.bigmodel.cn/api/anthropic"
"glm-5.3-anth" = ["glm-5.3-anth", "", "${STORE_KEY_IN_SYSTEM}"]
`;
    const keytar = makeMockKeytar(new Map([
      [`${KEY_STORE_SERVICE}/glm-5.3/https://api.unrelated.dev`, 'sk-wrong-KEY'],
    ]));
    const config = parseSimpleToml(toml);

    await assert.rejects(
      applySystemKeyStore(config, { keytarImpl: keytar }),
      (err: Error & { fatal?: boolean }) => {
        assert.equal(err.fatal, true);
        assert.match(err.message, /glm-5\.3-anth\/https:\/\/open\.bigmodel\.cn\/api\/anthropic/);
        return true;
      },
    );
  });

  it('marks the config for the TUI 🔒 indicator once keys are in the keychain', async () => {
    const keytar = makeMockKeytar(new Map([
      [`${KEY_STORE_SERVICE}/claude/https://api.claude.dev`, 'sk-cat-111'],
      [`${KEY_STORE_SERVICE}/claude-opus-4/https://override.gpt.dev`, 'sk-entry-222'],
      [`${KEY_STORE_SERVICE}/default_upstream/https://api.default.dev`, 'sk-default-000'],
    ]));
    const sentinelToml = SAMPLE_TOML
      .replace('sk-cat-111', STORE_KEY_IN_SYSTEM)
      .replace('sk-entry-222', STORE_KEY_IN_SYSTEM)
      .replace('sk-default-000', STORE_KEY_IN_SYSTEM);
    const config = parseSimpleToml(sentinelToml);
    await applySystemKeyStore(config, { keytarImpl: keytar });
    assert.equal(toDashboardConfigPayload(config).api_keys_in_system_store, true);

    // Flag off → no marker.
    const plainConfig = parseSimpleToml(SAMPLE_TOML.replace('store_key_in_system = true', ''));
    const untouched = await applySystemKeyStore(plainConfig, { keytarImpl: makeMockKeytar() });
    assert.equal(toDashboardConfigPayload(untouched).api_keys_in_system_store, false);
  });

  it('fails loud when a sentinel has no keychain entry', async () => {
    const sentinelToml = SAMPLE_TOML.replace('sk-cat-111', STORE_KEY_IN_SYSTEM);
    const keytar = makeMockKeytar(); // empty keychain
    const config = parseSimpleToml(sentinelToml);

    await assert.rejects(
      applySystemKeyStore(config, { keytarImpl: keytar }),
      (err: Error & { fatal?: boolean }) => {
        assert.equal(err.fatal, true);
        assert.match(err.message, /models\.claude\.api_key/);
        assert.match(err.message, /claude\/https:\/\/api\.claude\.dev/);
        return true;
      },
    );
  });

  it('stores plaintext keys and resolves them in the same load (fresh migration)', async () => {
    // First load migrates: keys stored, in-memory values stay as real keys.
    const keytar = makeMockKeytar();
    const { path } = writeTempConfig(SAMPLE_TOML);
    const config = parseSimpleToml(SAMPLE_TOML);
    await applySystemKeyStore(config, { configPath: path, keytarImpl: keytar });

    const claude = config.models!.claude as { api_key?: string };
    assert.equal(claude.api_key, 'sk-cat-111', 'in-memory key remains usable after migration');

    // Second load (file now has sentinels) resolves from the populated store.
    const reloaded = parseSimpleToml(readFileSync(path, 'utf-8'));
    await applySystemKeyStore(reloaded, { configPath: path, keytarImpl: keytar });
    assert.equal((reloaded.models!.claude as { api_key?: string }).api_key, 'sk-cat-111');
  });
});

describe('config round-trip with store_key_in_system', () => {
  it('parses the flag as boolean and re-serializes it', () => {
    const config = parseSimpleToml(SAMPLE_TOML);
    assert.equal(config.general?.store_key_in_system, true);
    const serialized = serializeProxyConfigToml(config);
    assert.ok(serialized.includes('store_key_in_system = true'), serialized);
    const reparsed = parseSimpleToml(serialized);
    assert.equal(reparsed.general?.store_key_in_system, true);
  });
});
