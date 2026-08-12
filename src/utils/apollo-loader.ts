/**
 * Apollo (apolloconfig/apollo) config loader.
 *
 * Approach: one Apollo namespace holds the *entire* proxy_config.toml content
 * as a plain-text value. We fetch that namespace via the standard Apollo
 * Config Service read API, take its `configurations` payload as a TOML string,
 * and hand it back to the caller — which feeds it through the existing
 * parseSimpleToml() + validation pipeline in config-loader.ts. No Apollo SDK,
 * no live-reload long-poll; reload happens on-demand via /config-reload, the
 * same model the Consul backend uses.
 *
 * The connection is described by a file pointed at by PROXY_CONFIG_APOLLO,
 * with the form:
 *
 *   apollo:
 *   app_id = "test"
 *   cluster = "default"
 *   namespace = "model_proxy_v3_test"
 *   meta = "https://test-apollo-config.example.com"
 *   access_key_secret = "<plaintext HMAC-SHA1 key>"
 *
 * parseSimpleToml() cannot parse this file (it only knows the proxy's own
 * section names), so this module has a small dedicated parser.
 *
 * Auth follows the Apollo client signing convention (matching ctrip-apollo-
 * client): the `access_key_secret` is a PLAINTEXT HMAC-SHA1 key. It is never
 * sent directly. Each request is signed —
 *   Authorization: Apollo <app_id>:<base64(HMAC-SHA1(secret, "<ts>\n<path?query>"))>
 *   Timestamp: <ms-epoch>
 * — where <path?query> is the URL path plus any query string. No `enc:` or
 * AES handling is performed; if a deployment stores the key encrypted at rest,
 * it must be decrypted before being written to this file.
 *
 * Unlike the Consul loader, the Apollo `meta` host is NOT restricted to
 * private/LAN addresses — Apollo meta servers are typically public hostnames.
 * This is a deliberate deviation; see README.
 */

import { createHmac } from 'crypto';
import { networkInterfaces } from 'os';

/**
 * Detect the local LAN IPv4 address, used as the Apollo `ip` query parameter.
 * Mirrors apollo-client-python's init_ip(): the address a UDP socket bound
 * toward an arbitrary public target would pick as its source. This is sent on
 * every request because Apollo uses it for gray-release IP-rule matching — a
 * namespace published only to certain IPs returns 404 for everyone else, even
 * with valid auth. Returns '' if no IPv4 is routable (e.g. Workers build).
 */
function detectLocalIp(): string {
  try {
    const ifaces = networkInterfaces();
    for (const list of Object.values(ifaces)) {
      if (!list) continue;
      for (const iface of list) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
  } catch {
    // networkInterfaces() can throw in some sandboxes; fall through.
  }
  return '';
}

export interface ApolloConfig {
  app_id: string;
  cluster: string;
  namespace: string;
  meta: string;
  access_key_secret: string;
}

const REQUIRED_APOLLO_FIELDS: ReadonlyArray<keyof ApolloConfig> = [
  'app_id',
  'cluster',
  'namespace',
  'meta',
  'access_key_secret',
];

/**
 * Parse the PROXY_CONFIG_APOLLO file content into an ApolloConfig.
 * Throws a single error listing every missing required field, so operators
 * see the full list at once rather than fixing one field per restart.
 */
export function parseApolloFile(content: string): ApolloConfig {
  const values: Partial<ApolloConfig> = {};

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    // `apollo:` header line carries no data; ignore it (and any other bare
    // section-like header) rather than treating it as a missing `=`.
    if (line.endsWith(':')) {
      continue;
    }

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(["'])(.*?)\2$/);
    if (!match) {
      continue;
    }
    const [, key, , value] = match;
    if ((REQUIRED_APOLLO_FIELDS as ReadonlyArray<string>).includes(key)) {
      (values as Record<string, string>)[key] = value;
    }
  }

  const missing = REQUIRED_APOLLO_FIELDS.filter((f) => !values[f]);
  if (missing.length > 0) {
    throw new Error(
      `PROXY_CONFIG_APOLLO file is missing required field(s): ${missing.join(', ')}`
    );
  }

  return values as ApolloConfig;
}

/**
 * Build the Apollo auth headers for a given request URL.
 *
 * HMAC-SHA1 over `<timestamp>\n<path+query>` keyed by the secret, base64-encoded,
 * and sent as `Authorization: Apollo <appId>:<sig>` alongside the `Timestamp`
 * header.
 *
 * The secret is never sent. Returns {} if the secret is empty (unsigned request).
 */
function apolloAuthHeaders(url: string, appId: string, secret: string): Record<string, string> {
  if (!secret) {
    return {};
  }
  const timestamp = Date.now();
  let pathWithQuery: string;
  try {
    const u = new URL(url);
    pathWithQuery = u.pathname + (u.search || '');
  } catch {
    // Should never happen — fetchApolloConfig builds the URL itself — but fail
    // loudly rather than signing garbage.
    throw new Error(`apolloAuthHeaders: cannot parse URL: ${url}`);
  }
  const sig = createHmac('sha1', secret)
    .update(`${timestamp}\n${pathWithQuery}`)
    .digest()
    .toString('base64');
  return {
    Authorization: `Apollo ${appId}:${sig}`,
    Timestamp: String(timestamp),
  };
}

interface ApolloConfigServiceResponse {
  appId?: string;
  cluster?: string;
  namespace?: string;
  configurations?: Record<string, string> | null;
  releaseVersion?: string;
}

/**
 * Fetch the named Apollo namespace and return its `configurations` payload as
 * a single string ready for parseSimpleToml(). If the namespace carries
 * multiple keys, their values are joined with `\n` in iteration order.
 *
 * @throws Error if the request fails, the response is not ok, or the body
 *         does not contain a `configurations` object.
 */
export async function fetchApolloConfig(ap: ApolloConfig): Promise<string> {
  // Append ?ip=<client-ip> so the server can apply gray-release IP rules and
  // so the signature covers the same query string the server sees (matches
  // apollo-client-python's get_json_from_net). releaseKey is omitted (we have
  // no prior — server returns 200 with a fresh body).
  const clientIp = detectLocalIp();
  const ipQuery = clientIp ? `?ip=${encodeURIComponent(clientIp)}` : '';
  const url = `${ap.meta.replace(/\/+$/, '')}/configs/${encodeURIComponent(ap.app_id)}/${encodeURIComponent(ap.cluster)}/${encodeURIComponent(ap.namespace)}${ipQuery}`;

  const headers = apolloAuthHeaders(url, ap.app_id, ap.access_key_secret);
  const response = await fetch(url, { headers });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch config from Apollo at ${url}: ${response.status} ${response.statusText}`
    );
  }

  const body = (await response.json()) as ApolloConfigServiceResponse;
  if (!body || typeof body !== 'object' || !body.configurations || typeof body.configurations !== 'object') {
    throw new Error(`Apollo response from ${url} did not contain a 'configurations' object`);
  }

  const values = Object.values(body.configurations);
  if (values.length === 0) {
    throw new Error(`Apollo namespace ${ap.namespace} at ${url} has an empty 'configurations' object`);
  }

  return values.join('\n');
}
