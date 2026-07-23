import { existsSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  buildRuntimeServiceDefinition,
  loadServerComposeTemplate,
  persistStateAndCompose,
  resolveInstanceExact,
} from "../compose";
import {
  getRunningContainerNames,
  getRunningServices,
  runCompose,
} from "../docker";
import { buildRuntimeTemplateContext, loadMergedEnv } from "../env";
import { PapucsError } from "../errors";
import { copyFileWithDirs, ensureDir, nowIso, toPosix } from "../fs";
import { resolveGitMetadata } from "../git";
import {
  collectSourceManifest,
  loadServerConfig,
  reportOverrides,
} from "../manifest";
import {
  buildServerName,
  extractServerNumber,
  validateIdentifier,
} from "../naming";
import { cachePath, loadCache, loadState, saveCache } from "../state";
import {
  applySync,
  hasPendingSync,
  manifestCacheEntries,
  replaceRuntimeDataFromManifest,
} from "../sync";
import type {
  ApplySyncResult,
  ProjectContext,
  Reporter,
  RuntimeInstance,
  RuntimeState,
} from "../types";

async function nextServerIndex(
  context: ProjectContext,
  serverType: string,
  state: RuntimeState,
): Promise<number> {
  const serverConfig = await loadServerConfig(context, serverType);
  let highest = 0;
  for (const name of await getRunningContainerNames(context)) {
    highest = Math.max(
      highest,
      extractServerNumber(context, serverConfig, serverType, name) ?? 0,
    );
  }
  for (const instance of state.instances) {
    if (instance.serverType === serverType) {
      highest = Math.max(highest, instance.index);
    }
  }
  return highest + 1;
}

async function materializeInstance(
  context: ProjectContext,
  state: RuntimeState,
  instance: RuntimeInstance,
  reporter: Reporter,
): Promise<void> {
  const manifest = await collectSourceManifest(context, instance.serverType);
  reportOverrides(reporter, manifest.overrides);
  const template = await loadServerComposeTemplate(
    context,
    instance.serverType,
    manifest.config,
  );
  const mergedEnv = await loadMergedEnv(
    context,
    instance.serverType,
    manifest.config,
  );
  const git = await resolveGitMetadata(context);
  const variables = buildRuntimeTemplateContext({
    serverType: instance.serverType,
    instanceId: instance.id,
    index: instance.index,
    instanceName: instance.serverName,
    mergedEnv: {
      ...mergedEnv,
      REF_TAG: git.ref,
      SHA_TAG: git.sha,
    },
  });
  instance.composeService = buildRuntimeServiceDefinition({
    templateService: template.appServiceDefinition,
    image: manifest.config.image,
    serverName: instance.serverName,
    variables,
  });
  instance.templateServiceName = template.appServiceName;
  instance.updatedAt = nowIso();

  const runtimeDataDir = path.join(
    context.runtimeRoot,
    instance.runtimeDataDir,
  );
  const files = await replaceRuntimeDataFromManifest(
    context,
    runtimeDataDir,
    manifest,
    { replacementVariables: variables },
  );
  await saveCache(context, {
    instanceId: instance.id,
    serverType: instance.serverType,
    updatedAt: nowIso(),
    files,
  });

  const current = state.instances.findIndex(
    (candidate) => candidate.id === instance.id,
  );
  if (current >= 0) {
    state.instances[current] = instance;
  }
}

export async function commandUp(
  context: ProjectContext,
  serverTypeValue: string,
  reporter: Reporter,
): Promise<RuntimeInstance> {
  const serverType = validateIdentifier(serverTypeValue, "Server type");
  const state = await loadState(context);
  const serverConfig = await loadServerConfig(context, serverType);
  const index = await nextServerIndex(context, serverType, state);
  const id = `${serverType}-${index}`;
  const serverName = buildServerName(context, serverConfig, serverType, index);
  const instance: RuntimeInstance = {
    id,
    serverType,
    index,
    serverName,
    serviceName: id,
    runtimeDataDir: toPosix(
      path.relative(
        context.runtimeRoot,
        path.join(context.runtimeInstancesDir, id, "data"),
      ),
    ),
    templateServiceName: serverConfig.compose_service,
    composeService: {},
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  state.instances.push(instance);

  try {
    await materializeInstance(context, state, instance, reporter);
    await persistStateAndCompose(context, state);
    await runCompose(context, ["up", "-d", instance.serviceName]);
  } catch (error) {
    state.instances = state.instances.filter(
      (candidate) => candidate.id !== instance.id,
    );
    await persistStateAndCompose(context, state).catch(() => undefined);
    await rm(cachePath(context, instance.id), { force: true });
    throw error;
  }

  reporter.log(`Started ${instance.id} (${instance.serverName}).`);
  return instance;
}

export async function commandDown(
  context: ProjectContext,
  target: string,
  all: boolean,
  reporter: Reporter,
): Promise<string[]> {
  const state = await loadState(context);
  const targets = all
    ? state.instances.filter((instance) => instance.serverType === target)
    : [resolveInstanceExact(state, target)];
  if (targets.length === 0) {
    throw new PapucsError(`No managed instances found for '${target}'.`);
  }

  const removed: string[] = [];
  for (const instance of targets) {
    await runCompose(context, ["stop", instance.serviceName]);
    await runCompose(context, ["rm", "-f", instance.serviceName]);
    removed.push(instance.id);
    reporter.log(`Stopped ${instance.id}; runtime files kept.`);
  }
  state.instances = state.instances.filter(
    (instance) => !removed.includes(instance.id),
  );
  await persistStateAndCompose(context, state);
  return removed;
}

export async function commandRebuild(
  context: ProjectContext,
  target: string,
  reporter: Reporter,
  start = true,
): Promise<RuntimeInstance> {
  const state = await loadState(context);
  const instance = resolveInstanceExact(state, target);
  await runCompose(context, ["stop", instance.serviceName], {
    allowFailure: true,
  });
  await runCompose(context, ["rm", "-f", instance.serviceName], {
    allowFailure: true,
  });
  await materializeInstance(context, state, instance, reporter);
  await persistStateAndCompose(context, state);
  if (start) {
    await runCompose(context, ["up", "-d", instance.serviceName]);
  }
  reporter.log(`${start ? "Rebuilt and started" : "Rebuilt"} ${instance.id}.`);
  return instance;
}

export async function commandRestart(
  context: ProjectContext,
  target: string,
  reporter: Reporter,
): Promise<RuntimeInstance> {
  return await commandRebuild(context, target, reporter, true);
}

export async function commandRestartAll(
  context: ProjectContext,
  reporter: Reporter,
): Promise<{ instances: string[]; infrastructure: string[] }> {
  const state = await loadState(context);
  const running = await getRunningServices(context);
  const runningInstances = state.instances.filter((instance) =>
    running.has(instance.serviceName),
  );
  const managedServiceNames = new Set(
    state.instances.map((instance) => instance.serviceName),
  );
  const infrastructure = [...running].filter(
    (service) => !managedServiceNames.has(service),
  );
  if (infrastructure.length > 0) {
    await runCompose(context, ["restart", ...infrastructure]);
    for (const service of infrastructure) {
      reporter.log(`Restarted infrastructure service ${service}.`);
    }
  }
  for (const instance of runningInstances) {
    await commandRestart(context, instance.id, reporter);
  }
  if (infrastructure.length === 0 && runningInstances.length === 0) {
    reporter.log("No running Papucs services found.");
  }
  return {
    instances: runningInstances.map((instance) => instance.id),
    infrastructure,
  };
}

export async function commandSync(
  context: ProjectContext,
  serverTypeValue: string,
  dryRun: boolean,
  reporter: Reporter,
): Promise<Record<string, ApplySyncResult>> {
  const serverType = validateIdentifier(serverTypeValue, "Server type");
  const state = await loadState(context);
  const running = await getRunningServices(context);
  const candidates = state.instances.filter(
    (instance) =>
      instance.serverType === serverType && running.has(instance.serviceName),
  );
  if (candidates.length === 0) {
    reporter.log(`No running instances found for '${serverType}'.`);
    return {};
  }

  const manifest = await collectSourceManifest(context, serverType);
  const mergedEnv = await loadMergedEnv(context, serverType, manifest.config);
  const git = await resolveGitMetadata(context);
  const results: Record<string, ApplySyncResult> = {};
  for (const instance of candidates) {
    const variables = buildRuntimeTemplateContext({
      serverType,
      instanceId: instance.id,
      index: instance.index,
      instanceName: instance.serverName,
      mergedEnv: {
        ...mergedEnv,
        REF_TAG: git.ref,
        SHA_TAG: git.sha,
      },
    });
    const cache = await loadCache(context, instance.id, instance.serverType);
    const result = await applySync(
      context,
      path.join(context.runtimeRoot, instance.runtimeDataDir),
      manifest,
      cache,
      { dryRun, replacementVariables: variables },
    );
    results[instance.id] = result;
    if (!dryRun) {
      await saveCache(context, {
        instanceId: instance.id,
        serverType,
        updatedAt: nowIso(),
        files: manifestCacheEntries(manifest),
      });
    }
    reporter.log(
      `[${instance.id}] ${dryRun ? "Would update" : "Updated"} ${result.changed.length}, ${dryRun ? "would delete" : "deleted"} ${result.deleted.length}.`,
    );
  }
  return results;
}

export async function commandStatus(
  context: ProjectContext,
  serverType: string | undefined,
): Promise<
  Array<{
    id: string;
    serverType: string;
    running: boolean;
    runtimeExists: boolean;
    lastSync: string | null;
    pendingChanges: boolean;
  }>
> {
  const state = await loadState(context);
  const running = await getRunningServices(context);
  const selected = serverType
    ? state.instances.filter((instance) => instance.serverType === serverType)
    : state.instances;
  const manifests = new Map<
    string,
    Awaited<ReturnType<typeof collectSourceManifest>>
  >();
  const result = [];
  for (const instance of selected) {
    let manifest = manifests.get(instance.serverType);
    if (!manifest) {
      manifest = await collectSourceManifest(context, instance.serverType);
      manifests.set(instance.serverType, manifest);
    }
    const cache = await loadCache(context, instance.id, instance.serverType);
    result.push({
      id: instance.id,
      serverType: instance.serverType,
      running: running.has(instance.serviceName),
      runtimeExists: existsSync(
        path.join(context.runtimeRoot, instance.runtimeDataDir),
      ),
      lastSync: cache.updatedAt || null,
      pendingChanges: hasPendingSync(context, manifest, cache),
    });
  }
  return result;
}

export async function commandStopAll(
  context: ProjectContext,
  reporter: Reporter,
): Promise<void> {
  if (existsSync(context.runtimeComposePath)) {
    await runCompose(context, ["down", "--remove-orphans"], {
      allowFailure: true,
    });
  }
  const state = await loadState(context);
  state.instances = [];
  await persistStateAndCompose(context, state);
  await rm(context.runtimeCacheDir, { recursive: true, force: true });
  await ensureDir(context.runtimeCacheDir);
  reporter.log(`Stopped Papucs project '${context.config.project}'.`);
}

export async function commandPull(
  context: ProjectContext,
  target: string,
  selectionValue: string,
  layerValue: string,
  options: { force: boolean; dryRun: boolean },
  reporter: Reporter,
): Promise<string[]> {
  const state = await loadState(context);
  const instance = resolveInstanceExact(state, target);
  const running = await getRunningServices(context);
  if (!running.has(instance.serviceName)) {
    throw new PapucsError(`Instance '${instance.id}' is not running.`);
  }
  const layer = validateIdentifier(layerValue, "Layer name");
  const layerDir = path.join(context.layersDir, layer);
  if (!existsSync(path.join(layerDir, "_layer.yml"))) {
    throw new PapucsError(`Layer does not exist: ${layer}`);
  }

  const raw = selectionValue.trim().replaceAll("\\", "/");
  const wildcard = raw.endsWith("/*");
  if ((raw.match(/\*/g)?.length ?? 0) > (wildcard ? 1 : 0)) {
    throw new PapucsError("Only a trailing /* wildcard is supported.");
  }
  const relative = path.posix.normalize(wildcard ? raw.slice(0, -2) : raw);
  if (
    !relative ||
    relative === "." ||
    relative === ".." ||
    relative.startsWith("../") ||
    relative.startsWith("/")
  ) {
    throw new PapucsError(`Invalid runtime selection: '${selectionValue}'.`);
  }
  const runtimeData = path.resolve(
    context.runtimeRoot,
    instance.runtimeDataDir,
  );
  const source = path.resolve(runtimeData, relative);
  const containment = path.relative(runtimeData, source);
  if (containment.startsWith("..") || path.isAbsolute(containment)) {
    throw new PapucsError("Runtime selection escapes instance data.");
  }
  if (!existsSync(source)) {
    throw new PapucsError(`Runtime selection does not exist: ${relative}`);
  }

  const selections: Array<{ source: string; relative: string }> = [];
  if (wildcard) {
    if (!(await stat(source)).isDirectory()) {
      throw new PapucsError("Wildcard selection must point to a directory.");
    }
    const { listFilesRecursive } = await import("../fs");
    for (const file of await listFilesRecursive(source)) {
      selections.push({
        source: file,
        relative: toPosix(path.join(relative, path.relative(source, file))),
      });
    }
  } else {
    if (!(await stat(source)).isFile()) {
      throw new PapucsError("Use a trailing /* to copy directory content.");
    }
    selections.push({ source, relative });
  }

  for (const item of selections) {
    const destination = path.join(layerDir, item.relative);
    if (existsSync(destination) && !options.force) {
      throw new PapucsError(
        `Destination exists: ${destination}. Use --force to overwrite.`,
      );
    }
  }
  if (!options.dryRun) {
    for (const item of selections) {
      await copyFileWithDirs(item.source, path.join(layerDir, item.relative));
    }
  }
  reporter.log(
    `${options.dryRun ? "Would copy" : "Copied"} ${selections.length} file(s) to layer '${layer}'.`,
  );
  return selections.map((item) => item.relative);
}

export async function commandDev(
  context: ProjectContext,
  serverType: string,
  reporter: Reporter,
): Promise<RuntimeInstance> {
  const safeType = validateIdentifier(serverType, "Server type");
  let state = await loadState(context);
  const running = await getRunningServices(context);
  let instance = state.instances
    .filter((candidate) => candidate.serverType === safeType)
    .sort((left, right) => left.index - right.index)
    .find((candidate) => running.has(candidate.serviceName));

  if (instance) {
    await commandSync(context, safeType, false, reporter);
  } else {
    instance = state.instances
      .filter((candidate) => candidate.serverType === safeType)
      .sort((left, right) => left.index - right.index)[0];
    if (instance) {
      instance = await commandRebuild(context, instance.id, reporter, true);
    } else {
      instance = await commandUp(context, safeType, reporter);
    }
  }

  state = await loadState(context);
  return resolveInstanceExact(state, instance.id);
}
