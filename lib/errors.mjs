// Small error helpers shared by relay and agent code.

// Human-readable message for anything that was thrown (Errors, strings, null…).
export function errorMessage(e) {
  return String((e && e.message) || e);
}

const NETWORK_ERROR_KINDS = [
  [/ECONNREFUSED/, 'connection refused'],
  [/ENETUNREACH|EHOSTUNREACH/, 'network unreachable'],
  [/ECONNRESET/, 'connection reset'],
  [/abort|timeout|ETIMEDOUT/i, 'timeout'],
  [/EAI_AGAIN|ENOTFOUND/, 'DNS failure'],
];

// Collapse a fetch/socket failure into a short reason ("connection refused",
// "timeout", …). Unknown errors fall through as their raw message.
export function networkErrorKind(e) {
  const raw = String((e && (e.cause?.code || e.code || e.message)) || e || 'unknown error');
  for (const [pattern, kind] of NETWORK_ERROR_KINDS) if (pattern.test(raw)) return kind;
  return raw;
}
