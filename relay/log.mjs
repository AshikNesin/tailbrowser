// Timestamped logging, so "why was it down" is answerable from nohup output.

const DEBUG = !!process.env.TB_DEBUG;

export function log(...args) {
  console.log(new Date().toISOString(), '[relay]', ...args);
}

// TB_DEBUG=1 wire tracing; payloads are only serialized when enabled
export function debugLog(label, payload) {
  if (!DEBUG) return;
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  console.log(new Date().toISOString(), '[debug]', label, (text ?? '').slice(0, 300));
}
