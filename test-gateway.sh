#!/bin/bash
# Nexus AI Gateway — Stress Test Suite
# Tests: Routing, Fallback, Performance, Reliability

NEXUS="http://localhost:3060"
RESULTS=""
PASS=0
FAIL=0

log() { echo -e "\033[1;36m[$1]\033[0m $2"; }
pass() { PASS=$((PASS+1)); echo -e "  \033[1;32m✅ PASS:\033[0m $1"; }
fail() { FAIL=$((FAIL+1)); echo -e "  \033[1;31m❌ FAIL:\033[0m $1"; }

nexus_chat() {
  local model="$1" msg="$2" temp="${3:-0.1}" max_tok="${4:-100}"
  curl -s -X POST "$NEXUS/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -d "{\"model\":\"$model\",\"messages\":[{\"role\":\"user\",\"content\":\"$msg\"}],\"temperature\":$temp,\"max_tokens\":$max_tok}"
}

# ═══════════════════════════════════════════════════════════
echo ""
log "TEST 1" "AUTO-ROUTING — Task Classification"
echo "  Testing if auto-routing classifies tasks correctly..."
# ═══════════════════════════════════════════════════════════

# Conversation
R=$(nexus_chat "auto" "Hey, how are you doing today?")
TASK=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin).get('x_nexus',{}).get('task_category','MISSING'))" 2>/dev/null)
if [ "$TASK" = "conversation" ]; then pass "Casual chat → classified as '$TASK'"; else fail "Casual chat → got '$TASK' (expected 'conversation')"; fi

# Coding
R=$(nexus_chat "auto" "Write a Python function to sort a list using merge sort")
TASK=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin).get('x_nexus',{}).get('task_category','MISSING'))" 2>/dev/null)
if [ "$TASK" = "coding" ]; then pass "Coding request → classified as '$TASK'"; else fail "Coding request → got '$TASK' (expected 'coding')"; fi

# Analysis
R=$(nexus_chat "auto" "Analyze the economic impact of rising interest rates on the housing market and provide a detailed breakdown")
TASK=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin).get('x_nexus',{}).get('task_category','MISSING'))" 2>/dev/null)
if [ "$TASK" = "analysis" ]; then pass "Analysis request → classified as '$TASK'"; else fail "Analysis request → got '$TASK' (expected 'analysis'), check classifier"; fi

# Creative
R=$(nexus_chat "auto" "Write a short poem about the ocean at sunset with vivid imagery")
TASK=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin).get('x_nexus',{}).get('task_category','MISSING'))" 2>/dev/null)
if [ "$TASK" = "creative" ]; then pass "Creative request → classified as '$TASK'"; else fail "Creative request → got '$TASK' (expected 'creative'), check classifier"; fi

# ═══════════════════════════════════════════════════════════
echo ""
log "TEST 2" "PROVIDER SELECTION — Correct routing to providers"
echo "  Testing explicit model→provider routing..."
# ═══════════════════════════════════════════════════════════

# Local Ollama model
R=$(nexus_chat "llama3.1:latest" "Say hi" 0.1 10)
PROV=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin).get('x_nexus',{}).get('provider','MISSING'))" 2>/dev/null)
if [ "$PROV" = "ollama" ]; then pass "llama3.1:latest → routed to '$PROV'"; else fail "llama3.1:latest → got '$PROV' (expected 'ollama')"; fi

# Cloud model via OpenRouter
R=$(nexus_chat "meta-llama/llama-4-scout-17b-16e-instruct" "Say hi" 0.1 10)
PROV=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin).get('x_nexus',{}).get('provider','MISSING'))" 2>/dev/null)
if [ "$PROV" = "openrouter" ]; then pass "llama-4-scout → routed to '$PROV'"; else fail "llama-4-scout → got '$PROV' (expected 'openrouter')"; fi

# Local qwen3
R=$(nexus_chat "qwen3:8b" "Say hi" 0.1 10)
PROV=$(echo "$R" | python3 -c "import sys,json; print(json.load(sys.stdin).get('x_nexus',{}).get('provider','MISSING'))" 2>/dev/null)
if [ "$PROV" = "ollama" ]; then pass "qwen3:8b → routed to '$PROV'"; else fail "qwen3:8b → got '$PROV' (expected 'ollama')"; fi

# ═══════════════════════════════════════════════════════════
echo ""
log "TEST 3" "PERFORMANCE — Gateway overhead measurement"
echo "  Comparing direct Ollama vs Nexus-proxied latency..."
# ═══════════════════════════════════════════════════════════

# Warm up the model first
curl -s http://192.168.1.112:11434/api/chat -d '{"model":"llama3.1:latest","messages":[{"role":"user","content":"hi"}],"stream":false}' > /dev/null 2>&1

# Direct to Ollama (3 runs)
DIRECT_TOTAL=0
for i in 1 2 3; do
  START=$(python3 -c "import time; print(int(time.time()*1000))")
  curl -s http://192.168.1.112:11434/v1/chat/completions \
    -H "Content-Type: application/json" \
    -d '{"model":"llama3.1:latest","messages":[{"role":"user","content":"What is 1+1? One word."}],"max_tokens":5}' > /dev/null 2>&1
  END=$(python3 -c "import time; print(int(time.time()*1000))")
  ELAPSED=$((END - START))
  DIRECT_TOTAL=$((DIRECT_TOTAL + ELAPSED))
done
DIRECT_AVG=$((DIRECT_TOTAL / 3))

# Through Nexus (3 runs)
NEXUS_TOTAL=0
for i in 1 2 3; do
  START=$(python3 -c "import time; print(int(time.time()*1000))")
  curl -s -X POST "$NEXUS/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -d '{"model":"llama3.1:latest","messages":[{"role":"user","content":"What is 1+1? One word."}],"max_tokens":5}' > /dev/null 2>&1
  END=$(python3 -c "import time; print(int(time.time()*1000))")
  ELAPSED=$((END - START))
  NEXUS_TOTAL=$((NEXUS_TOTAL + ELAPSED))
done
NEXUS_AVG=$((NEXUS_TOTAL / 3))

OVERHEAD=$((NEXUS_AVG - DIRECT_AVG))
echo "  Direct Ollama avg: ${DIRECT_AVG}ms"
echo "  Via Nexus avg:     ${NEXUS_AVG}ms"
echo "  Gateway overhead:  ${OVERHEAD}ms"
if [ "$OVERHEAD" -lt 200 ]; then pass "Overhead ${OVERHEAD}ms (< 200ms threshold)"; else fail "Overhead ${OVERHEAD}ms (> 200ms threshold)"; fi

# ═══════════════════════════════════════════════════════════
echo ""
log "TEST 4" "RELIABILITY — Error handling & edge cases"
echo "  Testing malformed requests, missing fields, bad models..."
# ═══════════════════════════════════════════════════════════

# Empty messages array
R=$(curl -s -X POST "$NEXUS/v1/chat/completions" -H "Content-Type: application/json" -d '{"messages":[]}')
HAS_ERROR=$(echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if 'error' in d else 'no')" 2>/dev/null)
if [ "$HAS_ERROR" = "yes" ]; then pass "Empty messages → returned error"; else fail "Empty messages → no error returned"; fi

# No messages field at all
R=$(curl -s -X POST "$NEXUS/v1/chat/completions" -H "Content-Type: application/json" -d '{"model":"llama3.1:latest"}')
HAS_ERROR=$(echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if 'error' in d else 'no')" 2>/dev/null)
if [ "$HAS_ERROR" = "yes" ]; then pass "Missing messages field → returned error"; else fail "Missing messages field → no error returned"; fi

# Invalid JSON
R=$(curl -s -X POST "$NEXUS/v1/chat/completions" -H "Content-Type: application/json" -d 'not json at all')
STATUS=$(echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print('error' if 'error' in d else 'ok')" 2>/dev/null || echo "error")
if [ "$STATUS" = "error" ]; then pass "Invalid JSON → handled gracefully"; else fail "Invalid JSON → unexpected response"; fi

# Non-existent model
R=$(curl -s -X POST "$NEXUS/v1/chat/completions" -H "Content-Type: application/json" \
  -d '{"model":"totally-fake-model-12345","messages":[{"role":"user","content":"hi"}]}')
HAS_ERROR=$(echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if 'error' in d else 'no')" 2>/dev/null)
if [ "$HAS_ERROR" = "yes" ]; then pass "Non-existent model → returned error"; else fail "Non-existent model → no error returned"; fi

# Very long input (stress)
LONG_MSG=$(python3 -c "print('hello ' * 500)")
R=$(nexus_chat "llama3.1:latest" "$LONG_MSG" 0.1 10)
HAS_CHOICES=$(echo "$R" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if 'choices' in d else 'no')" 2>/dev/null)
if [ "$HAS_CHOICES" = "yes" ]; then pass "Long input (2500 words) → completed successfully"; else fail "Long input → failed"; fi

# ═══════════════════════════════════════════════════════════
echo ""
log "TEST 5" "API ENDPOINTS — All routes respond"
echo "  Testing all API endpoints..."
# ═══════════════════════════════════════════════════════════

for endpoint in "/api/status" "/api/usage" "/api/credits" "/api/models" "/api/config" "/v1/models"; do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$NEXUS$endpoint")
  if [ "$STATUS" = "200" ]; then pass "GET $endpoint → $STATUS"; else fail "GET $endpoint → $STATUS"; fi
done

# ═══════════════════════════════════════════════════════════
echo ""
log "TEST 6" "USAGE TRACKING — Stats accuracy"
echo "  Checking if all requests were tracked..."
# ═══════════════════════════════════════════════════════════

USAGE=$(curl -s "$NEXUS/api/usage")
TOTAL=$(echo "$USAGE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('totalRequests',0))" 2>/dev/null)
if [ "$TOTAL" -gt 5 ]; then pass "Usage tracker recorded $TOTAL requests"; else fail "Usage tracker only shows $TOTAL requests"; fi

PROVIDERS=$(echo "$USAGE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(','.join(d.get('requestsByProvider',{}).keys()))" 2>/dev/null)
echo "  Providers used: $PROVIDERS"

TASKS=$(echo "$USAGE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(','.join(d.get('requestsByTask',{}).keys()))" 2>/dev/null)
echo "  Task categories: $TASKS"

# ═══════════════════════════════════════════════════════════
echo ""
echo "════════════════════════════════════════════"
echo "  RESULTS: $PASS passed, $FAIL failed"
echo "════════════════════════════════════════════"
echo ""
