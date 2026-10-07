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
  const result = await runCommand(
    "docker",
    [
      "ps",
      "--filter",
      `label=com.docker.compose.project=${context.composeProjectName}`,
      "--filter",
      "label=com.docker.compose.oneoff=False",
      "--format",
      '{{.Label "com.docker.compose.service"}}',
    ],
    { cwd: context.root },
  );
  if (result.code !== 0) {
    throw new PapucsError(
      `Could not inspect running project services.\n${result.stderr}`,
    );
  }
  return new Set(
    result.stdout
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

/** Inspect only exit state; never load container environment or other secrets. */
async function projectServiceContainers(
  context: ProjectContext,
  services?: string[],
): Promise<Array<{ id: string; service: string }>> {
  const listing = await runCommand(
    "docker",
    [
      "ps",
      "-a",
      "--filter",
      `label=com.docker.compose.project=${context.composeProjectName}`,
      "--filter",
      "label=com.docker.compose.oneoff=False",
      "--format",
      '{{.ID}}\t{{.Label "com.docker.compose.service"}}',
    ],
    { cwd: context.root },
  );
  if (listing.code !== 0) {
    throw new PapucsError(
      `Could not verify stopped services.\n${listing.stderr}`,
    );
  }
  const containers = listing.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [id = "", service = ""] = line.split("\t");
      return { id, service };
    })
    .filter((container) => !services || services.includes(container.service));
  for (const service of services ?? []) {
    if (!containers.some((container) => container.service === service)) {
      throw new PapucsError(
        `Stop of '${service}' is unproven: container is missing. Dependencies kept running.`,
      );
    }
  }
  return containers;
}

interface ContainerExitState {
  Running?: boolean;
  Restarting?: boolean;
  ExitCode?: number;
  OOMKilled?: boolean;
  Status?: string;
  HealthStatus?: string;
}

async function containerExitState(
  context: ProjectContext,
  container: { id: string; service: string },
): Promise<ContainerExitState> {
  const inspected = await runCommand(
    "docker",
    [
      "inspect",
      "--format",
      '{"Running":{{.State.Running}},"Restarting":{{.State.Restarting}},"Status":{{json .State.Status}},"ExitCode":{{.State.ExitCode}},"OOMKilled":{{.State.OOMKilled}},"HealthStatus":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}}}',
      container.id,
    ],
    { cwd: context.root },
  );
  if (inspected.code !== 0)
    throw new PapucsError(
      `Could not verify stop of '${container.service}'. Dependencies kept running.`,
    );
  return JSON.parse(inspected.stdout) as ContainerExitState;
}

export async function assertServicesHealthy(
  context: ProjectContext,
  services: string[],
): Promise<void> {
  for (const container of await projectServiceContainers(context, services)) {
    const state = await containerExitState(context, container);
    if (
      !state.Running ||
      state.Restarting ||
      state.HealthStatus !== "healthy"
    ) {
      throw new PapucsError(
        `Excluded dependency '${container.service}' is not healthy. Wait for it to become healthy before restartall.`,
      );
    }
  }
}

/** A retry must not erase a previous failed stop merely because its process is now exited. */
export async function assertStoppedContainersSafe(
  context: ProjectContext,
): Promise<void> {
  for (const container of await projectServiceContainers(context)) {
    const state = await containerExitState(context, container);
    if (state.Running || state.Restarting) continue;
    if (
      (state.Status !== "exited" && state.Status !== "created") ||
      state.OOMKilled ||
      ![0, 143].includes(state.ExitCode ?? -1)
    ) {
      throw new PapucsError(
        `Service '${container.service}' has an unproven previous stop (status=${state.Status}, exit=${state.ExitCode}, OOM=${state.OOMKilled}). Runtime state retained.`,
      );
    }
  }
}

export async function assertServicesStopped(
  context: ProjectContext,
  services: string[],
  successfulCompletion = false,
): Promise<void> {
  const containers = await projectServiceContainers(context, services);
  for (const container of containers) {
    const state = await containerExitState(context, container);
    if (
      state.Running ||
      state.Restarting ||
      state.Status !== "exited" ||
      state.OOMKilled ||
      !(successfulCompletion ? [0] : [0, 143]).includes(state.ExitCode ?? -1)
    ) {
      throw new PapucsError(
        `Service '${container.service}' did not stop cleanly (status=${state.Status}, exit=${state.ExitCode}, OOM=${state.OOMKilled}). Dependencies kept running.`,
      );
    }
  }
}

export async function waitServicesCompleted(
  context: ProjectContext,
  services: string[],
): Promise<void> {
  const containers = await projectServiceContainers(context, services);
  const waiting = await runCommand(
    "docker",
    ["wait", ...containers.map((container) => container.id)],
    { cwd: context.root },
  );
  if (waiting.code !== 0)
    throw new PapucsError("Could not wait for one-shot dependency completion.");
  await assertServicesStopped(context, services, true);
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
