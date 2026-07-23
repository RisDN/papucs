import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export async function ensureDir(pathValue: string): Promise<void> {
  await mkdir(pathValue, { recursive: true });
}

export async function atomicWriteFile(
  filePath: string,
  content: string | Uint8Array,
): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await writeFile(temporary, content);
  try {
    await rename(temporary, filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "EPERM") {
      await rm(temporary, { force: true });
      throw error;
    }
    await rm(filePath, { force: true });
    await rename(temporary, filePath);
  }
}

export async function listFilesRecursive(root: string): Promise<string[]> {
  if (!existsSync(root)) {
    return [];
  }

  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }
  return files.sort();
}

export async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(filePath))
    .digest("hex");
}

export async function copyFileWithDirs(
  fromPath: string,
  toPath: string,
): Promise<void> {
  await ensureDir(path.dirname(toPath));
  await writeFile(toPath, await readFile(fromPath));
}

export async function deleteFileAndEmptyParents(
  filePath: string,
  stopDir: string,
): Promise<void> {
  if (!existsSync(filePath)) {
    return;
  }
  await unlink(filePath);

  let current = path.dirname(filePath);
  const stop = path.resolve(stopDir);
  while (path.resolve(current) !== stop) {
    const entries = await readdir(current);
    if (entries.length > 0) {
      break;
    }
    await rm(current, { recursive: true, force: true });
    current = path.dirname(current);
  }
}

export function toPosix(value: string): string {
  return value.replaceAll(path.sep, "/");
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function deepClone<T>(value: T): T {
  return structuredClone(value);
}
