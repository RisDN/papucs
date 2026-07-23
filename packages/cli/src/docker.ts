import { existsSync } from "node:fs";
import type { ProjectContext } from "./types";
import { PapucsError } from "./errors";
import { runCommand, type CommandResult } from "./process";

export async function runCompose(
  context: ProjectContext,
  args: string[],
  options: { allowFailure?: boolean; stream?: boolean } = {},
): Promise<CommandResult> {
  const composeArgs = ["compose", "--project-name", context.composeProjectName];
  if (existsSync(context.envPath)) {
    composeArgs.push("--env-file", context.envPath);
  }
  composeArgs.push("-f", context.runtimeComposePath, ...args);
  const result = await runCommand("docker", composeArgs, {
    cwd: context.root,
    stream: options.stream,
  });
  if (result.code !== 0 && options.allowFailure !== true) {
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new PapucsError(
      `docker compose ${args.join(" ")} failed.${details ? `\n${details}` : ""}`,
    );
  }
  return result;
}

export async function getRunningServices(
  context: ProjectContext,
): Promise<Set<string>> {
  if (!existsSync(context.runtimeComposePath)) {
    return new Set();
  }
  const result = await runCompose(
    context,
    ["ps", "--services", "--status", "running"],
    { allowFailure: true },
  );
  if (result.code !== 0) {
    return new Set();
  }
  return new Set(
    result.stdout
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

export async function getRunningContainerNames(
  context: ProjectContext,
): Promise<string[]> {
  const result = await runCommand("docker", ["ps", "--format", "{{.Names}}"], {
    cwd: context.root,
  });
  if (result.code !== 0) {
    throw new PapucsError(`docker ps failed.\n${result.stderr}`);
  }
  return result.stdout
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
}
