import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { readLayerMeta, readServerConfig } from "./config";
import { PapucsError } from "./errors";
import { listFilesRecursive, sha256File, toPosix } from "./fs";
import { validateIdentifier } from "./naming";
import type {
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
  const activeLayers: string[] = [];

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

  const addLayer = async (rawLayer: string): Promise<void> => {
    const layer = parseLayerConfigEntry(rawLayer);
    if (options.skipBuildLayers && layer.skipBuild) {
      return;
    }
    if (activeLayers.includes(layer.name)) {
      throw new PapucsError(
        `Circular layer reference: ${[...activeLayers, layer.name].join(" -> ")}.`,
      );
    }
    const layerDir = path.join(context.layersDir, layer.name);
    const metadataPath = path.join(layerDir, "_layer.yml");
    if (!existsSync(metadataPath)) {
      throw new PapucsError(
        `Layer '${layer.name}' is missing mandatory metadata: ${metadataPath}`,
      );
    }
    const metadata = await readLayerMeta(metadataPath);
    if (metadata.name !== layer.name) {
      throw new PapucsError(
        `Layer metadata name must equal folder name '${layer.name}': ${metadataPath}`,
      );
    }
    // Track only the current branch: shared layers must retain list-order precedence.
    activeLayers.push(layer.name);
    try {
      for (const childLayer of metadata.layers ?? []) {
        await addLayer(childLayer);
      }
      await addDirectory(layerDir, `layer:${layer.name}`);
    } finally {
      activeLayers.pop();
    }
  };

  for (const rawLayer of config.layers ?? []) {
    await addLayer(rawLayer);
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
