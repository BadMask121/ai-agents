import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { p } from "./paths";

export type ApplyStatus =
  | "draft"
  | "ready"
  | "applied"
  | "failed";

export type ApplyField = {
  question: string;
  answer: string;
  /**
   * Where the answer came from — lets the UI show "drafted by agent" vs
   * "user edit" vs "from CV Section H" hints. Optional; default "agent".
   */
  source?: "agent" | "user" | "section-h" | "cv";
};

export type ApplyMessage = {
  role: "user" | "agent" | "system";
  content: string;
  timestamp: string;
};

export type ApplySession = {
  id: string;
  jobNum: number | null;
  jobUrl: string;
  company: string | null;
  title: string | null;
  score: number | null;
  status: ApplyStatus;
  createdAt: string;
  updatedAt: string;
  preparing: boolean;
  /**
   * null while the prepareApplication agent is still running, a populated
   * object once the initial draft lands. The UI renders a loading skeleton
   * when this is null.
   */
  payload: {
    fields: ApplyField[];
  } | null;
  history: ApplyMessage[];
  error: string | null;
};

/**
 * Valid status transitions. Invalid transitions throw — this catches logic
 * errors in the API routes early and prevents a session from e.g. going
 * directly from draft → applied without an explicit ready step.
 */
const TRANSITIONS: Record<ApplyStatus, ApplyStatus[]> = {
  draft: ["ready", "failed"],
  ready: ["applied", "draft", "failed"],
  applied: [],
  failed: ["draft"],
};

function assertTransition(from: ApplyStatus, to: ApplyStatus) {
  if (from === to) return;
  if (!TRANSITIONS[from].includes(to)) {
    throw new Error(`invalid apply-session transition: ${from} → ${to}`);
  }
}

function sessionPath(id: string): string {
  return path.join(p.applySessions, `${id}.json`);
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(p.applySessions, { recursive: true });
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, content, "utf-8");
  await fs.rename(tmp, filePath);
}

export async function createSession(input: {
  jobNum: number | null;
  jobUrl: string;
  company: string | null;
  title: string | null;
  score: number | null;
}): Promise<ApplySession> {
  await ensureDir();
  const now = new Date().toISOString();
  const session: ApplySession = {
    id: randomUUID(),
    jobNum: input.jobNum,
    jobUrl: input.jobUrl,
    company: input.company,
    title: input.title,
    score: input.score,
    status: "draft",
    createdAt: now,
    updatedAt: now,
    preparing: true,
    payload: null,
    history: [],
    error: null,
  };
  await atomicWrite(sessionPath(session.id), JSON.stringify(session, null, 2));
  return session;
}

export async function getSession(id: string): Promise<ApplySession | null> {
  try {
    const raw = await fs.readFile(sessionPath(id), "utf-8");
    return JSON.parse(raw) as ApplySession;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function listSessionsForJob(jobNum: number): Promise<ApplySession[]> {
  await ensureDir();
  const entries = await fs.readdir(p.applySessions).catch(() => [] as string[]);
  const out: ApplySession[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(p.applySessions, name), "utf-8");
      const s = JSON.parse(raw) as ApplySession;
      if (s.jobNum === jobNum) out.push(s);
    } catch {
      // skip malformed files rather than blow up the whole list
    }
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return out;
}

async function mutate(
  id: string,
  mutator: (s: ApplySession) => ApplySession,
): Promise<ApplySession> {
  const existing = await getSession(id);
  if (!existing) throw new Error(`apply session not found: ${id}`);
  const next = mutator({ ...existing });
  next.updatedAt = new Date().toISOString();
  await atomicWrite(sessionPath(id), JSON.stringify(next, null, 2));
  return next;
}

export async function updatePayload(
  id: string,
  fields: ApplyField[],
): Promise<ApplySession> {
  return mutate(id, (s) => {
    s.payload = { fields };
    s.preparing = false;
    return s;
  });
}

export async function appendMessage(
  id: string,
  role: ApplyMessage["role"],
  content: string,
): Promise<ApplySession> {
  return mutate(id, (s) => {
    s.history = [
      ...s.history,
      { role, content, timestamp: new Date().toISOString() },
    ];
    return s;
  });
}

export async function setStatus(
  id: string,
  next: ApplyStatus,
): Promise<ApplySession> {
  return mutate(id, (s) => {
    assertTransition(s.status, next);
    s.status = next;
    return s;
  });
}

export async function setError(id: string, error: string): Promise<ApplySession> {
  return mutate(id, (s) => {
    s.error = error;
    s.preparing = false;
    s.status = "failed";
    return s;
  });
}

export async function markPreparingDone(id: string): Promise<ApplySession> {
  return mutate(id, (s) => {
    s.preparing = false;
    return s;
  });
}
