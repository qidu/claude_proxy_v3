/**
 * Convert OpenAI response to Gemini generateContent format
 */

function parseToolArguments(value: unknown): Record<string, unknown> {
    if (value && typeof value === 'object') return value as Record<string, unknown>;
    if (typeof value !== 'string' || value === '') return {};
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

export function convertOpenAIToGeminiGenerateContent(
    openaiResponse: any,
    modelId: string,
    requestId: string
): Record<string, unknown> {
    const choices = openaiResponse.choices || [];
    const usage = openaiResponse.usage;

    const geminiResponse: Record<string, any> = {
        model: modelId,
        candidates: [] as any[],
        usageMetadata: {
            promptTokenCount: usage?.prompt_tokens || 0,
            candidatesTokenCount: usage?.completion_tokens || 0,
            totalTokenCount: usage?.total_tokens || 0,
        }
    };

    if (choices.length > 0) {
        const choice = choices[0];
        const content = choice.delta?.content || choice.message?.content || '';
        const toolCalls = choice.message?.tool_calls || choice.delta?.tool_calls || [];
        const parts: any[] = [];

        if (content !== '') {
            parts.push({ text: content });
        }
        for (const toolCall of toolCalls) {
            const fn = toolCall.function || {};
            parts.push({
                functionCall: {
                    name: fn.name || '',
                    args: parseToolArguments(fn.arguments),
                }
            });
        }

        // Skip empty content chunks in streaming
        if (parts.length === 0) {
            // Return minimal response without candidates
            delete geminiResponse.candidates;
            return geminiResponse;
        }

        const candidate: any = {
            content: {
                role: 'model',
                parts
            },
            index: choice.index || 0
        };

        // Only add finishReason if it's present and meaningful
        if (choice.finish_reason && choice.finish_reason !== 'null') {
            candidate.finishReason = choice.finish_reason;
        }

        geminiResponse.candidates.push(candidate);
    }

    return geminiResponse;
}

/**
 * Convert OpenAI response to Gemini Interactions format
 */
export function convertOpenAIToGeminiInteractions(
    openaiResponse: any,
    modelId: string,
    requestId: string
): Record<string, unknown> {
    const choices = openaiResponse.choices || [];
    const usage = openaiResponse.usage;

    const interactionResponse: Record<string, any> = {
        id: `v1_${Date.now()}_${requestId}`,
        model: modelId,
        status: 'completed',
        object: 'interaction',
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        role: 'model',
        outputs: [] as any[],
        usage: {
            total_input_tokens: usage?.prompt_tokens || 0,
            total_output_tokens: usage?.completion_tokens || 0,
            total_tokens: usage?.total_tokens || 0,
        }
    };

    if (choices.length > 0) {
        const choice = choices[0];
        const content = choice.delta?.content || choice.message?.content || '';
        const toolCalls = choice.message?.tool_calls || choice.delta?.tool_calls || [];
        const outputs: any[] = [];

        if (content !== '') {
            outputs.push({
                type: 'text',
                text: content
            });
        }
        for (const toolCall of toolCalls) {
            const fn = toolCall.function || {};
            outputs.push({
                type: 'function_call',
                id: toolCall.id,
                call_id: toolCall.id,
                name: fn.name || '',
                arguments: parseToolArguments(fn.arguments),
            });
        }

        // Skip empty content chunks in streaming
        if (outputs.length === 0) {
            // Return minimal response without outputs
            delete interactionResponse.outputs;
            return interactionResponse;
        }

        interactionResponse.outputs = outputs;
    }

    return interactionResponse;
}
