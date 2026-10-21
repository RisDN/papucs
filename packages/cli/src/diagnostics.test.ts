import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { collectStopDiagnostics, formatStopDiagnostics } from "./diagnostics";
import { inspectProjectContainers, type ContainerSnapshot } from "./inspection";
import { runCommand } from "./process";
import type { ProjectContext } from "./types";

vi.mock("./inspection", () => ({ inspectProjectContainers: vi.fn() }));
vi.mock("./process", () => ({ runCommand: vi.fn() }));
const inspect = vi.mocked(inspectProjectContainers);
const run = vi.mocked(runCommand);
const roots: string[] = [];
const NOW = "2026-10-21T13:00:00.000Z";

async function fixture(): Promise<ProjectContext> {
  const root = await mkdtemp(path.join(os.tmpdir(), "papucs-diagnostics-"));
  roots.push(root);
  return {
    root,
    envPath: path.join(root, ".env"),
    serversDir: path.join(root, "servers"),
    runtimeRoot: path.join(root, ".runtime"),
    runtimeStatePath: path.join(root, ".runtime", "state.json"),
    runtimeComposePath: path.join(root, ".runtime", "docker-compose.yml"),
    composeProjectName: "papucs-test-project",
  } as ProjectContext;
}

function snapshot(
  overrides: Partial<ContainerSnapshot> = {},
): ContainerSnapshot {
  return {
    id: "a".repeat(64),
    service: "tempo",
    name: "test-tempo",
    status: "exited",
    running: false,
    restarting: false,
    exitCode: 137,
    oomKilled: false,
    startedAt: "2026-10-21T11:00:00.000Z",
    finishedAt: "2026-10-21T12:30:03.014Z",
    healthStatus: null,
    healthcheckEnabled: false,
    stopSignal: null,
    stopTimeout: null,
    init: null,
    restartPolicy: "unless-stopped",
    image: "grafana/tempo:3.1.0",
    ...overrides,
  };
}

function event(
  action: string,
  at: string,
  attributes: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    id: "a".repeat(64),
    action,
    timeNano: Date.parse(at) * 1e6,
    project: "papucs-test-project",
    service: "tempo",
    oneoff: "False",
    signal: "",
    exitCode: "",
    ...attributes,
  });
}

function commands(events = "", logs = "", stderr = ""): void {
  run.mockImplementation(async (_command, args) => ({
    code: 0,
    stdout: args[0] === "events" ? events : logs,
    stderr: args[0] === "logs" ? stderr : "",
  }));
}

describe("read-only stop diagnostics", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    inspect.mockReset();
    inspect.mockResolvedValue([snapshot()]);
    run.mockReset();
    commands();
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const root of roots.splice(0))
      await rm(root, { recursive: true, force: true });
  });

  test("does not invent a cause or successful stop when history is missing", async () => {
    const context = await fixture();
    const report = await collectStopDiagnostics(context);
    expect(report.since).toBe("2026-10-21T12:00:00.000Z");
    expect(report.until).toBe(NOW);
    const container = report.containers[0]!;
    expect(container.snapshot.exitCode).toBe(137);
    expect(container.observedStop).toBeNull();
    expect(container.stopPolicy.stoppedCleanly).toBe(false);
    expect(container.daemonStopTimeout).toBeNull();
    expect(container.stopSignalAssumption).toContain("Linux");
    expect(container.warnings.join(" ")).toContain("No matching events");
    expect(formatStopDiagnostics(report).join("\n")).toContain(
      "daemon default unknown",
    );
    expect(await readdir(context.root)).toEqual([]);
  });

  test("reports observed TERM to KILL and exit timing without claiming timeout causality", async () => {
    commands(
      [
        event("kill", "2026-10-21T12:30:00.000Z", { signal: "15" }),
        event("kill", "2026-10-21T12:30:03.014Z", { signal: "9" }),
        event("die", "2026-10-21T12:30:03.020Z", { exitCode: "137" }),
      ].join("\n"),
    );
    const report = await collectStopDiagnostics(await fixture());
    expect(report.containers[0]!.observedStop).toMatchObject({
      signal: "SIGTERM",
      signalToKillMs: 3014,
      signalToExitMs: 3020,
      exitCode: 137,
    });
    const output = formatStopDiagnostics(report).join("\n");
    expect(output).toContain("SIGTERM to SIGKILL: 3.014s");
    expect(output).toContain("does not establish the cause");
  });

  test.each([0, 143])(
    "accepts clean exit %i while preserving the actual configured stop settings",
    async (exitCode) => {
      inspect.mockResolvedValue([
        snapshot({
          exitCode,
          stopTimeout: 60,
          stopSignal: "SIGINT",
          init: true,
        }),
      ]);
      commands(
        [
          event("kill", "2026-10-21T12:30:00.000Z", { signal: "2" }),
          event("die", "2026-10-21T12:30:01.000Z", {
            exitCode: String(exitCode),
          }),
        ].join("\n"),
      );
      const item = (await collectStopDiagnostics(await fixture()))
        .containers[0]!;
      expect(item.stopPolicy).toEqual({
        acceptedExitCodes: [0, 143],
        exitCodeAccepted: true,
        stoppedCleanly: true,
        previousStopSafe: true,
      });
      expect(item.snapshot.stopTimeout).toBe(60);
      expect(item.effectiveStopSignal).toBe("SIGINT");
      expect(item.stopSignalAssumption).toBeNull();
      expect(item.observedStop!.signalToExitMs).toBe(1000);
      expect(item.observedStop!.killAt).toBeNull();
    },
  );

  test.each([
    { exitCode: 0, oomKilled: true },
    { exitCode: 0, status: "running", running: true },
    { exitCode: 143, status: "restarting", restarting: true },
    { exitCode: 255 },
  ])("does not accept an unsafe state %j", async (overrides) => {
    inspect.mockResolvedValue([snapshot(overrides)]);
    expect(
      (await collectStopDiagnostics(await fixture())).containers[0]!.stopPolicy
        .stoppedCleanly,
    ).toBe(false);
  });

  test("keeps stop timing within one lifecycle episode", async () => {
    commands(
      [
        event("kill", "2026-10-21T12:10:00.000Z", { signal: "15" }),
        event("die", "2026-10-21T12:10:01.000Z", { exitCode: "0" }),
        event("start", "2026-10-21T12:20:00.000Z"),
        event("die", "2026-10-21T12:30:00.000Z", { exitCode: "137" }),
      ].join("\n"),
    );
    const observed = (await collectStopDiagnostics(await fixture()))
      .containers[0]!.observedStop!;
    expect(observed.signalAt).toBeNull();
    expect(observed.signalToExitMs).toBeNull();
    expect(observed.exitCode).toBe(137);
  });

  test("uses only read commands, scoped history, and IDs from project inspection", async () => {
    const context = await fixture();
    inspect.mockResolvedValue([
      snapshot(),
      snapshot({ id: "b".repeat(64), service: "lobby" }),
    ]);
    commands(
      [
        event("kill", "2026-10-21T12:30:00.000Z", {
          project: "other-project",
          signal: "15",
        }),
        event("die", "2026-10-21T12:30:01.000Z", {
          id: "external-id",
          exitCode: "137",
        }),
        event("die", "2026-10-21T12:30:02.000Z", {
          oneoff: "True",
          exitCode: "137",
        }),
        event("exec_create", "2026-10-21T12:30:02.000Z"),
        event("die", "2026-10-21T11:59:00.000Z", { exitCode: "137" }),
        event("die", "2026-10-21T13:01:00.000Z", { exitCode: "137" }),
      ].join("\n"),
    );
    const report = await collectStopDiagnostics(context, {
      services: ["tempo"],
    });
    expect(inspect).toHaveBeenCalledWith(context);
    expect(report.containers).toHaveLength(1);
    expect(report.containers[0]!.events).toEqual([]);
    expect(run.mock.calls).toHaveLength(2);
    const eventArgs = run.mock.calls[0]![1];
    expect(eventArgs).toContain(
      "label=com.docker.compose.project=papucs-test-project",
    );
    expect(eventArgs).toContain("label=com.docker.compose.oneoff=False");
    expect(eventArgs).toContain("type=container");
    expect(eventArgs).toContain("--until");
    expect(eventArgs).toContain(NOW);
    for (const [command, args, options] of run.mock.calls) {
      expect(command).toBe("docker");
      expect(["events", "logs"]).toContain(args[0]);
      expect(options?.timeoutMs).toBe(5000);
      expect(options?.maxOutputBytes).toBeGreaterThan(0);
      expect(args).not.toContain("--follow");
    }
    expect(run.mock.calls[1]![1].at(-1)).toBe("a".repeat(64));
  });

  test("does not query arbitrary requested service or container identifiers", async () => {
    const report = await collectStopDiagnostics(await fixture(), {
      services: ["external-id"],
    });
    expect(report.containers).toEqual([]);
    expect(report.warnings.join(" ")).toContain("no project container");
    expect(run).not.toHaveBeenCalled();
  });

  test("redacts current, server and saved environment values, credentials and control characters", async () => {
    const context = await fixture();
    await writeFile(
      context.envPath,
      "DB_PASSWORD=current-root-secret\nSHORT=x\n",
    );
    await mkdir(path.join(context.serversDir, "lobby"), { recursive: true });
    await writeFile(
      path.join(context.serversDir, "lobby", ".env"),
      "TOKEN=server-env-secret\n",
    );
    await mkdir(context.runtimeRoot);
    await writeFile(
      context.runtimeStatePath,
      JSON.stringify({
        version: 1,
        instances: [
          {
            id: "lobby-1",
            composeService: { environment: ["PASSWORD=old-runtime-secret"] },
          },
        ],
      }),
    );
    await writeFile(
      context.runtimeComposePath,
      "services:\n  database:\n    environment:\n      PASSWORD: saved-infra-secret\n",
    );
    commands(
      "",
      [
        "current-root-secret server-env-secret old-runtime-secret saved-infra-secret",
        "postgres://alice:uri-secret@host/db?token=query-secret",
        'password="quoted secret" API_KEY=key-secret Bearer bearer-secret',
        "\u001b[31mred\u001b[0m\u0000\u202ehidden x",
      ].join("\n"),
    );
    inspect.mockResolvedValue([
      snapshot({ service: "tempo\nFORGED\u001b[31m", image: "image\u0000" }),
    ]);
    const report = await collectStopDiagnostics(context);
    const output = JSON.stringify(report);
    for (const secret of [
      "current-root-secret",
      "server-env-secret",
      "old-runtime-secret",
      "saved-infra-secret",
      "uri-secret",
      "query-secret",
      "quoted secret",
      "key-secret",
      "bearer-secret",
    ])
      expect(output).not.toContain(secret);
    expect(output).toContain("[REDACTED]");
    expect(report.containers[0]!.snapshot.service).toBe("tempo FORGED");
    expect(report.containers[0]!.snapshot.image).toBe("image");
    for (const character of ["\u0000", "\u001b", "\u202e"])
      expect(report.containers[0]!.logs.join("\n")).not.toContain(character);
  });

  test("caps log line count, byte count, and the requested Docker tail", async () => {
    commands(
      "",
      Array.from(
        { length: 200 },
        (_, index) => `${index} ${"A".repeat(6000)}`,
      ).join("\n"),
    );
    const item = (await collectStopDiagnostics(await fixture(), { tail: 5000 }))
      .containers[0]!;
    expect(run.mock.calls.find(([, args]) => args[0] === "logs")![1]).toContain(
      "100",
    );
    expect(item.logs.length).toBeLessThanOrEqual(100);
    expect(Buffer.byteLength(item.logs.join("\n"))).toBeLessThanOrEqual(8192);
    expect(item.logs.every((line) => Buffer.byteLength(line) <= 2048)).toBe(
      true,
    );
    expect(item.warnings).toContain(
      "Log excerpt truncated to diagnostic limits.",
    );
  });

  test("preserves ordinary environment values and numeric evidence while masking short credentials", async () => {
    const context = await fixture();
    await writeFile(
      context.envPath,
      [
        "DEBUG=0",
        "EULA=true",
        "PORT=137",
        "MODE=active",
        "PASSWORD=x",
        "TOKEN=137",
        "API_KEY=true",
        "CLIENT_SECRET=abc",
      ].join("\n"),
    );
    const evidence =
      "2026-10-21T12:30:03.014Z exit=137 OOM=false DEBUG=0 EULA=true MODE=active";
    commands(
      "",
      [
        evidence,
        "PASSWORD=x TOKEN=137 API_KEY=true CLIENT_SECRET=abc",
        "postgres://user:x@host/db?token=137 Authorization: Bearer x",
        "unlabelled scalar 137 and short text abc remain ambiguous",
      ].join("\n"),
    );
    const report = await collectStopDiagnostics(context);
    const logs = report.containers[0]!.logs;
    expect(logs[0]).toBe(evidence);
    expect(logs[1]).toBe(
      "PASSWORD=[REDACTED] TOKEN=[REDACTED] API_KEY=[REDACTED] CLIENT_SECRET=[REDACTED]",
    );
    expect(logs[2]).not.toContain("user:x");
    expect(logs[2]).not.toContain("token=137");
    expect(logs[2]).not.toContain("Bearer x");
    expect(logs[3]).toContain("scalar 137 and short text abc");
    expect(report.warnings.join(" ")).toContain(
      "unlabelled occurrences cannot be identified safely",
    );
  });

  test("recognizes URI credentials under non-sensitive environment keys", async () => {
    const context = await fixture();
    await writeFile(
      context.envPath,
      "DATABASE_URL=postgres://user:connection-secret@host/db?token=url-token-secret\nSERVICE_NAME=tempo\n",
    );
    commands("", "tempo emitted connection-secret and url-token-secret");
    const logs = (
      await collectStopDiagnostics(context)
    ).containers[0]!.logs.join("\n");
    expect(logs).toBe("tempo emitted [REDACTED] and [REDACTED]");
  });

  test("uses warnings for unavailable evidence without leaking command errors", async () => {
    run.mockRejectedValue(new Error("connection failed password=do-not-show"));
    const report = await collectStopDiagnostics(await fixture());
    expect(report.containers).toHaveLength(1);
    expect(report.warnings.join(" ")).toContain("event history unavailable");
    expect(report.containers[0]!.warnings).toContain(
      "Container logs unavailable.",
    );
    expect(JSON.stringify(report)).not.toContain("do-not-show");
  });

  test("keeps multibyte logs within byte limits and drops unexpected inspection fields", async () => {
    inspect.mockResolvedValue([
      {
        ...snapshot(),
        Env: ["PASSWORD=unexpected-secret"],
        Cmd: ["private-command"],
      } as ContainerSnapshot,
    ]);
    commands(
      "",
      Array.from({ length: 10 }, () => "😀".repeat(1500)).join("\n"),
    );
    const report = await collectStopDiagnostics(await fixture());
    const logs = report.containers[0]!.logs;
    expect(Buffer.byteLength(logs.join("\n"))).toBeLessThanOrEqual(8192);
    expect(logs.every((line) => Buffer.byteLength(line) <= 2048)).toBe(true);
    expect(JSON.stringify(report)).not.toContain("unexpected-secret");
    expect(JSON.stringify(report)).not.toContain("private-command");
  });

  test("bounds retained events and does not mislabel created containers as cleanly stopped", async () => {
    inspect.mockResolvedValue([snapshot({ status: "created", exitCode: 0 })]);
    commands(
      Array.from({ length: 300 }, (_, index) =>
        event(
          "start",
          new Date(
            Date.parse("2026-10-21T12:00:00.000Z") + index * 1000,
          ).toISOString(),
        ),
      ).join("\n"),
    );
    const item = (await collectStopDiagnostics(await fixture(), { tail: 0 }))
      .containers[0]!;
    expect(item.events).toHaveLength(64);
    expect(item.stopPolicy.previousStopSafe).toBe(true);
    expect(item.stopPolicy.stoppedCleanly).toBe(false);
    expect(item.observedStop).toBeNull();
  });

  test("reports inspection failure without throwing or reading any logs", async () => {
    inspect.mockRejectedValue(new Error("private diagnostic detail"));
    const report = await collectStopDiagnostics(await fixture());
    expect(report.containers).toEqual([]);
    expect(report.warnings.join(" ")).toContain("inspection unavailable");
    expect(JSON.stringify(report)).not.toContain("private diagnostic detail");
    expect(run).not.toHaveBeenCalled();
  });

  test("withholds logs if stored environment data cannot be read safely", async () => {
    const context = await fixture();
    await mkdir(context.runtimeRoot);
    await writeFile(context.runtimeStatePath, "broken state file");
    const report = await collectStopDiagnostics(context);
    expect(report.warnings.join(" ")).toContain("log excerpts withheld");
    expect(run.mock.calls.every(([, args]) => args[0] === "events")).toBe(true);
  });

  test("handles malformed events, invalid since, and disabled logs", async () => {
    commands("not-json\nnull");
    const report = await collectStopDiagnostics(await fixture(), {
      since: "not-a-date",
      tail: 0,
    });
    expect(report.warnings.join(" ")).toContain("Invalid event start");
    expect(report.warnings.join(" ")).toContain("unreadable");
    expect(run.mock.calls).toHaveLength(1);
  });
});
