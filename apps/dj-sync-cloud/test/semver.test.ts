import { describe, expect, it } from "vitest";
import pkg from "../package.json";
import { AGENT_PROTOCOL, WORKER_VERSION } from "../src/constants";
import { parseSemver, protocolCompatible } from "../src/semver";

describe("versions", () => {
  it("WORKER_VERSION matches package.json", () => {
    expect(WORKER_VERSION).toBe(pkg.version);
  });

  it("both versions are valid semver", () => {
    expect(parseSemver(WORKER_VERSION)).not.toBeNull();
    expect(parseSemver(AGENT_PROTOCOL)).not.toBeNull();
  });
});

describe("parseSemver", () => {
  it("parses release, pre-release and build forms", () => {
    expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseSemver(" 0.10.0-rc.1+abc ")).toEqual({ major: 0, minor: 10, patch: 0 });
  });

  it("rejects non-semver", () => {
    for (const s of [null, undefined, "", "1", "1.2", "v1.2.3", "01.2.3", "1.2.x", "1.2.3.4"]) {
      expect(parseSemver(s), String(s)).toBeNull();
    }
  });
});

describe("protocolCompatible", () => {
  const w = parseSemver("1.2.0")!;
  it.each([
    ["1.0.0", true],
    ["1.2.0", true],
    ["1.2.9", true],
    ["1.3.0", false], // agent needs a newer minor than the Worker has
    ["2.0.0", false],
    ["0.9.0", false],
  ])("worker 1.2.0 vs agent %s → %s", (agent, want) => {
    expect(protocolCompatible(w, parseSemver(agent)!)).toBe(want);
  });
});
