/**
 * Extract the last JSON object/array from a string of model output.
 *
 * We instruct the drafting model to return ONLY a JSON object, but models
 * occasionally wrap it in prose or a ```json fence. This is the same defensive
 * "take the last balanced block" approach as career-ops-ui's runClaudePrompt.
 * Returns null if nothing parseable is found.
 */
export function extractLastJsonBlock<T = unknown>(text: string): T | null {
  if (!text) return null;

  // Prefer a fenced ```json block if present (take the last one).
  const fenceMatches = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (let i = fenceMatches.length - 1; i >= 0; i--) {
    const candidate = fenceMatches[i]?.[1]?.trim();
    const parsed = tryParse<T>(candidate);
    if (parsed !== null) return parsed;
  }

  // Otherwise scan for the last balanced {...} or [...] span.
  const span = lastBalancedSpan(text);
  if (span) {
    const parsed = tryParse<T>(span);
    if (parsed !== null) return parsed;
  }

  // Last resort: maybe the whole string is JSON.
  return tryParse<T>(text.trim());
}

function tryParse<T>(candidate: string | undefined): T | null {
  if (!candidate) return null;
  try {
    return JSON.parse(candidate) as T;
  } catch {
    return null;
  }
}

/**
 * Find the last balanced {...} or [...] substring by scanning from each closing
 * brace backwards to a matching opener. Cheap and good enough for model output.
 */
function lastBalancedSpan(text: string): string | null {
  for (let end = text.length - 1; end >= 0; end--) {
    const close = text[end];
    const open = close === "}" ? "{" : close === "]" ? "[" : null;
    if (!open) continue;
    let depth = 0;
    for (let start = end; start >= 0; start--) {
      const ch = text[start];
      if (ch === close) depth++;
      else if (ch === open) {
        depth--;
        if (depth === 0) return text.slice(start, end + 1);
      }
    }
  }
  return null;
}
