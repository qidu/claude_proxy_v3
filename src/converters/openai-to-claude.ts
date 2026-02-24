/**
 * Converter from OpenAI API format to Claude API format
 */

import { ClaudeMessagesResponse, ClaudeContentBlock, ClaudeTokenCountingResponse, ClaudeModelsResponse, ClaudeModel } from '../types/claude.js';
import { OpenAIResponse, OpenAITokenCountingResponse, OpenAIModelsResponse, OpenAIModel, OpenAITextPart } from '../types/openai.js';

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
 * Convert OpenAI model response to Claude format
 */
export function convertOpenAIToClaudeResponse(
    openaiResponse: OpenAIResponse,
    model: string,
    requestId: string
): ClaudeMessagesResponse {
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
            usage: {
                input_tokens: openaiResponse.usage?.prompt_tokens || 0,
                output_tokens: openaiResponse.usage?.completion_tokens || 0,
                cache_creation_input_tokens: openaiResponse.usage?.prompt_cache_miss_tokens,
                cache_read_input_tokens: openaiResponse.usage?.prompt_cache_hit_tokens,
            },
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

        // Always add text block even if empty to maintain structure
        contentBlocks.push({
            type: 'text',
            text: textContent
        });
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

    const stopReason = convertFinishReasonToStopReason(choice.finish_reason);

    const response: ClaudeMessagesResponse = {
        id: openaiResponse.id || requestId,
        type: "message",
        role: "assistant",
        model: model,
        content: contentBlocks,
        stop_reason: stopReason,
        usage: {
            input_tokens: openaiResponse.usage?.prompt_tokens || 0,
            output_tokens: openaiResponse.usage?.completion_tokens || 0,
            cache_creation_input_tokens: openaiResponse.usage?.prompt_cache_miss_tokens,
            cache_read_input_tokens: openaiResponse.usage?.prompt_cache_hit_tokens,
        },
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
