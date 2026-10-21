import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { readYamlObject } from "../config";
import { resolveInstanceExact } from "../compose";
import { buildDependencyGraph, dependencyLayers } from "../dependencies";
import { runCompose } from "../docker";
import { PapucsError } from "../errors";
import {
  inspectProjectContainers,
  type ContainerSnapshot,
} from "../inspection";
import { runCommand } from "../process";
import { loadStateReadOnly } from "../state";
import type {
  ComposeDocument,
  DependencyCondition,
  ProjectContext,
  Reporter,
  RuntimeState,
} from "../types";

export interface StartResult {
  targets: string[];
  layers: string[][];
  started: string[];
  alreadyRunning: string[];
  completed: string[];
}

function successfulCompletion(container: ContainerSnapshot): boolean {
  return (
    container.status === "exited" &&
    !container.running &&
    !container.restarting &&
    container.exitCode === 0 &&
    !container.oomKilled
  );
}

function recoveryHint(state: RuntimeState, service: string): string {
  const instance = state.instances.find((item) => item.serviceName === service);
  return instance
    ? `Use 'papucs rebuild ${instance.id}' only if replacing its runtime data from sources is intended.`
    : `Recreate the infrastructure service '${service}' with Docker Compose, then retry.`;
}

/** Start existing containers only: no Compose generation, rebuild, or data copy. */
export async function commandStart(
  context: ProjectContext,
  targets: string[],
  options: { waitTimeout: number },
  reporter: Reporter,
): Promise<StartResult> {
  if (targets.length === 0)
    throw new PapucsError(
      "At least one exact instance or service is required.",
    );
  if (!Number.isFinite(options.waitTimeout) || options.waitTimeout <= 0)
    throw new PapucsError(
      "Start wait timeout must be a positive number of seconds.",
    );
  if (!existsSync(context.runtimeComposePath))
    throw new PapucsError(
      "Generated runtime Compose is missing. Use 'papucs up' to create instances before starting them.",
    );

  const state = await loadStateReadOnly(context);
  const document = await readYamlObject<ComposeDocument>(
    context.runtimeComposePath,
  );
  const services = document.services;
  if (
    !services ||
    typeof services !== "object" ||
    Array.isArray(services) ||
    Object.values(services).some(
      (service) =>
        !service || typeof service !== "object" || Array.isArray(service),
    )
  )
    throw new PapucsError(
      "Generated runtime Compose has invalid service definitions.",
    );
  const graph = buildDependencyGraph(services);
  const selected = new Set(
    targets.map((target) => {
      const isInstance = state.instances.some((instance) =>
        [instance.id, instance.serviceName, instance.serverName].includes(
          target,
        ),
      );
      const service = isInstance
        ? resolveInstanceExact(state, target).serviceName
        : target;
      if (!graph.has(service))
        throw new PapucsError(
          `No existing instance or infrastructure service found for '${target}'. Use an exact instance id, container name, or service name.`,
        );
      return service;
    }),
  );
  const required = new Set(selected);
  const pending = [...required];
  for (let index = 0; index < pending.length; index++) {
    for (const provider of graph.get(pending[index]!)!) {
      if (!required.has(provider)) {
        required.add(provider);
        pending.push(provider);
      }
    }
  }
  const layers = dependencyLayers(graph, required);
  const conditions = new Map<string, Set<DependencyCondition>>();
  for (const consumer of required) {
    const dependencies = services[consumer]!.depends_on;
    for (const provider of graph.get(consumer)!) {
      const settings =
        dependencies && !Array.isArray(dependencies)
          ? (
              dependencies as Record<
                string,
                { condition?: DependencyCondition }
              >
            )[provider]
          : undefined;
      const condition = settings?.condition ?? "service_started";
      const values = conditions.get(provider) ?? new Set<DependencyCondition>();
      values.add(condition);
      conditions.set(provider, values);
    }
  }
  for (const [service, values] of conditions) {
    if (values.has("service_completed_successfully") && values.size > 1)
      throw new PapucsError(
        `Service '${service}' is required both running and completed. These start readiness conditions cannot be satisfied together.`,
      );
  }

  // Validate every required managed data directory before Docker can create a bind source.
  for (const instance of state.instances.filter((item) =>
    required.has(item.serviceName),
  )) {
    const dataDirectory = path.resolve(
      context.runtimeRoot,
      instance.runtimeDataDir,
    );
    const relative = path.relative(context.runtimeRoot, dataDirectory);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
      throw new PapucsError(
        `Invalid runtime data directory for '${instance.id}'.`,
      );
    const dataStat = await stat(dataDirectory).catch(() => undefined);
    if (!dataStat?.isDirectory())
      throw new PapucsError(
        `Runtime data directory for '${instance.id}' is missing. Restore it before starting. ${recoveryHint(state, instance.serviceName)}`,
      );
  }
  await runCompose(context, ["config", "--quiet"]);
  const initial = await inspectProjectContainers(context);
  const containers = new Map<string, ContainerSnapshot[]>();
  for (const service of required) {
    const matches = initial.filter(
      (container) => container.service === service,
    );
    if (matches.length === 0)
      throw new PapucsError(
        `Cannot start '${service}': its existing container is missing. ${recoveryHint(state, service)} No containers were started.`,
      );
    for (const container of matches) {
      if (
        !["created", "exited", "running", "restarting"].includes(
          container.status,
        )
      )
        throw new PapucsError(
          `Cannot start '${service}' while container '${container.name}' is ${container.status}. Resolve that Docker state first. No containers were started.`,
        );
    }
    containers.set(service, matches);
  }

  const readiness = new Map<string, DependencyCondition>();
  for (const service of required) {
    const values = conditions.get(service);
    readiness.set(
      service,
      values?.has("service_completed_successfully")
        ? "service_completed_successfully"
        : values?.has("service_healthy") ||
            (selected.has(service) &&
              containers
                .get(service)!
                .some((container) => container.healthcheckEnabled))
          ? "service_healthy"
          : "service_started",
    );
    if (
      readiness.get(service) === "service_healthy" &&
      containers
        .get(service)!
        .some((container) => !container.healthcheckEnabled)
    )
      throw new PapucsError(
        `Service '${service}' requires health readiness, but its existing container has no healthcheck. Recreate it with the intended configuration. No containers were started.`,
      );
  }

  const deadline = Date.now() + options.waitTimeout * 1000;
  const result: StartResult = {
    targets: [...selected],
    layers,
    started: [],
    alreadyRunning: [],
    completed: [],
  };
  for (const layer of layers) {
    if (Date.now() >= deadline)
      throw new PapucsError(
        `Start wait timeout of ${options.waitTimeout}s expired before starting the next dependency layer. Runtime data retained.`,
      );
    const toStart: ContainerSnapshot[] = [];
    for (const service of layer) {
      const members = containers.get(service)!;
      if (
        readiness.get(service) === "service_completed_successfully" &&
        members.every(successfulCompletion)
      ) {
        result.completed.push(service);
        reporter.log(`Reused completed service ${service}.`);
        continue;
      }
      const stopped = members.filter(
        (container) =>
          !container.running &&
          !container.restarting &&
          !(
            readiness.get(service) === "service_completed_successfully" &&
            successfulCompletion(container)
          ),
      );
      if (stopped.length > 0) {
        toStart.push(...stopped);
        result.started.push(service);
      } else {
        result.alreadyRunning.push(service);
      }
    }
    if (toStart.length > 0) {
      const start = await runCommand(
        "docker",
        ["start", ...toStart.map((container) => container.id)],
        { cwd: context.root },
      );
      if (start.code !== 0)
        throw new PapucsError(
          `Could not start existing containers for ${[...new Set(toStart.map((container) => container.service))].join(", ")}. Runtime data retained; already-started providers remain running.${start.stderr ? `\n${start.stderr}` : ""}`,
        );
    }
    while (true) {
      const current = await inspectProjectContainers(context);
      const waiting: string[] = [];
      for (const service of layer) {
        const condition = readiness.get(service)!;
        for (const expected of containers.get(service)!) {
          const container = current.find(
            (candidate) =>
              candidate.id === expected.id && candidate.service === service,
          );
          if (!container)
            throw new PapucsError(
              `Container for '${service}' disappeared or was replaced during start. Runtime state retained.`,
            );
          if (
            condition === "service_completed_successfully" &&
            successfulCompletion(container)
          )
            continue;
          if (
            container.status === "exited" ||
            container.status === "dead" ||
            container.status === "removing" ||
            container.status === "paused"
          )
            throw new PapucsError(
              `Service '${service}' failed start readiness (status=${container.status}, exit=${container.exitCode}, OOM=${container.oomKilled}, required=${condition}). Dependent services were not started.`,
            );
          const ready =
            container.running &&
            !container.restarting &&
            container.status === "running" &&
            (condition === "service_started" ||
              (condition === "service_healthy" &&
                container.healthStatus === "healthy"));
          if (!ready)
            waiting.push(
              `${service} (${condition}, status=${container.status}, health=${container.healthStatus ?? "none"})`,
            );
        }
      }
      if (waiting.length === 0) break;
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new PapucsError(
          `Timed out after ${options.waitTimeout}s waiting for ${waiting.join(", ")}. Dependent services were not started; runtime data retained.`,
        );
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(250, remaining)),
      );
    }
    for (const service of layer) {
      if (result.started.includes(service))
        reporter.log(`Started existing service ${service}.`);
      else if (result.alreadyRunning.includes(service))
        reporter.log(`Service ${service} is already running.`);
    }
  }
  return result;
}
