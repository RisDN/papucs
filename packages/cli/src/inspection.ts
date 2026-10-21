import { PapucsError } from "./errors";
import { runCommand } from "./process";
import type { ProjectContext } from "./types";

/** Deliberately excludes environment, arguments, mounts and arbitrary labels. */
export interface ContainerSnapshot {
  id: string;
  service: string;
  name: string;
  status: string;
  running: boolean;
  restarting: boolean;
  exitCode: number;
  oomKilled: boolean;
  startedAt: string;
  finishedAt: string;
  healthStatus: string | null;
  healthcheckEnabled: boolean;
  stopSignal: string | null;
  stopTimeout: number | null;
  init: boolean | null;
  restartPolicy: string;
  image: string;
}

const snapshotFormat =
  '{"id":{{json .Id}},"name":{{json .Name}},"status":{{json .State.Status}},' +
  '"running":{{.State.Running}},"restarting":{{.State.Restarting}},' +
  '"exitCode":{{.State.ExitCode}},"oomKilled":{{.State.OOMKilled}},' +
  '"startedAt":{{json .State.StartedAt}},"finishedAt":{{json .State.FinishedAt}},' +
  '"healthStatus":{{with index .State "Health"}}{{json .Status}}{{else}}null{{end}},' +
  '"healthcheck":{{with index .Config "Healthcheck"}}{{json (index . "Test")}}{{else}}null{{end}},' +
  '"stopSignal":{{json (index .Config "StopSignal")}},"stopTimeout":{{json (index .Config "StopTimeout")}},' +
  '"init":{{json (index .HostConfig "Init")}},"restartPolicy":{{json .HostConfig.RestartPolicy.Name}},' +
  '"restartMaximumRetryCount":{{.HostConfig.RestartPolicy.MaximumRetryCount}},' +
  '"image":{{json .Config.Image}}}';

export async function inspectProjectContainers(
  context: ProjectContext,
): Promise<ContainerSnapshot[]> {
  const listing = await runCommand(
    "docker",
    [
      "ps",
      "-a",
      "--no-trunc",
      "--filter",
      `label=com.docker.compose.project=${context.composeProjectName}`,
      "--filter",
      "label=com.docker.compose.oneoff=False",
      "--format",
      '{{.ID}}\t{{.Label "com.docker.compose.service"}}',
    ],
    { cwd: context.root, timeoutMs: 5000, maxOutputBytes: 1024 * 1024 },
  );
  if (listing.code !== 0) {
    throw new PapucsError(
      "Could not list project containers. Check Docker availability.",
    );
  }
  const containers = listing.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [id, service] = line.split("\t");
      if (!id || !service)
        throw new PapucsError("Invalid project container listing.");
      return { id, service };
    });
  return await Promise.all(
    containers.map(async ({ id, service }) => {
      const result = await runCommand(
        "docker",
        ["inspect", "--format", snapshotFormat, id],
        { cwd: context.root, timeoutMs: 5000, maxOutputBytes: 16 * 1024 },
      );
      if (result.code !== 0) {
        throw new PapucsError(
          `Could not inspect container for '${service}'; Docker state may have changed.`,
        );
      }
      let value: ContainerSnapshot & {
        healthcheck?: string[] | null;
        restartMaximumRetryCount?: number;
      };
      try {
        value = JSON.parse(result.stdout) as typeof value;
        if (
          typeof value.id !== "string" ||
          typeof value.status !== "string" ||
          typeof value.running !== "boolean" ||
          typeof value.restarting !== "boolean" ||
          typeof value.exitCode !== "number" ||
          typeof value.oomKilled !== "boolean"
        ) {
          throw new Error("Invalid snapshot");
        }
      } catch {
        throw new PapucsError(`Invalid Docker inspection for '${service}'.`);
      }
      const { healthcheck, restartMaximumRetryCount, ...snapshot } = value;
      return {
        ...snapshot,
        service,
        name: value.name.replace(/^\//, ""),
        stopSignal: value.stopSignal || null,
        stopTimeout: value.stopTimeout ?? null,
        init: value.init ?? null,
        healthStatus: value.healthStatus ?? null,
        restartPolicy:
          value.restartPolicy === "on-failure" && restartMaximumRetryCount
            ? `on-failure:${restartMaximumRetryCount}`
            : value.restartPolicy,
        healthcheckEnabled:
          Array.isArray(healthcheck) &&
          healthcheck.length > 0 &&
          healthcheck[0] !== "NONE",
      };
    }),
  );
}
