import { describe, expect, it } from "vitest";
import { originAllowed } from "../src/http";
import { publicHosts } from "../src/util";

describe("hostnames", () => {
  it("accepts the canonical host and its aliases as Origin, nothing else", () => {
    const hosts = publicHosts({ PUBLIC_HOST: "djsync.jeffrey.build", PUBLIC_HOST_ALIASES: "mcp.triplejmusic.art" });
    expect(hosts).toBe("djsync.jeffrey.build,mcp.triplejmusic.art");
    expect(originAllowed("https://djsync.jeffrey.build", hosts)).toBe(true);
    expect(originAllowed("https://MCP.triplejmusic.art", hosts)).toBe(true);
    expect(originAllowed("https://chatgpt.com", hosts)).toBe(true);
    expect(originAllowed("https://evil.example", hosts)).toBe(false);
    expect(originAllowed("https://djsync.jeffrey.build.evil.example", hosts)).toBe(false);
    expect(originAllowed(null, hosts)).toBe(true);
    expect(publicHosts({ PUBLIC_HOST: "a.example" })).toBe("a.example");
  });
});
