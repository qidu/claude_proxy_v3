/**
 * coordinator.ts — stage detection for the coordinator composite mode.
 *
 * The coordinator routes a conversation to a cheap executor model once the
 * planning stage is over, detected by the presence of trigger tool calls in
 * the accumulated message history.  Every request carries the full messages[]
 * array, so stage is re-derived per-request with no server-side state.
 */

interface ContentBlock {
  type: string;
  name?: string;
}

interface Message {
  role: string;
  content?: ContentBlock[] | string;
}

/**
 * Inspect the tail of `messages` for trigger tool calls and return whether
 * the conversation is in the planning or executing stage.
 *
 * @param messages  The full messages array from the incoming request body.
 * @param triggerTools  null = any tool_use fires hand-off;
 *                      Set<string> = only the named tools fire hand-off.
 * @param tailLimit  How many assistant messages to scan from the end (default 20).
 *                   Bounds cost on very long conversations.
 */
export function detectCoordinatorStage(
  messages: unknown[],
  triggerTools: Set<string> | null,
  tailLimit = 20,
): 'planning' | 'executing' {
  let assistantSeen = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Message;
    if (msg?.role !== 'assistant') continue;

    assistantSeen++;
    if (assistantSeen > tailLimit) break;

    const content = msg.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block?.type !== 'tool_use') continue;
      if (triggerTools === null) return 'executing';
      if (typeof block.name === 'string' && triggerTools.has(block.name)) return 'executing';
    }
  }

  return 'planning';
}
