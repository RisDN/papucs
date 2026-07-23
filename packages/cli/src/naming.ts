import { PapucsError } from "./errors";
import type { ProjectContext, ServerConfig } from "./types";

const placeholderPattern = /%([A-Za-z0-9_]+)%/g;

export function validateIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(normalized)) {
    throw new PapucsError(
      `${label} must match /^[A-Za-z0-9][A-Za-z0-9_-]*$/: '${value}'.`,
    );
  }
  return normalized;
}

export function buildTemplateValues(
  context: ProjectContext,
  serverConfig: ServerConfig,
  serverType: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const values: Record<string, string> = {
    project: context.config.project,
    server_type: serverType,
  };
  for (const [key, value] of Object.entries(serverConfig)) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      values[key.toLowerCase()] = String(value);
    }
  }
  for (const [key, value] of Object.entries(extra)) {
    values[key.toLowerCase()] = value;
  }
  return values;
}

export function replacePercentPlaceholders(
  input: string,
  values: Record<string, string>,
  label: string,
): string {
  const output = input.replace(
    placeholderPattern,
    (full, key: string) => values[key.toLowerCase()] ?? full,
  );
  const unresolved = output.match(placeholderPattern);
  if (unresolved) {
    throw new PapucsError(
      `Unresolved placeholders in ${label}: ${[...new Set(unresolved)].join(", ")}.`,
    );
  }
  return output;
}

export function buildServerName(
  context: ProjectContext,
  serverConfig: ServerConfig,
  serverType: string,
  index: number,
): string {
  return replacePercentPlaceholders(
    serverConfig.instance_name,
    buildTemplateValues(context, serverConfig, serverType, {
      index: String(index),
    }),
    `instance_name for '${serverType}'`,
  );
}

export function extractServerNumber(
  context: ProjectContext,
  serverConfig: ServerConfig,
  serverType: string,
  containerName: string,
): number | null {
  const marker = "__PAPUCS_INDEX__";
  const pattern = replacePercentPlaceholders(
    serverConfig.instance_name,
    buildTemplateValues(context, serverConfig, serverType, { index: marker }),
    `instance_name for '${serverType}'`,
  );
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^${escaped.replace(marker, "([0-9]+)")}$`).exec(
    containerName,
  );
  const parsed = Number(match?.[1]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
