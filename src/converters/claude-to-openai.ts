/**
 * Converter from Claude API format to OpenAI API format
 */

import { ClaudeMessagesRequest, ClaudeTokenCountingRequest, ClaudeContent, ClaudeContentBlock, ClaudeTool, ThinkingConfigParam } from '../types/claude.js';
import { OpenAIRequest, OpenAITokenCountingRequest, OpenAIMessage, OpenAIToolCall } from '../types/openai.js';

/**
 * Recursively cleans a JSON Schema to make it compatible with target APIs like Google Gemini.
 * - Removes '$schema' and 'additionalProperties' keys.
 * - For properties of type 'string', removes the 'format' field unless it's 'date-time' or 'enum'.
 */
export function recursivelyCleanSchema(schema: any): any {
    if (schema === null || typeof schema !== 'object') {
        return schema;
    }

    if (Array.isArray(schema)) {
        return schema.map(item => recursivelyCleanSchema(item));
    }

    const newSchema: { [key: string]: any } = {};
    for (const key in schema) {
        if (Object.prototype.hasOwnProperty.call(schema, key)) {
            if (key === '$schema' || key === 'additionalProperties') {
                continue;
            }
            newSchema[key] = recursivelyCleanSchema(schema[key]);
        }
    }

    if (newSchema.type === 'string' && newSchema.format) {
        const supportedFormats = ['date-time', 'enum'];
        if (!supportedFormats.includes(newSchema.format)) {
            delete newSchema.format;
        }
    }

    return newSchema;
}

/**
 * Convert Claude content blocks to OpenAI format
 */
function convertClaudeContentToOpenAI(content: ClaudeContent): OpenAIMessage['content'] {
    if (typeof content === 'string') {
        return content;
    }

    const contentArray = content.map(block => {
        if (block.type === 'text') {
            return { type: 'text' as const, text: block.text };
        } else if (block.type === 'image') {
            return {
                type: 'image_url' as const,
                image_url: {
                    url: `data:${block.source.media_type};base64,${block.source.data}`
                }
            };
        }
        // Skip document, tool_use, tool_result blocks (handled separately)
        return null;
    }).filter(Boolean) as any[];

    return contentArray.length > 0 ? contentArray : '';
}

/**
 * Convert Claude tool definitions to OpenAI format
 */
function convertClaudeToolsToOpenAI(tools: ClaudeTool[] | undefined): OpenAIRequest['tools'] {
    if (!tools || tools.length === 0) {
        return undefined;
    }

    return tools.map(tool => ({
        type: "function" as const,
        function: {
            name: tool.name,
            description: tool.description || '',
            parameters: recursivelyCleanSchema(tool.input_schema),
        },
    }));
}

/**
 * Convert Claude tool_choice to OpenAI format
 */
function convertClaudeToolChoiceToOpenAI(toolChoice: ClaudeMessagesRequest['tool_choice']): OpenAIRequest['tool_choice'] {
    if (!toolChoice) {
        return undefined;
    }

    if (toolChoice.type === 'auto' || toolChoice.type === 'any') {
        return 'auto';
    } else if (toolChoice.type === 'tool') {
        return {
            type: 'function',
            function: { name: toolChoice.name! }
        };
    } else if (toolChoice.type === 'none') {
        return 'none';
    }

    return undefined;
}

/**
 * Convert Claude thinking config to OpenAI format
 */
function convertClaudeThinkingToOpenAI(thinking: ThinkingConfigParam | undefined): OpenAIRequest['thinking'] {
    if (!thinking) {
        return undefined;
    }

    // Handle boolean values (true = enabled, false = disabled)
    if (thinking.type === true || thinking.type === 'enabled') {
        return {
            enabled: true,
            budget_tokens: thinking.budget_tokens
        };
    } else if (thinking.type === false || thinking.type === 'disabled') {
        return {
            enabled: false
        };
    }

    return undefined;
}

/**
 * Extract tool results from Claude content array
 */
function extractToolResultsFromClaudeContent(content: ClaudeContentBlock[]): Array<{ tool_use_id: string; content: string }> {
    return content
        .filter(block => block.type === 'tool_result')
        .map(block => ({
            tool_use_id: block.tool_use_id,
            content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
        }));
}

/**
 * Extract non-tool content from Claude content array
 */
function extractNonToolContentFromClaudeContent(content: ClaudeContentBlock[]): ClaudeContentBlock[] {
    return content.filter(block => block.type !== 'tool_result');
}

/**
 * Convert Claude token counting request to OpenAI format
 */
export function convertClaudeTokenCountingToOpenAI(
    claudeRequest: ClaudeTokenCountingRequest,
    modelName: string,
    requestId?: string
): OpenAITokenCountingRequest {
    const openaiMessages: OpenAIMessage[] = [];

    // Handle system message - must be first in OpenAI format
    if (claudeRequest.system) {
        const systemContent = typeof claudeRequest.system === 'string'
            ? claudeRequest.system
            : claudeRequest.system.map(block => block.text).join('\n');
        openaiMessages.push({ role: "system", content: systemContent });
    }

    // Process each message
    for (const message of claudeRequest.messages) {
        if (message.role === 'user') {
            if (Array.isArray(message.content)) {
                const toolResults = extractToolResultsFromClaudeContent(message.content);
                const otherContent = extractNonToolContentFromClaudeContent(message.content);

                // Add tool results as tool messages first
                toolResults.forEach(toolResult => {
                    openaiMessages.push({
                        role: 'tool',
                        tool_call_id: toolResult.tool_use_id,
                        content: toolResult.content,
                    });
                });

                // Add other content as user message
                if (otherContent.length > 0) {
                    const contentArray = convertClaudeContentToOpenAI(otherContent);
                    if (contentArray !== '') {
                        openaiMessages.push({
                            role: "user",
                            content: contentArray
                        });
                    }
                }
            } else {
                // Simple string content
                openaiMessages.push({ role: "user", content: message.content });
            }
        } else if (message.role === 'assistant') {
            const textParts: string[] = [];
            const toolCalls: OpenAIToolCall[] = [];

            if (Array.isArray(message.content)) {
                message.content.forEach(block => {
                    if (block.type === 'text') {
                        textParts.push(block.text);
                    } else if (block.type === 'tool_use') {
                        toolCalls.push({
                            id: block.id,
                            type: 'function',
                            function: {
                                name: block.name,
                                arguments: JSON.stringify(block.input || {})
                            },
                        });
                    }
                });
            }

            // OpenAI requires content to be non-null for assistant messages with tool calls
            const assistantMessage: OpenAIMessage = {
                role: 'assistant',
                content: textParts.length > 0 ? textParts.join('\n') : ''
            };

            if (toolCalls.length > 0) {
                assistantMessage.tool_calls = toolCalls;
            }

            openaiMessages.push(assistantMessage);
        }
    }

    // Build OpenAI token counting request
    const openaiRequest: OpenAITokenCountingRequest = {
        model: modelName,
        messages: openaiMessages,
    };

    // Handle tools
    const convertedTools = convertClaudeToolsToOpenAI(claudeRequest.tools);
    if (convertedTools) {
        openaiRequest.tools = convertedTools;
    }

    // Handle thinking
    const convertedThinking = convertClaudeThinkingToOpenAI(claudeRequest.thinking);
    if (convertedThinking !== undefined) {
        openaiRequest.thinking = convertedThinking;
    }

    return openaiRequest;
}

/**
 * Main converter: Claude Messages Request → OpenAI Request
 */
export function convertClaudeToOpenAIRequest(
    claudeRequest: ClaudeMessagesRequest,
    modelName: string
): OpenAIRequest {
    const openaiMessages: OpenAIMessage[] = [];

    // Handle system message - must be first in OpenAI format
    if (claudeRequest.system) {
        const systemContent = typeof claudeRequest.system === 'string' 
            ? claudeRequest.system 
            : claudeRequest.system.map(block => block.text).join('\n');
        openaiMessages.push({ role: "system", content: systemContent });
    }

    // Process each message
    for (const message of claudeRequest.messages) {
        if (message.role === 'user') {
            if (Array.isArray(message.content)) {
                const toolResults = extractToolResultsFromClaudeContent(message.content);
                const otherContent = extractNonToolContentFromClaudeContent(message.content);

                // Add tool results as tool messages first
                toolResults.forEach(toolResult => {
                    openaiMessages.push({
                        role: 'tool',
                        tool_call_id: toolResult.tool_use_id,
                        content: toolResult.content,
                    });
                });

                // Add other content as user message
                if (otherContent.length > 0) {
                    const contentArray = convertClaudeContentToOpenAI(otherContent);
                    if (contentArray !== '') {
                        openaiMessages.push({
                            role: "user",
                            content: contentArray
                        });
                    }
                }
            } else {
                // Simple string content
                openaiMessages.push({ role: "user", content: message.content });
            }
        } else if (message.role === 'assistant') {
            const textParts: string[] = [];
            const toolCalls: OpenAIToolCall[] = [];

            if (Array.isArray(message.content)) {
                message.content.forEach(block => {
                    if (block.type === 'text') {
                        textParts.push(block.text);
                    } else if (block.type === 'tool_use') {
                        toolCalls.push({
                            id: block.id,
                            type: 'function',
                            function: {
                                name: block.name,
                                arguments: JSON.stringify(block.input || {})
                            },
                        });
                    }
                });
            }

            // OpenAI requires content to be non-null for assistant messages with tool calls
            const assistantMessage: OpenAIMessage = {
                role: 'assistant',
                content: textParts.length > 0 ? textParts.join('\n') : ''
            };

            if (toolCalls.length > 0) {
                assistantMessage.tool_calls = toolCalls;
            }

            openaiMessages.push(assistantMessage);
        }
    }

    // Build OpenAI request
    const openaiRequest: OpenAIRequest = {
        model: modelName,
        messages: openaiMessages,
        max_tokens: claudeRequest.max_tokens,
        temperature: claudeRequest.temperature,
        top_p: claudeRequest.top_p,
        stream: claudeRequest.stream,
        stop: claudeRequest.stop_sequences,
    };

    // Handle tools
    const convertedTools = convertClaudeToolsToOpenAI(claudeRequest.tools);
    if (convertedTools) {
        openaiRequest.tools = convertedTools;
    }

    // Handle tool_choice
    const convertedToolChoice = convertClaudeToolChoiceToOpenAI(claudeRequest.tool_choice);
    if (convertedToolChoice !== undefined) {
        openaiRequest.tool_choice = convertedToolChoice;
    }

    // Handle thinking
    const convertedThinking = convertClaudeThinkingToOpenAI(claudeRequest.thinking);
    if (convertedThinking !== undefined) {
        openaiRequest.thinking = convertedThinking;
    }

    return openaiRequest;
}
