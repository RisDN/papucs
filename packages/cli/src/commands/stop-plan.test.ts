import { existsSync } from "node:fs";
import type * as FsPromises from "node:fs/promises";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { inspectProjectContainers } from "../inspection";
import type { ContainerSnapshot } from "../inspection";
import { buildShutdownCompose } from "../shutdown";
import { buildDependencyGraph, dependencyLayers } from "../dependencies";
import type { ProjectContext, RuntimeInstance, RuntimeState } from "../types";
import { commandStopPlan, formatStopPlan } from "./stop-plan";

vi.mock("../inspection", () => ({ inspectProjectContainers: vi.fn() }));
vi.mock("../git", () => ({
  resolveGitMetadata: vi.fn(async () => ({
    ref: "main",
    sha: "abc",
    githubOwner: "example",
  })),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    mkdir: vi.fn(actual.mkdir),
    writeFile: vi.fn(actual.writeFile),
    open: vi.fn(actual.open),
    rename: vi.fn(actual.rename),
    rm: vi.fn(actual.rm),
  };
});

const temporaryDirectories: string[] = [];
const inspected = vi.mocked(inspectProjectContainers);
beforeEach(() => {
  inspected.mockReset();
  inspected.mockResolvedValue([]);
});
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

function container(
  service: string,
  extra: Partial<ContainerSnapshot> = {},
): ContainerSnapshot {
  return {
    id: `${service}-container-id`,
    service,
    name: `example-${service}`,
    status: "running",
    running: true,
    restarting: false,
    exitCode: 0,
    oomKilled: false,
    startedAt: "2026-10-21T10:00:00Z",
    finishedAt: "0001-01-01T00:00:00Z",
    healthStatus: null,
    stopSignal: null,
    stopTimeout: null,
    init: null,
    restartPolicy: "no",
    image: "example/server",
    healthcheckEnabled: false,
    ...extra,
  };
}

async function fixture(options: { runtime?: boolean; managed?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "papucs-stop-plan-"));
  temporaryDirectories.push(root);
  const runtimeRoot = path.join(root, ".runtime");
  const context: ProjectContext = {
    root,
    configPath: path.join(root, "papucs.yml"),
    config: {
      version: 1,
      project: "example",
      runtime: { dir: ".runtime" },
      sources: { layers: "layers", servers: "servers" },
      compose: {
        file: "docker-compose.yml",
        shared_server_template: "template.yml",
      },
      build: {
        dockerfile_template: "Dockerfile.template",
        image: "example/server",
        tags: ["test"],
      },
      preserve_paths: ["libraries"],
      replaceable_text_extensions: [".yml"],
    },
    runtimeRoot,
    runtimeComposePath: path.join(runtimeRoot, "docker-compose.yml"),
    runtimeStatePath: path.join(runtimeRoot, "state.json"),
    runtimeCacheDir: path.join(runtimeRoot, "cache"),
    runtimeInstancesDir: path.join(runtimeRoot, "instances"),
    runtimeBuildDir: path.join(runtimeRoot, "build"),
    runtimeLockPath: path.join(runtimeRoot, "lock"),
    composeFilePath: path.join(root, "docker-compose.yml"),
    serversDir: path.join(root, "servers"),
    layersDir: path.join(root, "layers"),
    sharedServerComposeTemplatePath: path.join(root, "template.yml"),
    dockerfileTemplatePath: path.join(root, "Dockerfile.template"),
    runtimeReplaceScriptPath: path.join(root, "scripts", "runtime.sh"),
    envPath: path.join(root, ".env"),
    composeProjectName: "papucs-example-12345678",
  };
  const instance: RuntimeInstance = {
    id: "worker-1",
    serverType: "worker",
    index: 1,
    serverName: "example-worker-1",
    serviceName: "worker-1",
    runtimeDataDir: "instances/worker-1/data",
    templateServiceName: "application",
    composeService: {
      image: "example/server",
      stop_grace_period: "10s",
      depends_on: ["database"],
    },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  const state: RuntimeState = {
    version: 1,
    instances: options.managed === false ? [] : [instance],
  };
  const infrastructure = {
    database: { image: "example/database" },
    cache: { image: "example/cache" },
  };
  const writeJson = async (file: string, value: unknown) =>
    await writeFile(file, JSON.stringify(value));
  await writeJson(context.composeFilePath, { services: infrastructure });
  await writeJson(context.sharedServerComposeTemplatePath, {
    services: {
      application: {
        stop_grace_period: "${STOP_WINDOW}",
        stop_signal: "SIGTERM",
        init: true,
        restart: "unless-stopped",
        healthcheck: { disable: true },
        depends_on: ["database"],
        environment: { SECRET: "template-secret-not-in-report" },
        command: ["secret-command-not-in-report"],
        "x-papucs": { inject_environment: true },
      },
    },
  });
  await writeFile(
    context.envPath,
    "STOP_WINDOW=1m\nPASSWORD=env-secret-not-in-report\n",
  );
  const workerDirectory = path.join(context.serversDir, "worker");
  await mkdir(workerDirectory, { recursive: true });
  await writeJson(path.join(workerDirectory, "worker.yml"), {
    name: "worker",
    image: "example/server",
    compose_service: "application",
    instance_name: "example-worker-%index%",
    papucs_port_base: 25565,
    layers: [],
  });
  if (options.runtime !== false) {
    await mkdir(runtimeRoot, { recursive: true });
    await writeJson(context.runtimeStatePath, state);
    await writeJson(context.runtimeComposePath, {
      services: {
        ...infrastructure,
        ...(state.instances.length
          ? { "worker-1": instance.composeService }
          : {}),
      },
    });
  }
  return { context, state, instance, infrastructure, writeJson };
}

describe("read-only stop plan", () => {
  test("rebuilds current managed settings in memory and compares source, generated and Docker", async () => {
    const { context } = await fixture();
    inspected.mockResolvedValue([
      container("worker-1", {
        stopTimeout: 20,
        stopSignal: "SIGTERM",
        init: true,
        restartPolicy: "always",
        healthcheckEnabled: true,
      }),
      container("database"),
      container("cache"),
    ]);
    for (const write of [mkdir, writeFile, open, rename, rm])
      vi.mocked(write).mockClear();
    const stateBefore = await readFile(context.runtimeStatePath, "utf8");
    const composeBefore = await readFile(context.runtimeComposePath, "utf8");
    const report = await commandStopPlan(context);
    expect(report.ok).toBe(true);
    expect(report.stopLayers).toEqual([["worker-1"], ["cache", "database"]]);
    const worker = report.lifecycleDiffs.find(
      (entry) => entry.service === "worker-1",
    )!;
    expect(worker.source).toMatchObject({
      stopTimeoutSeconds: 60,
      stopSignal: "SIGTERM",
      init: true,
      restartPolicy: "unless-stopped",
      healthcheckEnabled: false,
    });
    expect(worker.generated?.stopTimeoutSeconds).toBe(10);
    expect(worker.actual[0]?.settings.stopTimeoutSeconds).toBe(20);
    expect(worker.sourceDiffersFromGenerated).toContain("stopTimeoutSeconds");
    expect(worker.actual[0]?.differsFromGenerated).toContain(
      "stopTimeoutSeconds",
    );
    expect(worker.actual[0]?.settings.dependencies).toBeNull();
    expect(report.cleanup).toMatchObject({
      clearInstanceList: true,
      clearSyncCache: true,
      preserveNamedVolumes: true,
      preserveInstanceData: true,
    });
    expect(await readFile(context.runtimeStatePath, "utf8")).toBe(stateBefore);
    expect(await readFile(context.runtimeComposePath, "utf8")).toBe(
      composeBefore,
    );
    for (const write of [mkdir, writeFile, open, rename, rm])
      expect(write).not.toHaveBeenCalled();
    const output = JSON.stringify(report) + formatStopPlan(report).join("\n");
    expect(output).not.toContain("secret-not-in-report");
    expect(output).not.toContain("secret-command-not-in-report");
    expect(output).not.toContain("PASSWORD");
    expect(output).toContain("unknown daemon default");
  });

  test("uses the same old/new dependency union as actual shutdown", async () => {
    const { context, state, infrastructure, writeJson } = await fixture();
    state.instances[0]!.composeService = { depends_on: ["cache"] };
    await writeJson(context.runtimeStatePath, state);
    await writeJson(context.runtimeComposePath, {
      services: {
        ...infrastructure,
        cache: { depends_on: ["database"] },
        "worker-1": { depends_on: ["database"] },
      },
    });
    inspected.mockResolvedValue([
      container("worker-1"),
      container("cache"),
      container("database"),
    ]);
    const report = await commandStopPlan(context);
    const shutdown = await buildShutdownCompose(context, state);
    expect(report.stopLayers).toEqual(
      dependencyLayers(
        buildDependencyGraph(shutdown.services ?? {}),
        report.runningServices,
        "reverse",
      ),
    );
    expect(report.stopLayers).toEqual([["worker-1"], ["cache"], ["database"]]);
    expect(report.ok).toBe(true);
  });

  test("shows source dependency drift without pretending to inspect Docker edges", async () => {
    const { context, writeJson } = await fixture();
    await writeJson(context.sharedServerComposeTemplatePath, {
      services: { application: { depends_on: ["cache"] } },
    });
    inspected.mockResolvedValue([
      container("worker-1"),
      container("cache"),
      container("database"),
    ]);
    const report = await commandStopPlan(context);
    const worker = report.lifecycleDiffs.find(
      (entry) => entry.service === "worker-1",
    )!;
    expect(worker.source?.dependencies).toEqual(["cache"]);
    expect(worker.generated?.dependencies).toEqual(["database"]);
    expect(worker.sourceDiffersFromGenerated).toContain("dependencies");
    expect(worker.actual[0]?.differsFromGenerated).not.toContain(
      "dependencies",
    );
    // Stopall uses its saved/current shutdown union, not a speculative rematerialization.
    expect(report.stopLayers).toEqual([["worker-1"], ["cache", "database"]]);
  });

  test.each([
    { exitCode: 255, oomKilled: false },
    { exitCode: 137, oomKilled: false },
    { exitCode: 0, oomKilled: true },
    { exitCode: 143, oomKilled: true },
  ])("blocks unproven previous stop %j", async (exit) => {
    const { context } = await fixture();
    inspected.mockResolvedValue([
      container("worker-1", { status: "exited", running: false, ...exit }),
    ]);
    const report = await commandStopPlan(context);
    expect(report.ok).toBe(false);
    expect(report.blockers).toContainEqual(
      expect.objectContaining({
        code: "unproven-previous-stop",
        service: "worker-1",
      }),
    );
  });

  test.each([0, 143])("accepts previous normal exit %s", async (exitCode) => {
    const { context } = await fixture();
    inspected.mockResolvedValue([
      container("worker-1", { status: "exited", running: false, exitCode }),
    ]);
    const report = await commandStopPlan(context);
    expect(report.ok).toBe(true);
    expect(report.stopLayers).toEqual([]);
    expect(report.cleanup.containers).toHaveLength(1);
  });

  test("empty project stays read-only and does not invent a daemon timeout", async () => {
    const { context } = await fixture({ runtime: false, managed: false });
    const report = await commandStopPlan(context);
    expect(report.ok).toBe(true);
    expect(report.stopLayers).toEqual([]);
    expect(report.cleanup.removeProjectContainers).toBe(false);
    expect(existsSync(context.runtimeRoot)).toBe(false);
    expect(report.lifecycleDiffs[0]?.source?.stopTimeoutSeconds).toBeNull();
    expect(formatStopPlan(report).join("\n")).toContain(
      "unknown daemon default",
    );
  });

  test("blocks missing runtime Compose with a running project service", async () => {
    const { context } = await fixture({ runtime: false, managed: false });
    inspected.mockResolvedValue([container("database")]);
    const report = await commandStopPlan(context);
    expect(report.ok).toBe(false);
    expect(report.blockers).toContainEqual(
      expect.objectContaining({ code: "missing-runtime-compose" }),
    );
    expect(existsSync(context.runtimeRoot)).toBe(false);
  });

  test("blocks a running service absent from the entire shutdown graph", async () => {
    const { context } = await fixture();
    inspected.mockResolvedValue([container("unknown-service")]);
    const report = await commandStopPlan(context);
    expect(report.ok).toBe(false);
    expect(report.blockers).toContainEqual(
      expect.objectContaining({
        code: "unknown-running-service",
        service: "unknown-service",
      }),
    );
  });

  test("blocks missing runtime Compose even when managed instances are stopped", async () => {
    const { context } = await fixture();
    await rm(context.runtimeComposePath);
    inspected.mockResolvedValue([
      container("worker-1", { running: false, status: "exited", exitCode: 0 }),
    ]);
    const report = await commandStopPlan(context);
    expect(report.ok).toBe(false);
    expect(report.blockers).toContainEqual(
      expect.objectContaining({ code: "missing-runtime-compose" }),
    );
  });

  test("reports implicit Compose dependency edges from current templates", async () => {
    const { context, writeJson } = await fixture();
    await writeJson(context.sharedServerComposeTemplatePath, {
      services: { application: { network_mode: "service:cache" } },
    });
    const report = await commandStopPlan(context);
    const worker = report.lifecycleDiffs.find(
      (entry) => entry.service === "worker-1",
    )!;
    expect(worker.source?.dependencies).toEqual(["cache"]);
    expect(worker.sourceDiffersFromGenerated).toContain("dependencies");
  });

  test("reports conservative union cycles without forwarding sensitive errors", async () => {
    const { context, infrastructure, writeJson } = await fixture({
      managed: false,
    });
    await writeJson(context.composeFilePath, {
      services: { ...infrastructure, database: { depends_on: ["cache"] } },
    });
    await writeJson(context.runtimeComposePath, {
      services: { ...infrastructure, cache: { depends_on: ["database"] } },
    });
    inspected.mockResolvedValue([container("database"), container("cache")]);
    const report = await commandStopPlan(context);
    expect(report.ok).toBe(false);
    expect(report.blockers).toContainEqual(
      expect.objectContaining({ code: "dependency-cycle" }),
    );
    expect(report.stopLayers).toEqual([]);
  });

  test("redacts inspection and YAML parser errors", async () => {
    const { context } = await fixture();
    inspected.mockRejectedValue(
      new Error("docker stderr PASSWORD=do-not-print"),
    );
    await writeFile(
      context.runtimeComposePath,
      "services: [PASSWORD=also-do-not-print\n",
    );
    const report = await commandStopPlan(context);
    expect(report.ok).toBe(false);
    expect(JSON.stringify(report)).not.toContain("do-not-print");
    expect(report.blockers.map((issue) => issue.code)).toContain(
      "inspection-failed",
    );
    expect(report.blockers.map((issue) => issue.code)).toContain(
      "unreadable-runtime-compose",
    );
  });

  test("normalizes equivalent durations, preserves retry policies and inherited defaults", async () => {
    const { context, infrastructure, writeJson } = await fixture({
      managed: false,
    });
    await writeJson(context.composeFilePath, {
      services: {
        ...infrastructure,
        cache: { stop_grace_period: "1m30s", restart: "on-failure:3" },
      },
    });
    await writeJson(context.runtimeComposePath, {
      services: {
        ...infrastructure,
        cache: { stop_grace_period: "90s", restart: "on-failure:3" },
      },
    });
    inspected.mockResolvedValue([
      container("cache", {
        stopTimeout: 90,
        stopSignal: "SIGTERM",
        init: false,
        restartPolicy: "on-failure:3",
        healthcheckEnabled: true,
      }),
    ]);
    const report = await commandStopPlan(context);
    const cache = report.lifecycleDiffs.find(
      (entry) => entry.service === "cache",
    )!;
    expect(cache.sourceDiffersFromGenerated).toEqual([]);
    expect(cache.actual[0]?.differsFromGenerated).toEqual([]);
    expect(cache.source?.stopTimeoutSeconds).toBe(90);
  });

  test("flags an explicit timeout missing from Docker without guessing its effective default", async () => {
    const { context, infrastructure, writeJson } = await fixture({
      managed: false,
    });
    const document = {
      services: {
        ...infrastructure,
        cache: { stop_grace_period: "60s" },
      },
    };
    await writeJson(context.composeFilePath, document);
    await writeJson(context.runtimeComposePath, document);
    inspected.mockResolvedValue([
      container("cache", { stopTimeout: null }),
      container("database", { stopTimeout: 90 }),
    ]);
    const report = await commandStopPlan(context);
    const cache = report.lifecycleDiffs.find(
      (entry) => entry.service === "cache",
    )!;
    const database = report.lifecycleDiffs.find(
      (entry) => entry.service === "database",
    )!;
    expect(cache.sourceDiffersFromGenerated).toEqual([]);
    expect(cache.actual[0]?.differsFromGenerated).toEqual([
      "stopTimeoutSeconds",
    ]);
    expect(cache.actual[0]?.settings.stopTimeoutSeconds).toBeNull();
    expect(database.actual[0]?.differsFromGenerated).toEqual([]);
    expect(formatStopPlan(report).join("\n")).toContain(
      "source=60; generated=60; actual=cache-contai=unknown daemon default",
    );
  });
});
