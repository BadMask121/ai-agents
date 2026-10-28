export interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSemver(s: string | null | undefined): SemVer | null {
  const m = SEMVER.exec((s ?? "").trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/**
 * An agent speaking `agent` can talk to a Worker speaking `worker` when the
 * MAJOR matches and the agent doesn't need a MINOR the Worker hasn't got.
 */
export function protocolCompatible(worker: SemVer, agent: SemVer): boolean {
  return worker.major === agent.major && agent.minor <= worker.minor;
}
