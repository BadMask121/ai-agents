import { describe, it, expect } from "vitest";
import { decodeEntities, htmlToText } from "./text.js";

describe("htmlToText", () => {
  it("drops head/style/script and comments, keeps paragraphs and line breaks", () => {
    const html =
      "<html><head><title>T</title><style>p{color:red}</style></head><body>" +
      "<!-- hidden --><p>Hello&nbsp;there,</p><div>Line one<br>Line two</div><script>x()</script></body></html>";
    expect(htmlToText(html)).toBe("Hello there,\nLine one\nLine two");
  });

  it("keeps link targets unless the text already shows them", () => {
    expect(htmlToText('<a href="https://ex.com/a">Read more</a>')).toBe("Read more (https://ex.com/a)");
    expect(htmlToText('<a href="https://ex.com">https://ex.com</a>')).toBe("https://ex.com");
    expect(htmlToText('<a href="mailto:x@y.z">x@y.z</a>')).toBe("x@y.z");
  });

  it("turns list items into bullets and collapses blank space", () => {
    expect(htmlToText("<ul><li>One</li>\n\n\n<li>Two</li></ul>")).toBe("• One\n\n• Two");
  });

  it("is fast on a large message", () => {
    const big = "<table>" + "<tr><td><p style='x'>Cell &amp; text</p></td></tr>".repeat(8000) + "</table>";
    const t0 = performance.now();
    const out = htmlToText(big);
    expect(out.startsWith("Cell & text")).toBe(true);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});

describe("decodeEntities", () => {
  it("decodes named, decimal and hex entities and leaves unknown ones", () => {
    expect(decodeEntities("&lt;b&gt; &#233; &#x1F4EC; &bogus;")).toBe("<b> é 📬 &bogus;");
  });
});
