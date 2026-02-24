/**
 * Claude to Gemini Request Converter
 * Converts Claude API requests to Gemini Interactions API format
 */

import { ClaudeMessagesRequest, ClaudeContentBlock, ClaudeTool, ClaudeMessage, ClaudeTextBlock, ClaudeImageBlock, ClaudeToolUseBlock, ClaudeToolResultBlock, ThinkingBlock } from '../types/claude.js';
import { GeminiInteractionRequest, GeminiTool, GeminiContent, GeminiGenerationConfig, GeminiInput } from '../types/gemini.js';

/**
 * Convert Claude request to Gemini format
 */
export function convertClaudeToGeminiRequest(
    claudeRequest: ClaudeMessagesRequest,
    modelId?: string
): GeminiInteractionRequest {
    const geminiRequest: GeminiInteractionRequest = {
        model: modelId || claudeRequest.model,
        input: convertClaudeMessagesToGeminiInput(claudeRequest.messages),
        stream: claudeRequest.stream,
        store: true,
    };

    // Convert system instruction (Claude uses 'system' field)
    if (claudeRequest.system) {
        if (typeof claudeRequest.system === 'string') {
            geminiRequest.system_instruction = claudeRequest.system;
        } else if (Array.isArray(claudeRequest.system)) {
            geminiRequest.system_instruction = claudeRequest.system
                .map(s => (s as ClaudeTextBlock).text || '')
                .join('\n');
        }
    }

    // Convert tools
    if (claudeRequest.tools && claudeRequest.tools.length > 0) {
        geminiRequest.tools = claudeRequest.tools.map(convertClaudeToolToGemini);
    }

    // Convert generation config
    if (claudeRequest.temperature !== undefined ||
        claudeRequest.top_k !== undefined ||
        claudeRequest.max_tokens !== undefined ||
        claudeRequest.stop_sequences ||
        claudeRequest.thinking) {
        geminiRequest.generation_config = convertClaudeConfigToGemini(claudeRequest);
    }

    // Convert tool choice
    if (claudeRequest.tool_choice) {
        if (!geminiRequest.generation_config) {
            geminiRequest.generation_config = {};
        }
        geminiRequest.generation_config.tool_choice = convertClaudeToolChoiceToGemini(claudeRequest.tool_choice);
    }

    return geminiRequest;
}

/**
 * Convert Claude messages to Gemini input format
 */
function convertClaudeMessagesToGeminiInput(
    messages: ClaudeMessage[]
): GeminiInput {
    if (messages.length === 0) {
        return '';
    }

    // Check if simple text-only conversation
    const isTextOnly = messages.every(msg => {
        if (typeof msg.content === 'string') return true;
        if (Array.isArray(msg.content)) {
            return msg.content.every(block =>
                typeof block === 'string' || block.type === 'text'
            );
        }
        return typeof msg.content === 'string';
    });

    if (isTextOnly) {
        // Simple string concatenation for text-only conversations
        return messages
            .map(msg => {
                const content = typeof msg.content === 'string'
                    ? msg.content
                    : Array.isArray(msg.content)
                        ? msg.content.map(block =>
                            typeof block === 'string' ? block : (block as ClaudeTextBlock).text
                        ).join('')
                        : '';
                const role = msg.role === 'user' ? 'User' : 'Model';
                return `${role}: ${content}`;
            })
            .join('\n\n');
    }

    // Multi-modal or complex content - use array format
    const turns: Array<{ role: 'user' | 'model'; content: Array<GeminiContent> }> = [];

    for (const msg of messages) {
        const role = msg.role === 'user' ? 'user' : 'model';
        const content = convertClaudeContentToGemini(msg.content);

        if (typeof content === 'string') {
            turns.push({ role, content: [{ type: 'text', text: content }] });
        } else if (Array.isArray(content)) {
            turns.push({ role, content });
        }
    }

    return turns;
}

/**
 * Convert Claude content to Gemini format
 */
function convertClaudeContentToGemini(
    content: string | ClaudeContentBlock | Array<ClaudeContentBlock>
): string | Array<GeminiContent> {
    if (typeof content === 'string') {
        return content;
    }

    if (!Array.isArray(content)) {
        content = [content];
    }

    const geminiContent: Array<GeminiContent> = [];

    for (const block of content) {
        if (typeof block === 'string') {
            geminiContent.push({ type: 'text', text: block });
            continue;
        }

        switch (block.type) {
            case 'text':
                const textBlock = block as ClaudeTextBlock;
                geminiContent.push({
                    type: 'text',
                    text: textBlock.text || '',
                    annotations: textBlock.citations?.map(c => ({
                        start_index: c.start_char_index,
                        end_index: c.end_char_index,
                        source: c.document_title || '',
                    })),
                });
                break;

            case 'image':
                const imgBlock = block as ClaudeImageBlock;
                if (imgBlock.source.data) {
                    geminiContent.push({
                        type: 'image',
                        data: imgBlock.source.data,
                        mime_type: mapClaudeImageMimeToGemini(imgBlock.source.media_type),
                    });
                }
                break;

            case 'tool_use':
                const toolUseBlock = block as ClaudeToolUseBlock;
                geminiContent.push({
                    type: 'function_call',
                    name: toolUseBlock.name,
                    arguments: toolUseBlock.input as Record<string, unknown>,
                    id: toolUseBlock.id,
                });
                break;

            case 'tool_result':
                const toolResultBlock = block as ClaudeToolResultBlock;
                geminiContent.push({
                    type: 'function_result',
                    name: '',
                    result: toolResultBlock.content as string,
                    is_error: false,
                    call_id: toolResultBlock.tool_use_id,
                });
                break;

            case 'thinking':
                const thinkingBlock = block as ThinkingBlock;
                geminiContent.push({
                    type: 'thought',
                    signature: thinkingBlock.signature || '',
                });
                break;

            case 'document':
                // Claude document blocks would need mapping
                geminiContent.push({
                    type: 'text',
                    text: '[Document]',
                });
                break;

            default:
                // Handle unknown block types
                geminiContent.push({
                    type: 'text',
                    text: JSON.stringify(block),
                });
        }
    }

    return geminiContent;
}

/**
 * Convert Claude tools to Gemini format
 */
function convertClaudeToolToGemini(tool: ClaudeTool): GeminiTool {
    return {
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
    };
}

/**
 * Convert Claude config to Gemini generation config
 */
function convertClaudeConfigToGemini(claudeRequest: ClaudeMessagesRequest): GeminiGenerationConfig {
    const config: GeminiGenerationConfig = {};

    if (claudeRequest.temperature !== undefined) {
        config.temperature = claudeRequest.temperature;
    }

    if (claudeRequest.top_k !== undefined) {
        // Gemini uses top_p, not top_k - approximate conversion
        config.top_p = claudeRequest.top_k / 100;
    }

    if (claudeRequest.max_tokens) {
        config.max_output_tokens = claudeRequest.max_tokens;
    }

    if (claudeRequest.stop_sequences) {
        config.stop_sequences = claudeRequest.stop_sequences;
    }

    // Handle thinking config
    if (claudeRequest.thinking && claudeRequest.thinking.type === 'enabled') {
        config.thinking_level = 'medium';
        config.max_output_tokens = claudeRequest.thinking.budget_tokens || config.max_output_tokens;
    }

    return config;
}

/**
 * Convert Claude tool choice to Gemini format
 */
function convertClaudeToolChoiceToGemini(
    toolChoice: { type: "auto" | "any" | "tool"; name?: string } | { type: "none" }
): { type: 'auto' | 'any' | 'none' | 'function'; function?: { name: string } } {
    if (toolChoice.type === 'auto') {
        return { type: 'auto' };
    }

    if (toolChoice.type === 'none') {
        return { type: 'none' };
    }

    if (toolChoice.type === 'any') {
        return { type: 'any' };
    }

    if (toolChoice.type === 'tool' && toolChoice.name) {
        return { type: 'function', function: { name: toolChoice.name } };
    }

    return { type: 'auto' };
}

/**
 * Map Claude image mime type to Gemini format
 */
function mapClaudeImageMimeToGemini(
    mimeType?: string
): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/heic' | 'image/heif' {
    switch (mimeType) {
        case 'image/png':
            return 'image/png';
        case 'image/jpeg':
        case 'image/jpg':
            return 'image/jpeg';
        case 'image/webp':
            return 'image/webp';
        case 'image/heic':
            return 'image/heic';
        case 'image/heif':
            return 'image/heif';
        default:
            return 'image/png';
    }
}