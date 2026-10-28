// Thin REST + SSE client. All calls are same-origin (served by server.mjs) or
// proxied through Vite's dev server, so relative /api paths just work.

export async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const getConfig = () => api('/api/config');
export const putConfig = (next) => api('/api/config', { method: 'PUT', body: JSON.stringify(next) });
export const listSessions = () => api('/api/sessions');
export const createSession = () => api('/api/sessions', { method: 'POST', body: '{}' });
export const saveSession = (s) => api(`/api/sessions/${s.id}`, { method: 'PUT', body: JSON.stringify(s) });
export const deleteSession = (id) => api(`/api/sessions/${id}`, { method: 'DELETE' });
export const jlcStatus = () => api('/api/jlc/status');
export const jlcConnect = (timeoutMs) => api('/api/jlc/connect', { method: 'POST', body: JSON.stringify({ timeoutMs }) });

// Streams the chat completion, emitting parsed SSE events to `onEvent`.
// Returns an abort() function so callers can stop generation mid-flight.
export function streamChat(messages, onEvent) {
  const controller = new AbortController();
  (async () => {
    try {
      const res = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages }),
        signal: controller.signal
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const event = parseSse(raw);
          if (event) onEvent(event);
        }
      }
    } catch (err) {
      if (controller.signal.aborted) onEvent({ type: 'aborted' });
      else onEvent({ type: 'error', message: err.message });
    }
  })();
  return () => controller.abort();
}

function parseSse(raw) {
  let type = 'message';
  const dataLines = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) type = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (!dataLines.length) return null;
  try {
    return { type, ...JSON.parse(dataLines.join('\n')) };
  } catch {
    return null;
  }
}
