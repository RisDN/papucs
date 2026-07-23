import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile, ensureDir, nowIso } from "./fs";
import type { ProjectContext, RuntimeState, SyncCache } from "./types";

export function emptyState(): RuntimeState {
  return { version: 1, instances: [] };
}

export function normalizeRuntimeState(state: RuntimeState): RuntimeState {
  const lastIndex = new Map<string, number>();
  state.instances.forEach((instance, index) => {
    lastIndex.set(instance.id, index);
  });
  return {
    version: 1,
    instances: state.instances.filter(
      (instance, index) => lastIndex.get(instance.id) === index,
    ),
  };
}

export async function ensureRuntimeDirectories(
  context: ProjectContext,
): Promise<void> {
  await ensureDir(context.runtimeRoot);
  await ensureDir(context.runtimeCacheDir);
  await ensureDir(context.runtimeInstancesDir);
  await ensureDir(context.runtimeBuildDir);
}

export async function loadState(
  context: ProjectContext,
): Promise<RuntimeState> {
  await ensureRuntimeDirectories(context);
  if (!existsSync(context.runtimeStatePath)) {
    return emptyState();
  }
  const parsed = JSON.parse(
    await readFile(context.runtimeStatePath, "utf8"),
  ) as RuntimeState;
  return normalizeRuntimeState({
    ...emptyState(),
    ...parsed,
    instances: Array.isArray(parsed.instances) ? parsed.instances : [],
  });
}

export async function saveState(
  context: ProjectContext,
  state: RuntimeState,
): Promise<void> {
  await atomicWriteFile(
    context.runtimeStatePath,
    `${JSON.stringify(normalizeRuntimeState(state), null, 2)}\n`,
  );
}

export function cachePath(context: ProjectContext, instanceId: string): string {
  return path.join(context.runtimeCacheDir, `${instanceId}.json`);
}

export async function loadCache(
  context: ProjectContext,
  instanceId: string,
  serverType: string,
): Promise<SyncCache> {
  const filePath = cachePath(context, instanceId);
  const fallback: SyncCache = {
    instanceId,
    serverType,
    updatedAt: "",
    files: {},
  };
  if (!existsSync(filePath)) {
    return fallback;
  }
  return {
    ...fallback,
    ...(JSON.parse(await readFile(filePath, "utf8")) as SyncCache),
  };
}

export async function saveCache(
  context: ProjectContext,
  cache: SyncCache,
): Promise<void> {
  await atomicWriteFile(
    cachePath(context, cache.instanceId),
    `${JSON.stringify({ ...cache, updatedAt: cache.updatedAt || nowIso() }, null, 2)}\n`,
  );
}
