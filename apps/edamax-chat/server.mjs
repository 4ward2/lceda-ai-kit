import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { scoreSchematicComplexity } from './project-complexity.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const dataDir = path.join(root, 'data');
const configFile = path.join(dataDir, 'config.json');
const sessionsFile = path.join(dataDir, 'sessions.json');
const host = process.env.EDAMAX_HOST || '127.0.0.1';
const port = Number(process.env.EDAMAX_PORT || 19321);
const jlcBase = process.env.JLC_MCP_HTTP || 'http://127.0.0.1:19151';

const EDA_SYSTEM_PROMPT = [
  '你是 EDAMax，嘉立创 EDA（JLCEDA Pro）原理图工程助手，通过 MCP 工具实时操作用户当前打开的原理图。工具名以 jlc__ 前缀提供（点号写成双下划线）。',
  '',
  '【总原则】',
  '- 先读后写：动手前先用 jlc__schematic__list_components / jlc__schematic__snapshot 了解现状。',
  '- 每次写操作前用一句话说明将改什么。',
  '- 优先高层工具（apply_ir / search_devices / verify_netlist / capture_png），避免 jlc__eda__invoke、jlc__eda__get（底层不安全）。',
  '',
  '【放器件必须先查库】apply_ir 的 components 需要真实 deviceUuid 与 libraryUuid。放任何器件前先调用 jlc__library__search_devices（如 "resistor 10k 0603"），从结果取 deviceUuid/libraryUuid 填入 IR，绝不凭空编造 UUID。',
  '',
  '【SchematicIR v1 —— apply_ir 的 ir 参数】',
  '顶层：{ version:1, units:"mm", page:{ensure:false}, components:[], netFlags:[], netPorts:[], connections:[], post:{} }',
  '- units 用 "mm"（毫米坐标）。',
  '- page.ensure:false —— 用户已打开原理图时务必设 false，避免误建新页。',
  '- components[]：{ id:"R1", deviceUuid, libraryUuid, x, y, rotation:0, designator:"R1", name:"10k" }，id 稳定唯一。',
  '- netFlags[]：电源/地符号 { id:"GND1", identification:"Ground", net:"GND", x, y }。',
  '- netPorts[]：端口 { id:"VIN1", direction:"IN", net:"VIN", x, y }。',
  '- connections[]：仅用于连接两个真实器件引脚 { id:"C1", from:{componentId:"R1",pinNumber:"2"}, to:{componentId:"R2",pinNumber:"1"}, net:"VOUT", style:"manhattan" }。from/to 的 componentId 必须是 components[].id 且带 pinNumber，绝不能指向 netFlags/netPorts 的 id（否则 apply_ir 会 500）。',
  '- 把某个引脚接到电源/地/命名网络（VIN/VOUT/GND 等）：不要用 connections，改用 jlc__schematic__netlabel__attach_pin（在指定 primitiveId+pinNumber 处拉出带 NET 的短线），或 wires[].net。',
  '- post：{ drc:{strict:false}, save:true, zoomToAll:true } 仅最后一步启用。',
  '- 增量：apply_ir 默认按 id upsert，不删未出现图元；clearMode 默认 "mcp"（安全），绝不用 "all"（清空整页，高危）。',
  '',
  '【推荐流程】1) 读现状 2) search_devices 拿 UUID 3) apply_ir 放器件+connections 4) jlc__schematic__verify_netlist 校验 5) jlc__view__capture_png 截图确认。可拆多回合：先放器件、再补连线、最后收尾。',
  '',
  '【PCB 布局（Layout-as-Code）】当用户已切到 PCB 标签时可用 jlc__pcb__* 工具：',
  '- jlc__pcb__list_components：读取当前 PCB 上所有器件的位号/坐标(x,y,mil)/旋转，动手布局前先读。',
  '- jlc__pcb__apply_layout_ir：应用 LayoutIR v1。顶层 { version:1, units:"mm", importFromSchematic, placements:[], board, pours:[], routing, drc:true, save:false }。',
  '  · importFromSchematic:true —— 首次从关联原理图导入器件与网络（幂等）；已导入则可省略。',
  '  · placements[]：{ designator:"R1", x, y, rotation:0, layer:"top"|"bottom", lock:false }。按位号定位已存在的器件（不是创建）。位号必须与 PCB 上一致，找不到会记入 skippedPlacements。',
  '  · board（可选）：{ shape:"rect", x, y, width, height } 画矩形板框。',
  '  · pours[]（可选）：{ id:"GND_TOP", net:"GND", layer:"top", polygon:[x1,y1,x2,y2,...], priority, fillMethod:"solid" } 覆铜；polygon 为闭合多边形顶点(至少3点)。',
  '  · routing（可选）：{ mode:"nets"|"all"|"none", nets:["VOUT","GND"], layers:["top","bottom"], existingPrimitiveMode:"keep"|"remove" } 自动布线；mode:"nets" 时必须给 nets。',
  '  · 坐标默认 units:"mm"（内部换算成 mil）。drc:true 时返回 DRC 违规列表作为验收，空即通过。',
  '- jlc__pcb__drc：单独跑 DRC 返回违规列表。',
  '【PCB 推荐流程】1) list_components 读现状 2) apply_layout_ir 先 placements 布局 3) 需要时再 board/pours 4) routing 布线 5) 看 drc 结果，有违规再调整。可拆多回合。'
].join('\n');

const defaults = {
  apiBase: 'https://api.openai.com/v1', model: 'gpt-4.1-mini',
  temperature: 0.2, maxContextMessages: 40, enableJlcTools: true,
  systemPrompt: EDA_SYSTEM_PROMPT
};

await fs.mkdir(dataDir, { recursive: true });
async function readJson(file, fallback) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return structuredClone(fallback); } }
async function writeJson(file, value) { await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8'); }
// The API key is never stored on disk: it is read from the environment on every request.
function envOverrides() {
  const out = { apiKey: process.env.EDAMAX_API_KEY || process.env.OPENAI_API_KEY || '' };
  if (process.env.EDAMAX_API_BASE) out.apiBase = process.env.EDAMAX_API_BASE;
  if (process.env.EDAMAX_MODEL) out.model = process.env.EDAMAX_MODEL;
  return out;
}
async function config() {
  const stored = await readJson(configFile, {});
  delete stored.apiKey;
  return { ...defaults, ...stored, ...envOverrides() };
}
async function sessions() { return await readJson(sessionsFile, []); }

function send(res, status, value, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(value));
}
async function body(req) {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}
function safeConfig(value) { return { ...value, apiKey: value.apiKey ? '••••••••' + value.apiKey.slice(-4) : '' }; }
async function jlc(pathname, options = {}) {
  const response = await fetch(jlcBase + pathname, { ...options, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`JLC MCP HTTP ${response.status}`);
  return response.json();
}
async function toolDefinitions() {
  const result = await jlc('/v1/tools');
  return (result.tools || []).map(tool => ({
    type: 'function', function: {
      name: tool.name.replaceAll('.', '__'),
      description: tool.description,
      parameters: tool.inputSchema || { type: 'object', properties: {} }
    }
  }));
}
async function callTool(call) {
  const name = call.function.name.replaceAll('__', '.');
  const args = JSON.parse(call.function.arguments || '{}');
  return jlc('/v1/tools/call', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, arguments: args })
  });
}
async function jlcCallTool(name, args = {}) {
  return jlc('/v1/tools/call', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, arguments: args })
  });
}
// Actively wait for the EDA extension's WebSocket bridge to be connected.
// The MCP server is the WS *server* (extension dials in on 9050-9059), so we
// cannot force a connection — we poll status within a timeout and, once linked,
// flash a toast inside the EDA editor and run a round-trip ping to confirm.
async function jlcConnect(timeoutMs = 15000) {
  const started = Date.now();
  let attempts = 0, bridge = null, lastError = null;
  while (Date.now() - started < timeoutMs) {
    attempts++;
    try {
      const status = await jlc('/v1/status');
      bridge = status?.bridge || null;
      if (bridge?.connected) {
        let ping = null;
        try { ping = await jlcCallTool('jlc.bridge.ping'); } catch (error) { lastError = error.message; }
        try { await jlcCallTool('jlc.bridge.show_message', { message: 'EDAMax 对话窗口已连接' }); } catch {}
        return { connected: true, attempts, elapsedMs: Date.now() - started, bridge, ping };
      }
    } catch (error) { lastError = error.message; }
    await new Promise(resolve => setTimeout(resolve, 1200));
  }
  return { connected: false, attempts, elapsedMs: Date.now() - started, bridge, error: lastError };
}
async function complete(cfg, messages) {
  const tools = cfg.enableJlcTools ? await toolDefinitions() : [];
  const working = [{ role: 'system', content: cfg.systemPrompt }, ...messages.slice(-cfg.maxContextMessages)];
  for (let round = 0; round < 6; round++) {
    const response = await fetch(cfg.apiBase.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST', signal: AbortSignal.timeout(120000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: cfg.model, temperature: cfg.temperature, messages: working, ...(tools.length ? { tools, tool_choice: 'auto' } : {}) })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.error?.message || `Model API ${response.status}`);
    const message = payload.choices?.[0]?.message;
    if (!message) throw new Error('模型没有返回消息');
    working.push(message);
    if (!message.tool_calls?.length) return { message, usage: payload.usage, toolRounds: round };
    for (const call of message.tool_calls) {
      let output;
      try { output = await callTool(call); } catch (error) { output = { ok: false, error: error.message }; }
      working.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(output) });
    }
  }
  throw new Error('工具调用轮数超过安全上限 6');
}

function safeParse(text) { try { return JSON.parse(text || '{}'); } catch { return text || {}; } }

// Streams one model round, forwarding content deltas via `emit` and returning
// the accumulated assistant content plus any (fragmented) tool calls.
async function streamModelRound(cfg, working, tools, signal, emit) {
  const response = await fetch(cfg.apiBase.replace(/\/$/, '') + '/chat/completions', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.model, temperature: cfg.temperature, stream: true, messages: working, ...(tools.length ? { tools, tool_choice: 'auto' } : {}) })
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let message; try { message = JSON.parse(text)?.error?.message; } catch {}
    throw new Error(message || `Model API ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', content = '';
  const toolCalls = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      let json; try { json = JSON.parse(payload); } catch { continue; }
      const delta = json.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) { content += delta.content; emit('delta', { content: delta.content }); }
      for (const tc of delta.tool_calls || []) {
        const i = tc.index ?? 0;
        toolCalls[i] ??= { id: tc.id, type: 'function', function: { name: '', arguments: '' } };
        if (tc.id) toolCalls[i].id = tc.id;
        if (tc.function?.name) toolCalls[i].function.name += tc.function.name;
        if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
      }
    }
  }
  return { content, toolCalls: toolCalls.filter(Boolean) };
}

// Full agentic streaming loop: model -> tools -> model, emitting SSE events.
async function completeStream(cfg, messages, emit, signal) {
  const tools = cfg.enableJlcTools ? await toolDefinitions() : [];
  const working = [{ role: 'system', content: cfg.systemPrompt }, ...messages.slice(-cfg.maxContextMessages)];
  const maxRounds = cfg.maxToolRounds || 16;
  for (let round = 0; round < maxRounds; round++) {
    const { content, toolCalls } = await streamModelRound(cfg, working, tools, signal, emit);
    working.push({ role: 'assistant', content: content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
    if (!toolCalls.length) return emit('done', { round });
    for (const call of toolCalls) {
      emit('tool_call', { id: call.id, name: call.function.name.replaceAll('__', '.'), arguments: safeParse(call.function.arguments) });
      let output;
      try { output = await callTool(call); } catch (error) { output = { ok: false, error: error.message }; }
      if (output && output.ok === false && output.error) emit('tool_result', { id: call.id, error: String(output.error) });
      else emit('tool_result', { id: call.id, result: output });
      working.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(output) });
    }
  }
  emit('error', { message: `工具调用轮数超过安全上限 ${maxRounds}` });
}

const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
async function staticFile(req, res) {
  const rel = req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
  const target = path.resolve(publicDir, rel);
  if (!target.startsWith(path.resolve(publicDir))) return send(res, 403, { error: 'forbidden' });
  try { const bytes = await fs.readFile(target); res.writeHead(200, { 'Content-Type': mime[path.extname(target)] || 'application/octet-stream' }); res.end(bytes); }
  catch { send(res, 404, { error: 'not found' }); }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/api/health') return send(res, 200, { ok: true, jlcBase });
    if (url.pathname === '/api/jlc/status') { try { return send(res, 200, await jlc('/v1/status')); } catch (e) { return send(res, 200, { ok: false, error: e.message }); } }
    if (url.pathname === '/api/jlc/connect' && req.method === 'POST') {
      const input = await body(req).catch(() => ({}));
      try { return send(res, 200, await jlcConnect(Math.min(60000, Number(input.timeoutMs) || 15000))); }
      catch (e) { return send(res, 200, { connected: false, error: e.message }); }
    }
    if (url.pathname === '/api/jlc/projects/complexity' && req.method === 'POST') return send(res, 200, scoreSchematicComplexity(await body(req)));
    if (url.pathname === '/api/config' && req.method === 'GET') return send(res, 200, safeConfig(await config()));
    if (url.pathname === '/api/config' && req.method === 'PUT') {
      const next = { ...(await readJson(configFile, {})), ...(await body(req)) };
      delete next.apiKey;
      await writeJson(configFile, next); return send(res, 200, safeConfig(await config()));
    }
    if (url.pathname === '/api/sessions' && req.method === 'GET') return send(res, 200, await sessions());
    if (url.pathname === '/api/sessions' && req.method === 'POST') {
      const list = await sessions(); const item = { id: crypto.randomUUID(), title: '新会话', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
      list.unshift(item); await writeJson(sessionsFile, list); return send(res, 201, item);
    }
    if (url.pathname.startsWith('/api/sessions/') && req.method === 'PUT') {
      const id = url.pathname.split('/').pop(); const list = await sessions(); const i = list.findIndex(x => x.id === id);
      if (i < 0) return send(res, 404, { error: 'session not found' });
      list[i] = { ...list[i], ...(await body(req)), id, updatedAt: Date.now() }; await writeJson(sessionsFile, list); return send(res, 200, list[i]);
    }
    if (url.pathname.startsWith('/api/sessions/') && req.method === 'DELETE') {
      const id = url.pathname.split('/').pop(); const list = (await sessions()).filter(x => x.id !== id); await writeJson(sessionsFile, list); return send(res, 200, { ok: true });
    }
    if (url.pathname === '/api/chat' && req.method === 'POST') {
      const input = await body(req); const cfg = await config();
      if (!cfg.apiKey) return send(res, 400, { error: '未设置 API Key：请设置环境变量 EDAMAX_API_KEY 后重启服务' });
      return send(res, 200, await complete(cfg, input.messages || []));
    }
    if (url.pathname === '/api/chat/stream' && req.method === 'POST') {
      const input = await body(req); const cfg = await config();
      if (!cfg.apiKey) return send(res, 400, { error: '未设置 API Key：请设置环境变量 EDAMAX_API_KEY 后重启服务' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' });
      const controller = new AbortController();
      req.on('close', () => controller.abort());
      const emit = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
      try { await completeStream(cfg, input.messages || [], emit, controller.signal); }
      catch (error) { if (!controller.signal.aborted) emit('error', { message: error.message }); }
      finally { res.end(); }
      return;
    }
    return staticFile(req, res);
  } catch (error) { send(res, 500, { error: error.message }); }
});
server.listen(port, host, () => console.log(`EDAMax Chat listening at http://${host}:${port}`));
