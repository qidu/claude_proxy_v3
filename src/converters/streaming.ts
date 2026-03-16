/**
 * Streaming response converter from OpenAI SSE to Claude SSE
 */

import { countClaudeRequestTokens, countTokensWithTiktoken, getTiktokenTokenizer, TokenCountingOptions } from '../utils/token-counting.js';
import { TokenCountingConfig } from './openai-to-claude.js';

export function createStreamTransformer(
    model: string,
    requestId: string,
    requestBody?: Record<string, unknown>,
    tokenCountingConfig?: TokenCountingConfig,
    includeThinking = false
) {
    let initialized = false;
    let buffer = "";
    let hasToolCalls = false;
    let hasThinking = false;
    let thinkingStarted = false;
    const messageMutex = requestId || `msg_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
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

    // Thinking content accumulation state
    let accumulatedThinkingContent = "";
    let accumulatedSignature = "";
    let thinkingBlockIndex = -1;

    // Token counting state
    let inputTokens = 0;
    let outputTokens = 0;
    let tokenizer: any = null;
    let tokenizerReady = false;

    // Calculate input tokens and prepare tokenizer for output counting
    const initializeTokenCounting = async () => {
        if (tokenCountingConfig?.enabled && requestBody) {
            try {
                const options: TokenCountingOptions = {
                    useLocalCounting: true,
                    tokenizer: null,
                };
                // Count input tokens
                inputTokens = countClaudeRequestTokens(requestBody as any, options);
                // Initialize tokenizer for output counting
                tokenizer = await getTiktokenTokenizer(tokenCountingConfig.modelName);
                tokenizerReady = true;
            } catch (e) {
                inputTokens = 0;
                tokenizerReady = false;
            }
        }
    };

    // Count output tokens for text content
    const countOutputTokens = (text: string) => {
        if (!tokenizerReady || !text) return;
        try {
            outputTokens += countTokensWithTiktoken(text, { tokenizer, useLocalCounting: true });
        } catch (e) {
            // Ignore counting errors
        }
    };

    // Count output tokens for tool call arguments
    const countToolCallTokens = (args: string) => {
        if (!tokenizerReady || !args) return;
        try {
            outputTokens += countTokensWithTiktoken(args, { tokenizer, useLocalCounting: true });
        } catch (e) {
            // Ignore counting errors
        }
    };

    // Count thinking tokens separately
    const countThinkingTokens = (thinkingText: string) => {
        if (!tokenizerReady || !thinkingText) return;
        try {
            outputTokens += countTokensWithTiktoken(thinkingText, { tokenizer, useLocalCounting: true });
        } catch (e) {
            // Ignore counting errors
        }
    };

    const sendEvent = (controller: TransformStreamDefaultController, event: string, data: object) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
    };

    // Process thinking extraction from text content
    const processThinkingExtraction = (textContent: string, controller: TransformStreamDefaultController) => {
        // Add to buffer for processing
        accumulatedThinkingContent += textContent;

        // Try to extract complete thinking blocks
        const thinkingRegex = /<thinking>([\s\S]*?)<\/thinking>/g;
        let match;
        let lastIndex = 0;
        let hasCompleteThinkingBlock = false;

        while ((match = thinkingRegex.exec(accumulatedThinkingContent)) !== null) {
            // Send any text before this thinking block
            if (match.index > lastIndex) {
                const textBefore = accumulatedThinkingContent.substring(lastIndex, match.index);
                if (textBefore.trim()) {
                    countOutputTokens(textBefore);
                    sendEvent(controller, 'content_block_delta', {
                        type: 'content_block_delta',
                        index: 0,
                        delta: { type: 'text_delta', text: textBefore }
                    });
                }
            }

            // Extract thinking content
            const thinkingContent = match[1];

            // Start thinking block if not already started
            if (!thinkingStarted) {
                thinkingStarted = true;
                thinkingBlockIndex = contentBlockIndex + 1;
                contentBlockIndex = thinkingBlockIndex;
                sendEvent(controller, 'content_block_start', {
                    type: 'content_block_start',
                    index: thinkingBlockIndex,
                    content_block: { type: 'thinking', thinking: '' }
                });
            }

            // Send thinking delta
            countThinkingTokens(thinkingContent);
            sendEvent(controller, 'content_block_delta', {
                type: 'content_block_delta',
                index: thinkingBlockIndex,
                delta: { type: 'thinking_delta', thinking: thinkingContent }
            });

            lastIndex = thinkingRegex.lastIndex;
            hasCompleteThinkingBlock = true;
            hasThinking = true;
        }

        // If we found complete thinking blocks, remove processed content
        if (hasCompleteThinkingBlock) {
            accumulatedThinkingContent = accumulatedThinkingContent.substring(lastIndex);
        }

        // If we have remaining text after thinking blocks, send it
        if (accumulatedThinkingContent && !accumulatedThinkingContent.includes('<thinking>')) {
            countOutputTokens(accumulatedThinkingContent);
            sendEvent(controller, 'content_block_delta', {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: accumulatedThinkingContent }
            });
            accumulatedThinkingContent = '';
        }
    };

    return {
        transform(chunk: Uint8Array, controller: TransformStreamDefaultController) {
            // Decode chunk for processing
            decoder.decode(chunk, { stream: true });
            if (!initialized) {
                // Initialize token counting
                initializeTokenCounting();

                // Send message_start event with input tokens
                sendEvent(controller, 'message_start', {
                    type: 'message_start',
                    message: {
                        id: messageMutex,
                        type: 'message',
                        role: 'assistant',
                        model,
                        content: [],
                        stop_reason: null,
                        usage: { input_tokens: inputTokens, output_tokens: outputTokens }
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

                    // Send signature_delta before content_block_stop for thinking block if we have signature
                    if (thinkingStarted && thinkingBlockIndex !== -1 && accumulatedSignature) {
                        sendEvent(controller, 'content_block_delta', {
                            type: 'content_block_delta',
                            index: thinkingBlockIndex,
                            delta: {
                                type: 'signature_delta',
                                signature: accumulatedSignature,
                                index: thinkingBlockIndex
                            }
                        });
                    }

                    // Send content_block_stop for thinking block if active
                    if (thinkingStarted && thinkingBlockIndex !== -1) {
                        sendEvent(controller, 'content_block_stop', {
                            type: 'content_block_stop',
                            index: thinkingBlockIndex
                        });
                    }

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
                        else if ((!finishReason || finishReason === 'stop') && hasToolCalls) finalStopReason = 'tool_use';
                    } catch (e) { }

                    // Send message_delta with final output token count
                    sendEvent(controller, 'message_delta', {
                        type: 'message_delta',
                        delta: { stop_reason: finalStopReason, stop_sequence: null },
                        usage: { output_tokens: outputTokens }
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
                    if (!openaiChunk.choices || !Array.isArray(openaiChunk.choices) || openaiChunk.choices.length === 0) {
                        continue;
                    }
                    const delta = openaiChunk.choices[0]?.delta;
                    if (!delta) continue;

                    // Handle text content delta
                    if (delta.content) {
                        const textContent = delta.content;

                        // Check if this chunk contains thinking markers
                        if (textContent.includes('<thinking>') || textContent.includes('</thinking>') || accumulatedThinkingContent) {
                            // Process thinking extraction with state management
                            processThinkingExtraction(textContent, controller);
                        } else {
                            // No thinking markers found, send as regular text
                            countOutputTokens(textContent);
                            sendEvent(controller, 'content_block_delta', {
                                type: 'content_block_delta',
                                index: 0,
                                delta: { type: 'text_delta', text: textContent }
                            });
                        }
                    }

                    // Handle thinking/reasoning content (OpenAI-compatible thinking mode)
                    if (includeThinking) {
                        // Handle reasoning_content (common in thinking-enabled models)
                        const reasoningContent = delta.reasoning_content || delta.reasoning;
                        if (reasoningContent && typeof reasoningContent === 'string') {
                            // Add reasoning content to accumulated thinking content
                            accumulatedThinkingContent += reasoningContent;
                            hasThinking = true;

                            // Start thinking block if not already started
                            if (!thinkingStarted) {
                                thinkingStarted = true;
                                thinkingBlockIndex = contentBlockIndex + 1;
                                contentBlockIndex = thinkingBlockIndex;
                                sendEvent(controller, 'content_block_start', {
                                    type: 'content_block_start',
                                    index: thinkingBlockIndex,
                                    content_block: { type: 'thinking', thinking: '' }
                                });
                            }

                            // Send thinking delta
                            countThinkingTokens(reasoningContent);
                            sendEvent(controller, 'content_block_delta', {
                                type: 'content_block_delta',
                                index: thinkingBlockIndex,
                                delta: { type: 'thinking_delta', thinking: reasoningContent }
                            });
                        }

                        // Handle signature delta for thinking verification
                        const signatureContent = delta.signature;
                        if (signatureContent && typeof signatureContent === 'string') {
                            // Accumulate signature for thinking block
                            accumulatedSignature += signatureContent;
                        }

                        // Also check for signature in the chunk metadata (similar to non-streaming)
                        const reasoningItemId = openaiChunk.reasoning_item_id;
                        const responseSignature = openaiChunk.signature;

                        if (reasoningItemId && !accumulatedSignature) {
                            accumulatedSignature = reasoningItemId;
                        } else if (responseSignature && !accumulatedSignature) {
                            accumulatedSignature = responseSignature;
                        }
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
                            if (tc_delta.function?.arguments) {
                                countToolCallTokens(tc_delta.function.arguments);
                                toolCalls[index].args += tc_delta.function.arguments;
                            }

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
                // Send content_block_stop for all active blocks
                sendEvent(controller, 'content_block_stop', {
                    type: 'content_block_stop',
                    index: 0
                });

                // Send signature_delta before content_block_stop for thinking block if we have signature
                if (thinkingStarted && thinkingBlockIndex !== -1 && accumulatedSignature) {
                    sendEvent(controller, 'content_block_delta', {
                        type: 'content_block_delta',
                        index: thinkingBlockIndex,
                        delta: {
                            type: 'signature_delta',
                            signature: accumulatedSignature,
                            index: thinkingBlockIndex
                        }
                    });
                }

                // Send content_block_stop for thinking block if active
                if (thinkingStarted && thinkingBlockIndex !== -1) {
                    sendEvent(controller, 'content_block_stop', {
                        type: 'content_block_stop',
                        index: thinkingBlockIndex
                    });
                }

                // Send content_block_stop for tool calls
                Object.values(toolCalls).forEach(tc => {
                    if (tc.started) {
                        sendEvent(controller, 'content_block_stop', {
                            type: 'content_block_stop',
                            index: tc.claudeIndex
                        });
                    }
                });

                sendEvent(controller, 'message_delta', {
                    type: 'message_delta',
                    delta: { stop_reason: "end_turn", stop_sequence: null },
                    usage: { output_tokens: outputTokens }
                });

                sendEvent(controller, 'message_stop', {
                    type: 'message_stop'
                });
            }
        }
    };
}