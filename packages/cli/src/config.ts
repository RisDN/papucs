import { readFile } from "node:fs/promises";
import YAML from "yaml";
import { z } from "zod";
import { PapucsError } from "./errors";
import type { ProjectConfig, ServerConfig } from "./types";

const relativePathSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => !value.includes("\0"), "Path contains a null byte.");

const projectConfigSchema = z
  .object({
    version: z.literal(1),
    project: z
      .string()
      .trim()
      .min(1)
      .regex(
        /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
        "project must be a filesystem-safe name",
      ),
    runtime: z.object({
      dir: relativePathSchema,
    }),
    sources: z.object({
      layers: relativePathSchema,
      servers: relativePathSchema,
    }),
    compose: z.object({
      file: relativePathSchema,
      shared_server_template: relativePathSchema,
    }),
    build: z.object({
      dockerfile_template: relativePathSchema,
      image: z.string().trim().min(1),
      tags: z.array(z.string().trim().min(1)).min(1),
    }),
    preserve_paths: z.array(relativePathSchema).default([]),
    replaceable_text_extensions: z
      .array(z.string().regex(/^\.[A-Za-z0-9]+$/))
      .min(1),
  })
  .strict();

const serverConfigSchema = z
  .object({
    name: z.string().trim().min(1),
    image: z.string().trim().min(1),
    compose_service: z.string().trim().min(1),
    instance_name: z.string().trim().min(1),
    actions_build: z.boolean().optional(),
    build: z
      .object({
        image: z.string().trim().min(1).optional(),
        tags: z.array(z.string().trim().min(1)).min(1).optional(),
      })
      .optional(),
    interpolate_variables: z
      .record(z.union([z.string(), z.number(), z.boolean()]))
      .optional(),
    layers: z.array(z.string().trim().min(1)).optional(),
  })
  .passthrough();

async function readYaml(path: string): Promise<unknown> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    throw new PapucsError(
      `Cannot read YAML file '${path}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    return YAML.parse(content) as unknown;
  } catch (error) {
    throw new PapucsError(
      `Invalid YAML in '${path}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function formatSchemaError(path: string, error: z.ZodError): PapucsError {
  const details = error.issues
    .map((issue) => {
      const field = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `${field}: ${issue.message}`;
    })
    .join("; ");
  return new PapucsError(`Invalid configuration '${path}': ${details}`);
}

export async function readProjectConfig(path: string): Promise<ProjectConfig> {
  const result = projectConfigSchema.safeParse(await readYaml(path));
  if (!result.success) {
    throw formatSchemaError(path, result.error);
  }
  return result.data;
}

export async function readServerConfig(path: string): Promise<ServerConfig> {
  const result = serverConfigSchema.safeParse(await readYaml(path));
  if (!result.success) {
    throw formatSchemaError(path, result.error);
  }

  const indexCount = result.data.instance_name.match(/%index%/gi)?.length ?? 0;
  if (indexCount !== 1) {
    throw new PapucsError(
      `Invalid configuration '${path}': instance_name must contain exactly one %index% placeholder.`,
    );
  }

  return result.data;
}

export async function readYamlObject<T>(path: string): Promise<T> {
  const value = await readYaml(path);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PapucsError(`Expected YAML object in '${path}'.`);
  }
  return value as T;
}

export function stringifyYaml(value: unknown): string {
  return YAML.stringify(value, { lineWidth: 120 });
}
