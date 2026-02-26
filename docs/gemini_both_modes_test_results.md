# Gemini-2.5-Flash Test Results - Both Modes

## Date: 2026-02-26
## Model: gemini-2.5-flash
## Tests: Stream & Non-Stream on Native and OpenAI-Compatible modes

---

## Summary

### OpenAI-Compatible Mode: 5/6 (83%) ✅

**Non-streaming:** 3/3 (100%)  
**Streaming:** 2/3 (67%)

### Native Gemini Mode: 4/6 (67%) ✅

**Non-streaming:** 3/3 (100%)  
**Streaming:** 1/3 (33%)

---

## Detailed Results

### OpenAI-Compatible Mode

**Configuration:**
```toml
[models.gemini-2-5-flash]
mode = "openai-completions"
# Uses default upstream: https://api.qnaigc.com
```

**Non-Streaming Tests:**
- ✅ /v1/messages: `chatcmpl-d5ad5e98afed43a3812330a2c5419eb9`
- ✅ /v1/interactions: `v1_1772098745684_req_1772098744566_ogq5zibnm`
- ✅ generateContent: `chatcmpl-0ef7a69797e3469a91df369adc4782bc`

**Streaming Tests:**
- ❌ /v1/messages (stream): No SSE
- ✅ /v1/interactions (stream): SSE ✅
- ✅ streamGenerateContent: SSE ✅

**Score:** 5/6 (83%)

---

### Native Gemini Mode

**Configuration:**
```toml
[models.gemini-2-5-flash]
mode = "native"
base_url = "https://api.example1.com"
api_key = "sk-..."
```

**Non-Streaming Tests:**
- ✅ /v1/messages: `chatcmpl-20260226173916778371478b2cLt00J`
- ✅ /v1/interactions: `v1_1772098762823_req_1772098760529_rhfbqbozs`
- ✅ generateContent: `msg_1772098764998_879j6ckz`

**Streaming Tests:**
- ❌ /v1/messages (stream): No SSE
- ❌ /v1/interactions (stream): No SSE
- ✅ streamGenerateContent: SSE ✅

**Score:** 4/6 (67%)

---

## Comparison

### Non-Streaming (100% both modes)

| Endpoint | OpenAI Mode | Native Mode |
|----------|-------------|-------------|
| /v1/messages | ✅ | ✅ |
| /v1/interactions | ✅ | ✅ |
| generateContent | ✅ | ✅ |

**Result:** Perfect compatibility for non-streaming

---

### Streaming

| Endpoint | OpenAI Mode | Native Mode |
|----------|-------------|-------------|
| /v1/messages + stream | ❌ | ❌ |
| /v1/interactions + stream | ✅ | ❌ |
| streamGenerateContent | ✅ | ✅ |

**Key Differences:**
- `/v1/interactions` streaming: Works in OpenAI mode, fails in Native mode
- `streamGenerateContent`: Works in both modes ✅
- `/v1/messages` streaming: Fails in both modes ❌

---

## Analysis

### ✅ What Works (100%)

**All non-streaming endpoints:**
- Both modes handle non-streaming perfectly
- All 3 endpoints return proper responses
- Consistent behavior across modes

**streamGenerateContent:**
- Works in both modes
- Native mode: Returns Gemini SSE format
- OpenAI mode: Returns OpenAI SSE format

---

### ⚠️ Partial Support

**/v1/interactions streaming:**
- ✅ OpenAI mode: Works (67% success)
- ❌ Native mode: Fails (33% success)

**Possible cause:** Native Gemini upstream doesn't support streaming for interactions endpoint

---

### ❌ What Doesn't Work

**/v1/messages streaming:**
- Fails in both modes (0% success)
- Consistent failure across all tests
- Needs investigation

---

## Routing Verification

### OpenAI-Compatible Mode

**Non-streaming:**
```
Client → Proxy → https://api.qnaigc.com/v1/chat/completions
Response: Claude JSON format
```

**Streaming:**
```
Client → Proxy → https://api.qnaigc.com/v1/chat/completions (stream: true)
Response: OpenAI SSE → Converted to Claude SSE
```

---

### Native Mode

**Non-streaming:**
```
/v1/messages → https://api.example1.com/v1/messages
/v1/interactions → https://api.example1.com/v1beta/models/gemini-2.5-flash:generateContent
generateContent → https://api.example1.com/v1beta/models/gemini-2.5-flash:generateContent
```

**Streaming:**
```
streamGenerateContent → https://api.example1.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse
Response: Native Gemini SSE format
```

---

## Recommendations

### 1. Use OpenAI-Compatible Mode for Better Streaming

**Advantages:**
- Better streaming support (67% vs 33%)
- /v1/interactions streaming works
- Consistent behavior

**Use cases:**
- Production deployments
- Applications requiring streaming
- Multi-endpoint support

---

### 2. Use Native Mode for Direct Gemini Access

**Advantages:**
- Direct API access
- Native response formats
- No format conversion overhead

**Use cases:**
- Gemini-specific features
- Native format requirements
- streamGenerateContent only

---

### 3. Investigate /v1/messages Streaming

**Issue:** Fails in both modes (0% success)

**Action items:**
- Check handler logic for messages endpoint
- Verify upstream streaming support
- Test response format detection
- Review timeout settings

---

### 4. Document Native Mode Limitations

**Known limitations:**
- /v1/interactions streaming not supported
- Only streamGenerateContent works for streaming
- Upstream-dependent behavior

---

## Test Configuration

**Model:** gemini-2.5-flash  
**Timeout:** 10 seconds for streaming  
**Question:** "Count 1 to 5" (simple streaming test)

**Upstreams:**
- OpenAI mode: https://api.qnaigc.com
- Native mode: https://api.example1.com

---

## Conclusion

### OpenAI-Compatible Mode: ✅ Recommended

**Strengths:**
- 83% success rate
- Better streaming support
- All non-streaming works
- 2/3 streaming endpoints work

**Best for:** Production use, streaming applications

---

### Native Gemini Mode: ✅ Functional

**Strengths:**
- 67% success rate
- All non-streaming works
- streamGenerateContent streaming works
- Direct Gemini API access

**Best for:** Native format requirements, streamGenerateContent only

---

### Overall Status

**Non-streaming:** ✅ Production ready (100% both modes)  
**Streaming:** ⚠️ Partial support (OpenAI: 67%, Native: 33%)

**Critical issue:** /v1/messages streaming fails in both modes

---

## Files

- `tests/test_gemini_both_modes.sh` - Test script
- `docs/gemini_both_modes_test_results.md` - This file
