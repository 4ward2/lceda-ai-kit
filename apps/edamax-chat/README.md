# edamax-chat

A local chat window for an EDA agent. It talks to any OpenAI-compatible API and
exposes the tools of a running JLCEDA MCP bridge to the model as function calls.

- Streaming output, stop mid-way, Markdown with code highlighting and copy.
- MCP tool calls are shown live as collapsible cards (tool name, arguments, result).
- Copy / regenerate messages, rename and delete sessions; sessions are kept in
  `data/sessions.json` on your machine.
- A schematic-complexity scorer (`project-complexity.mjs`) behind
  `POST /api/jlc/projects/complexity`.

## Run

```sh
cd web && npm install && npm run build && cd ..   # builds web/ into public/
export EDAMAX_API_KEY=...                          # PowerShell: $env:EDAMAX_API_KEY="..."
node server.mjs                                    # http://127.0.0.1:19321
```

| Variable | Meaning | Default |
|---|---|---|
| `EDAMAX_API_KEY` (or `OPENAI_API_KEY`) | model API key, **only read from the environment, never written to disk** | — |
| `EDAMAX_API_BASE` | OpenAI-compatible base URL | `https://api.openai.com/v1` |
| `EDAMAX_MODEL` | model name | `gpt-4.1-mini` |
| `EDAMAX_HOST` / `EDAMAX_PORT` | listen address | `127.0.0.1` / `19321` |
| `JLC_MCP_HTTP` | HTTP endpoint of the MCP bridge | `http://127.0.0.1:19151` |

Other settings (model, temperature, context length, system prompt) can be changed
in the settings dialog and are stored in `data/config.json`; the key is never
stored there.

Front-end development: `cd web && npm run dev` (port 5173, `/api` proxied to 19321).

## Streaming API

`POST /api/chat/stream` (SSE). Events: `delta` (text), `tool_call` (name +
arguments), `tool_result` (result or `error`), `done`, `error`. Closing the
connection aborts the upstream request.

## Connecting to the EDA

The bridge extension inside JLCEDA Pro dials **out** to a local WebSocket server
(port 9050, negotiated over 9050–9059 for multiple windows), so the server
cannot dial in. Click the status pill in the lower left (`POST /api/jlc/connect`):
it polls the bridge, and once linked shows a toast inside the editor and does a
`jlc.bridge.ping` round trip. See the top-level README for installing the bridge.

## 中文

本地的 EDA Agent 对话窗口：接任意 OpenAI 兼容接口，把嘉立创 MCP 桥接暴露的工具交给模型调用；流式输出、可中途停止、
工具调用以卡片实时展示。**API Key 只从环境变量 `EDAMAX_API_KEY` 读取，不写入磁盘。**
