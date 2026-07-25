# The Testing and Verification Task for proxy
1. Testing Proxy

reading ./tests/README.md for how to run proxy at PORT=7777 without key checking.
restarting proxy by: find pid with `lsof -ni:7777`, kill the pid, then start proxy

```
npm run build
DEV_NO_KEY=true DEV_PASS_THROUGH=true PORT=7777 npm start
```

2. Testing Resouces: models for antigravity agent testing
```
    "deepseek-v4-comp",               # local test for endpoint '/v1/chat/completions'
    "deepseek-v4-auth",               # local test for endpoint '/v1/messages'
    "max-m3-comp",                    # local test for endpoint '/v1/chat/completions'
    "max-m3-anth",                    # local test for endpoint '/v1/messages'
```

refer to 'source ~/dev/ai/bin/activate' to activate or create of venv of python

test model 'deepseek-v4-comp' on agent 'antigravity' for coding task #1 in python script with 'OPENAI-COMPATIBLE API'
```
ANTIGRAVITY_USE_GEMINI_API=false API_KEY=test PROXY_BASE=http://localhost:7777 python3 tests/multi-agents-test.py 1 1 1
```

test model 'deepseek-v4-comp' on agent 'antigravity' for coding task #1 in python script with 'GEMINI API'
```
ANTIGRAVITY_USE_GEMINI_API=true API_KEY=test PROXY_BASE=http://localhost:7777 python3 tests/multi-agents-test.py 1 1 1
```

then test other models on same agent and same task one by one

```
PROXY_BASE=http://localhost:7777 python3 tests/multi-agents-test.py 2 1 1
PROXY_BASE=http://localhost:7777 python3 tests/multi-agents-test.py 3 1 1
PROXY_BASE=http://localhost:7777 python3 tests/multi-agents-test.py 4 1 1
```

2. Results expected

for each model, we expect the agent antigravity runs and output nearly same size (lines) results without many errors.
for each model, we expect the proxy outputs no ERRORS in log.

3. Recording
output testing round index to two log file, then:
output each round agent testing to log file 'agent_testing.log'.
output each round proxy logs to file 'pronx_testing.log'.

4. Actions required

if there are conflicts to transform same messages from same upstream mode of different models, use different implementation for different upstream model even on same upstream mode, such as 'anthropic-messages' or 'opanai-completions'.
fix source codes of proxy in `./src` if log shows errors of four testing model and its target model in proxy logs.
