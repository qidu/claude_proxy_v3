Testing SSE streaming on all 3 endpoints
==========================================
Model: gemini-2.5-flash

1. SSE streaming #1
```
data: {"candidates": [{"content": {"parts": [{"text": "1\n2\n"}],"role": "model"},"index": 0}],"usageMetadata": {"promptTokenCount": 8,"candidatesTokenCount": 3,"totalTokenCount": 11,"promptTokensDetails": [{"modality": "TEXT","tokenCount": 8}]},"modelVersion": "gemini-2.5-flash","responseId": "WhmlabShCNjv-8YPl_D1gAo"}

data: {"candidates": [{"content": {"parts": [{"text": "3\n4\n5"}],"role": "model"},"finishReason": "STOP","index": 0}],"usageMetadata": {"promptTokenCount": 8,"candidatesTokenCount": 8,"totalTokenCount": 16,"promptTokensDetails": [{"modality": "TEXT","tokenCount": 8}]},"modelVersion": "gemini-2.5-flash","responseId": "WhmlabShCNjv-8YPl_D1gAo"}
```

2. SSE streaming #2
```
data: {"candidates": [{"content": {"parts": [{"text": "1\n2\n"}],"role": "model"},"index": 0}],"usageMetadata": {"promptTokenCount": 8,"candidatesTokenCount": 3,"totalTokenCount": 11,"promptTokensDetails": [{"modality": "TEXT","tokenCount": 8}]},"modelVersion": "gemini-2.5-flash","responseId": "Wxmlaf6jJOP2-8YP49W7-A4"}

data: {"candidates": [{"content": {"parts": [{"text": "3\n4\n5"}],"role": "model"},"finishReason": "STOP","index": 0}],"usageMetadata": {"promptTokenCount": 8,"candidatesTokenCount": 8,"totalTokenCount": 16,"promptTokensDetails": [{"modality": "TEXT","tokenCount": 8}]},"modelVersion": "gemini-2.5-flash","responseId": "Wxmlaf6jJOP2-8YP49W7-A4"}
```

3. SSE streaming #3
```
data: {"candidates": [{"content": {"parts": [{"text": "1\n2\n"}],"role": "model"},"index": 0}],"usageMetadata": {"promptTokenCount": 8,"candidatesTokenCount": 3,"totalTokenCount": 11,"promptTokensDetails": [{"modality": "TEXT","tokenCount": 8}]},"modelVersion": "gemini-2.5-flash","responseId": "XRmlaeWbCeP2-8YP49W7-A4"}

data: {"candidates": [{"content": {"parts": [{"text": "3\n4\n5"}],"role": "model"},"finishReason": "STOP","index": 0}],"usageMetadata": {"promptTokenCount": 8,"candidatesTokenCount": 8,"totalTokenCount": 16,"promptTokensDetails": [{"modality": "TEXT","tokenCount": 8}]},"modelVersion": "gemini-2.5-flash","responseId": "XRmlaeWbCeP2-8YP49W7-A4"}
```
