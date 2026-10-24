// Minimal `--name value` flag reader shared by the relay and dev tools.
// A flag given without a value (last arg, or followed by another --flag)
// reads as `true` so callers can reject it explicitly.
export function flagReader(argv) {
  return (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    if (i === -1) return fallback;
    const value = argv[i + 1];
    return value !== undefined && !value.startsWith('--') ? value : true;
  };
}
