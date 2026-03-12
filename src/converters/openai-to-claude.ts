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
 * Extract token counts from various response formats
 * Handles standard OpenAI format and non-standard formats like QNAIGC
 */
function extractTokenCounts(usage: Record<string, any> | undefined): {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
} {
    if (!usage) {
        return { input_tokens: 0, output_tokens: 0 };
    }

    // Standard OpenAI format: prompt_tokens, completion_tokens
    // QNAIGC non-standard format: input, output
    return {
        input_tokens: usage.prompt_tokens ?? usage.input ?? 0,
        output_tokens: usage.completion_tokens ?? usage.output ?? 0,
        cache_creation_input_tokens: usage.prompt_cache_miss_tokens,
        cache_read_input_tokens: usage.prompt_cache_hit_tokens,
    };
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
            usage: extractTokenCounts(openaiResponse.usage),
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
        usage: extractTokenCounts(openaiResponse.usage),
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
