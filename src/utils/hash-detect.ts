/**
 * Detect likely-cryptographic-hash strings in text.
 *
 * TypeScript port of `submodules/privacy-filter/hash_detect.py`. The algorithm
 * is identical (entropy-based scan + hexspeak / ordered-sequence filters), but
 * this module is Workers-safe: no `fs`, no `child_process`, no Python — just
 * a regex pass and a per-token priority classifier.
 *
 * Identifies contiguous hex strings whose length and entropy profile match
 * real cryptographic digests (MD5, SHA-1, SHA-256, their truncations, Git
 * short hashes), while filtering out:
 *
 *   * Hexspeak magic numbers (`deadbeef`, `cafebabe`, ...).
 *   * Repetitive / ordered sequences (`ffffffff`, `1234567890abcdef`).
 *   * English dictionary words that happen to be valid hex (`fabaceae`).
 *
 * Use case: pre-redacting API keys, tokens and other hex-shaped secrets
 * before forwarding text to a downstream LLM, because sequence-labeling PII
 * models tend to miss them.
 *
 * Public API
 * ----------
 * * `HashSpan`         — frozen `{start, end, token, priority}`.
 * * `shannonEntropy`   — bits/symbol; theoretical max for hex is 4.0.
 * * `detectHashPriority`— classify a single token ("HIGH" | "LOW" | "NO").
 * * `findHashSpans`    — find all hash spans in a string.
 *
 * Constants
 * ---------
 * * `HASH_HIGH`, `HASH_LOW`, `HASH_NO`
 * * `BUILTIN_HEX_WORDS_WHITELIST`
 *
 * User overrides (per-call)
 * -------------------------
 * `findHashSpans` and `detectHashPriority` accept an optional `whitelist`
 * set. Build it once at config load time from
 *   * `BUILTIN_HEX_WORDS_WHITELIST` (always included)
 *   * toml/env additions
 *   * toml/env removals (entries prefixed `-` in the env-var form)
 *   * optional whitelist file (Node-only; workers do not have filesystem)
 */

export const HASH_HIGH = 'HIGH'; // 16..256 chars AND a multiple of 8, high entropy.
export const HASH_LOW = 'LOW';   // > 8 chars, high entropy, but not HIGH-shaped.
export const HASH_NO = 'NO';     // not a hash (non-hex, whitelisted, low entropy, ...).

/** Minimum length for a token to be considered for whitelist lookup. */
const MIN_WHITELIST_LEN = 8;

/**
 * Built-in whitelist (immutable; merged with user overrides at config load).
 * Matches the Python reference: hexspeak magic numbers + English dictionary
 * words that happen to be valid hex.
 */
export const BUILTIN_HEX_WORDS_WHITELIST: ReadonlySet<string> = new Set(
  [
    // ---- Classic hexspeak magic numbers ----
    'deadbeef',    // invalid-memory marker
    'cafebabe',    // Java .class magic
    'decafbad',    // common placeholder
    'feedface',    // debugger marker
    'baadfeed',    // bad-block marker
    'feedbeef',    // variant
    'beefdead',    // variant
    'defacade',    // architecture / art term
    'addbedface',  // 11-char variant
    // ---- Hexspeak with 0 / 1 digits ----
    'c0edbabe',    // 8 chars
    'c001d00d',    // 8 chars
    'baadf00d',    // 8 chars
    // ---- Real English dictionary words (pure A-F) ----
    'fabaceae',    // the bean family
  ]
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= MIN_WHITELIST_LEN),
);

/**
 * A token of >= 9 hex chars is worth classifying. We require non-hex
 * boundaries on both sides so we don't slice into UUIDs / hex paths
 * like `.../deadbeef/...` mid-string, and so we don't double-match
 * the same hex run twice.
 */
const TOKEN_RE = /(?<![a-fA-F0-9])[a-fA-F0-9]{8,}(?![a-fA-F0-9])/g;

/**
 * Reference ordering for sequence detection. Strings whose sorted chars
 * are a permutation of the first N entries of this alphabet (e.g.
 * "1234567890abcdef", "fedcba9876543210", "0123456789abcdef0123") are
 * treated as deliberate sequences, not hashes.
 */
const HEX_ALPHABET = '0123456789abcdef';

export interface HashSpan {
  /** Inclusive start index in the source text. */
  start: number;
  /** Exclusive end index in the source text. */
  end: number;
  /** The matched token (the hash-shaped substring). */
  token: string;
  /** One of `HASH_HIGH` or `HASH_LOW`. `HASH_NO` spans are never emitted. */
  priority: string;
}

/** Shannon entropy in bits/symbol (theoretical max for hex = log2(16) = 4.0). */
export function shannonEntropy(s: string): number {
  if (!s) return 0;
  const length = s.length;
  const counts: Record<string, number> = Object.create(null);
  for (let i = 0; i < length; i++) {
    const c = s.charAt(i);
    counts[c] = (counts[c] || 0) + 1;
  }
  let entropy = 0;
  for (const c in counts) {
    const p = counts[c] / length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * True if `token` is a permutation of the first `len(token)` hex digits.
 *
 * Catches things like `"1234567890abcdef"`, `"fedcba9876543210"` and
 * `"0123456789abcdef0123"` which have max entropy (4.0) but are clearly
 * not hashes. For a random hex token of length N the probability of this
 * matching is N! / 16**N, vanishingly small for N >= 9.
 */
function isOrderedHexSequence(token: string): boolean {
  const sorted = token.toLowerCase().split('').sort();
  return sorted.every((c, i) => c === HEX_ALPHABET[i]);
}

/**
 * Classify a single token as a likely hash.
 *
 * Returns one of `HASH_HIGH`, `HASH_LOW`, `HASH_NO`.
 *
 * The default `entropyThreshold` of 3.0 is permissive enough to catch
 * real-world MD5 / SHA prefixes (which can have entropy around 3.3), while
 * still filtering out repetitive runs (`ffff...`, `abababab...`).
 */
export function detectHashPriority(
  token: string,
  entropyThreshold: number = 3.0,
  whitelist: ReadonlySet<string> = BUILTIN_HEX_WORDS_WHITELIST,
): string {
  if (!/^[a-fA-F0-9]+$/.test(token)) return HASH_NO;
  if (whitelist.has(token.toLowerCase())) return HASH_NO;

  const length = token.length;
  if (length < 8) return HASH_NO;
  if (isOrderedHexSequence(token)) return HASH_NO;
  if (shannonEntropy(token) < entropyThreshold) return HASH_NO;
  if (16 <= length && length <= 256 && length % 8 === 0) return HASH_HIGH;
  return HASH_LOW;
}

/**
 * Find hash-shaped spans in `text`.
 *
 * Spans are returned in left-to-right order. `HASH_NO` candidates are
 * omitted; only `HASH_HIGH` and `HASH_LOW` spans are returned.
 */
export function findHashSpans(
  text: string,
  entropyThreshold: number = 3.0,
  whitelist: ReadonlySet<string> = BUILTIN_HEX_WORDS_WHITELIST,
): HashSpan[] {
  if (!text) return [];
  const spans: HashSpan[] = [];
  // Reset the regex (it has the /g flag and is module-level to avoid re-allocation).
  TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_RE.exec(text)) !== null) {
    const token = match[0];
    const priority = detectHashPriority(token, entropyThreshold, whitelist);
    if (priority === HASH_NO) continue;
    spans.push({
      start: match.index,
      end: match.index + token.length,
      token,
      priority,
    });
  }
  return spans;
}

/**
 * Build a final whitelist from the built-ins plus user additions/removals
 * (the inline toml form is the canonical override; the env-var form mirrors
 * the Python `OPF_HASH_WHITELIST_FILE` syntax so existing deployment notes
 * stay accurate).
 *
 * Additions and removals are lowercased and whitespace-stripped. Entries
 * shorter than `MIN_WHITELIST_LEN` (8) are silently dropped. Entries that
 * don't match `^[a-f0-9]+$` are also dropped (whitelist is hex-only).
 *
 * `whitelistFile` is read synchronously if present. The reader is injected
 * so Workers (no fs) can pass `null` and Node can pass `(p) => readFileSync(p, 'utf8')`.
 */
export function buildWhitelist(
  additions: readonly string[] = [],
  removals: readonly string[] = [],
  whitelistFile: string | null = null,
  readFile: ((path: string) => string) | null = null,
): Set<string> {
  const merged = new Set<string>(BUILTIN_HEX_WORDS_WHITELIST);

  const ingest = (entries: readonly string[], mode: 'add' | 'remove') => {
    for (const raw of entries) {
      const stripped = raw.split('#', 1)[0].trim().toLowerCase();
      if (!stripped) continue;
      const token = stripped.startsWith('-') ? stripped.slice(1).trim() : stripped;
      if (token.length < MIN_WHITELIST_LEN) continue;
      if (!/^[a-f0-9]+$/.test(token)) continue;
      if (mode === 'add') merged.add(token);
      else merged.delete(token);
    }
  };
  ingest(additions, 'add');
  ingest(removals, 'remove');

  if (whitelistFile && readFile) {
    let content: string;
    try {
      content = readFile(whitelistFile);
    } catch {
      // Filesystem errors are reported by the caller (logger.warn) — don't
      // throw here, an unreadable whitelist is a config bug, not a request
      // error. We continue with the in-memory additions/removals.
      return merged;
    }
    const fileAdds: string[] = [];
    const fileRemoves: string[] = [];
    for (const raw of content.split(/\r?\n/)) {
      const stripped = raw.split('#', 1)[0].trim().toLowerCase();
      if (!stripped) continue;
      if (stripped.startsWith('-')) fileRemoves.push(stripped.slice(1).trim());
      else fileAdds.push(stripped);
    }
    ingest(fileAdds, 'add');
    ingest(fileRemoves, 'remove');
  }

  return merged;
}
