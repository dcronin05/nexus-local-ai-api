# Nexus AI Gateway

Intelligent routing proxy for AI model access. Provides a single OpenAI-compatible endpoint that routes requests across multiple providers (OpenRouter, Ollama) with automatic fallback, model discovery, and usage tracking.

## Quick Start

```bash
# Clone and install
git clone git@github.com:dcronin05/nexus-local-ai-api.git
cd nexus-local-ai-api
npm ci

# Configure
cp .env.example .env   # Edit with your API keys

# Run
npm run dev             # Development (hot reload)
npm run build && npm start  # Production
```

## API Reference

**Base URL:** `http://192.168.1.112:3060` (production) or `http://localhost:3060` (local dev)

### Chat Completions

```bash
# Basic request
curl -X POST http://192.168.1.112:3060/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama3.1:latest",
    "messages": [{"role": "user", "content": "Hello"}]
  }'

# With tool calling
curl -X POST http://192.168.1.112:3060/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3:8b",
    "messages": [{"role": "user", "content": "What time is it?"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_time",
        "description": "Get current time",
        "parameters": {"type": "object", "properties": {}}
      }
    }],
    "tool_choice": "auto"
  }'
```

**Supported parameters:** `model`, `messages`, `temperature`, `max_tokens`, `top_p`, `stop`, `stream`, `tools`, `tool_choice`

**Response includes:** Standard OpenAI format + `x_nexus` metadata (provider, routing decision, latency).

### Available Models

| Model | Provider | Best For |
|-------|----------|----------|
| `llama3.1:latest` | ollama (local) | Fast general tasks |
| `qwen3:8b` | ollama (local) | Reasoning, tool calling |
| `deepseek-coder-v2:16b` | ollama (local) | Code generation |
| `gemma3:12b` | ollama (local) | General purpose |
| `google/gemma-3-27b-it:free` | openrouter | Free cloud fallback |
| Any OpenRouter model ID | openrouter | Specialized tasks |

Use `model: "auto"` or omit to let Nexus route automatically.

### Management Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/status` | GET | Provider health + uptime |
| `/api/models` | GET | Full model catalog (355+ models) |
| `/v1/models` | GET | OpenAI-compatible model list |
| `/api/usage` | GET | Request stats and cost tracking |
| `/api/credits` | GET | OpenRouter credit balance |
| `/api/config` | GET | Gateway configuration |

### Admin Endpoints (Remote Management)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/admin/version` | GET | Git commit, branch, version |
| `/api/admin/update` | POST | Self-update: git pull → build → restart |
| `/api/admin/restart` | POST | Restart the gateway process |
| `/api/admin/logs` | GET | Recent PM2 log output |

```bash
# Check version
curl http://192.168.1.112:3060/api/admin/version

# Deploy latest code (no SSH needed)
curl -X POST http://192.168.1.112:3060/api/admin/update
```

## Architecture

```
Client (any app/agent) ──► Nexus Gateway ──► ModelRouter ──► OllamaProvider (local)
                              :3060                     └──► OpenRouterProvider (cloud)
```

- **Gateway** proxies all OpenAI-compatible parameters faithfully
- **ModelRouter** selects provider based on model availability + priority
- **Fallback**: if local Ollama fails, automatically tries OpenRouter
- **Tool calling**: full passthrough — client sends `tools`, model returns `tool_calls`

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NEXUS_PORT` | `3060` | Server port |
| `NEXUS_HOST` | `0.0.0.0` | Bind address |
| `OPENROUTER_API_KEY` | — | OpenRouter API key |
| `OPENROUTER_DEFAULT_MODEL` | `google/gemma-3-27b-it:free` | Default cloud model |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama instance URL |
| `OLLAMA_DEFAULT_MODEL` | `llama3.1` | Default local model |
| `AI_PROVIDER_PRIORITY` | `openrouter,ollama` | Provider fallback order |

## Deployment

Production instance runs on the Windows host (`192.168.1.112`) via PM2:

```bash
pm2 start dist/index.js --name nexus-gateway
pm2 save
```

GitHub: https://github.com/dcronin05/nexus-local-ai-api
