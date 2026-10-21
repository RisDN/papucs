import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  inspectProjectContainers,
  type ContainerSnapshot,
} from "../inspection";
import { runCommand } from "../process";
import type {
  ProjectContext,
  RuntimeInstance,
  RuntimeComposeService,
} from "../types";
import { commandStart } from "./start";

vi.mock("../process", () => ({ runCommand: vi.fn() }));
vi.mock("../inspection", () => ({ inspectProjectContainers: vi.fn() }));

const mockedRun = vi.mocked(runCommand);
const mockedInspect = vi.mocked(inspectProjectContainers);
const reporter = { log: vi.fn(), warn: vi.fn(), verbose: vi.fn() };
const roots: string[] = [];
let snapshots: ContainerSnapshot[];
let starts: string[][];
let finishJobs: Map<string, number>;
let unhealthy: Set<string>;

function container(
  service: string,
  changes: Partial<ContainerSnapshot> = {},
): ContainerSnapshot {
  return {
    id: `id-${service}`,
    service,
    name: `example-${service}`,
    status: "exited",
    running: false,
    restarting: false,
    exitCode: 143,
    oomKilled: false,
    startedAt: "previous-start",
    finishedAt: "previous-stop",
    healthStatus: null,
    healthcheckEnabled: false,
    stopSignal: null,
    stopTimeout: null,
    init: null,
    restartPolicy: "unless-stopped",
    image: "example/application",
    ...changes,
  };
}

beforeEach(() => {
  starts = [];
  snapshots = [];
  finishJobs = new Map();
  unhealthy = new Set();
  vi.clearAllMocks();
  mockedInspect.mockImplementation(async () => structuredClone(snapshots));
  mockedRun.mockImplementation(async (command, args) => {
    expect(command).toBe("docker");
    if (args[0] === "compose") {
      expect(args.slice(-2)).toEqual(["config", "--quiet"]);
      return { code: 0, stdout: "", stderr: "" };
    }
    expect(args[0]).toBe("start");
    starts.push(args.slice(1));
    for (const id of args.slice(1)) {
      const target = snapshots.find((item) => item.id === id)!;
      const finish = finishJobs.get(target.service);
      Object.assign(target, {
        status: finish === undefined ? "running" : "exited",
        running: finish === undefined,
        restarting: false,
        exitCode: finish ?? 0,
        startedAt: "new-start",
        finishedAt: finish === undefined ? "" : "new-stop",
        healthStatus: target.healthcheckEnabled
          ? unhealthy.has(target.service)
            ? "unhealthy"
            : "healthy"
          : null,
      });
    }
    return { code: 0, stdout: "", stderr: "" };
  });
});

afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture(
  services: Record<string, RuntimeComposeService> = {
    database: { image: "example/db" },
    "gateway-1": { image: "example/gateway", depends_on: ["database"] },
    "worker-1": { image: "example/worker", depends_on: ["gateway-1"] },
  },
): Promise<ProjectContext> {
  const root = await mkdtemp(path.join(os.tmpdir(), "papucs-start-"));
  roots.push(root);
  const runtimeRoot = path.join(root, ".runtime");
  const context = {
    root,
    runtimeRoot,
    runtimeComposePath: path.join(runtimeRoot, "docker-compose.yml"),
    runtimeStatePath: path.join(runtimeRoot, "state.json"),
    runtimeCacheDir: path.join(runtimeRoot, "cache"),
    runtimeInstancesDir: path.join(runtimeRoot, "instances"),
    envPath: path.join(root, ".env"),
    composeProjectName: "papucs-start-fixture",
  } as ProjectContext;
  await mkdir(context.runtimeCacheDir, { recursive: true });
  const instances: RuntimeInstance[] = [];
  for (const service of Object.keys(services)) {
    snapshots.push(container(service));
    if (!service.endsWith("-1")) continue;
    const instance: RuntimeInstance = {
      id: service,
      serviceName: service,
      serverType: service.slice(0, -2),
      serverName: `example-${service}`,
      index: 1,
      runtimeDataDir: `instances/${service}/data`,
      composeService: services[service]!,
      templateServiceName: "application",
      createdAt: "original",
      updatedAt: "original",
    };
    instances.push(instance);
    const data = path.join(runtimeRoot, instance.runtimeDataDir);
    await mkdir(data, { recursive: true });
    await writeFile(path.join(data, "world.dat"), `runtime-owned:${service}`);
    await writeFile(
      path.join(context.runtimeCacheDir, `${service}.json`),
      `cache:${service}`,
    );
  }
  await writeFile(
    context.runtimeStatePath,
    JSON.stringify({ version: 1, instances }),
  );
  await writeFile(context.runtimeComposePath, JSON.stringify({ services }));
  return context;
}

describe("start existing runtime", () => {
  test("starts transitive providers in order and preserves IDs, runtime data, state, cache and generated Compose", async () => {
    const context = await fixture();
    const files = [
      context.runtimeStatePath,
      context.runtimeComposePath,
      path.join(context.runtimeCacheDir, "worker-1.json"),
      path.join(context.runtimeInstancesDir, "worker-1/data/world.dat"),
    ];
    const before = await Promise.all(
      files.map((file) => readFile(file, "utf8")),
    );
    const ids = snapshots.map((item) => item.id);
    const result = await commandStart(
      context,
      ["example-worker-1"],
      { waitTimeout: 1 },
      reporter,
    );
    expect(starts).toEqual([
      ["id-database"],
      ["id-gateway-1"],
      ["id-worker-1"],
    ]);
    expect(result.targets).toEqual(["worker-1"]);
    expect(result.started).toEqual(["database", "gateway-1", "worker-1"]);
    expect(snapshots.map((item) => item.id)).toEqual(ids);
    expect(
      await Promise.all(files.map((file) => readFile(file, "utf8"))),
    ).toEqual(before);
    expect(
      mockedRun.mock.calls.every(
        ([, args]) =>
          args[0] === "start" ||
          (args[0] === "compose" && args.at(-2) === "config"),
      ),
    ).toBe(true);
  });

  test("accepts exact infrastructure service recovery after a failed stop", async () => {
    const context = await fixture({ tempo: { image: "example/tempo" } });
    snapshots[0]!.exitCode = 137;
    await commandStart(context, ["tempo"], { waitTimeout: 1 }, reporter);
    expect(starts).toEqual([["id-tempo"]]);
  });

  test("already running services are idempotent and duplicate targets do not start twice", async () => {
    const context = await fixture();
    snapshots.forEach((item) =>
      Object.assign(item, { status: "running", running: true }),
    );
    const result = await commandStart(
      context,
      ["worker-1", "example-worker-1"],
      { waitTimeout: 1 },
      reporter,
    );
    expect(starts).toEqual([]);
    expect(result.alreadyRunning).toEqual([
      "database",
      "gateway-1",
      "worker-1",
    ]);
    expect(result.targets).toEqual(["worker-1"]);
  });

  test("preflights all targets before starting any provider", async () => {
    const context = await fixture();
    snapshots = snapshots.filter((item) => item.service !== "worker-1");
    await expect(
      commandStart(context, ["worker-1"], { waitTimeout: 1 }, reporter),
    ).rejects.toThrow("existing container is missing");
    expect(starts).toEqual([]);
  });

  test("missing providers abort without changing existing targets", async () => {
    const context = await fixture();
    snapshots = snapshots.filter((item) => item.service !== "database");
    await expect(
      commandStart(context, ["worker-1"], { waitTimeout: 1 }, reporter),
    ).rejects.toThrow("Recreate the infrastructure service 'database'");
    expect(starts).toEqual([]);
  });

  test("missing runtime data directory aborts before any Docker mutation", async () => {
    const context = await fixture();
    await rm(path.join(context.runtimeInstancesDir, "worker-1/data"), {
      recursive: true,
    });
    await expect(
      commandStart(context, ["worker-1"], { waitTimeout: 1 }, reporter),
    ).rejects.toThrow("Runtime data directory for 'worker-1' is missing");
    expect(mockedRun).not.toHaveBeenCalled();
  });

  test("does not require current source templates or unrelated stopped containers", async () => {
    const context = await fixture({
      cache: { image: "example/cache" },
      unused: { image: "example/unused" },
    });
    snapshots = snapshots.filter((item) => item.service === "cache");
    await rm(context.runtimeStatePath);
    await commandStart(context, ["cache"], { waitTimeout: 1 }, reporter);
    expect(starts).toEqual([["id-cache"]]);
  });

  test("invalid graph and Compose configuration both fail before start", async () => {
    const context = await fixture({
      a: { depends_on: ["b"] },
      b: { depends_on: ["a"] },
    });
    await expect(
      commandStart(context, ["a"], { waitTimeout: 1 }, reporter),
    ).rejects.toThrow("Dependency cycle");
    expect(mockedRun).not.toHaveBeenCalled();
    await writeFile(
      context.runtimeComposePath,
      JSON.stringify({ services: { a: { image: "example/a" } } }),
    );
    mockedRun.mockResolvedValueOnce({
      code: 1,
      stdout: "",
      stderr: "invalid Compose",
    });
    await expect(
      commandStart(context, ["a"], { waitTimeout: 1 }, reporter),
    ).rejects.toThrow("invalid Compose");
    expect(starts).toEqual([]);
  });

  test("unknown exact target and paused containers fail preflight", async () => {
    const context = await fixture();
    await expect(
      commandStart(context, ["worker"], { waitTimeout: 1 }, reporter),
    ).rejects.toThrow("Use an exact instance id");
    snapshots[0]!.status = "paused";
    await expect(
      commandStart(context, ["worker-1"], { waitTimeout: 1 }, reporter),
    ).rejects.toThrow("is paused");
    expect(starts).toEqual([]);
  });

  test("service_started does not demand health when the declared dependency does not", async () => {
    const context = await fixture();
    snapshots[0]!.healthcheckEnabled = true;
    unhealthy.add("database");
    await commandStart(context, ["worker-1"], { waitTimeout: 1 }, reporter);
    expect(starts.at(-1)).toEqual(["id-worker-1"]);
  });

  test("unhealthy dependency times out without starting its consumer", async () => {
    const context = await fixture({
      database: { image: "example/db" },
      "worker-1": {
        depends_on: { database: { condition: "service_healthy" } },
      },
    });
    snapshots[0]!.healthcheckEnabled = true;
    unhealthy.add("database");
    await expect(
      commandStart(context, ["worker-1"], { waitTimeout: 0.01 }, reporter),
    ).rejects.toThrow("Timed out");
    expect(starts).toEqual([["id-database"]]);
    expect(snapshots[0]!.running).toBe(true);
  });

  test("waits until a provider becomes healthy before starting consumers", async () => {
    const context = await fixture({
      database: { image: "example/db" },
      "worker-1": {
        depends_on: { database: { condition: "service_healthy" } },
      },
    });
    snapshots[0]!.healthcheckEnabled = true;
    unhealthy.add("database");
    let inspections = 0;
    mockedInspect.mockImplementation(async () => {
      if (++inspections === 3) snapshots[0]!.healthStatus = "healthy";
      if (inspections < 3) expect(starts).not.toContainEqual(["id-worker-1"]);
      return structuredClone(snapshots);
    });
    await commandStart(context, ["worker-1"], { waitTimeout: 1 }, reporter);
    expect(starts).toEqual([["id-database"], ["id-worker-1"]]);
  });

  test("health readiness without an actual healthcheck fails complete preflight", async () => {
    const context = await fixture({
      database: { image: "example/db" },
      "worker-1": {
        depends_on: { database: { condition: "service_healthy" } },
      },
    });
    await expect(
      commandStart(context, ["worker-1"], { waitTimeout: 1 }, reporter),
    ).rejects.toThrow("existing container has no healthcheck");
    expect(starts).toEqual([]);
  });

  test("reuses successful completed one-shot providers without rerunning them", async () => {
    const context = await fixture({
      migrate: { image: "example/migrate" },
      "worker-1": {
        depends_on: {
          migrate: { condition: "service_completed_successfully" },
        },
      },
    });
    snapshots[0]!.exitCode = 0;
    const result = await commandStart(
      context,
      ["worker-1"],
      { waitTimeout: 1 },
      reporter,
    );
    expect(result.completed).toEqual(["migrate"]);
    expect(starts).toEqual([["id-worker-1"]]);
  });

  test("waits for successful one-shot completion and blocks consumers after failure", async () => {
    const context = await fixture({
      migrate: { image: "example/migrate" },
      "worker-1": {
        depends_on: {
          migrate: { condition: "service_completed_successfully" },
        },
      },
    });
    finishJobs.set("migrate", 1);
    await expect(
      commandStart(context, ["worker-1"], { waitTimeout: 1 }, reporter),
    ).rejects.toThrow("exit=1");
    expect(starts).toEqual([["id-migrate"]]);
    starts = [];
    finishJobs.set("migrate", 0);
    await commandStart(context, ["worker-1"], { waitTimeout: 1 }, reporter);
    expect(starts).toEqual([["id-migrate"], ["id-worker-1"]]);
  });

  test("failed Docker start retains state and does not start later layers", async () => {
    const context = await fixture();
    const state = await readFile(context.runtimeStatePath, "utf8");
    mockedRun.mockImplementation(async (_command, args) =>
      args[0] === "compose"
        ? { code: 0, stdout: "", stderr: "" }
        : { code: 1, stdout: "", stderr: "injected start failure" },
    );
    await expect(
      commandStart(context, ["worker-1"], { waitTimeout: 1 }, reporter),
    ).rejects.toThrow("Runtime data retained");
    expect(
      mockedRun.mock.calls.filter(([, args]) => args[0] === "start"),
    ).toHaveLength(1);
    expect(await readFile(context.runtimeStatePath, "utf8")).toBe(state);
  });

  test("detects container replacement while waiting", async () => {
    const context = await fixture();
    mockedInspect
      .mockResolvedValueOnce(structuredClone(snapshots))
      .mockResolvedValue([]);
    await expect(
      commandStart(context, ["worker-1"], { waitTimeout: 1 }, reporter),
    ).rejects.toThrow("disappeared or was replaced");
    expect(starts).toEqual([["id-database"]]);
  });

  test("starts only stopped replicas and retains already completed job replicas", async () => {
    const context = await fixture({
      migrate: { image: "example/migrate" },
      "worker-1": {
        depends_on: {
          migrate: { condition: "service_completed_successfully" },
        },
      },
    });
    snapshots.push(container("migrate", { id: "completed-job", exitCode: 0 }));
    finishJobs.set("migrate", 0);
    await commandStart(context, ["worker-1"], { waitTimeout: 1 }, reporter);
    expect(starts).toEqual([["id-migrate"], ["id-worker-1"]]);
    expect(
      snapshots.find((item) => item.id === "completed-job")!.startedAt,
    ).toBe("previous-start");
  });

  test("rejects incompatible one-shot readiness before any container starts", async () => {
    const context = await fixture({
      provider: { image: "example/provider" },
      first: {
        depends_on: {
          provider: { condition: "service_completed_successfully" },
        },
      },
      second: { depends_on: { provider: { condition: "service_started" } } },
    });
    await expect(
      commandStart(context, ["first", "second"], { waitTimeout: 1 }, reporter),
    ).rejects.toThrow("required both running and completed");
    expect(mockedRun).not.toHaveBeenCalled();
  });
});
