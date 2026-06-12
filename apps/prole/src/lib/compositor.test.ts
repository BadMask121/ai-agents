import { describe, it, expect } from "vitest";
import { computeCanvasHeight, wrapText } from "./compositor";

describe("computeCanvasHeight", () => {
  it("returns image height when there is no message", () => {
    expect(computeCanvasHeight(400, "", 20, 6, 14)).toBe(400);
  });
  it("adds a band sized to the line count when there is a message", () => {
    // 2 lines * lineHeight(20) + 2*padding(6) = 52, added to 400 => 452
    const h = computeCanvasHeight(400, "two\nlines", 20, 6, 14);
    expect(h).toBe(452);
  });
});

describe("wrapText", () => {
  it("keeps short text on one line", () => {
    const measure = (s: string) => s.length * 8; // 8px per char
    expect(wrapText("hello world", 200, measure)).toEqual(["hello world"]);
  });
  it("wraps text that exceeds the max width", () => {
    const measure = (s: string) => s.length * 8;
    expect(wrapText("hello world", 80, measure)).toEqual(["hello", "world"]);
  });
  it("preserves explicit newlines", () => {
    const measure = (s: string) => s.length * 8;
    expect(wrapText("a\nb", 200, measure)).toEqual(["a", "b"]);
  });
});
