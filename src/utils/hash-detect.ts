/**
 * Detect likely-cryptographic-hash and API-key strings in text.
 *
 * TypeScript port of `submodules/privacy-filter/hash_detect.py`. The algorithm
 * is identical (entropy-based scan + hexspeak / ordered-sequence filters), but
 * this module is Workers-safe: no `fs`, no `child_process`, no Python — just
 * a regex pass and a per-token priority classifier.
 *
 * Two complementary scanners run on every token:
 *
 * **Hex scanner** — identifies contiguous hex strings whose length and entropy
 * profile match real cryptographic digests (MD5, SHA-1, SHA-256, their
 * truncations, Git short hashes), while filtering out:
 *   * Hexspeak magic numbers (`deadbeef`, `cafebabe`, ...).
 *   * Repetitive / ordered sequences (`ffffffff`, `1234567890abcdef`).
 *   * English dictionary words that happen to be valid hex (`fabaceae`).
 *
 * **Base64url scanner** — identifies high-entropy tokens drawn from the
 * base64url alphabet `[A-Za-z0-9+/=_-]` that contain at least one uppercase
 * letter or digit not in `[a-f0-9]`, so they are not pure-hex. This catches
 * API keys like `ouV7bwSqBiabj9kei4_ZiIlcQW90nsx` that the hex scanner misses.
 * Minimum length: 20 chars. Entropy threshold: same as hex (default 3.3 bits,
 * computed over the full alphabet so the effective bar is higher).
 *
 * Use case: pre-redacting API keys, tokens and other hash-shaped secrets
 * before forwarding text to a downstream LLM, because sequence-labeling PII
 * models tend to miss them.
 *
 * Public API
 * ----------
 * * `HashSpan`          — frozen `{start, end, token, priority}`.
 * * `shannonEntropy`    — bits/symbol; theoretical max for hex is 4.0.
 * * `detectHashPriority`— classify a single hex token ("HIGH" | "LOW" | "NO").
 * * `detectB64Priority` — classify a single base64url token ("HIGH" | "NO").
 * * `findHashSpans`     — find all hash/key spans (hex + base64url) in a string.
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

/** Default minimum hex token length to consider for hash detection. */
export const DEFAULT_HASH_MIN_LEN = 8;

/**
 * Build a token regex that captures hex runs of at least `minLen` chars.
 * We require non-hex boundaries on both sides so we don't slice into UUIDs
 * or hex paths like `.../deadbeef/...` mid-string.
 */
function buildTokenRe(minLen: number): RegExp {
  return new RegExp(`(?<![a-fA-F0-9])[a-fA-F0-9]{${minLen},}(?![a-fA-F0-9])`, 'g');
}

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
 * The default `entropyThreshold` of 3.3 filters out most descriptive
 * identifiers (filenames, kebab-case words) while still catching full-length
 * SHA-256 hashes and longer API keys. Some short MD5 prefixes with low
 * entropy may be missed at this threshold.
 */
export function detectHashPriority(
  token: string,
  entropyThreshold: number = 3.3,
  whitelist: ReadonlySet<string> = BUILTIN_HEX_WORDS_WHITELIST,
  minLen: number = DEFAULT_HASH_MIN_LEN,
): string {
  if (!/^[a-fA-F0-9]+$/.test(token)) return HASH_NO;
  if (whitelist.has(token.toLowerCase())) return HASH_NO;

  const length = token.length;
  if (length < minLen) return HASH_NO;
  if (isOrderedHexSequence(token)) return HASH_NO;
  if (shannonEntropy(token) < entropyThreshold) return HASH_NO;
  if (16 <= length && length <= 256 && length % 8 === 0) return HASH_HIGH;
  return HASH_LOW;
}

/**
 * Hard floor for the base64url scanner: even if `hash_min_len` config is set
 * lower, we never match base64url tokens shorter than this to avoid common
 * false positives (short identifiers, words, etc.).
 */
const B64_MIN_LEN = 20;

/**
 * Build a base64url token regex requiring at least `effectiveMin` chars.
 * Alphabet: `[A-Za-z0-9_-]` — URL-safe subset (no `=`, `+`, `/`) so that
 * punctuation like `key=VALUE` is never absorbed into the token.
 */
function buildB64TokenRe(effectiveMin: number): RegExp {
  return new RegExp(
    `(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{${effectiveMin},}(?![A-Za-z0-9_-])`,
    'g',
  );
}

/**
 * Minimum length of the longest `_`/`-`-delimited segment for a base64url
 * token to qualify as a key. Random keys have one long unbroken run; word-
 * underscore identifiers (`deepseek_v4_anthropic_compat`) are chopped into
 * short dictionary segments (max run 8-9), so this rejects them while keeping
 * real keys that happen to contain a separator (`ouV7bwSqBiabj9kei4_ZiIlcQW90nsx`,
 * max run 18).
 */
const B64_MIN_SEGMENT_RUN = 12;

/**
 * Minimum digit ratio for a base64url token to qualify as a key. Random keys
 * are digit-rich (>= 0.16 in practice); descriptive identifiers carry only an
 * incidental digit or two (`v4` -> ~0.04), so this is a second, independent
 * signal against word-underscore false positives.
 */
const B64_MIN_DIGIT_RATIO = 0.08;

/** Longest run of chars between `_`/`-` separators. */
function maxSegmentRun(token: string): number {
  let max = 0;
  for (const seg of token.split(/[_-]/)) {
    if (seg.length > max) max = seg.length;
  }
  return max;
}

/**
 * Classify a single base64url token.
 *
 * Returns `HASH_HIGH` when:
 *   1. The token length meets `Math.max(B64_MIN_LEN, minLen)`.
 *   2. It contains at least one character outside `[a-f0-9]` (i.e. is not a
 *      pure-hex string — those are already handled by the hex scanner).
 *   3. It contains at least one digit `[0-9]` (real API keys almost always do;
 *      this filters out descriptive identifiers like filenames).
 *   4. Its longest `_`/`-`-delimited segment is at least `B64_MIN_SEGMENT_RUN`
 *      chars, and its digit ratio is at least `B64_MIN_DIGIT_RATIO` — two
 *      independent signals that reject word-underscore identifiers such as
 *      `deepseek_v4_anthropic_compat` while keeping real random keys.
 *   5. Shannon entropy meets `entropyThreshold`.
 *
 * Returns `HASH_NO` otherwise.
 *
 * There is no `HASH_LOW` tier for base64url tokens: the longer minimum length
 * (floor 20) already provides sufficient precision that every match above the
 * entropy bar is treated as HIGH.
 */
export function detectB64Priority(
  token: string,
  entropyThreshold: number = 3.3,
  minLen: number = DEFAULT_HASH_MIN_LEN,
): string {
  if (token.length < Math.max(B64_MIN_LEN, minLen)) return HASH_NO;
  // Skip pure-hex tokens — the hex scanner handles them with finer-grained
  // priority classification (HIGH/LOW) and the hexspeak whitelist.
  if (/^[a-fA-F0-9]+$/.test(token)) return HASH_NO;
  // Require at least one digit — real API keys contain digits; descriptive
  // identifiers (filenames, kebab-case words) typically do not.
  if (!/[0-9]/.test(token)) return HASH_NO;
  // Reject word-underscore identifiers: they split into short dictionary
  // segments and carry only an incidental digit. Real keys have a long
  // unbroken run and are digit-rich.
  if (maxSegmentRun(token) < B64_MIN_SEGMENT_RUN) return HASH_NO;
  const digitCount = (token.match(/[0-9]/g) as RegExpMatchArray | null)?.length ?? 0;
  if (digitCount / token.length < B64_MIN_DIGIT_RATIO) return HASH_NO;
  if (shannonEntropy(token) < entropyThreshold) return HASH_NO;
  return HASH_HIGH;
}

const EXT_RE = /^\.[A-Za-z0-9]{1,5}(?![A-Za-z0-9_-])/;

/**
 * Check whether the span at [start, end) in `text` sits inside a file path.
 *
 * Returns true when:
 *   - The char before the span is `/` or `\` (path separator), or
 *   - The text after the span looks like a file extension: `.ext` (1-5
 *     alphanumeric chars) followed by a non-base64url boundary.
 *
 * This filters out path components and filenames that the entropy/length
 * scanners would otherwise flag as hash-shaped.
 */
function isInPathContext(text: string, start: number, end: number): boolean {
  if (start > 0) {
    const before = text[start - 1];
    if (before === '/' || before === '\\') return true;
  }
  if (EXT_RE.test(text.slice(end))) return true;
  return false;
}

/**
 * Find hash-shaped spans in `text`.
 *
 * Runs both the hex scanner and the base64url scanner. Spans from both are
 * merged, de-overlapped (a span fully contained within another is dropped,
 * so a b64url key like `sk-6f1ea0…` and its inner hex run `6f1ea0…` produce
 * one span, not two), and returned in left-to-right order. `HASH_NO`
 * candidates are omitted.
 */
export function findHashSpans(
  text: string,
  entropyThreshold: number = 3.3,
  whitelist: ReadonlySet<string> = BUILTIN_HEX_WORDS_WHITELIST,
  minLen: number = DEFAULT_HASH_MIN_LEN,
): HashSpan[] {
  if (!text) return [];
  const spans: HashSpan[] = [];

  // --- Hex scanner ---
  const tokenRe = buildTokenRe(minLen);
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(text)) !== null) {
    const start = match.index;
    const end = start + match[0].length;
    if (isInPathContext(text, start, end)) continue;
    const token = match[0];
    const priority = detectHashPriority(token, entropyThreshold, whitelist, minLen);
    if (priority === HASH_NO) continue;
    spans.push({ start, end, token, priority });
  }

  // --- Base64url scanner ---
  const b64TokenRe = buildB64TokenRe(Math.max(B64_MIN_LEN, minLen));
  while ((match = b64TokenRe.exec(text)) !== null) {
    const token = match[0];
    const priority = detectB64Priority(token, entropyThreshold, minLen);
    if (priority === HASH_NO) continue;
    const start = match.index;
    const end = start + token.length;
    // Skip if this range is already fully covered by a hex span (no duplicate).
    const overlaps = spans.some((s) => s.start <= start && s.end >= end);
    if (overlaps) continue;
    if (isInPathContext(text, start, end)) continue;
    spans.push({ start, end, token, priority });
  }

  // Sort left-to-right for the caller (applySpans iterates right-to-left).
  spans.sort((a, b) => a.start - b.start);

  // De-overlap: drop any span fully contained within another. This resolves
  // the case where a b64url span and a hex span share the same key — e.g.
  // `sk-6f1ea04…` is matched by the b64 scanner (prefix `sk-`) while the
  // hex scanner matches the inner `6f1ea04…` run. The narrower span is the
  // duplicate; keeping only the wider one ensures applySpans produces a
  // clean, non-overlapping replacement set so round-trip restore is exact.
  const deduped: HashSpan[] = [];
  for (const span of spans) {
    // Pop the last kept span if the current one contains it.
    while (deduped.length > 0) {
      const prev = deduped[deduped.length - 1];
      if (span.start <= prev.start && span.end >= prev.end) {
        deduped.pop();
      } else {
        break;
      }
    }
    // Skip the current span if the last kept one contains it.
    const prev = deduped[deduped.length - 1];
    if (prev && prev.start <= span.start && prev.end >= span.end) {
      continue;
    }
    deduped.push(span);
  }

  return deduped;
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
