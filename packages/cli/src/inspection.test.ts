import { beforeEach, describe, expect, test, vi } from "vitest";
import { inspectProjectContainers } from "./inspection";
import { runCommand } from "./process";
import type { ProjectContext } from "./types";

vi.mock("./process", () => ({ runCommand: vi.fn() }));
const mockedRunCommand = vi.mocked(runCommand);
const context = {
  root: "project",
  composeProjectName: "isolated-project",
} as ProjectContext;
const success = { code: 0, stdout: "", stderr: "" };
const snapshot = {
  id: "container-id",
  name: "/container-name",
  status: "exited",
  running: false,
  restarting: false,
  exitCode: 137,
  oomKilled: false,
  startedAt: "start",
  finishedAt: "end",
  healthStatus: null,
  healthcheck: ["NONE"],
  stopSignal: "",
  stopTimeout: null,
  init: null,
  restartPolicy: "on-failure",
  restartMaximumRetryCount: 3,
  image: "example:1",
};

beforeEach(() => mockedRunCommand.mockReset());

describe("project container inspection", () => {
  test("reads only lifecycle fields of project containers, excluding one-offs", async () => {
    mockedRunCommand.mockResolvedValueOnce({
      ...success,
      stdout: "container-id\tapp",
    });
    mockedRunCommand.mockResolvedValueOnce({
      ...success,
      stdout: JSON.stringify(snapshot),
    });
    const [actual] = await inspectProjectContainers(context);
    expect(actual).toMatchObject({
      id: "container-id",
      service: "app",
      name: "container-name",
      stopTimeout: null,
      stopSignal: null,
      healthcheckEnabled: false,
      restartPolicy: "on-failure:3",
    });
    const listing = mockedRunCommand.mock.calls[0]![1];
    expect(listing).toContain(
      "label=com.docker.compose.project=isolated-project",
    );
    expect(listing).toContain("label=com.docker.compose.oneoff=False");
    const inspection = mockedRunCommand.mock.calls[1]![1];
    expect(inspection.at(-1)).toBe("container-id");
    expect(inspection.join(" ")).not.toMatch(
      /\.Env|\.Cmd|\.Mounts|json \.\}\}/u,
    );
    expect(actual).not.toHaveProperty("healthcheck");
    expect(actual).not.toHaveProperty("restartMaximumRetryCount");
  });

  test("distinguishes enabled healthchecks and configured zero timeout", async () => {
    mockedRunCommand.mockResolvedValueOnce({
      ...success,
      stdout: "container-id\tapp",
    });
    mockedRunCommand.mockResolvedValueOnce({
      ...success,
      stdout: JSON.stringify({
        ...snapshot,
        healthcheck: ["CMD", "true"],
        stopTimeout: 0,
        stopSignal: "SIGINT",
        restartPolicy: "unless-stopped",
      }),
    });
    expect((await inspectProjectContainers(context))[0]).toMatchObject({
      healthcheckEnabled: true,
      stopTimeout: 0,
      stopSignal: "SIGINT",
      restartPolicy: "unless-stopped",
    });
  });

  test("empty project needs no inspection", async () => {
    mockedRunCommand.mockResolvedValueOnce(success);
    expect(await inspectProjectContainers(context)).toEqual([]);
    expect(mockedRunCommand).toHaveBeenCalledTimes(1);
  });

  test("does not expose raw Docker errors", async () => {
    mockedRunCommand.mockResolvedValueOnce({
      ...success,
      code: 1,
      stderr: "private",
    });
    await expect(inspectProjectContainers(context)).rejects.toThrow(
      "Could not list project containers",
    );
  });

  test("fails closed on malformed inspection", async () => {
    mockedRunCommand.mockResolvedValueOnce({
      ...success,
      stdout: "container-id\tapp",
    });
    mockedRunCommand.mockResolvedValueOnce({ ...success, stdout: "{}" });
    await expect(inspectProjectContainers(context)).rejects.toThrow(
      "Invalid Docker inspection",
    );
  });
});
