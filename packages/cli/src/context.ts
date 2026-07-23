import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { readProjectConfig } from "./config";
import { PapucsError } from "./errors";
import type { ProjectContext } from "./types";

export interface ResolveProjectOptions {
  cwd?: string;
  project?: string;
  config?: string;
}

export function resolveInsideRoot(
  root: string,
  configuredPath: string,
  label: string,
): string {
  if (path.isAbsolute(configuredPath)) {
    throw new PapucsError(`${label} must be relative to the project root.`);
  }

  const resolved = path.resolve(root, configuredPath);
  const relative = path.relative(root, resolved);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new PapucsError(`${label} escapes the project root.`);
  }
  return resolved;
}

export function findProjectConfig(startDirectory: string): string {
  let current = path.resolve(startDirectory);
  while (true) {
    const candidate = path.join(current, "papucs.yml");
    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  throw new PapucsError(
    `No papucs.yml found from '${startDirectory}' or any parent directory.`,
  );
}

function composeProjectName(project: string, root: string): string {
  const safeProject = project
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const rootHash = createHash("sha256").update(root).digest("hex").slice(0, 8);
  return `papucs-${safeProject || "project"}-${rootHash}`;
}

export async function resolveProjectContext(
  options: ResolveProjectOptions = {},
): Promise<ProjectContext> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  let configPath: string;

  if (options.config) {
    configPath = path.resolve(cwd, options.config);
  } else if (options.project) {
    const projectPath = path.resolve(cwd, options.project);
    if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
      throw new PapucsError(`Project directory does not exist: ${projectPath}`);
    }
    configPath = path.join(projectPath, "papucs.yml");
  } else {
    configPath = findProjectConfig(cwd);
  }

  if (!existsSync(configPath)) {
    throw new PapucsError(`Papucs configuration not found: ${configPath}`);
  }

  const root = path.dirname(configPath);
  const config = await readProjectConfig(configPath);
  const runtimeRoot = resolveInsideRoot(
    root,
    config.runtime.dir,
    "runtime.dir",
  );

  return {
    root,
    configPath,
    config,
    runtimeRoot,
    runtimeComposePath: path.join(runtimeRoot, "docker-compose.yml"),
    runtimeStatePath: path.join(runtimeRoot, "state.json"),
    runtimeCacheDir: path.join(runtimeRoot, "cache"),
    runtimeInstancesDir: path.join(runtimeRoot, "instances"),
    runtimeBuildDir: path.join(runtimeRoot, "build"),
    runtimeLockPath: path.join(runtimeRoot, "lock"),
    composeFilePath: resolveInsideRoot(
      root,
      config.compose.file,
      "compose.file",
    ),
    serversDir: resolveInsideRoot(
      root,
      config.sources.servers,
      "sources.servers",
    ),
    layersDir: resolveInsideRoot(root, config.sources.layers, "sources.layers"),
    sharedServerComposeTemplatePath: resolveInsideRoot(
      root,
      config.compose.shared_server_template,
      "compose.shared_server_template",
    ),
    dockerfileTemplatePath: resolveInsideRoot(
      root,
      config.build.dockerfile_template,
      "build.dockerfile_template",
    ),
    runtimeReplaceScriptPath: resolveInsideRoot(
      root,
      "scripts/papucs-runtime-replace.sh",
      "runtime replacement script",
    ),
    envPath: path.join(root, ".env"),
    composeProjectName: composeProjectName(config.project, root),
  };
}
