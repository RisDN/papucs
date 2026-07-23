import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import type { ProjectContext, ServerConfig } from "./types";

export function parseEnvContent(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separator = normalized.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = normalized.slice(0, separator).trim();
    let value = normalized.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      result[key] = value;
    }
  }
  return result;
}

async function readOptionalEnv(
  pathValue: string,
): Promise<Record<string, string>> {
  if (!existsSync(pathValue)) {
    return {};
  }
  return parseEnvContent(await readFile(pathValue, "utf8"));
}

export async function loadMergedEnv(
  context: ProjectContext,
  serverType: string,
  serverConfig: ServerConfig,
): Promise<Record<string, string>> {
  const globalEnv = await readOptionalEnv(context.envPath);
  const serverEnv = await readOptionalEnv(
    path.join(context.serversDir, serverType, ".env"),
  );
  const interpolated = Object.fromEntries(
    Object.entries(serverConfig.interpolate_variables ?? {}).map(
      ([key, value]) => [key, String(value)],
    ),
  );
  return { ...globalEnv, ...serverEnv, ...interpolated };
}

export function normalizeEnvironment(
  environment: unknown,
): Record<string, string> {
  if (Array.isArray(environment)) {
    return Object.fromEntries(
      environment
        .filter((value): value is string => typeof value === "string")
        .map((value) => {
          const separator = value.indexOf("=");
          return separator > 0
            ? [value.slice(0, separator), value.slice(separator + 1)]
            : [value, ""];
        }),
    );
  }
  if (environment && typeof environment === "object") {
    return Object.fromEntries(
      Object.entries(environment as Record<string, unknown>).map(
        ([key, value]) => [key, value == null ? "" : String(value)],
      ),
    );
  }
  return {};
}

export function denormalizeEnvironment(
  environment: Record<string, string>,
): string[] {
  return Object.entries(environment).map(([key, value]) => `${key}=${value}`);
}

function detectHostNumericId(getter: (() => number) | undefined): string {
  if (process.platform !== "linux" || typeof getter !== "function") {
    return "1000";
  }
  const value = getter();
  return value > 0 ? String(value) : "1000";
}

export function buildRuntimeTemplateContext(options: {
  serverType: string;
  instanceId: string;
  index: number;
  instanceName: string;
  mergedEnv: Record<string, string>;
}): Record<string, string> {
  const serverPrefix = options.serverType
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "_");
  const exactPort =
    options.mergedEnv[`PAPUCS_PORT_${options.index}`] ??
    options.mergedEnv[`PORTS_${options.index}`];
  const basePort =
    options.mergedEnv[`${serverPrefix}_PORT_BASE`] ??
    options.mergedEnv.PAPUCS_PORT_BASE ??
    options.mergedEnv.PORT_BASE;
  const port =
    exactPort && /^\d+$/.test(exactPort)
      ? exactPort
      : basePort && /^\d+$/.test(basePort)
        ? String(Number(basePort) + options.index - 1)
        : undefined;

  const context: Record<string, string> = {
    ...options.mergedEnv,
    PAPUCS_INSTANCE_ID: options.instanceId,
    PAPUCS_INSTANCE_NAME: options.instanceName,
    PAPUCS_INSTANCE_INDEX: String(options.index),
    PAPUCS_SERVER_TYPE: options.serverType,
    PAPUCS_DATA_PATH: `./instances/${options.instanceId}/data`,
    PAPUCS_HOST_UID:
      options.mergedEnv.PAPUCS_HOST_UID ?? detectHostNumericId(process.getuid),
    PAPUCS_HOST_GID:
      options.mergedEnv.PAPUCS_HOST_GID ?? detectHostNumericId(process.getgid),
    SERVER_NAME: options.mergedEnv.SERVER_NAME ?? options.instanceName,
    MOTD: options.mergedEnv.MOTD ?? options.instanceName,
  };
  if (port) {
    context.PAPUCS_PORT = port;
    context.SERVER_PORT ??= port;
  }
  return context;
}
