import { existsSync } from "node:fs";
import path from "node:path";
import { readYamlObject, stringifyYaml } from "./config";
import { PapucsError } from "./errors";
import { deepClone, toPosix, atomicWriteFile } from "./fs";
import { denormalizeEnvironment, normalizeEnvironment } from "./env";
import { loadServerConfig } from "./manifest";
import { saveState } from "./state";
import type {
  ComposeDocument,
  ComposeTemplate,
  ProjectContext,
  RuntimeComposeService,
  RuntimeInstance,
  RuntimeState,
  ServerConfig,
} from "./types";

function jsonEquals(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function resolveStringPlaceholders(
  input: string,
  variables: Record<string, string>,
): string {
  const resolved = input.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (full, key: string) => variables[key] ?? full,
  );
  const unresolved = resolved.match(/\$\{PAPUCS_[A-Za-z0-9_]+\}/g);
  if (unresolved) {
    throw new PapucsError(
      `Unresolved Papucs Compose placeholders: ${[...new Set(unresolved)].join(", ")}.`,
    );
  }
  return resolved;
}

function resolvePlaceholders<T>(
  input: T,
  variables: Record<string, string>,
): T {
  if (typeof input === "string") {
    return resolveStringPlaceholders(input, variables) as T;
  }
  if (Array.isArray(input)) {
    return input.map((value) => resolvePlaceholders(value, variables)) as T;
  }
  if (input && typeof input === "object") {
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>).map(([key, value]) => [
        key,
        resolvePlaceholders(value, variables),
      ]),
    ) as T;
  }
  return input;
}

function runtimeRelativePath(
  context: ProjectContext,
  source: string,
  baseDirectory: string,
): string {
  const value = source.trim();
  if (!value.startsWith("./") && !value.startsWith("../")) {
    return source;
  }
  const relative = toPosix(
    path.relative(context.runtimeRoot, path.resolve(baseDirectory, value)),
  );
  if (relative === "") {
    return ".";
  }
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function rewriteVolume(
  context: ProjectContext,
  value: unknown,
  baseDirectory: string,
): unknown {
  if (typeof value === "string") {
    // Windows drive prefixes are not accepted in project-owned relative templates.
    const separator = value.indexOf(":");
    if (separator < 0) {
      return value;
    }
    const source = value.slice(0, separator);
    return `${runtimeRelativePath(context, source, baseDirectory)}${value.slice(separator)}`;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = { ...(value as Record<string, unknown>) };
    if (typeof record.source === "string") {
      record.source = runtimeRelativePath(
        context,
        record.source,
        baseDirectory,
      );
    }
    return record;
  }
  return value;
}

function rewriteServicePaths(
  context: ProjectContext,
  service: RuntimeComposeService,
  baseDirectory: string,
): RuntimeComposeService {
  const result = deepClone(service);
  if (Array.isArray(result.volumes)) {
    result.volumes = result.volumes.map((volume) =>
      rewriteVolume(context, volume, baseDirectory),
    );
  }
  if (
    result.extends &&
    typeof result.extends === "object" &&
    !Array.isArray(result.extends)
  ) {
    const extension = {
      ...(result.extends as Record<string, unknown>),
    };
    if (typeof extension.file === "string") {
      extension.file = runtimeRelativePath(
        context,
        extension.file,
        baseDirectory,
      );
    }
    result.extends = extension;
  }
  return result;
}

function rewriteServices(
  context: ProjectContext,
  services: Record<string, RuntimeComposeService>,
  baseDirectory: string,
): Record<string, RuntimeComposeService> {
  return Object.fromEntries(
    Object.entries(services).map(([name, service]) => [
      name,
      rewriteServicePaths(context, service, baseDirectory),
    ]),
  );
}

export function resolveServerComposeTemplatePath(
  context: ProjectContext,
  serverType: string,
): string {
  const custom = path.join(
    context.serversDir,
    serverType,
    "docker-compose.yml",
  );
  return existsSync(custom) ? custom : context.sharedServerComposeTemplatePath;
}

export async function loadServerComposeTemplate(
  context: ProjectContext,
  serverType: string,
  serverConfig: ServerConfig,
): Promise<ComposeTemplate> {
  const filePath = resolveServerComposeTemplatePath(context, serverType);
  if (!existsSync(filePath)) {
    throw new PapucsError(`Server Compose template not found: ${filePath}`);
  }
  const document = await readYamlObject<ComposeDocument>(filePath);
  const services = rewriteServices(
    context,
    document.services ?? {},
    path.dirname(filePath),
  );
  const appServiceDefinition = services[serverConfig.compose_service];
  if (!appServiceDefinition) {
    throw new PapucsError(
      `Compose service '${serverConfig.compose_service}' for '${serverType}' not found in ${filePath}.`,
    );
  }
  const infraServices = Object.fromEntries(
    Object.entries(services).filter(
      ([name]) => name !== serverConfig.compose_service,
    ),
  );
  return {
    appServiceName: serverConfig.compose_service,
    appServiceDefinition,
    infraServices,
    topLevelNetworks: deepClone(document.networks ?? {}),
    topLevelVolumes: deepClone(document.volumes ?? {}),
  };
}

export function buildRuntimeServiceDefinition(options: {
  templateService: RuntimeComposeService;
  image: string;
  serverName: string;
  variables: Record<string, string>;
}): RuntimeComposeService {
  const service = resolvePlaceholders(
    deepClone(options.templateService),
    options.variables,
  );
  service.image = options.image;
  service.container_name = options.serverName;

  const extension = service["x-papucs"];
  const injectEnvironment =
    extension !== null &&
    typeof extension === "object" &&
    !Array.isArray(extension) &&
    (extension as Record<string, unknown>).inject_environment === true;
  delete service["x-papucs"];
  if (injectEnvironment) {
    service.environment = denormalizeEnvironment({
      ...options.variables,
      ...normalizeEnvironment(service.environment),
    });
  }
  return service;
}

function mergeSection(
  target: Record<string, unknown>,
  incoming: Record<string, unknown>,
  section: string,
): void {
  for (const [name, value] of Object.entries(incoming)) {
    if (name in target && !jsonEquals(target[name], value)) {
      throw new PapucsError(
        `Conflicting Compose ${section} definition: '${name}'.`,
      );
    }
    target[name] = deepClone(value);
  }
}

export async function buildRuntimeCompose(
  context: ProjectContext,
  state: RuntimeState,
): Promise<ComposeDocument> {
  if (!existsSync(context.composeFilePath)) {
    throw new PapucsError(
      `Root Compose template not found: ${context.composeFilePath}`,
    );
  }
  const rootDocument = await readYamlObject<ComposeDocument>(
    context.composeFilePath,
  );
  const services = rewriteServices(
    context,
    rootDocument.services ?? {},
    context.root,
  );
  const networks = deepClone(rootDocument.networks ?? {});
  const volumes = deepClone(rootDocument.volumes ?? {});

  const seenServerTypes = new Set<string>();
  for (const instance of state.instances) {
    if (!seenServerTypes.has(instance.serverType)) {
      seenServerTypes.add(instance.serverType);
      const serverConfig = await loadServerConfig(context, instance.serverType);
      const template = await loadServerComposeTemplate(
        context,
        instance.serverType,
        serverConfig,
      );
      mergeSection(services, template.infraServices, "service");
      mergeSection(networks, template.topLevelNetworks, "network");
      mergeSection(volumes, template.topLevelVolumes, "volume");
    }
    services[instance.serviceName] = deepClone(instance.composeService);
  }

  const document: ComposeDocument = { services };
  if (Object.keys(networks).length > 0) {
    document.networks = networks;
  }
  if (Object.keys(volumes).length > 0) {
    document.volumes = volumes;
  }
  return document;
}

export async function persistStateAndCompose(
  context: ProjectContext,
  state: RuntimeState,
): Promise<void> {
  const normalized: RuntimeState = {
    version: 1,
    instances: deduplicateInstances(state.instances),
  };
  const compose = await buildRuntimeCompose(context, normalized);
  await atomicWriteFile(context.runtimeComposePath, stringifyYaml(compose));
  await saveState(context, normalized);
  state.instances = normalized.instances;
}

function deduplicateInstances(instances: RuntimeInstance[]): RuntimeInstance[] {
  const last = new Map<string, number>();
  instances.forEach((instance, index) => last.set(instance.id, index));
  return instances.filter((instance, index) => last.get(instance.id) === index);
}

export function resolveInstanceExact(
  state: RuntimeState,
  target: string,
): RuntimeInstance {
  for (const field of ["id", "serviceName", "serverName"] as const) {
    const matches = state.instances.filter(
      (instance) => instance[field] === target,
    );
    if (matches.length === 0) {
      continue;
    }
    if (field !== "id" && matches.length > 1) {
      throw new PapucsError(
        `Ambiguous target '${target}'. Use exact instance id.`,
      );
    }
    return matches.at(-1) as RuntimeInstance;
  }
  throw new PapucsError(`No managed instance found for '${target}'.`);
}
