// Tiny env-var parsing helpers. Used by every module that exposes a knob
// (invoke timeouts, agentmail concurrency caps, watchdog thresholds, dedup
// window, …) so the parse-and-default rules don't drift between call sites.
//
// In particular, `parsePositiveInt` rejects 0 — agentmail's previous
// `parseInt(...) || DEFAULT` pattern accepted any falsy parse and silently
// swapped a configured 0 for the default, which was a real footgun.

export function parsePositiveInt(name: string, fallback: number): number {
  const raw = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export function parseNonNegativeInt(name: string, fallback: number): number {
  const raw = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

export function parseString(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw && raw.length > 0 ? raw : fallback;
}
