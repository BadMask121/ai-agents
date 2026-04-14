import path from "node:path";

export const WORKSPACE =
  process.env.CAREER_OPS_WORKSPACE ?? "/workspace/career-ops";

export const p = {
  root: WORKSPACE,
  cv: path.join(WORKSPACE, "cv.md"),
  profile: path.join(WORKSPACE, "config", "profile.yml"),
  portals: path.join(WORKSPACE, "portals.yml"),
  modesProfile: path.join(WORKSPACE, "modes", "_profile.md"),
  pipeline: path.join(WORKSPACE, "data", "pipeline.md"),
  applications: path.join(WORKSPACE, "data", "applications.md"),
  scanHistory: path.join(WORKSPACE, "data", "scan-history.tsv"),
  reports: path.join(WORKSPACE, "reports"),
  output: path.join(WORKSPACE, "output"),
  logs: path.join(WORKSPACE, "logs"),
  applySessions: path.join(WORKSPACE, "data", "apply-sessions"),
};
