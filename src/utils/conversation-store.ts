/**
 * In-memory conversation store for the Responses API stateful mode.
 *
 * When CONVERSATION_STATE=true, the proxy caches each response's output items
 * keyed by the generated response ID. Subsequent requests that carry
 * `previous_response_id` have the prior history prepended to their `input`
 * before conversion to Chat Completions format, making a stateless upstream
 * behave as a stateful Responses API endpoint.
 *
 * Two shapes of state exist:
 *  - Response entries (keyed by response ID): full merged input + output items
 *    + the serialized response object (for GET /v1/responses/{id}).
 *  - Conversation threads (keyed by conversation ID): the accumulated item
 *    list for the `conversation` request parameter.
 *
 * TTL: 3600 seconds (1 hour). Eviction is lazy (on access) plus opportunistic
 * (on every write). There is no cross-process or cross-instance sharing.
 */

const CONVERSATION_TTL_MS = 3600 * 1000;
const MAX_ENTRIES = parseInt(process.env.CONVERSATION_MAX_ENTRIES ?? '10000', 10);

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
  /**
   * The serialized Responses API response object as returned to the client.
   * Stored so GET /v1/responses/{id} can serve it back without an upstream call.
   */
  response?: Record<string, unknown>;
  expiresAt: number;
}

interface ConversationThreadEntry {
  /**
   * Accumulated items for a conversation: [...prior items, ...each turn's new
   * input items, ...each turn's output items]. Prepended to a request's input
   * when that conversation ID is referenced via the `conversation` parameter.
   */
  items: unknown[];
  expiresAt: number;
}

// Insertion-ordered maps; oldest entries are at the front (Map preserves insertion order).
const store = new Map<string, ConversationEntry>();
const threads = new Map<string, ConversationThreadEntry>();

function evictExpired(): void {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) {
      store.delete(key);
    }
  }
  for (const [key, entry] of threads) {
    if (entry.expiresAt <= now) {
      threads.delete(key);
    }
  }
}

function evictOldest(): void {
  // Map iteration is insertion-ordered, so the first key is the oldest.
  const firstKey = store.keys().next().value;
  if (firstKey !== undefined) {
    store.delete(firstKey);
  }
  const firstThreadKey = threads.keys().next().value;
  if (firstThreadKey !== undefined) {
    threads.delete(firstThreadKey);
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
 * @param response     The serialized Responses API response object (optional;
 *                     enables GET /v1/responses/{id} retrieval).
 */
export function saveConversation(
  responseId: string,
  inputItems: unknown[],
  outputItems: unknown[],
  response?: Record<string, unknown>
): void {
  store.set(responseId, {
    inputItems,
    outputItems,
    response,
    expiresAt: Date.now() + CONVERSATION_TTL_MS,
  });
  // Opportunistic cleanup: remove expired entries first, then enforce hard cap.
  evictExpired();
  while (store.size + threads.size > MAX_ENTRIES) {
    evictOldest();
  }
}

/**
 * Retrieve the accumulated items of a conversation thread by conversation ID.
 * Returns undefined if not found or expired.
 */
export function getConversationThreadItems(conversationId: string): unknown[] | undefined {
  const entry = threads.get(conversationId);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    threads.delete(conversationId);
    return undefined;
  }
  return entry.items;
}

/**
 * Append items to a conversation thread (creating it on first use) after a
 * response that referenced the conversation completes.
 */
export function appendConversationThreadItems(conversationId: string, items: unknown[]): void {
  if (items.length === 0) return;
  const existing = threads.get(conversationId);
  if (existing && existing.expiresAt > Date.now()) {
    existing.items.push(...items);
    existing.expiresAt = Date.now() + CONVERSATION_TTL_MS;
  } else {
    threads.set(conversationId, {
      items: [...items],
      expiresAt: Date.now() + CONVERSATION_TTL_MS,
    });
  }
  evictExpired();
  while (store.size + threads.size > MAX_ENTRIES) {
    evictOldest();
  }
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
