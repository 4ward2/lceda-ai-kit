# lceda-ai-kit

AI chat and impedance tools for **JLCEDA Pro** (嘉立创 EDA 专业版), built on its
official extension API.

```
 ┌──────────────────────┐   OpenAI-compatible API   ┌───────────────┐
 │  apps/edamax-chat     │ ────────────────────────▶ │  your model   │
 │  browser UI + Node    │ ◀──── tool calls ──────── └───────────────┘
 │  server (127.0.0.1)   │
 └──────────┬───────────┘
            │ HTTP  /v1/tools, /v1/tools/call
            ▼
 ┌──────────────────────┐   WebSocket (9050–9059)   ┌──────────────────────────────┐
 │  MCP bridge server    │ ◀──────────────────────── │  bridge extension in JLCEDA  │
 │  (upstream, not here) │                           │  Pro: official eda.* API     │
 └──────────────────────┘                           └──────────────────────────────┘

 extension/edamax-adaptive-pour   another extension in JLCEDA Pro (official eda.* API)
 impedance/                       offline solver + local web panel, no EDA needed
```

| Part | What it does | Runs on |
|---|---|---|
| `apps/edamax-chat/` | Chat window: streaming, stop, Markdown, live tool-call cards; turns the bridge's tools into model function calls | Node 20+, browser |
| `extension/edamax-adaptive-pour/` | Rebuilds copper pours on affected layers after a pad changes, then reports new DRC errors | JLCEDA Pro V3 extension |
| `impedance/` | Target impedance → trace width/spacing (IPC-2141A), per-signal-class targets, local web panel | Python 3.9+, no dependencies |

## What uses the official extension API

Everything that touches the editor goes through the official extension API
(`eda.*` objects available to extensions): the adaptive-pour extension in this
repo, and the upstream bridge extension that the chat app talks to. Nothing here
injects code into the client, patches its files, or uses a debugging port.

## Not included

**This repository does not contain any rules, data or code extracted from the
JLCEDA client or from JLC's websites.** There is no DRC rule table, no stackup
library and no client JavaScript. The stackup file under
`impedance/examples/` is hand-written example data.

The MCP bridge is a separate upstream project and is not copied here:

- **jlc-eda-mcp** by XuF163 — <https://github.com/XuF163/jlc-eda-mcp>
  (GitCode mirror: <https://gitcode.com/qwert124516/jlc-eda-mcp>). Its bridge
  extension `jlceda-mcp-bridge` declares Apache-2.0; the repository root has no
  LICENSE file, so it is linked rather than vendored.

## Setup

1. **Bridge.** Follow the upstream README: build or download the
   `jlceda-mcp-bridge` `.eext`, import it in JLCEDA Pro's extension manager,
   restart the EDA, and start the upstream bridge server so it exposes HTTP
   tools (the chat app expects `http://127.0.0.1:19151`, change with
   `JLC_MCP_HTTP`). Test on a throw-away project first; write tools modify the
   open document.
2. **Chat.** See [`apps/edamax-chat/README.md`](apps/edamax-chat/README.md):
   build `web/`, set `EDAMAX_API_KEY`, run `node server.mjs`, open
   <http://127.0.0.1:19321>.
3. **Adaptive pour.** See
   [`extension/edamax-adaptive-pour/README.md`](extension/edamax-adaptive-pour/README.md).
4. **Impedance.** See [`impedance/README.md`](impedance/README.md):
   `python impedance/server.py` and open <http://127.0.0.1:8780>.

## 中文说明

给嘉立创 EDA 专业版用的 AI 对话与阻抗工具，**只基于官方扩展 API**。

- `apps/edamax-chat/`：本地对话窗口，接任意 OpenAI 兼容模型，把 MCP 桥接暴露的工具交给模型调用；API Key 只从环境变量读取。
- `extension/edamax-adaptive-pour/`：焊盘改动后自动重建受影响铜层的铺铜并检查 DRC，只用官方 `eda.*` 接口。
- `impedance/`：离线阻抗求解（IPC-2141A）和本地网页面板，叠层由用户自己提供。

**本仓库不包含任何从嘉立创客户端或网页提取的规则、数据或代码。** 没有注入客户端、没有改客户端文件、不用调试端口。
MCP 桥接是上游项目 XuF163/jlc-eda-mcp，没有复制进来，安装方法见上面的 Setup。

## License

Apache-2.0, Copyright 2026 4ward2. See [LICENSE](LICENSE).
