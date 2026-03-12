/**
 * Streaming response converter from OpenAI SSE to Claude SSE
 */

export function createStreamTransformer(model: string, requestId: string) {
    let initialized = false;
    let buffer = "";
    let hasToolCalls = false;
    const messageId = requestId || `msg_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const toolCalls: {
        [index: number]: {
            id: string,
            name: string,
            args: string,
            claudeIndex: number,
            started: boolean
        }
    } = {};
    let contentBlockIndex = 0;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const sendEvent = (controller: TransformStreamDefaultController, event: string, data: object) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    };

    return {
        transform(chunk: Uint8Array, controller: TransformStreamDefaultController) {
            // Decode chunk for processing
            const chunkText = decoder.decode(chunk, { stream: true });
        if (!initialized) {
            // Send message_start event with proper headers
            sendEvent(controller, 'message_start', {
                type: 'message_start',
                message: {
                    id: messageId,
                    type: 'message',
                    role: 'assistant',
                    model,
                    content: [],
                    stop_reason: null,
                    usage: { input_tokens: 0, output_tokens: 0 }
                }
            });
            // Send content_block_start for first text block
            sendEvent(controller, 'content_block_start', {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'text', text: '' }
            });
            initialized = true;
        }

        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.substring(6);

            if (data.trim() === "[DONE]") {
                // Send content_block_stop for all active blocks
                sendEvent(controller, 'content_block_stop', {
                    type: 'content_block_stop',
                    index: 0
                });

                Object.values(toolCalls).forEach(tc => {
                    if (tc.started) {
                        sendEvent(controller, 'content_block_stop', {
                            type: 'content_block_stop',
                            index: tc.claudeIndex
                        });
                    }
                });

                // Determine final stop reason
                let finalStopReason = "end_turn";
                try {
                    const lastChunk = JSON.parse(lines[lines.length - 2].substring(6));
                    const finishReason = lastChunk.choices?.[0]?.finish_reason;
                    if (finishReason === 'tool_calls' || finishReason === 'tool_use') finalStopReason = 'tool_use';
                    else if (finishReason === 'length') finalStopReason = 'max_tokens';
                    else if (finishReason === 'content_filter') finalStopReason = 'content_filter';
                    // Handle empty or unknown finish_reason - infer from tool calls
                    else if (!finishReason && hasToolCalls) finalStopReason = 'tool_use';
                } catch (e) { }

                // Send message_delta with proper usage
                sendEvent(controller, 'message_delta', {
                    type: 'message_delta',
                    delta: { stop_reason: finalStopReason, stop_sequence: null },
                    usage: { output_tokens: 0 }
                });

                // Send message_stop
                sendEvent(controller, 'message_stop', {
                    type: 'message_stop'
                });

                controller.terminate();
                return;
            }

            try {
                const openaiChunk = JSON.parse(data);
                // Validate that choices exists and has at least one element
                if (!openaiChunk.choices || !Array.isArray(openaiChunk.choices) || openaiChunk.choices.length === 0) {
                    continue; // Skip invalid chunks
                }
                const delta = openaiChunk.choices[0]?.delta;
                if (!delta) continue;

                // Handle text content delta
                if (delta.content) {
                    sendEvent(controller, 'content_block_delta', {
                        type: 'content_block_delta',
                        index: 0,
                        delta: { type: 'text_delta', text: delta.content }
                    });
                }

                // Handle tool call deltas
                if (delta.tool_calls) {
                    hasToolCalls = true;
                    for (const tc_delta of delta.tool_calls) {
                        const index = tc_delta.index;
                        if (!toolCalls[index]) {
                            toolCalls[index] = {
                                id: '',
                                name: '',
                                args: '',
                                claudeIndex: 0,
                                started: false
                            };
                        }

                        if (tc_delta.id) toolCalls[index].id = tc_delta.id;
                        if (tc_delta.function?.name) toolCalls[index].name = tc_delta.function.name;
                        if (tc_delta.function?.arguments) toolCalls[index].args += tc_delta.function.arguments;

                        // Start new tool_use block when we have both id and name
                        if (toolCalls[index].id && toolCalls[index].name && !toolCalls[index].started) {
                            contentBlockIndex++;
                            toolCalls[index].claudeIndex = contentBlockIndex;
                            toolCalls[index].started = true;

                            sendEvent(controller, 'content_block_start', {
                                type: 'content_block_start',
                                index: contentBlockIndex,
                                content_block: {
                                    type: 'tool_use',
                                    id: toolCalls[index].id,
                                    name: toolCalls[index].name,
                                    input: {}
                                }
                            });
                        }

                        // Send input_json_delta for tool arguments
                        if (toolCalls[index].started && tc_delta.function?.arguments) {
                            sendEvent(controller, 'content_block_delta', {
                                type: 'content_block_delta',
                                index: toolCalls[index].claudeIndex,
                                delta: { type: 'input_json_delta', partial_json: tc_delta.function.arguments }
                            });
                        }
                    }
                }
            } catch (e) {
                // Ignore JSON parse errors for non-data lines
            }
        }
    },

    flush(controller: TransformStreamDefaultController) {
        // Send final events if stream ends unexpectedly
        if (initialized) {
            sendEvent(controller, 'message_delta', {
                type: 'message_delta',
                delta: { stop_reason: "end_turn", stop_sequence: null },
                usage: { output_tokens: 0 }
            });

            sendEvent(controller, 'message_stop', {
                type: 'message_stop'
            });
        }
    }
};
}