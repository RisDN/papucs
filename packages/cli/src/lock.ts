import { existsSync } from "node:fs";
import { open, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { ensureDir, nowIso } from "./fs";
import { PapucsError } from "./errors";
import type { ProjectContext } from "./types";

interface LockDocument {
  token: string;
  pid: number;
  command: string;
  startedAt: string;
}

const STALE_AFTER_MS = 30 * 60 * 1000;

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readLock(path: string): Promise<LockDocument | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as LockDocument;
  } catch {
    return null;
  }
}

function lockIsStale(lock: LockDocument | null): boolean {
  if (!lock) {
    return true;
  }
  const startedAt = Date.parse(lock.startedAt);
  return (
    !Number.isFinite(startedAt) ||
    Date.now() - startedAt > STALE_AFTER_MS ||
    !processIsAlive(lock.pid)
  );
}

export async function withProjectLock<T>(
  context: ProjectContext,
  command: string,
  action: () => Promise<T>,
): Promise<T> {
  await ensureDir(context.runtimeRoot);
  const token = randomUUID();
  const document: LockDocument = {
    token,
    pid: process.pid,
    command,
    startedAt: nowIso(),
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(context.runtimeLockPath, "wx");
      await handle.writeFile(JSON.stringify(document, null, 2), "utf8");
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }

      const existing = await readLock(context.runtimeLockPath);
      if (attempt === 0 && lockIsStale(existing)) {
        await rm(context.runtimeLockPath, { force: true });
        continue;
      }

      const owner = existing
        ? `${existing.command} (PID ${existing.pid}, ${existing.startedAt})`
        : "unknown process";
      throw new PapucsError(
        `Project is locked by ${owner}. Remove '${context.runtimeLockPath}' only if that process no longer exists.`,
      );
    }
  }

  if (!existsSync(context.runtimeLockPath)) {
    throw new PapucsError("Failed to acquire the project lock.");
  }

  try {
    return await action();
  } finally {
    const current = await readLock(context.runtimeLockPath);
    if (current?.token === token) {
      await rm(context.runtimeLockPath, { force: true });
    }
  }
}
