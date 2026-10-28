/**
 * HTML email → readable plain text, cheaply: a few linear regex passes instead
 * of a DOM parser, so a large message stays well inside the Workers free-plan
 * CPU budget. Good enough for a model to read; not a layout engine.
 */

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  copy: "©",
  reg: "®",
  trade: "™",
  euro: "€",
  pound: "£",
  bull: "•",
};

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

const BLOCK_END = /<\/(?:p|div|h[1-6]|li|tr|table|ul|ol|blockquote|section|article|header|footer|pre)\s*>/gi;

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|head|title|noscript)\b[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(BLOCK_END, "\n")
      .replace(/<li\b[^>]*>/gi, "• ")
      // Keep where a link goes when its text doesn't already say it.
      .replace(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, href: string, inner: string) => {
        const text = inner.replace(/<[^>]+>/g, "").trim();
        return /^https?:/i.test(href) && text && !text.includes(href) ? `${text} (${href})` : text || href;
      })
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
