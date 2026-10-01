import { PapucsError } from "./errors";
import { deepClone } from "./fs";
import type {
  DependencyCondition,
  RuntimeComposeService,
  RuntimeInstance,
  ServerDependency,
} from "./types";

export type DependencyGraph = Map<string, Set<string>>;

const conditions = new Set<DependencyCondition>([
  "service_started",
  "service_healthy",
  "service_completed_successfully",
]);

function readDependsOn(
  service: RuntimeComposeService,
  serviceName: string,
): Map<string, Record<string, unknown>> {
  const value = service.depends_on;
  if (value === undefined) {
    return new Map();
  }
  if (Array.isArray(value)) {
    if (value.some((entry) => typeof entry !== "string" || !entry.trim())) {
      throw new PapucsError(`Invalid depends_on for service '${serviceName}'.`);
    }
    return new Map(
      value.map((entry: string) => [entry, { condition: "service_started" }]),
    );
  }
  if (!value || typeof value !== "object") {
    throw new PapucsError(`Invalid depends_on for service '${serviceName}'.`);
  }
  const result = new Map<string, Record<string, unknown>>();
  for (const [name, settings] of Object.entries(value)) {
    if (
      !name ||
      !settings ||
      typeof settings !== "object" ||
      Array.isArray(settings)
    ) {
      throw new PapucsError(`Invalid depends_on for service '${serviceName}'.`);
    }
    const definition = settings as Record<string, unknown>;
    if (
      definition.condition !== undefined &&
      !conditions.has(definition.condition as DependencyCondition)
    ) {
      throw new PapucsError(
        `Invalid dependency condition for '${serviceName}' on '${name}'.`,
      );
    }
    result.set(name, deepClone(definition));
  }
  return result;
}

export function mergeDeclaredDependencies(options: {
  serviceName: string;
  service: RuntimeComposeService;
  declarations: ServerDependency[];
  instances: RuntimeInstance[];
  infrastructureServices: Set<string>;
}): void {
  const {
    serviceName,
    service,
    declarations,
    instances,
    infrastructureServices,
  } = options;
  if (declarations.length === 0) {
    return;
  }
  const dependencies = readDependsOn(service, serviceName);
  for (const declaration of declarations) {
    let provider: string;
    if (declaration.service !== undefined) {
      provider = declaration.service;
      if (!infrastructureServices.has(provider)) {
        throw new PapucsError(
          `Dependency service '${provider}' for '${serviceName}' does not exist in the infrastructure Compose services.`,
        );
      }
    } else {
      const matches = instances.filter((instance) =>
        declaration.server !== undefined
          ? instance.serverType === declaration.server
          : instance.id === declaration.instance,
      );
      const target = declaration.server ?? declaration.instance;
      if (matches.length === 0) {
        throw new PapucsError(
          `Dependency '${target}' for '${serviceName}' has no managed or planned instance. Include its server type in 'papucs up'.`,
        );
      }
      if (matches.length !== 1) {
        throw new PapucsError(
          `Dependency '${target}' for '${serviceName}' is ambiguous. Use an exact instance dependency.`,
        );
      }
      provider = matches[0]!.serviceName;
    }
    if (provider === serviceName) {
      throw new PapucsError(
        `Service '${serviceName}' cannot depend on itself.`,
      );
    }
    const condition = declaration.condition ?? "service_started";
    const previous = dependencies.get(provider);
    if (previous) {
      const previousCondition = previous.condition ?? "service_started";
      if (previousCondition !== condition || previous.required === false) {
        throw new PapucsError(
          `Conflicting dependency '${provider}' for service '${serviceName}'.`,
        );
      }
    } else {
      dependencies.set(provider, { condition });
    }
  }
  service.depends_on = Object.fromEntries(dependencies);
}

export function buildDependencyGraph(
  services: Record<string, RuntimeComposeService>,
): DependencyGraph {
  const graph: DependencyGraph = new Map(
    Object.keys(services).map((name) => [name, new Set<string>()]),
  );
  const add = (consumer: string, provider: string, required = true): void => {
    if (!graph.has(provider)) {
      if (!required) {
        return;
      }
      throw new PapucsError(
        `Service '${consumer}' depends on missing service '${provider}'.`,
      );
    }
    if (consumer === provider) {
      throw new PapucsError(`Service '${consumer}' cannot depend on itself.`);
    }
    graph.get(consumer)!.add(provider);
  };
  for (const [name, service] of Object.entries(services)) {
    for (const [provider, definition] of readDependsOn(service, name)) {
      add(name, provider, definition.required !== false);
    }
    for (const field of ["links", "volumes_from"] as const) {
      const value = service[field];
      if (!Array.isArray(value)) {
        continue;
      }
      for (const reference of value) {
        if (typeof reference !== "string") {
          throw new PapucsError(`Invalid ${field} for service '${name}'.`);
        }
        if (field === "volumes_from" && reference.startsWith("container:")) {
          continue;
        }
        add(name, reference.split(":")[0]!);
      }
    }
    for (const field of ["network_mode", "ipc", "pid"] as const) {
      const value = service[field];
      if (typeof value === "string" && value.startsWith("service:")) {
        add(name, value.slice("service:".length));
      }
    }
  }
  dependencyLayers(graph);
  return graph;
}

function selectedServices(
  graph: DependencyGraph,
  selected?: Iterable<string>,
): Set<string> {
  const names = new Set(selected ?? graph.keys());
  for (const name of names) {
    if (!graph.has(name)) {
      throw new PapucsError(`Unknown dependency graph service '${name}'.`);
    }
  }
  return names;
}

export function dependencyLayers(
  graph: DependencyGraph,
  selected?: Iterable<string>,
  direction: "forward" | "reverse" = "forward",
): string[][] {
  const remaining = selectedServices(graph, selected);
  const layers: string[][] = [];
  while (remaining.size > 0) {
    const layer = [...remaining]
      .filter(
        (name) =>
          ![...graph.get(name)!].some((provider) => remaining.has(provider)),
      )
      .sort();
    if (layer.length === 0) {
      throw new PapucsError(
        `Dependency cycle detected among services: ${[...remaining].sort().join(", ")}.`,
      );
    }
    layers.push(layer);
    for (const name of layer) {
      remaining.delete(name);
    }
  }
  return direction === "reverse" ? layers.reverse() : layers;
}

export function dependentClosure(
  graph: DependencyGraph,
  targets: Iterable<string>,
): Set<string> {
  const result = selectedServices(graph, targets);
  const pending = [...result];
  for (let index = 0; index < pending.length; index++) {
    const provider = pending[index]!;
    for (const [consumer, dependencies] of graph) {
      if (dependencies.has(provider) && !result.has(consumer)) {
        result.add(consumer);
        pending.push(consumer);
      }
    }
  }
  return result;
}
