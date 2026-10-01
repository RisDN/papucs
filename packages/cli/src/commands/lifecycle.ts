import { existsSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  buildRuntimeCompose,
  buildRuntimeServiceDefinition,
  loadServerComposeTemplate,
  persistStateAndCompose,
  resolveInstanceExact,
} from "../compose";
import {
  assertServicesStopped,
  assertStoppedContainersSafe,
  waitServicesCompleted,
  getRunningContainerNames,
  getRunningServices,
  runCompose,
} from "../docker";
import { readYamlObject } from "../config";
import {
  buildDependencyGraph,
  dependencyLayers,
  dependentClosure,
} from "../dependencies";
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
import { loadCache, loadState, saveCache } from "../state";
import {
  applySync,
  hasPendingSync,
  manifestCacheEntries,
  replaceRuntimeDataFromManifest,
} from "../sync";
import type {
  ApplySyncResult,
  ComposeDocument,
  ProjectContext,
  Reporter,
  RuntimeInstance,
  RuntimeState,
  SourceManifest,
  SyncCacheFileEntry,
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

export async function replaceInstanceRuntimeData(options: {
  context: ProjectContext;
  runtimeDataDir: string;
  manifest: SourceManifest;
  replacementVariables: Record<string, string>;
}): Promise<Record<string, SyncCacheFileEntry>> {
  return await replaceRuntimeDataFromManifest(
    options.context,
    options.runtimeDataDir,
    options.manifest,
    {
      replacementVariables: options.replacementVariables,
    },
  );
}

async function prepareInstance(
  context: ProjectContext,
  instance: RuntimeInstance,
  reporter: Reporter,
): Promise<{ manifest: SourceManifest; variables: Record<string, string> }> {
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

  return { manifest, variables };
}

async function materializeInstance(
  context: ProjectContext,
  state: RuntimeState,
  instance: RuntimeInstance,
  reporter: Reporter,
  prepared?: Awaited<ReturnType<typeof prepareInstance>>,
): Promise<void> {
  const { manifest, variables } =
    prepared ?? (await prepareInstance(context, instance, reporter));

  const runtimeDataDir = path.join(
    context.runtimeRoot,
    instance.runtimeDataDir,
  );
  const files = await replaceInstanceRuntimeData({
    context,
    runtimeDataDir,
    manifest,
    replacementVariables: variables,
  });
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
  return (await commandUpBatch(context, [serverTypeValue], reporter))[0]!;
}

/** Plan every instance before dependency resolution or any Docker start. */
export async function commandUpBatch(
  context: ProjectContext,
  serverTypeValues: string[],
  reporter: Reporter,
): Promise<RuntimeInstance[]> {
  const serverTypes = serverTypeValues.map((value) =>
    validateIdentifier(value, "Server type"),
  );
  if (serverTypes.length === 0)
    throw new PapucsError("At least one server type is required.");
  const state = await loadState(context);
  const instances: RuntimeInstance[] = [];
  for (const serverType of serverTypes) {
    const serverConfig = await loadServerConfig(context, serverType);
    const index = await nextServerIndex(context, serverType, state);
    const id = `${serverType}-${index}`;
    const serverName = buildServerName(
      context,
      serverConfig,
      serverType,
      index,
    );
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
    instances.push(instance);
  }
  const prepared = [];
  for (const instance of instances)
    prepared.push(await prepareInstance(context, instance, reporter));
  await buildRuntimeCompose(context, state); // Missing, ambiguous, collision and cycle checks before data/cache writes.
  for (let index = 0; index < instances.length; index++) {
    await materializeInstance(
      context,
      state,
      instances[index]!,
      reporter,
      prepared[index],
    );
  }
  await persistStateAndCompose(context, state);
  // Compose handles health and one-shot dependency conditions for the complete batch.
  await runCompose(context, [
    "up",
    "-d",
    "--wait",
    "--no-recreate",
    ...instances.map((instance) => instance.serviceName),
  ]);
  for (const instance of instances)
    reporter.log(`Started ${instance.id} (${instance.serverName}).`);
  return instances;
}

async function shutdownCompose(
  context: ProjectContext,
  state: RuntimeState,
): Promise<ComposeDocument> {
  const planned = await buildRuntimeCompose(context, state);
  const graph = buildDependencyGraph(planned.services ?? {});
  if (existsSync(context.runtimeComposePath)) {
    const actual = await readYamlObject<ComposeDocument>(
      context.runtimeComposePath,
    );
    const previous = buildDependencyGraph(actual.services ?? {});
    for (const [service, providers] of previous) {
      if (!graph.has(service)) graph.set(service, new Set());
      for (const provider of providers) graph.get(service)?.add(provider);
    }
  }
  dependencyLayers(graph); // A reversed dependency edit can introduce a cycle in the conservative union.
  return {
    ...planned,
    services: Object.fromEntries(
      [...graph].map(([service, providers]) => [
        service,
        {
          ...planned.services?.[service],
          depends_on: [...providers],
        },
      ]),
    ),
  };
}

async function stopServices(
  context: ProjectContext,
  document: ComposeDocument,
  selected: Iterable<string>,
): Promise<void> {
  const graph = buildDependencyGraph(document.services ?? {});
  for (const layer of dependencyLayers(graph, selected, "reverse")) {
    await runCompose(context, ["stop", ...layer]);
    await assertServicesStopped(context, layer);
  }
}

async function preflightTargets(
  context: ProjectContext,
  state: RuntimeState,
  targets: RuntimeInstance[],
): Promise<Set<string>> {
  const graph = buildDependencyGraph(
    (await shutdownCompose(context, state)).services ?? {},
  );
  const running = await getRunningServices(context);
  for (const target of targets) {
    const consumers = [...dependentClosure(graph, [target.serviceName])].filter(
      (service) => service !== target.serviceName && running.has(service),
    );
    if (consumers.length > 0) {
      throw new PapucsError(
        `Cannot stop or rebuild '${target.id}' while dependent services are running: ${consumers.join(", ")}. Stop dependents first or use restartall.`,
      );
    }
  }
  return running;
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

  const running = await preflightTargets(context, state, targets);
  const remaining = {
    ...state,
    instances: state.instances.filter(
      (instance) => !targets.includes(instance),
    ),
  };
  await buildRuntimeCompose(context, remaining); // Do not remove a provider still referenced by stopped instances.

  const removed: string[] = [];
  for (const instance of targets) {
    await runCompose(context, ["stop", instance.serviceName]);
    if (running.has(instance.serviceName))
      await assertServicesStopped(context, [instance.serviceName]);
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
  const running = await preflightTargets(context, state, [instance]);
  const prepared = await prepareInstance(context, instance, reporter);
  await buildRuntimeCompose(context, state);
  await runCompose(context, ["stop", instance.serviceName]);
  if (running.has(instance.serviceName))
    await assertServicesStopped(context, [instance.serviceName]);
  await runCompose(context, ["rm", "-f", instance.serviceName]);
  await materializeInstance(context, state, instance, reporter, prepared);
  await persistStateAndCompose(context, state);
  if (start) {
    await runCompose(context, [
      "up",
      "-d",
      "--wait",
      "--no-recreate",
      instance.serviceName,
    ]);
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

export async function commandRestartBatch(
  context: ProjectContext,
  targets: string[],
  reporter: Reporter,
): Promise<RuntimeInstance[]> {
  const state = await loadState(context);
  const instances = targets.map((target) =>
    resolveInstanceExact(state, target),
  );
  await preflightTargets(context, state, instances);
  // Validate all replacements before the first target changes.
  for (const instance of instances)
    await prepareInstance(context, instance, reporter);
  await buildRuntimeCompose(context, state);
  await preflightTargets(context, state, instances);
  const rebuilt = [];
  for (const instance of instances)
    rebuilt.push(await commandRestart(context, instance.id, reporter));
  return rebuilt;
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
  if (infrastructure.length === 0 && runningInstances.length === 0) {
    reporter.log("No running Papucs services found.");
    return { instances: [], infrastructure: [] };
  }
  await assertStoppedContainersSafe(context);
  const prepared = new Map<
    string,
    Awaited<ReturnType<typeof prepareInstance>>
  >();
  for (const instance of runningInstances)
    prepared.set(
      instance.id,
      await prepareInstance(context, instance, reporter),
    );
  const starting = await buildRuntimeCompose(context, state);
  const stopping = await shutdownCompose(context, state);
  const graph = buildDependencyGraph(starting.services ?? {});
  // Never start a previously stopped provider as an incidental side effect of restartall.
  for (const service of running) {
    if (!graph.has(service))
      throw new PapucsError(
        `Running service '${service}' is absent from project Compose. Stop it explicitly before restartall.`,
      );
    for (const provider of graph.get(service) ?? []) {
      if (running.has(provider)) continue;
      const declaration = starting.services?.[service]?.depends_on;
      const condition =
        declaration &&
        typeof declaration === "object" &&
        !Array.isArray(declaration)
          ? (
              declaration as Record<
                string,
                { condition?: string; required?: boolean }
              >
            )[provider]
          : undefined;
      if (condition?.required === false) continue;
      if (condition?.condition === "service_completed_successfully") {
        await assertServicesStopped(context, [provider], true);
        continue;
      }
      throw new PapucsError(
        `Cannot restart '${service}': dependency '${provider}' was not running. Start it explicitly first; restartall preserves stopped services.`,
      );
    }
  }
  await stopServices(context, stopping, running);
  for (const instance of runningInstances) {
    await runCompose(context, ["rm", "-f", instance.serviceName]);
    await materializeInstance(
      context,
      state,
      instance,
      reporter,
      prepared.get(instance.id),
    );
  }
  await persistStateAndCompose(context, state);
  const completedProviders = new Set<string>();
  for (const [consumer, definition] of Object.entries(
    starting.services ?? {},
  )) {
    if (!running.has(consumer)) continue;
    const dependencies = definition.depends_on;
    if (
      !dependencies ||
      typeof dependencies !== "object" ||
      Array.isArray(dependencies)
    )
      continue;
    for (const [provider, options] of Object.entries(dependencies)) {
      if (
        options &&
        typeof options === "object" &&
        (options as { condition?: string }).condition ===
          "service_completed_successfully"
      )
        completedProviders.add(provider);
    }
  }
  for (const layer of dependencyLayers(graph, running)) {
    const oneShot = layer.filter((service) => completedProviders.has(service));
    const persistent = layer.filter(
      (service) => !completedProviders.has(service),
    );
    if (oneShot.length > 0) {
      await runCompose(context, ["up", "-d", "--no-deps", ...oneShot]);
      await waitServicesCompleted(context, oneShot);
    }
    if (persistent.length > 0)
      await runCompose(context, [
        "up",
        "-d",
        "--wait",
        "--no-deps",
        ...persistent,
      ]);
    for (const service of layer) reporter.log(`Restarted service ${service}.`);
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
  const state = await loadState(context);
  const running = await getRunningServices(context);
  const document = await shutdownCompose(context, state);
  await assertStoppedContainersSafe(context);
  if (existsSync(context.runtimeComposePath)) {
    await stopServices(context, document, running);
    await runCompose(context, ["down", "--remove-orphans"]);
  } else if (running.size > 0 || state.instances.length > 0) {
    throw new PapucsError(
      "Runtime Compose is missing; stop cannot be verified. Runtime state retained.",
    );
  }
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
