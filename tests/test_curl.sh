curl -s -X POST "http://localhost:8787/v1/interactions" \
        -H "Content-Type: application/json" \
        -H "x-goog-api-key: sk-dacbaffa39360db740a9120cb2ba1590b89c4ffb687eddae43acfdb813e2594d " \ 
        --data '{"model":"gemini-3-flash-preview","input":"Hello"}'
