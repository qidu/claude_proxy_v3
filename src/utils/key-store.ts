/**
 * System keychain API-key store (`[general] store_key_in_system = true`).
 *
 * When enabled, plaintext `api_key` values in the proxy config are extracted
 * on config load, stored into the OS keychain (macOS Keychain / Windows
 * Credential Vault / Linux Secret Service via `@github/keytar`), and the
 * config file on disk is rewritten to the literal sentinel
 * `STORE_KEY_IN_SYSTEM`. On every later load, sentinel values are resolved
 * back from the keychain into the in-memory config, so the synchronous
 * routing code keeps working with real keys.
 *
 * Keychain account format: `<target_model_id>/<base_url>` under the
 * `model_proxy_v3` service.
 *
 * This is a local/dev-host feature: the keytar native addon requires an OS
 * keychain (no Docker/distroless, no Cloudflare Workers). When the feature is
 * enabled but the keychain is unavailable, the error is fatal — no silent
 * fallback.
 *
 * Scope: ONLY configured api_key values of `[models.*]` targets (and
 * `[default_upstream].default_api_key`) in the local `proxy_config.toml` file.
 * Not applied to Consul/Apollo config-center sources; composite/schedule
 * aliases carry no api_key of their own; and caller/user keys from request
 * headers are never stored — an empty api_key (auth passthrough) is skipped.
 */

import { copyFileSync, readFileSync, writeFileSync } from 'fs';
import type { ModelCategoryConfig, ProxyConfig } from './config-loader.js';

export const KEY_STORE_SERVICE = 'model_proxy_v3';
export const STORE_KEY_IN_SYSTEM = 'STORE_KEY_IN_SYSTEM';

/** Minimal keytar surface used here (subset of @github/keytar's API). */
export interface KeytarLike {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  /** Optional — enables the best-effort base_url fallback on exact-miss. */
  findCredentials?(service: string): Promise<Array<{ account: string; password: string }>>;
}

/** Fatal error: loadProxyConfig must rethrow instead of degrading to `{}`. */
export class KeyStoreError extends Error {
  fatal = true;
}

const isNodeEnvironment = typeof process !== 'undefined' && process.versions?.node;

export function keychainAccount(targetModelId: string, baseUrl: string): string {
  return `${targetModelId}/${baseUrl}`;
}

/** A single api_key slot in the config plus the keychain account it maps to. */
interface KeySlot {
  /** Human-readable location for error/log messages, e.g. `models.claude.gpt-5`. */
  location: string;
  account: string;
  get(): string | undefined;
  set(value: string): void;
}

/**
 * Enumerate every api_key slot relevant for keychain storage:
 * - category-level `api_key` → account `<category>/<category base_url>`
 * - entry-level `api_key` (index 2) → account `<target>/<entry or category base_url>`
 * - `default_upstream.default_api_key` → account `default_upstream/<default_base_url>`
 */
function collectKeySlots(config: ProxyConfig): KeySlot[] {
  const slots: KeySlot[] = [];

  for (const [categoryName, categoryConfig] of Object.entries(config.models ?? {})) {
    if (Array.isArray(categoryConfig)) continue;
    const category = categoryConfig as ModelCategoryConfig;
    const categoryBaseUrl = category.base_url ?? '';

    if (category.api_key !== undefined) {
      const holder = category as { api_key?: string };
      slots.push({
        location: `models.${categoryName}.api_key`,
        account: keychainAccount(categoryName, categoryBaseUrl),
        get: () => holder.api_key,
        set: (v) => { holder.api_key = v; },
      });
    }

    for (const [modelName, entry] of Object.entries(category)) {
      if (!Array.isArray(entry) || entry.length < 3) continue;
      const [target, entryBaseUrl, entryApiKey] = entry as string[];
      if (entryApiKey === undefined || target === undefined) continue;
      const account = keychainAccount(target, entryBaseUrl || categoryBaseUrl);
      slots.push({
        location: `models.${categoryName}.${modelName}[2]`,
        account,
        get: () => (entry as string[])[2],
        set: (v) => { (entry as string[])[2] = v; },
      });
    }
  }

  const defaultUpstream = config.default_upstream;
  if (defaultUpstream?.default_api_key !== undefined) {
    const holder = defaultUpstream as { default_api_key?: string };
    slots.push({
      location: 'default_upstream.default_api_key',
      account: keychainAccount('default_upstream', defaultUpstream.default_base_url ?? ''),
      get: () => holder.default_api_key,
      set: (v) => { holder.default_api_key = v; },
    });
  }

  return slots;
}

/**
 * Locations of every api_key slot currently holding the `STORE_KEY_IN_SYSTEM`
 * sentinel. Used by the loader to refuse Consul/Apollo configs carrying
 * sentinels (they cannot be resolved without the local file + keychain).
 */
export function findSentinelApiKeys(config: ProxyConfig): string[] {
  return collectKeySlots(config).filter((slot) => slot.get() === STORE_KEY_IN_SYSTEM).map((slot) => slot.location);
}

async function loadKeytar(opts: { keytarImpl?: KeytarLike }): Promise<KeytarLike> {
  if (opts.keytarImpl) return opts.keytarImpl;
  try {
    const mod = await import('@github/keytar');
    return ((mod as { default?: KeytarLike }).default ?? mod) as KeytarLike;
  } catch (err) {
    throw new KeyStoreError(
      `store_key_in_system = true but the system keychain is unavailable: ${(err as Error).message}` +
      ` (requires the @github/keytar native addon and an OS keychain — not available in Docker/Workers)`,
    );
  }
}

export interface ApplySystemKeyStoreOptions {
  /** Path of the on-disk config file; enables the migration rewrite. */
  configPath?: string;
  /** Injectable keytar implementation (tests). */
  keytarImpl?: KeytarLike;
}

/**
 * Apply the system key store to a freshly parsed config (mutates in place):
 *
 * 1. Store pass — every plaintext api_key is written to the keychain under
 *    `<target_model_id>/<base_url>`.
 * 2. File rewrite — when `configPath` is given and at least one key was
 *    stored, the file is backed up to `<configPath>.bak` and each quoted
 *    plaintext key literal is replaced with `"STORE_KEY_IN_SYSTEM"`
 *    (targeted text replacement; comments and layout are preserved).
 * 3. Resolve pass — every `STORE_KEY_IN_SYSTEM` sentinel is replaced
 *    in-memory with the key fetched from the keychain. A missing keychain
 *    entry is fatal.
 *
 * No-op when `store_key_in_system` is not true or outside Node.js.
 */
export async function applySystemKeyStore(
  config: ProxyConfig,
  opts: ApplySystemKeyStoreOptions = {},
): Promise<ProxyConfig> {
  if (!isNodeEnvironment || config.general?.store_key_in_system !== true) {
    return config;
  }

  const keytar = await loadKeytar(opts);
  const slots = collectKeySlots(config);

  // 1. Store pass: plaintext keys → keychain.
  const storedRawKeys: string[] = [];
  for (const slot of slots) {
    const raw = slot.get();
    if (!raw || raw === STORE_KEY_IN_SYSTEM) continue;
    await keytar.setPassword(KEY_STORE_SERVICE, slot.account, raw);
    storedRawKeys.push(raw);
    console.info(`[key-store] stored ${slot.location} → keychain account "${slot.account}"`);
  }

  // 2. File rewrite: quoted plaintext literals → sentinel.
  if (opts.configPath && storedRawKeys.length > 0) {
    const content = readFileSync(opts.configPath, 'utf-8');
    copyFileSync(opts.configPath, `${opts.configPath}.bak`);
    let rewritten = content;
    for (const raw of new Set(storedRawKeys)) {
      rewritten = rewritten.split(JSON.stringify(raw)).join(JSON.stringify(STORE_KEY_IN_SYSTEM));
    }
    writeFileSync(opts.configPath, rewritten);
    console.info(`[key-store] replaced ${storedRawKeys.length} api_key(s) with "${STORE_KEY_IN_SYSTEM}" in ${opts.configPath} (backup: ${opts.configPath}.bak)`);
  }

  // 3. Resolve pass: sentinel → real key from keychain. Exact account match
  // first; on miss, best-effort fallback over every account under the
  // service, scored by base_url similarity (prefix relation) with target-name
  // similarity as tiebreaker — e.g. wanted "glm-5.3-anth/https://…/api/anthropic"
  // can fall back to "glm-5.3/https://…/api". Every fallback use is warned.
  let resolvedCount = 0;
  for (const slot of slots) {
    if (slot.get() !== STORE_KEY_IN_SYSTEM) continue;
    const exact = await keytar.getPassword(KEY_STORE_SERVICE, slot.account);
    const resolved = exact !== null
      ? { key: exact, account: slot.account }
      : await findBestEffortKey(keytar, slot.account);
    if (!resolved) {
      throw new KeyStoreError(
        `${slot.location} is "${STORE_KEY_IN_SYSTEM}" but no key was found in the system keychain` +
        ` (service "${KEY_STORE_SERVICE}", account "${slot.account}" — exact and best-effort base_url match)`,
      );
    }
    if (resolved.account !== slot.account) {
      console.warn(`[key-store] exact keychain account "${slot.account}" not found — using best-effort match "${resolved.account}"`);
    }
    slot.set(resolved.key);
    resolvedCount++;
  }

  // Internal marker (underscore-prefixed, like _validationErrors) consumed by
  // toDashboardConfigPayload → TUI 🔒 indicator. True when the feature ran and
  // the config had at least one api_key (after the passes above, every
  // plaintext key has been stored and rewritten to a sentinel in the file).
  if (storedRawKeys.length > 0 || resolvedCount > 0) {
    (config as ProxyConfig & { _api_keys_in_system_store?: boolean })._api_keys_in_system_store = true;
  }

  return config;
}

/**
 * List every keychain account (`<target_model_id>/<base_url>`) stored under
 * the proxy's service — used by the TUI 'K' overlay. Throws with a clear
 * message when the system keychain / native addon is unavailable.
 */
export async function listSystemKeychainAccounts(): Promise<string[]> {
  try {
    const keytar = await loadKeytar({});
    if (!keytar.findCredentials) {
      throw new Error('keytar build does not support findCredentials');
    }
    const credentials = await keytar.findCredentials(KEY_STORE_SERVICE);
    return credentials.map((c) => c.account).sort((a, b) => a.localeCompare(b));
  } catch (err) {
    throw new Error(`Cannot list system keychain keys: ${(err as Error).message}`);
  }
}

/** Split a keychain account into `<target_model_id>` / `<base_url>` parts. */
function splitAccount(account: string): { target: string; baseUrl: string } {
  const idx = account.indexOf('/');
  if (idx === -1) return { target: account, baseUrl: '' };
  return { target: account.slice(0, idx), baseUrl: account.slice(idx + 1) };
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Compatibility score between a wanted account and a candidate account.
 * Returns -1 when the base_urls are unrelated (no fallback allowed);
 * otherwise base_url match dominates and target-name similarity tiebreaks.
 */
function scoreAccountMatch(wanted: string, candidate: string): number {
  const w = splitAccount(wanted);
  const c = splitAccount(candidate);
  const bw = normalizeBaseUrl(w.baseUrl);
  const bc = normalizeBaseUrl(c.baseUrl);

  let baseScore: number;
  if (bw === bc) {
    baseScore = 1_000_000;
  } else if (bw.startsWith(bc) || bc.startsWith(bw)) {
    // Prefix relation (e.g. "https://x/api" vs "https://x/api/anthropic");
    // longer shared base ranks higher.
    baseScore = 100_000 + Math.min(bw.length, bc.length);
  } else {
    return -1;
  }

  let targetScore = 0;
  if (w.target === c.target) {
    targetScore = 10_000;
  } else if (w.target.startsWith(c.target) || c.target.startsWith(w.target)) {
    targetScore = 5_000 + Math.min(w.target.length, c.target.length);
  }

  return baseScore + targetScore;
}

/** Best-effort key lookup: enumerate all accounts under the service. */
async function findBestEffortKey(keytar: KeytarLike, wantedAccount: string): Promise<{ key: string; account: string } | null> {
  if (!keytar.findCredentials) return null;
  let credentials: Array<{ account: string; password: string }>;
  try {
    credentials = await keytar.findCredentials(KEY_STORE_SERVICE);
  } catch {
    return null;
  }
  let best: { key: string; account: string; score: number } | null = null;
  for (const { account, password } of credentials) {
    const score = scoreAccountMatch(wantedAccount, account);
    if (score < 0) continue;
    if (!best || score > best.score || (score === best.score && account < best.account)) {
      best = { key: password, account, score };
    }
  }
  return best ? { key: best.key, account: best.account } : null;
}
