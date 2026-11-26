/**
 * A canonical text for an analysis identity, the same whatever order its objects' keys arrive in. A result belongs
 * to the decision on show only when its identity's text is the one asked for.
 */
export function canonicalAnalysisKey(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalAnalysisKey).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalAnalysisKey((value as Record<string, unknown>)[key])).join(',') + '}';
  return JSON.stringify(value);
}
