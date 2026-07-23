import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { PapucsError } from "../errors";
import { atomicWriteFile, ensureDir, toPosix } from "../fs";
import { resolveGitMetadata } from "../git";
import {
  collectSourceManifest,
  listActionsBuildServerTypes,
  reportOverrides,
} from "../manifest";
import {
  buildTemplateValues,
  replacePercentPlaceholders,
  validateIdentifier,
} from "../naming";
import { runCommand } from "../process";
import { replaceRuntimeDataFromManifest } from "../sync";
import type { BuildImageResult, ProjectContext, Reporter } from "../types";

function escapeShellSingleQuote(value: string): string {
  const shellEscape = String.fromCharCode(39, 34, 39, 34, 39);
  return value.replaceAll("'", shellEscape);
}

function interpolateEnvironmentFile(variables: Record<string, string>): string {
  return `${Object.entries(variables)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}='${escapeShellSingleQuote(value)}'`)
    .join("\n")}\n`;
}

function validateDockerReference(value: string, label: string): string {
  if (!value || /\s/.test(value) || value.includes("://")) {
    throw new PapucsError(`Invalid ${label}: '${value}'.`);
  }
  return value;
}

export function sanitizeDockerTagValue(value: string): string {
  const sanitized = value
    .trim()
    .replaceAll(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^[.-]+/, "")
    .slice(0, 128);
  return sanitized || "unknown";
}

export async function commandBuildServer(
  context: ProjectContext,
  serverTypeValue: string,
  options: { push: boolean; dryRun: boolean },
  reporter: Reporter,
): Promise<BuildImageResult> {
  const serverType = validateIdentifier(serverTypeValue, "Server type");
  const manifest = await collectSourceManifest(context, serverType, {
    skipBuildLayers: true,
  });
  reportOverrides(reporter, manifest.overrides);

  const serverDockerfile = path.join(
    context.serversDir,
    serverType,
    "Dockerfile.template",
  );
  const dockerfileTemplatePath = existsSync(serverDockerfile)
    ? serverDockerfile
    : context.dockerfileTemplatePath;
  if (!existsSync(dockerfileTemplatePath)) {
    throw new PapucsError(
      `Dockerfile template not found: ${dockerfileTemplatePath}`,
    );
  }
  if (!existsSync(context.runtimeReplaceScriptPath)) {
    throw new PapucsError(
      `Runtime replacement script not found: ${context.runtimeReplaceScriptPath}`,
    );
  }

  const git = await resolveGitMetadata(context);
  const buildConfig = {
    image: manifest.config.build?.image ?? context.config.build.image,
    tags: manifest.config.build?.tags ?? context.config.build.tags,
  };
  const values = buildTemplateValues(context, manifest.config, serverType, {
    build_from: manifest.config.image,
    ref: sanitizeDockerTagValue(git.ref),
    sha: git.sha,
    github_owner: git.githubOwner,
  });
  const repository = validateDockerReference(
    replacePercentPlaceholders(
      buildConfig.image,
      values,
      `build.image for '${serverType}'`,
    ),
    "build image",
  ).replace(/:+$/, "");
  const tags = buildConfig.tags.map((tagTemplate) => {
    const tag = replacePercentPlaceholders(
      tagTemplate,
      values,
      `build.tags for '${serverType}'`,
    );
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag)) {
      throw new PapucsError(
        `Invalid Docker tag for '${serverType}': '${tag}'.`,
      );
    }
    return `${repository}:${tag}`;
  });
  const uniqueTags = [...new Set(tags)];
  const result: BuildImageResult = {
    serverType,
    localTags: uniqueTags,
    pushedTags: [],
  };
  if (options.dryRun) {
    reporter.log(
      `[${serverType}] Would build ${uniqueTags.join(", ")}${options.push ? " and push" : ""}.`,
    );
    return {
      ...result,
      pushedTags: options.push ? [...uniqueTags] : [],
    };
  }

  const buildDirectory = path.join(context.runtimeBuildDir, serverType);
  const dataDirectory = path.join(buildDirectory, "data");
  await rm(buildDirectory, { recursive: true, force: true });
  await ensureDir(dataDirectory);

  try {
    await replaceRuntimeDataFromManifest(context, dataDirectory, manifest, {
      preserve: false,
    });
    const dockerfileTemplate = await readFile(dockerfileTemplatePath, "utf8");
    const dockerfile = replacePercentPlaceholders(
      dockerfileTemplate,
      values,
      toPosix(path.relative(context.root, dockerfileTemplatePath)),
    );
    await atomicWriteFile(path.join(buildDirectory, "Dockerfile"), dockerfile);
    await atomicWriteFile(
      path.join(buildDirectory, "papucs-runtime-replace.sh"),
      await readFile(context.runtimeReplaceScriptPath),
    );
    await atomicWriteFile(
      path.join(buildDirectory, "papucs-interpolate.env"),
      interpolateEnvironmentFile(
        Object.fromEntries(
          Object.entries(manifest.config.interpolate_variables ?? {}).map(
            ([key, value]) => [key, String(value)],
          ),
        ),
      ),
    );
    await atomicWriteFile(
      path.join(buildDirectory, "replaceable_extensions.txt"),
      `${context.config.replaceable_text_extensions.join("\n")}\n`,
    );

    const tagArgs = uniqueTags.flatMap((tag) => ["-t", tag]);
    const buildResult = await runCommand(
      "docker",
      [
        "build",
        "-f",
        path.join(buildDirectory, "Dockerfile"),
        ...tagArgs,
        buildDirectory,
      ],
      { cwd: context.root },
    );
    if (buildResult.code !== 0) {
      throw new PapucsError(
        `Docker build failed for '${serverType}'.\n${[buildResult.stdout, buildResult.stderr].filter(Boolean).join("\n")}`,
      );
    }

    if (options.push) {
      for (const tag of uniqueTags) {
        const pushResult = await runCommand("docker", ["push", tag], {
          cwd: context.root,
        });
        if (pushResult.code !== 0) {
          throw new PapucsError(
            `Docker push failed for '${tag}'.\n${[pushResult.stdout, pushResult.stderr].filter(Boolean).join("\n")}`,
          );
        }
        result.pushedTags.push(tag);
      }
    }
  } finally {
    await rm(buildDirectory, { recursive: true, force: true });
  }

  reporter.log(
    `[${serverType}] Built ${uniqueTags.join(", ")}${options.push ? "; pushed successfully" : ""}.`,
  );
  return result;
}

export async function resolveBuildServerTypes(
  context: ProjectContext,
  requested: string[],
  actions: boolean,
  reporter: Reporter,
): Promise<string[]> {
  if (!actions) {
    if (requested.length === 0) {
      throw new PapucsError("At least one server type is required.", 2);
    }
    return requested;
  }
  const allowed = new Set(await listActionsBuildServerTypes(context));
  if (requested.length === 0) {
    if (allowed.size === 0) {
      throw new PapucsError("No server configuration has actions_build: true.");
    }
    return [...allowed];
  }
  const selected = requested.filter((serverType) => allowed.has(serverType));
  for (const skipped of requested.filter(
    (serverType) => !allowed.has(serverType),
  )) {
    reporter.warn(`Skipping '${skipped}': actions_build is not true.`);
  }
  if (selected.length === 0) {
    throw new PapucsError("No requested server is enabled for Actions build.");
  }
  return selected;
}
