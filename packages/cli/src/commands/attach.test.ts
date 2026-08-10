import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { runCommand } from "../process";
import type { ProjectContext, RuntimeState } from "../types";
import { commandAttach } from "./attach";

vi.mock("../process", () => ({
  runCommand: vi.fn(),
}));

const mockedRunCommand = vi.mocked(runCommand);

async function createContext(): Promise<ProjectContext> {
  const root = await mkdtemp(path.join(os.tmpdir(), "papucs-attach-"));
  const runtimeRoot = path.join(root, ".runtime");
  const context = {
    root,
    runtimeRoot,
    runtimeStatePath: path.join(runtimeRoot, "state.json"),
    runtimeCacheDir: path.join(runtimeRoot, "cache"),
    runtimeInstancesDir: path.join(runtimeRoot, "instances"),
    runtimeBuildDir: path.join(runtimeRoot, "build"),
  } as ProjectContext;
  await mkdir(runtimeRoot, { recursive: true });
  const state: RuntimeState = {
    version: 1,
    instances: [
      {
        id: "spawn-1",
        serverType: "spawn",
        index: 1,
        serverName: "example-spawn-1",
        serviceName: "spawn-1",
        runtimeDataDir: "instances/spawn-1/data",
        templateServiceName: "minecraft",
        composeService: {},
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:00.000Z",
      },
    ],
  };
  await writeFile(context.runtimeStatePath, `${JSON.stringify(state)}\n`);
  return context;
}

describe("attach command", () => {
  beforeEach(() => {
    mockedRunCommand.mockReset();
  });

  test("attaches to the managed container name", async () => {
    const context = await createContext();
    mockedRunCommand.mockResolvedValue({ code: 0, stdout: "", stderr: "" });

    await commandAttach(context, "spawn-1");

    expect(mockedRunCommand).toHaveBeenCalledWith(
      "docker",
      ["attach", "example-spawn-1"],
      { cwd: context.root, stream: true },
    );
  });

  test("reports docker attach failures", async () => {
    const context = await createContext();
    mockedRunCommand.mockResolvedValue({ code: 1, stdout: "", stderr: "" });

    await expect(commandAttach(context, "spawn-1")).rejects.toThrow(
      "docker attach example-spawn-1 failed.",
    );
  });
});
