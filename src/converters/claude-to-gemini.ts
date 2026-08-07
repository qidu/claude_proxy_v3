/**
 * Claude to Gemini Request Converter
 * Converts Claude API requests to Gemini Interactions API format
 */

import { ClaudeMessagesRequest, ClaudeContentBlock, ClaudeTool, ClaudeMessage, ClaudeTextBlock, ClaudeImageBlock, ClaudeToolUseBlock, ClaudeToolResultBlock, ThinkingBlock } from '../types/claude.js';
import { GeminiInteractionRequest, GeminiTool, GeminiContent, GeminiGenerationConfig, GeminiInput } from '../types/gemini.js';
import { stringify } from '../utils/stringify.js';
import { fetchImageAsInlineData } from '../utils/image-fetch.js';

/**
 * Convert Claude request to Gemini generateContent format
 */
export function convertClaudeToGeminiRequest(
    claudeRequest: ClaudeMessagesRequest,
    modelId?: string
): Record<string, unknown> {
    const contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [];

    for (const msg of claudeRequest.messages) {
        const parts: Array<Record<string, unknown>> = [];
        
        if (typeof msg.content === 'string') {
            parts.push({ text: msg.content });
        } else if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
                if (typeof block === 'string') {
                    parts.push({ text: block });
                } else if (block.type === 'text') {
                    parts.push({ text: (block as ClaudeTextBlock).text });
                } else if (block.type === 'image') {
                    const imgBlock = block as ClaudeImageBlock;
                    parts.push({
                        inline_data: {
                            mime_type: imgBlock.source.media_type || 'image/jpeg',
                            data: imgBlock.source.data
                        }
                    });
                }
                // Skip other block types for now
            }
        }
        
        if (parts.length > 0) {
            contents.push({
                role: msg.role === 'user' ? 'user' : 'model',
                parts
            });
        }
    }

    const request: Record<string, unknown> = {
        contents
    };

    // Add system instruction
    if (claudeRequest.system) {
        if (typeof claudeRequest.system === 'string') {
            request.system_instruction = { parts: [{ text: claudeRequest.system }] };
        }
    }

    // Add generation config
    if (claudeRequest.temperature !== undefined || claudeRequest.max_tokens !== undefined) {
        const config: Record<string, unknown> = {};
        if (claudeRequest.temperature !== undefined) config.temperature = claudeRequest.temperature;
        if (claudeRequest.max_tokens !== undefined) config.max_output_tokens = claudeRequest.max_tokens;
        request.generation_config = config;
    }

    // Add cached content
    if (claudeRequest.cached_content) {
        request.cachedContent = claudeRequest.cached_content;
    }

    return request;
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
                    text: stringify(block),
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
    if (claudeRequest.thinking && (claudeRequest.thinking.type === 'enabled' || claudeRequest.thinking.type === true)) {
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

/**
 * Decode a data: URI into mime_type + base64 data. Throws on malformed input
 * (Rule #8 — Fail Loud) so the upstream receives an honest error rather than a
 * silently corrupted image part.
 */
function decodeDataUri(url: string): { mime_type: string; data: string } {
    const m = url.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
    if (!m) {
        throw new Error(`Malformed image_url data URI: ${url.slice(0, 60)}`);
    }
    const mime = m[1] || 'image/jpeg';
    const isBase64 = m[2] === ';base64';
    const raw = m[3] ?? '';
    if (!isBase64) {
        // URL-encoded inline payload — base64-encode the decoded bytes.
        return { mime_type: mime, data: btoa(decodeURIComponent(raw)) };
    }
    return { mime_type: mime, data: raw };
}

/**
 * Convert an OpenAI Chat Completions request body into a Gemini
 * generateContent request body. Mirrors `completionsToClaudeBody`
 * (src/handlers/openai.ts:499) for the anthropic-messages cross-mode route.
 *
 * Async because http(s) image_url values are fetched server-side with an SSRF
 * guard (src/utils/image-fetch.ts). `data:` URIs are decoded synchronously.
 */
export async function convertCompletionsToGeminiGenerateContentBody(
    completions: Record<string, unknown>,
    model: string,
): Promise<Record<string, unknown>> {
    const messages = (completions.messages as Array<Record<string, unknown>>) || [];
    const systemMsg = messages.find(m => m.role === 'system' || m.role === 'developer');
    const otherMessages = messages.filter(m => m.role !== 'system' && m.role !== 'developer');

    const contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [];

    for (const m of otherMessages) {
        const role = m.role === 'assistant' ? 'model' : (m.role as string);
        const parts: Array<Record<string, unknown>> = [];
        const reasoning = m.reasoning_content as string | undefined;

        if (reasoning) parts.push({ thought: true, text: reasoning });

        const toolCalls = m.tool_calls as Array<Record<string, unknown>> | undefined;
        if (toolCalls && toolCalls.length > 0) {
            for (const tc of toolCalls) {
                const fn = tc.function as Record<string, unknown> | undefined;
                let args: unknown = (fn?.arguments as string) ?? {};
                if (typeof args === 'string' && args !== '') {
                    try { args = JSON.parse(args); } catch { /* keep string */ }
                } else if (typeof args === 'string') {
                    args = {};
                }
                parts.push({ functionCall: { name: fn?.name ?? '', args } });
            }
        }

        if (m.role === 'tool') {
            // Tool result — emit as functionResponse on a user turn.
            parts.length = 0;
            parts.push({
                functionResponse: {
                    name: (m.name as string) || '',
                    response: { content: m.content ?? '' },
                },
            });
        } else {
            const content = m.content;
            if (typeof content === 'string') {
                if (content !== '') parts.push({ text: content });
            } else if (Array.isArray(content)) {
                for (const part of content as Array<Record<string, unknown>>) {
                    const pType = part.type;
                    if (pType === 'text' && typeof part.text === 'string') {
                        parts.push({ text: part.text });
                    } else if (pType === 'image_url') {
                        const url = (part.image_url as Record<string, unknown> | undefined)?.url as string;
                        if (typeof url !== 'string' || url === '') continue;
                        if (url.startsWith('data:')) {
                            parts.push({ inline_data: decodeDataUri(url) });
                        } else {
                            // http(s) — server-side fetch with SSRF guard.
                            // Fail Loud on any error (no placeholder).
                            parts.push({ inline_data: await fetchImageAsInlineData(url) });
                        }
                    }
                    // Other part types (e.g. input_audio) are skipped — Gemini
                    // generateContent's multimodal surface here is image-only.
                }
            }
        }

        if (parts.length > 0) contents.push({ role, parts });
    }

    const geminiBody: Record<string, unknown> = { contents };

    if (systemMsg) {
        const sysContent = typeof systemMsg.content === 'string'
            ? systemMsg.content
            : '';
        if (sysContent !== '') {
            geminiBody.systemInstruction = { parts: [{ text: sysContent }] };
        }
    }

    const config: Record<string, unknown> = {};
    if (completions.max_tokens !== undefined) config.max_output_tokens = completions.max_tokens;
    if (completions.temperature !== undefined) config.temperature = completions.temperature;
    if (completions.top_p !== undefined) config.top_p = completions.top_p;
    if (completions.stop !== undefined) {
        config.stopSequences = Array.isArray(completions.stop) ? completions.stop : [completions.stop];
    }
    if (Object.keys(config).length > 0) geminiBody.generationConfig = config;

    const tools = completions.tools as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(tools) && tools.length > 0) {
        const fds = tools
            .map(t => {
                const fn = (t.function ?? {}) as Record<string, unknown>;
                return {
                    name: fn.name,
                    description: fn.description ?? '',
                    parameters: fn.parameters ?? { type: 'object', properties: {} },
                };
            })
            .filter(fd => typeof fd.name === 'string');
        if (fds.length > 0) geminiBody.tools = [{ functionDeclarations: fds }];
    }

    if (completions.stream === true) geminiBody.stream = true;

    // Carrier for the requested model — Gemini generateContent URL embeds the
    // model, but the body field is harmless and useful for diagnostics.
    geminiBody.model = model;

    return geminiBody;
}