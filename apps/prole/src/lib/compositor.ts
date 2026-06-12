export type Measure = (text: string) => number;

/** Wrap text to `maxWidth`, honoring explicit "\n". `measure` returns pixel width. */
export function wrapText(text: string, maxWidth: number, measure: Measure): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(" ");
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (current && measure(candidate) > maxWidth) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    lines.push(current);
  }
  return lines;
}

/** Final canvas height = image height + caption band (only if message present). */
export function computeCanvasHeight(
  imageHeight: number,
  message: string,
  lineHeight: number,
  padding: number,
  _fontSize: number,
): number {
  if (!message.trim()) return imageHeight;
  const lineCount = message.split("\n").length;
  return imageHeight + lineCount * lineHeight + padding * 2;
}
