import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { readServerConfig, readYamlObject } from "./config";
import { PapucsError } from "./errors";
import { listFilesRecursive, sha256File, toPosix } from "./fs";
import { validateIdentifier } from "./naming";
import type {
  LayerMeta,
  ProjectContext,
  Reporter,
  ServerConfig,
  SourceFile,
  SourceManifest,
} from "./types";

export interface LayerConfigEntry {
  name: string;
  skipBuild: boolean;
}

export function parseLayerConfigEntry(value: string): LayerConfigEntry {
  const [rawName, ...args] = value.trim().split(/\s+/);
  const name = validateIdentifier(rawName ?? "", "Layer name");
  const unsupported = args.filter((arg) => arg !== "--skip-build");
  if (unsupported.length > 0) {
    throw new PapucsError(
      `Unsupported layer arguments for '${name}': ${unsupported.join(", ")}.`,
    );
  }
  return { name, skipBuild: args.includes("--skip-build") };
}

export function serverConfigPath(
  context: ProjectContext,
  serverType: string,
): string {
  const safeType = validateIdentifier(serverType, "Server type");
  return path.join(context.serversDir, safeType, `${safeType}.yml`);
}

export async function loadServerConfig(
  context: ProjectContext,
  serverType: string,
): Promise<ServerConfig> {
  const filePath = serverConfigPath(context, serverType);
  if (!existsSync(filePath)) {
    throw new PapucsError(`Server configuration not found: ${filePath}`);
  }
  return await readServerConfig(filePath);
}

export async function listServerTypes(
  context: ProjectContext,
): Promise<string[]> {
  if (!existsSync(context.serversDir)) {
    throw new PapucsError(`Servers directory not found: ${context.serversDir}`);
  }
  const entries = await readdir(context.serversDir, { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.name.startsWith("_") &&
        existsSync(serverConfigPath(context, entry.name)),
    )
    .map((entry) => entry.name)
    .sort();
}

export async function listActionsBuildServerTypes(
  context: ProjectContext,
): Promise<string[]> {
  const result: string[] = [];
  for (const serverType of await listServerTypes(context)) {
    if ((await loadServerConfig(context, serverType)).actions_build === true) {
      result.push(serverType);
    }
  }
  return result;
}

export async function collectSourceManifest(
  context: ProjectContext,
  serverType: string,
  options: { skipBuildLayers?: boolean } = {},
): Promise<SourceManifest> {
  const config = await loadServerConfig(context, serverType);
  const files = new Map<string, SourceFile>();
  const overrides: SourceManifest["overrides"] = [];

  const addDirectory = async (
    directory: string,
    source: string,
  ): Promise<void> => {
    for (const absolutePath of await listFilesRecursive(directory)) {
      const relPath = toPosix(path.relative(directory, absolutePath));
      if (relPath === "_layer.yml") {
        continue;
      }
      const previous = files.get(relPath);
      const entry: SourceFile = {
        absPath: absolutePath,
        relPath,
        hash: await sha256File(absolutePath),
        source,
      };
      if (previous) {
        overrides.push({ relPath, from: previous.source, to: source });
      }
      files.set(relPath, entry);
    }
  };

  for (const rawLayer of config.layers ?? []) {
    const layer = parseLayerConfigEntry(rawLayer);
    if (options.skipBuildLayers && layer.skipBuild) {
      continue;
    }
    const layerDir = path.join(context.layersDir, layer.name);
    const metadataPath = path.join(layerDir, "_layer.yml");
    if (!existsSync(metadataPath)) {
      throw new PapucsError(
        `Layer '${layer.name}' is missing mandatory metadata: ${metadataPath}`,
      );
    }
    const metadata = await readYamlObject<LayerMeta>(metadataPath);
    if (
      typeof metadata.name !== "string" ||
      metadata.name.trim() !== layer.name
    ) {
      throw new PapucsError(
        `Layer metadata name must equal folder name '${layer.name}': ${metadataPath}`,
      );
    }
    await addDirectory(layerDir, `layer:${layer.name}`);
  }

  const dataDir = path.join(context.serversDir, serverType, "data");
  if (existsSync(dataDir)) {
    await addDirectory(dataDir, `data:${serverType}`);
  }

  return { config, files, overrides };
}

export function reportOverrides(
  reporter: Reporter,
  overrides: SourceManifest["overrides"],
): void {
  if (overrides.length === 0) {
    return;
  }
  reporter.verbose("Overridden files (later source wins):");
  for (const override of overrides) {
    reporter.verbose(
      `- ${override.relPath}: ${override.from} -> ${override.to}`,
    );
  }
}
