/**
 * Converter from OpenAI API format to Claude API format
 */

import { ClaudeMessagesResponse, ClaudeContentBlock, ClaudeTokenCountingResponse, ClaudeModelsResponse, ClaudeModel } from '../types/claude.js';
import { OpenAIResponse, OpenAITokenCountingResponse, OpenAIModelsResponse, OpenAIModel, OpenAITextPart } from '../types/openai.js';
import { countClaudeRequestTokens, getTiktokenTokenizer, TokenCountingOptions } from '../utils/token-counting.js';

export interface TokenCountingConfig {
    enabled: boolean;
    modelName: string;
}

/**
 * Convert OpenAI finish reason to Claude stop reason
 */
function convertFinishReasonToStopReason(finishReason: string | null): string | null {
    if (!finishReason) return null;

    const stopReasonMap: Record<string, string> = {
        stop: "end_turn",
        length: "max_tokens",
        tool_calls: "tool_use",
        "stop_sequence": "end_turn",
        "content_filter": "content_filter",
    };

    return stopReasonMap[finishReason] || "end_turn";
}

/**
 * Extract token counts from various response formats
 * Handles standard OpenAI format and non-standard formats like QNAIGC
 * Uses local token counting as fallback when LOCAL_TOKEN_COUNTING is enabled
 */
export async function extractTokenCounts(
    usage: Record<string, any> | undefined,
    requestBody?: Record<string, any>,
    config?: TokenCountingConfig
): Promise<{
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
}> {
    if (!usage) {
        return { input_tokens: 0, output_tokens: 0 };
    }

    // Standard OpenAI format: prompt_tokens, completion_tokens
    // QNAIGC non-standard format: input, output
    const inputTokens = usage.prompt_tokens ?? usage.input;
    const outputTokens = usage.completion_tokens ?? usage.output;

    // If local token counting is enabled and upstream returned 0 or undefined, use local counting
    if (config?.enabled && (inputTokens === undefined || inputTokens === 0 || outputTokens === undefined || outputTokens === 0)) {
        return {
            input_tokens: await calculateLocalTokens(requestBody, config, 'input'),
            output_tokens: await calculateLocalTokens(requestBody, config, 'output'),
            cache_creation_input_tokens: usage.prompt_cache_miss_tokens,
            cache_read_input_tokens: usage.prompt_cache_hit_tokens,
        };
    }

    return {
        input_tokens: inputTokens ?? 0,
        output_tokens: outputTokens ?? 0,
        cache_creation_input_tokens: usage.prompt_cache_miss_tokens,
        cache_read_input_tokens: usage.prompt_cache_hit_tokens,
    };
}

/**
 * Calculate local token count for input or output
 */
async function calculateLocalTokens(
    requestBody: Record<string, any> | undefined,
    config: TokenCountingConfig,
    type: 'input' | 'output'
): Promise<number> {
    if (type === 'input') {
        // Count input tokens from request body
        if (!requestBody || !requestBody.messages) return 0;
        try {
            const tokenizer = await getTiktokenTokenizer(config.modelName);
            const options: TokenCountingOptions = {
                useLocalCounting: true,
                tokenizer,
            };
            return countClaudeRequestTokens(requestBody as any, options);
        } catch (e) {
            return 0;
        }
    }
    // For output tokens, we can only estimate or use upstream value
    // Return 0 as fallback since we can't predict completion size
    return 0;
}

/**
 * Convert OpenAI model response to Claude format
 */
export async function convertOpenAIToClaudeResponse(
    openaiResponse: OpenAIResponse,
    model: string,
    requestId: string,
    requestBody?: Record<string, any>,
    config?: TokenCountingConfig
): Promise<ClaudeMessagesResponse> {
    // Handle empty choices array gracefully
    if (!openaiResponse.choices || !Array.isArray(openaiResponse.choices) || openaiResponse.choices.length === 0) {
        // Return a valid Claude response with empty content
        return {
            id: openaiResponse.id || requestId,
            type: "message",
            role: "assistant",
            model: model,
            content: [],
            stop_reason: null,
            usage: await extractTokenCounts(openaiResponse.usage, requestBody, config),
        };
    }

    // Get the first choice (OpenAI typically returns one choice unless n > 1)
    const choice = openaiResponse.choices[0];
    const message = choice.message;
    const content = message.content;
    const contentBlocks: ClaudeContentBlock[] = [];

    // Handle text content
    if (content) {
        let textContent: string;
        if (typeof content === 'string') {
            textContent = content;
        } else if (Array.isArray(content)) {
            // Extract text from content parts
            textContent = content
                .filter(part => part.type === 'text')
                .map(part => (part as OpenAITextPart).text)
                .join('');
        } else {
            textContent = String(content);
        }

        // Extract <thinking>...</thinking> markers from text content
        const thinkingRegex = /<thinking>([\s\S]*?)<\/thinking>/g;
        let thinkingContent = '';
        let match;
        let hasThinkingContent = false;

        while ((match = thinkingRegex.exec(textContent)) !== null) {
            thinkingContent += match[1];
            hasThinkingContent = true;
        }

        // If thinking content found, strip markers from text
        if (hasThinkingContent) {
            const cleanedText = textContent.replace(/<thinking>[\s\S]*?<\/thinking>/g, '').trim();
            if (cleanedText) {
                contentBlocks.push({
                    type: 'text',
                    text: cleanedText
                });
            }
            // Add thinking block
            if (thinkingContent) {
                contentBlocks.push({
                    type: 'thinking',
                    thinking: thinkingContent
                });
            }
        } else {
            // No thinking markers found, add as regular text
            contentBlocks.push({
                type: 'text',
                text: textContent
            });
        }
    }

    // Handle tool calls
    if (message?.tool_calls) {
        message.tool_calls.forEach(call => {
            contentBlocks.push({
                type: 'tool_use',
                id: call.id,
                name: call.function.name,
                input: JSON.parse(call.function.arguments),
            });
        });
    }

    // Determine stop_reason, handling empty finish_reason from providers like QNAIGC
    let stopReason = convertFinishReasonToStopReason(choice.finish_reason);

    // If stop_reason is null/empty or "end_turn" but we have tool calls, use "tool_use"
    // This handles providers that return empty or incorrect finish_reason
    if ((!stopReason || stopReason === "end_turn") && message?.tool_calls && message.tool_calls.length > 0) {
        stopReason = "tool_use";
    }

    const response: ClaudeMessagesResponse = {
        id: openaiResponse.id || requestId,
        type: "message",
        role: "assistant",
        model: model,
        content: contentBlocks,
        stop_reason: stopReason,
        usage: await extractTokenCounts(openaiResponse.usage, requestBody, config),
    };

    return response;
}

/**
 * Convert OpenAI token counting response to Claude format
 */
export function convertOpenAITokenCountingToClaude(
    openaiResponse: OpenAITokenCountingResponse
): ClaudeTokenCountingResponse {
    return {
        type: "token_count",
        input_tokens: openaiResponse.prompt_tokens,
    };
}

/**
 * Convert Unix timestamp to RFC 3339 string
 */
function unixToRFC3339(timestamp: number): string {
    const date = new Date(timestamp * 1000);
    return date.toISOString();
}

/**
 * Convert OpenAI models response to Claude format
 */
export function convertOpenAIModelsToClaude(
    openaiResponse: OpenAIModelsResponse
): ClaudeModelsResponse {
    const models: ClaudeModel[] = openaiResponse.data.map(model => ({
        id: model.id,
        type: "model",
        created_at: unixToRFC3339(model.created),
        display_name: model.id, // OpenAI doesn't have display_name, use model id
    }));

    return {
        data: models,
        first_id: models.length > 0 ? models[0].id : null,
        has_more: false, // OpenAI doesn't support pagination in models list
        last_id: models.length > 0 ? models[models.length - 1].id : null,
    };
}
