import { beforeEach, afterEach, describe, expect, test, vi } from "vitest";
import { runCli, main } from "./cli";
import { resolveProjectContext } from "./context";
import { commandStart } from "./commands/start";
import { commandStopPlan, formatStopPlan } from "./commands/stop-plan";
import { commandStopAll } from "./commands/lifecycle";
import {
  collectStopDiagnostics,
  formatStopDiagnostics,
  type StopDiagnostics,
} from "./diagnostics";
import { StopFailure } from "./errors";
import { withProjectLock } from "./lock";
import { loadStateReadOnly } from "./state";
import type { ProjectContext, RuntimeState } from "./types";

vi.mock("./context", () => ({ resolveProjectContext: vi.fn() }));
vi.mock("./commands/start", () => ({ commandStart: vi.fn() }));
vi.mock("./commands/stop-plan", () => ({
  commandStopPlan: vi.fn(),
  formatStopPlan: vi.fn(),
}));
vi.mock("./commands/lifecycle", () => ({ commandStopAll: vi.fn() }));
vi.mock("./diagnostics", () => ({
  collectStopDiagnostics: vi.fn(),
  formatStopDiagnostics: vi.fn(),
}));
vi.mock("./lock", () => ({ withProjectLock: vi.fn() }));
vi.mock("./state", () => ({ loadStateReadOnly: vi.fn() }));

const project = { root: "/project" } as ProjectContext;
const diagnostics: StopDiagnostics = {
  project: "example",
  collectedAt: "2026-01-01T00:00:00.000Z",
  since: "2025-12-31T23:00:00.000Z",
  until: "2026-01-01T00:00:00.000Z",
  containers: [],
  warnings: [],
};
let output: string;
const initialExitCode = process.exitCode;

beforeEach(() => {
  vi.resetAllMocks();
  output = "";
  process.exitCode = undefined;
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    return true;
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.mocked(resolveProjectContext).mockResolvedValue(project);
  vi.mocked(withProjectLock).mockImplementation(
    async (_project, _command, action) => await action(),
  );
  vi.mocked(loadStateReadOnly).mockResolvedValue({ version: 1, instances: [] });
  vi.mocked(collectStopDiagnostics).mockResolvedValue(diagnostics);
  vi.mocked(formatStopDiagnostics).mockReturnValue(["shutdown evidence"]);
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = initialExitCode;
});

describe("lifecycle CLI contracts", () => {
  test("start locks mutation and prints only a JSON envelope", async () => {
    const result = {
      targets: ["backend-1"],
      layers: [["provider"], ["backend-1"]],
      started: ["provider", "backend-1"],
      alreadyRunning: [],
      completed: [],
    };
    vi.mocked(commandStart).mockResolvedValue(result);
    await runCli([
      "--project",
      "/project",
      "start",
      "backend-1",
      "--wait-timeout",
      "15",
      "--json",
    ]);
    expect(commandStart).toHaveBeenCalledWith(
      project,
      ["backend-1"],
      { waitTimeout: 15 },
      expect.anything(),
    );
    expect(withProjectLock).toHaveBeenCalledWith(
      project,
      "start",
      expect.any(Function),
    );
    expect(JSON.parse(output)).toEqual({
      schemaVersion: 1,
      ok: true,
      command: "start",
      data: result,
      warnings: [],
    });
  });

  test("invalid readiness timeout does not start containers", async () => {
    await expect(
      runCli(["start", "backend-1", "--wait-timeout", "0"]),
    ).rejects.toMatchObject({ exitCode: 2 });
    expect(commandStart).not.toHaveBeenCalled();
    expect(withProjectLock).not.toHaveBeenCalled();
  });

  test("dry-run is read-only and does not acquire a mutation lock", async () => {
    const plan = {
      ok: true,
      stopLayers: [["backend-1"]],
      blockers: [],
    } as unknown as Awaited<ReturnType<typeof commandStopPlan>>;
    vi.mocked(commandStopPlan).mockResolvedValue(plan);
    await runCli(["stopall", "--dry-run", "--json"]);
    expect(JSON.parse(output)).toMatchObject({
      ok: true,
      command: "stopall",
      data: plan,
    });
    expect(commandStopAll).not.toHaveBeenCalled();
    expect(withProjectLock).not.toHaveBeenCalled();
  });

  test("blocked plan has nonzero exit and false JSON success", async () => {
    vi.mocked(commandStopPlan).mockResolvedValue({
      ok: false,
      blockers: [{ code: "previous-stop", message: "exit137" }],
    } as Awaited<ReturnType<typeof commandStopPlan>>);
    await runCli(["stopall", "--dry-run", "--json"]);
    expect(JSON.parse(output).ok).toBe(false);
    expect(process.exitCode).toBe(1);
  });

  test("human plan uses its formatter", async () => {
    const printed = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);
    vi.mocked(commandStopPlan).mockResolvedValue({ ok: true } as Awaited<
      ReturnType<typeof commandStopPlan>
    >);
    vi.mocked(formatStopPlan).mockReturnValue(["Layer1: backend-1"]);
    await runCli(["stopall", "--dry-run"]);
    expect(printed).toHaveBeenCalledWith("Layer1: backend-1");
  });

  test("diagnose resolves managed names and can suppress logs", async () => {
    vi.mocked(loadStateReadOnly).mockResolvedValue({
      version: 1,
      instances: [
        {
          id: "backend-1",
          serviceName: "backend-1",
          serverName: "example-backend-1",
        },
      ],
    } as RuntimeState);
    await runCli(["diagnose", "example-backend-1", "--tail", "0", "--json"]);
    expect(collectStopDiagnostics).toHaveBeenCalledWith(project, {
      services: ["backend-1"],
      tail: 0,
    });
    expect(withProjectLock).not.toHaveBeenCalled();
    expect(JSON.parse(output)).toMatchObject({
      ok: true,
      command: "diagnose",
      data: diagnostics,
    });
  });

  test("diagnose accepts an infrastructure service", async () => {
    await runCli(["diagnose", "collector", "--json"]);
    expect(collectStopDiagnostics).toHaveBeenCalledWith(project, {
      services: ["collector"],
      tail: 20,
    });
  });

  test("stopall failure carries diagnostics without changing exit status", async () => {
    vi.mocked(commandStopAll).mockRejectedValue(
      new StopFailure("stop failed", ["backend-1"]),
    );
    await main(["--project", "/project", "stopall", "--json"]);
    expect(JSON.parse(output)).toMatchObject({
      ok: false,
      command: "stopall",
      error: { message: "stop failed", diagnostics },
    });
    expect(process.exitCode).toBe(1);
    expect(collectStopDiagnostics).toHaveBeenCalledWith(project, {
      services: ["backend-1"],
      since: expect.any(String),
    });
  });

  test("previous stop failure reads earlier event history", async () => {
    vi.mocked(commandStopAll).mockRejectedValue(
      new StopFailure("previous failure", ["backend-1"], true),
    );
    await main(["stopall", "--json"]);
    expect(collectStopDiagnostics).toHaveBeenCalledWith(project, {
      services: ["backend-1"],
      since: undefined,
    });
  });

  test("unavailable diagnostics retain the original failure", async () => {
    vi.mocked(commandStopAll).mockRejectedValue(
      new StopFailure("original failure", ["backend-1"]),
    );
    vi.mocked(collectStopDiagnostics).mockRejectedValue(
      new Error("daemon unavailable"),
    );
    await main(["stopall", "--json"]);
    expect(JSON.parse(output).error).toEqual({
      message: "original failure",
      diagnosticsWarning:
        "Shutdown diagnostics unavailable; the original failure is retained.",
    });
    expect(process.exitCode).toBe(1);
  });

  test("normal stopall success supports JSON", async () => {
    await runCli(["stopall", "--json"]);
    expect(JSON.parse(output)).toMatchObject({
      ok: true,
      command: "stopall",
      data: { stopped: true },
    });
  });
});
