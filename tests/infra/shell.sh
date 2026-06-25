#export TEST_KEY="sk-d8d563***"
#export TEST_MODEL="minimax/minimax-m2.1"
FILES=$(ls | tail | jq -R -s '.')
#echo $FILES
curl -X POST "http://localhost:8787/https/api.qnaigc.com/v1/messages" \
    -H "Authorization: Bearer ${TEST_KEY}" \
    -H "Content-Type: application/json" \
    -d '{
    "model": "'"${TEST_MODEL}"'",
      "messages": [
        {"role": "user", "content": "Check file types here"},
        {
          "role": "assistant",
          "content": [
            {"type": "text", "text": "I'\''ll check file types for you."},
            {
              "type": "tool_use",
              "id": "tool_123",
              "name": "ls_file",
              "input": {"operation": "ls"}
            }
          ]
        },
        {
          "role": "user",
          "content": [
            {
              "type": "tool_result",
              "tool_use_id": "tool_123",
              "content": "a.md b.txt"
            }
          ]
        }
      ],
      "max_tokens": 1000
    }'
#TEST_MODEL=""
#TEST_KEY=""
echo $TEST_MODEL
curl -X POST "http://localhost:8787/https/api.qnaigc.com/v1/messages" \
    -H "Authorization: Bearer ${TEST_KEY}" \
    -H "Content-Type: application/json" \
    -H "Accept: text/event-stream" \
    -d '{
      "model": "'"${TEST_MODEL}"'",
      "messages": [
        {"role": "user", "content": "what is the weather like"}
      ],
      "max_tokens": 1000,
      "stream": true
    }'
curl -s -X POST "http://localhost:8787/v1/interactions" \
        -H "Content-Type: application/json" \
        -H "x-goog-api-key: sk-dacbaffa39360db740a9120cb2ba1590b89c4ffb687eddae43acfdb813e2594d " \ 
        --data '{"model":"gemini-3-flash-preview","input":"Hello"}'
