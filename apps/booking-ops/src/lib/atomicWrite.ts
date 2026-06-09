import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Write a file atomically via tempfile + rename, so a crash mid-write can never
 * leave a half-written JSON record. Same pattern as career-ops-ui's applySession.
 */
export async function atomicWrite(
  filePath: string,
  content: string,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, content, "utf-8");
  await fs.rename(tmp, filePath);
}

/** Atomically write a value as pretty JSON. */
export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await atomicWrite(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

/** Read + parse a JSON file, or return `fallback` if it doesn't exist. */
export async function readJson<T>(
  filePath: string,
  fallback: T,
): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw err;
  }
}

/** Read a text file, or return `fallback` (default "") if it doesn't exist. */
export async function readText(
  filePath: string,
  fallback = "",
): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw err;
  }
}

/** True if a path exists. */
export async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
