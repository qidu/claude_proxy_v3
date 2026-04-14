/**
 * In-memory conversation store for the Responses API stateful mode.
 *
 * When CONVERSATION=true, the proxy caches each response's output items keyed
 * by the generated response ID. Subsequent requests that carry
 * `previous_response_id` have the prior history prepended to their `input`
 * before conversion to Chat Completions format, making a stateless upstream
 * behave as a stateful Responses API endpoint.
 *
 * TTL: 3600 seconds (1 hour). Eviction is lazy (on access) plus opportunistic
 * (on every write). There is no cross-process or cross-instance sharing.
 */

const CONVERSATION_TTL_MS = 3600 * 1000;

interface ConversationEntry {
  /**
   * The full normalized input array that was sent for this response,
   * already including all prior turns prepended. Stored so that when
   * the next turn arrives we can reconstruct:
   *   [...entry.inputItems, ...entry.outputItems, ...newInput]
   */
  inputItems: unknown[];
  /**
   * Output items from this response (type: message | function_call | …).
   * These are in Responses API item format and can be fed directly back
   * as input items on the next turn.
   */
  outputItems: unknown[];
  expiresAt: number;
}

const store = new Map<string, ConversationEntry>();

function evictExpired(): void {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) {
      store.delete(key);
    }
  }
}

/**
 * Retrieve a stored conversation entry by the response ID that produced it.
 * Returns undefined if not found or expired.
 */
export function getConversation(responseId: string): ConversationEntry | undefined {
  const entry = store.get(responseId);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    store.delete(responseId);
    return undefined;
  }
  return entry;
}

/**
 * Save a conversation entry after a response is produced.
 * @param responseId   The ID of the response just produced (becomes the key).
 * @param inputItems   The full merged input that was sent for this response.
 * @param outputItems  The output items from this response.
 */
export function saveConversation(
  responseId: string,
  inputItems: unknown[],
  outputItems: unknown[]
): void {
  store.set(responseId, {
    inputItems,
    outputItems,
    expiresAt: Date.now() + CONVERSATION_TTL_MS,
  });
  // Opportunistic cleanup to prevent unbounded growth
  evictExpired();
}

/**
 * Normalize a Responses API `input` field to an array of input items.
 * A plain string becomes a single user message item.
 */
export function normalizeInputToItems(input: unknown): unknown[] {
  if (typeof input === 'string') {
    return [{ type: 'message', role: 'user', content: input }];
  }
  if (Array.isArray(input)) return input as unknown[];
  if (input != null) {
    return [{ type: 'message', role: 'user', content: JSON.stringify(input) }];
  }
  return [];
}
