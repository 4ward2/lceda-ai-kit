import './style.css';
import { renderMarkdown } from './markdown.js';
import * as API from './api.js';

const el = (tag, props = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of [].concat(children)) if (child != null && child !== false) node.append(child);
  return node;
};
const $ = (sel, root = document) => root.querySelector(sel);

const state = {
  sessions: [],
  current: null,
  config: {},
  jlc: null,
  connecting: false,
  stopStream: null
};

// ---------- persistence helpers ----------
async function persistCurrent() {
  if (!state.current) return;
  const saved = await API.saveSession(state.current);
  const i = state.sessions.findIndex((s) => s.id === saved.id);
  // Keep local (unsaved streaming) messages but adopt server timestamps/title.
  state.sessions[i] = { ...state.current, updatedAt: saved.updatedAt };
  renderSessions();
}

async function newSession() {
  state.current = await API.createSession();
  state.sessions.unshift(state.current);
  renderSessions();
  renderChat();
}

async function selectSession(id) {
  if (state.stopStream) return;
  state.current = state.sessions.find((s) => s.id === id);
  renderSessions();
  renderChat();
}

async function removeSession(id) {
  if (!confirm('删除该会话？此操作不可撤销。')) return;
  await API.deleteSession(id);
  state.sessions = state.sessions.filter((s) => s.id !== id);
  if (state.current?.id === id) state.current = state.sessions[0] || null;
  renderSessions();
  renderChat();
}

async function renameSession(session) {
  const title = prompt('会话名称', session.title);
  if (title == null) return;
  session.title = title.trim() || session.title;
  await API.saveSession(session);
  renderSessions();
}

// ---------- rendering ----------
function renderSessions() {
  const list = $('#sessions');
  if (!list) return;
  list.replaceChildren(
    ...state.sessions.map((s) => {
      const active = state.current?.id === s.id;
      return el('div', { class: `session${active ? ' active' : ''}`, onClick: () => selectSession(s.id) }, [
        el('div', { class: 'sTitle' }, s.title || '新会话'),
        el('small', {}, new Date(s.updatedAt).toLocaleString()),
        el('div', { class: 'sActions' }, [
          el('button', { title: '重命名', onClick: (e) => { e.stopPropagation(); renameSession(s); } }, '✎'),
          el('button', { title: '删除', onClick: (e) => { e.stopPropagation(); removeSession(s.id); } }, '🗑')
        ])
      ]);
    })
  );
}

function toolCard(tool) {
  const status = tool.error ? 'err' : tool.result === undefined ? 'run' : 'ok';
  const badge = { run: '调用中', ok: '完成', err: '失败' }[status];
  const body = el('div', { class: 'tcBody' }, [
    el('div', { class: 'tcSection' }, [el('label', {}, '参数'), el('pre', {}, safeJson(tool.args))]),
    tool.result !== undefined || tool.error
      ? el('div', { class: 'tcSection' }, [
          el('label', {}, tool.error ? '错误' : '返回'),
          el('pre', {}, tool.error || safeJson(tool.result))
        ])
      : el('div', { class: 'tcRunning' }, '正在执行…')
  ]);
  body.hidden = status === 'ok'; // collapse successful calls by default
  const head = el('div', { class: 'tcHead', onClick: () => (body.hidden = !body.hidden) }, [
    el('span', { class: 'tcIcon' }, '🔧'),
    el('b', {}, tool.name),
    el('span', { class: `tcBadge ${status}` }, badge),
    el('span', { class: 'tcToggle' }, '▾')
  ]);
  return el('div', { class: 'toolcard' }, [head, body]);
}

function messageNode(msg, index) {
  const isUser = msg.role === 'user';
  const cards = (msg.toolCalls || []).map(toolCard);
  const contentHtml = isUser
    ? escapeHtml(msg.content || '')
    : renderMarkdown(msg.content || (msg.toolCalls?.length ? '' : ''));
  const bubble = el('div', { class: 'bubble', html: contentHtml });
  if (isUser) bubble.classList.add('plain');

  const actions = el('div', { class: 'msgActions' }, [
    el('button', { title: '复制', onClick: () => copyText(msg.content || '') }, '复制'),
    !isUser && index === state.current.messages.length - 1
      ? el('button', { title: '重新生成', onClick: () => regenerate() }, '重新生成')
      : null
  ]);

  return el('div', { class: `msg ${msg.role}` }, [
    el('div', { class: 'avatar' }, isUser ? '你' : 'E'),
    el('div', { class: 'msgMain' }, [...cards, msg.content || !cards.length ? bubble : null, actions])
  ]);
}

function renderChat() {
  const main = $('#chatBody');
  const title = $('#sessionTitle');
  const info = $('#contextInfo');
  const messages = state.current?.messages || [];
  if (title) title.textContent = state.current?.title || '新会话';
  if (info) info.textContent = `${messages.length} 条消息`;
  if (!main) return;
  if (!messages.length) {
    main.replaceChildren(
      el('div', { class: 'welcome' }, [
        el('div', { class: 'hero' }, 'PCB'),
        el('h2', {}, '和你的 EDA 一起工作'),
        el('p', {}, '读取当前嘉立创文档、生成原理图、检查网络，或继续开发智能铺铜与多层布线。工具调用会实时展示在对话中。')
      ])
    );
    return;
  }
  main.replaceChildren(...messages.map((m, i) => messageNode(m, i)));
  main.scrollTop = main.scrollHeight;
}

// Re-render only the last assistant message during streaming (cheap + no scroll jump).
function refreshLastMessage() {
  const main = $('#chatBody');
  if (!main) return;
  const nodes = main.querySelectorAll('.msg');
  const last = nodes[nodes.length - 1];
  const idx = state.current.messages.length - 1;
  const fresh = messageNode(state.current.messages[idx], idx);
  if (last) last.replaceWith(fresh);
  else main.append(fresh);
  main.scrollTop = main.scrollHeight;
}

// ---------- send / stream ----------
async function send() {
  const box = $('#prompt');
  const text = box.value.trim();
  if (!text || state.stopStream) return;
  if (!state.config.apiKey) return showError('未设置 API Key：请设置环境变量 EDAMAX_API_KEY 后重启服务');
  if (!state.current) await newSession();
  box.value = '';
  box.style.height = 'auto';
  showError('');
  state.current.messages.push({ role: 'user', content: text });
  if (state.current.messages.filter((m) => m.role === 'user').length === 1)
    state.current.title = text.slice(0, 28);
  renderChat();
  await persistCurrent();
  await runStream();
}

async function regenerate() {
  if (state.stopStream || !state.current) return;
  // Drop trailing assistant message(s), keep up to the last user turn.
  while (state.current.messages.length && state.current.messages.at(-1).role !== 'user')
    state.current.messages.pop();
  renderChat();
  await runStream();
}

async function runStream() {
  const assistant = { role: 'assistant', content: '', toolCalls: [] };
  state.current.messages.push(assistant);
  setStreaming(true);
  refreshLastMessage();

  await new Promise((resolve) => {
    state.stopStream = API.streamChat(state.current.messages.slice(0, -1), (ev) => {
      switch (ev.type) {
        case 'delta':
          assistant.content += ev.content || '';
          refreshLastMessage();
          break;
        case 'tool_call':
          assistant.toolCalls.push({ id: ev.id, name: ev.name, args: ev.arguments });
          refreshLastMessage();
          break;
        case 'tool_result': {
          const tc = assistant.toolCalls.find((t) => t.id === ev.id);
          if (tc) { if (ev.error) tc.error = ev.error; else tc.result = ev.result; }
          refreshLastMessage();
          break;
        }
        case 'done':
        case 'aborted':
          if (!assistant.content && !assistant.toolCalls.length)
            state.current.messages.pop();
          finish();
          break;
        case 'error':
          showError(ev.message);
          if (!assistant.content && !assistant.toolCalls.length)
            state.current.messages.pop();
          finish();
          break;
      }
    });
    async function finish() {
      setStreaming(false);
      state.stopStream = null;
      renderChat();
      await persistCurrent();
      resolve();
    }
  });
}

function setStreaming(on) {
  const send = $('#send');
  const stop = $('#stop');
  if (send) send.hidden = on;
  if (stop) stop.hidden = !on;
}

// ---------- dialogs ----------
function openSettings() {
  const c = state.config;
  const field = (label, input) => el('label', {}, [label, input]);
  const inputs = {};
  const make = (id, attrs) => (inputs[id] = el('input', attrs));
  const body = el('div', { class: 'formBody' }, [
    field('API Base', make('apiBase', { value: c.apiBase || '', placeholder: 'https://api.openai.com/v1' })),
    field('API Key', el('input', { value: c.apiKey ? '已从环境变量读取（' + c.apiKey + '）' : '未设置：请设置环境变量 EDAMAX_API_KEY', disabled: true })),
    field('模型', make('model', { value: c.model || '', placeholder: 'gpt-4.1-mini' })),
    el('div', { class: 'grid2' }, [
      field('Temperature', make('temperature', { type: 'number', min: '0', max: '2', step: '0.1', value: c.temperature ?? 0.2 })),
      field('上下文消息数', make('maxContextMessages', { type: 'number', min: '4', max: '200', value: c.maxContextMessages ?? 40 }))
    ]),
    field('系统提示词', (inputs.systemPrompt = el('textarea', { rows: '5' }, c.systemPrompt || ''))),
    el('label', { class: 'check' }, [
      (inputs.enableJlcTools = el('input', { type: 'checkbox', checked: c.enableJlcTools })),
      '启用嘉立创 MCP 工具'
    ])
  ]);
  const dialog = modal('模型与上下文设置', body, [
    el('button', { class: 'ghost', onClick: () => dialog.close() }, '取消'),
    el('button', {
      class: 'primary',
      onClick: async () => {
        const next = {
          apiBase: inputs.apiBase.value,
          model: inputs.model.value,
          systemPrompt: inputs.systemPrompt.value,
          temperature: Number(inputs.temperature.value),
          maxContextMessages: Number(inputs.maxContextMessages.value),
          enableJlcTools: inputs.enableJlcTools.checked
        };
        state.config = await API.putConfig(next);
        $('#modelName').textContent = state.config.model || '未配置';
        dialog.close();
      }
    }, '保存')
  ]);
}

function modal(title, body, actions) {
  const dialog = el('dialog', { class: 'modal', id: title.includes('搜索') ? 'searchDialog' : undefined }, [
    el('form', { method: 'dialog' }, [
      el('div', { class: 'modalHead' }, [
        el('h2', {}, title),
        el('button', { class: 'x', value: 'cancel', onClick: () => dialog.close() }, '×')
      ]),
      body,
      actions.length ? el('div', { class: 'modalActions' }, actions) : null
    ])
  ]);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

// ---------- misc ----------
function showError(msg) {
  const box = $('#error');
  if (box) box.textContent = msg || '';
}
function escapeHtml(s = '') {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function safeJson(value) {
  if (value === undefined) return '';
  if (typeof value === 'string') { try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; } }
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); } catch {}
}
function paintJlc(connected, text) {
  const dot = $('#jlcDot');
  if (dot) dot.className = `dot ${connected}`;
  const label = $('#jlcText');
  if (label) label.textContent = text;
}

async function refreshJlcStatus() {
  if (state.connecting) return state.jlc?.bridge?.connected || false;
  try {
    const s = await API.jlcStatus();
    state.jlc = s;
    const ok = !!s.bridge?.connected;
    paintJlc(ok ? 'ok' : 'bad', ok ? `嘉立创已连接 · :${s.bridge?.listenPort ?? ''}` : '嘉立创未连接（点击连接）');
    return ok;
  } catch {
    paintJlc('bad', '桥接不可用（点击重试）');
    return false;
  }
}

// Actively drive a connection attempt. The extension is the WS client, so this
// asks the server to poll/verify within a timeout rather than forcing a dial.
async function connectJlc(manual = false) {
  if (state.connecting) return;
  state.connecting = true;
  paintJlc('connecting', '正在连接嘉立创…');
  try {
    const r = await API.jlcConnect(manual ? 20000 : 12000);
    state.jlc = { bridge: r.bridge };
    if (r.connected) {
      paintJlc('ok', `嘉立创已连接 · :${r.bridge?.listenPort ?? ''}`);
    } else {
      paintJlc('bad', '嘉立创未连接（点击重试）');
      if (manual) showJlcHelp(r.error);
    }
  } catch (e) {
    paintJlc('bad', '连接失败（点击重试）');
    if (manual) showJlcHelp(e.message);
  } finally {
    state.connecting = false;
  }
}

function showJlcHelp(detail) {
  const steps = [
    '在嘉立创 EDA 专业版中打开工程，并进入原理图（Schematic）页。',
    '顶部菜单「MCP Bridge → Status」确认扩展已启用、状态为 Connected。',
    '扩展默认连接本机 9050 端口，多窗口会在 9050–9059 之间协商。',
    '确认 MCP 服务正在运行（本机 http://127.0.0.1:19151）。',
    '就绪后回到本窗口，点击左下角状态条即可重连。'
  ];
  const body = el('div', {}, [
    el('p', { class: 'helpLead' }, '桥接由嘉立创 EDA 扩展主动发起，请确保扩展侧已就绪：'),
    el('ol', { class: 'helpSteps' }, steps.map((s) => el('li', {}, s))),
    detail ? el('p', { class: 'helpDetail' }, `诊断信息：${detail}`) : null
  ]);
  modal('连接嘉立创 EDA', body, [
    el('button', { class: 'primary', onClick: (e) => { e.target.closest('dialog').close(); connectJlc(true); } }, '重新连接')
  ]);
}

// Delegated copy-button handler for code blocks.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.cbCopy');
  if (!btn) return;
  const code = btn.closest('.codeblock')?.querySelector('code');
  if (code) { copyText(code.innerText); btn.textContent = '已复制'; setTimeout(() => (btn.textContent = '复制'), 1200); }
});

// ---------- layout ----------
function layout() {
  const app = el('div', { class: 'app' }, [
    el('aside', {}, [
      el('div', { class: 'brand' }, [
        el('span', { class: 'logo' }, 'E'),
        el('div', {}, [el('b', {}, 'EDAMax'), el('small', {}, 'EDA Agent Console')])
      ]),
      el('button', { class: 'primary block', onClick: newSession }, '＋ 新会话'),
      el('div', { class: 'sessions', id: 'sessions' }),
      el('div', { class: 'asideFoot' }, [
        el('button', { class: 'jlcPill', id: 'jlcPill', title: '点击连接 / 重连嘉立创', onClick: () => connectJlc(true) }, [
          el('span', { class: 'dot', id: 'jlcDot' }),
          el('span', { id: 'jlcText' }, '嘉立创桥接检测中')
        ]),
        el('button', { class: 'iconBtn', title: '设置', onClick: openSettings }, '⚙')
      ])
    ]),
    el('main', {}, [
      el('header', {}, [
        el('div', {}, [el('h1', { id: 'sessionTitle' }, '新会话'), el('span', { id: 'contextInfo' }, '0 条消息')]),
        el('div', { class: 'modelBadge' }, [el('span', {}, '模型'), el('b', { id: 'modelName' }, '未配置')])
      ]),
      el('section', { class: 'messages', id: 'chatBody' }),
      el('footer', {}, [
        el('div', { class: 'error', id: 'error' }),
        el('div', { class: 'composer' }, [
          el('textarea', {
            id: 'prompt',
            rows: '1',
            placeholder: '描述你要设计、检查或修改的内容…',
            onInput: (e) => { e.target.style.height = 'auto'; e.target.style.height = Math.min(e.target.scrollHeight, 200) + 'px'; },
            onKeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }
          }),
          el('button', { class: 'send', id: 'send', onClick: send, title: '发送' }, '➤'),
          el('button', { class: 'stop', id: 'stop', hidden: true, onClick: () => state.stopStream?.(), title: '停止' }, '■')
        ]),
        el('small', { class: 'hint' }, 'Enter 发送 · Shift+Enter 换行 · 工具调用会实时展示在对话中')
      ])
    ])
  ]);
  $('#root').replaceChildren(app);
}

// ---------- boot ----------
async function boot() {
  layout();
  state.config = await API.getConfig();
  $('#modelName').textContent = state.config.model || '未配置';
  state.sessions = await API.listSessions();
  state.current = state.sessions[0] || null;
  renderSessions();
  renderChat();
  // Proactively attempt to connect on launch, then keep the status fresh.
  const connected = await refreshJlcStatus();
  if (!connected) connectJlc(false);
  setInterval(refreshJlcStatus, 10000);
}

boot();
