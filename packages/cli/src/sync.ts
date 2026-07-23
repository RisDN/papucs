import { existsSync } from "node:fs";
import { readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  copyFileWithDirs,
  deleteFileAndEmptyParents,
  ensureDir,
  toPosix,
} from "./fs";
import type {
  ApplySyncResult,
  ProjectContext,
  SourceManifest,
  SyncCache,
  SyncCacheFileEntry,
} from "./types";

function normalizeConfiguredPath(value: string): string | null {
  const normalized = value
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.?\//, "");
  if (!normalized || normalized === "." || normalized.includes("..")) {
    return null;
  }
  return normalized.replace(/\/+$/, "");
}

export function retainedPaths(context: ProjectContext): string[] {
  const normalized = context.config.preserve_paths
    .map(normalizeConfiguredPath)
    .filter((value): value is string => value !== null)
    .sort((left, right) => left.length - right.length);
  return normalized.filter(
    (candidate, index) =>
      !normalized
        .slice(0, index)
        .some(
          (parent) =>
            candidate === parent || candidate.startsWith(`${parent}/`),
        ),
  );
}

export function isRetainedPath(
  relativePath: string,
  configured: string[],
): boolean {
  const normalized = toPosix(relativePath);
  return configured.some(
    (entry) => normalized === entry || normalized.startsWith(`${entry}/`),
  );
}

async function findRetainedDirectories(
  runtimeDataDir: string,
  configured: string[],
): Promise<string[]> {
  if (!existsSync(runtimeDataDir)) {
    return [];
  }
  const matches: string[] = [];
  const stack: Array<{ absolute: string; relative: string }> = [
    { absolute: runtimeDataDir, relative: "" },
  ];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    for (const entry of await readdir(current.absolute, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const relative = current.relative
        ? `${current.relative}/${entry.name}`
        : entry.name;
      if (isRetainedPath(relative, configured)) {
        matches.push(relative);
      } else {
        stack.push({
          absolute: path.join(current.absolute, entry.name),
          relative,
        });
      }
    }
  }
  return matches;
}

export function manifestCacheEntries(
  manifest: SourceManifest,
): Record<string, SyncCacheFileEntry> {
  return Object.fromEntries(
    [...manifest.files.entries()].map(([relativePath, file]) => [
      relativePath,
      { hash: file.hash, source: file.source },
    ]),
  );
}

export async function replaceRuntimeDataFromManifest(
  context: ProjectContext,
  runtimeDataDir: string,
  manifest: SourceManifest,
  options: {
    preserve?: boolean;
    replacementVariables?: Record<string, string>;
  } = {},
): Promise<Record<string, SyncCacheFileEntry>> {
  const configured = options.preserve === false ? [] : retainedPaths(context);
  const temporary = `${runtimeDataDir}.__preserved`;
  await rm(temporary, { recursive: true, force: true });
  const preserved = await findRetainedDirectories(runtimeDataDir, configured);

  for (const relative of preserved) {
    const source = path.join(runtimeDataDir, relative);
    const target = path.join(temporary, relative);
    await ensureDir(path.dirname(target));
    await rename(source, target);
  }

  await rm(runtimeDataDir, { recursive: true, force: true });
  await ensureDir(runtimeDataDir);
  for (const source of manifest.files.values()) {
    await copyFileWithDirs(
      source.absPath,
      path.join(runtimeDataDir, source.relPath),
    );
  }
  for (const relative of preserved) {
    const source = path.join(temporary, relative);
    const target = path.join(runtimeDataDir, relative);
    await ensureDir(path.dirname(target));
    await rm(target, { recursive: true, force: true });
    await rename(source, target);
  }
  await rm(temporary, { recursive: true, force: true });

  if (options.replacementVariables) {
    await replaceEnvironmentVariables(
      context,
      runtimeDataDir,
      manifest,
      options.replacementVariables,
    );
  }
  return manifestCacheEntries(manifest);
}

async function replaceEnvironmentVariables(
  context: ProjectContext,
  runtimeDataDir: string,
  manifest: SourceManifest,
  variables: Record<string, string>,
): Promise<void> {
  const extensions = new Set(
    context.config.replaceable_text_extensions.map((value) =>
      value.toLowerCase(),
    ),
  );
  for (const relative of manifest.files.keys()) {
    if (!extensions.has(path.extname(relative).toLowerCase())) {
      continue;
    }
    const filePath = path.join(runtimeDataDir, relative);
    const original = await readFile(filePath, "utf8");
    const replaced = original.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
      (full, key: string) => variables[key] ?? full,
    );
    if (replaced !== original) {
      await writeFile(filePath, replaced, "utf8");
    }
  }
}

export async function applySync(
  context: ProjectContext,
  runtimeDataDir: string,
  manifest: SourceManifest,
  previousCache: SyncCache,
  options: {
    dryRun: boolean;
    replacementVariables: Record<string, string>;
  },
): Promise<ApplySyncResult> {
  const configured = retainedPaths(context);
  const changed: string[] = [];
  const deleted: string[] = [];

  for (const [relative, source] of manifest.files) {
    if (isRetainedPath(relative, configured)) {
      continue;
    }
    if (previousCache.files[relative]?.hash !== source.hash) {
      changed.push(relative);
      if (!options.dryRun) {
        await copyFileWithDirs(
          source.absPath,
          path.join(runtimeDataDir, relative),
        );
      }
    }
  }
  for (const relative of Object.keys(previousCache.files)) {
    if (
      !isRetainedPath(relative, configured) &&
      !manifest.files.has(relative)
    ) {
      deleted.push(relative);
      if (!options.dryRun) {
        await deleteFileAndEmptyParents(
          path.join(runtimeDataDir, relative),
          runtimeDataDir,
        );
      }
    }
  }
  if (!options.dryRun) {
    await replaceEnvironmentVariables(
      context,
      runtimeDataDir,
      manifest,
      options.replacementVariables,
    );
  }
  return { changed, deleted };
}

export function hasPendingSync(
  context: ProjectContext,
  manifest: SourceManifest,
  cache: SyncCache,
): boolean {
  const configured = retainedPaths(context);
  const current = [...manifest.files.entries()].filter(
    ([relative]) => !isRetainedPath(relative, configured),
  );
  const previous = Object.entries(cache.files).filter(
    ([relative]) => !isRetainedPath(relative, configured),
  );
  if (current.length !== previous.length) {
    return true;
  }
  return current.some(
    ([relative, source]) => cache.files[relative]?.hash !== source.hash,
  );
}
