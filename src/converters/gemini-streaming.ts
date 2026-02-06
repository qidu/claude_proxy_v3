/**
 * Gemini Streaming Response Converter
 * Converts Gemini SSE streaming format to Claude SSE streaming format
 */

import { GeminiSSEEvent, GeminiContent } from '../types/gemini';

/**
 * State for streaming conversion
 */
interface StreamingState {
    currentId: string;
    currentRole: string;
    contentIndex: number;
    accumulatedText: string;
    hasStarted: boolean;
    hasEnded: boolean;
}

/**
 * Create a transform stream for converting Gemini SSE to Claude SSE format
 */
export function createGeminiStreamTransformer(
    model: string,
    requestId: string
): TransformStream<string, string> {
    const state: StreamingState = {
        currentId: '',
        currentRole: 'assistant',
        contentIndex: 0,
        accumulatedText: '',
        hasStarted: false,
        hasEnded: false,
    };

    return new TransformStream({
        transform(chunk: string, controller: TransformStreamDefaultController<string>) {
            const lines = chunk.split('\n');
            let buffer = '';

            for (const line of lines) {
                if (line.startsWith('event:')) {
                    // Process event header if we have buffered data
                    if (buffer.trim() && state.hasStarted) {
                        processContentDelta(buffer, controller, model, requestId, state);
                        buffer = '';
                    }
                    continue;
                }

                if (line.startsWith('data:')) {
                    const data = line.slice(5).trim();
                    if (!data) continue;

                    try {
                        const event: GeminiSSEEvent = JSON.parse(data);
                        handleGeminiEvent(event, controller, model, requestId, state);
                    } catch (e) {
                        // Skip invalid JSON
                    }
                }
            }

            if (buffer.trim() && state.hasStarted) {
                processContentDelta(buffer, controller, model, requestId, state);
            }
        },
        flush(controller: TransformStreamDefaultController<string>) {
            if (state.hasStarted && !state.hasEnded) {
                // Send message stop event
                const messageStop = `event: message_stop\ndata: {"type":"message_stop","index":0}\n\n`;
                controller.enqueue(messageStop);
            }
        }
    });
}

/**
 * Handle Gemini SSE event
 */
function handleGeminiEvent(
    event: GeminiSSEEvent,
    controller: TransformStreamDefaultController<string>,
    model: string,
    requestId: string,
    state: StreamingState
) {
    switch (event.event_type) {
        case 'interaction.start':
            // Handle interaction start
            if (event.interaction) {
                state.currentId = event.interaction.id;
                state.currentRole = event.interaction.role || 'model';
                // Send message start
                const messageStart = {
                    type: 'message_start',
                    message: {
                        id: event.interaction.id,
                        type: 'message',
                        role: 'assistant',
                        model: model,
                        content: [] as any[],
                        stop_reason: null,
                        usage: { input_tokens: 0, output_tokens: 0 },
                    },
                };
                controller.enqueue(`event: message_start\ndata: ${JSON.stringify(messageStart)}\n\n`);
                state.hasStarted = true;
            }
            break;

        case 'content.start':
            // Handle new content block start
            if (event.content) {
                state.contentIndex = event.index || 0;
                const contentStart = {
                    type: 'content_block_start',
                    index: event.index || 0,
                    content_block: { type: mapGeminiContentTypeToClaude(event.content.type) },
                };
                controller.enqueue(`event: content_block_start\ndata: ${JSON.stringify(contentStart)}\n\n`);
            }
            break;

        case 'content.delta':
            // Handle content delta (text chunks, tool calls, etc.)
            if (event.delta) {
                const delta = event.delta as any;
                if (delta.type === 'text' && delta.text) {
                    state.accumulatedText += delta.text;
                    const deltaEvent = {
                        type: 'content_block_delta',
                        index: event.index || 0,
                        delta: { type: 'text_delta', text: delta.text },
                    };
                    controller.enqueue(`event: content_block_delta\ndata: ${JSON.stringify(deltaEvent)}\n\n`);
                } else if (delta.type === 'function_call') {
                    const toolUseEvent = {
                        type: 'content_block_delta',
                        index: event.index || 0,
                        delta: {
                            type: 'tool_use',
                            id: delta.id || `tool-${Date.now()}`,
                            name: delta.name,
                            input: delta.arguments || {},
                        },
                    };
                    controller.enqueue(`event: content_block_delta\ndata: ${JSON.stringify(toolUseEvent)}\n\n`);
                } else if (delta.type === 'function_result') {
                    const toolResultEvent = {
                        type: 'content_block_delta',
                        index: event.index || 0,
                        delta: {
                            type: 'tool_result',
                            tool_use_id: delta.call_id,
                            content: delta.result,
                            is_error: delta.is_error,
                        },
                    };
                    controller.enqueue(`event: content_block_delta\ndata: ${JSON.stringify(toolResultEvent)}\n\n`);
                } else {
                    // Generic delta
                    const genericEvent = {
                        type: 'content_block_delta',
                        index: event.index || 0,
                        delta,
                    };
                    controller.enqueue(`event: content_block_delta\ndata: ${JSON.stringify(genericEvent)}\n\n`);
                }
            }
            break;

        case 'content.stop':
            // Handle content block stop
            controller.enqueue(`event: content_block_stop\ndata: {"type":"content_block_stop","index":${event.index || 0}}\n\n`);
            break;

        case 'interaction.complete':
            // Handle interaction complete
            state.hasEnded = true;
            // Send message delta with stop reason
            const messageDelta = {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn' },
            };
            controller.enqueue(`event: message_delta\ndata: ${JSON.stringify(messageDelta)}\n\n`);
            // Send message stop
            controller.enqueue(`event: message_stop\ndata: {"type":"message_stop","index":0}\n\n`);
            break;

        case 'interaction.status_update':
            // Handle status update
            if (event.status === 'failed') {
                const errorDelta = {
                    type: 'message_delta',
                    delta: { stop_reason: 'max_tokens' },
                };
                controller.enqueue(`event: message_delta\ndata: ${JSON.stringify(errorDelta)}\n\n`);
            }
            break;

        case 'error':
            // Handle error
            const errorEvent = {
                type: 'error',
                error: {
                    type: event.error?.code || 'internal_error',
                    message: event.error?.message || 'Unknown error occurred',
                },
            };
            controller.enqueue(`event: error\ndata: ${JSON.stringify(errorEvent)}\n\n`);
            break;
    }
}

/**
 * Process accumulated text content delta
 */
function processContentDelta(
    text: string,
    controller: TransformStreamDefaultController<string>,
    model: string,
    requestId: string,
    state: StreamingState
): void {
    state.accumulatedText += text;
    const deltaEvent = {
        type: 'content_block_delta',
        index: state.contentIndex,
        delta: { type: 'text_delta', text },
    };
    controller.enqueue(`event: content_block_delta\ndata: ${JSON.stringify(deltaEvent)}\n\n`);
}

/**
 * Map Gemini content type to Claude content block type
 */
function mapGeminiContentTypeToClaude(geminiType: string): string {
    switch (geminiType) {
        case 'text':
            return 'text';
        case 'function_call':
            return 'tool_use';
        case 'image':
            return 'image';
        default:
            return 'text';
    }
}