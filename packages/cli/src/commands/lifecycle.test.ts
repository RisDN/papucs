import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { ProjectContext, RuntimeInstance, SourceManifest } from "../types";
import { resolveProjectContext } from "../context";
import { persistStateAndCompose } from "../compose";
import { loadState, saveCache } from "../state";
import { runCommand } from "../process";
import { assertServicesStopped, getRunningServices } from "../docker";
import {
  commandDown,
  commandRebuild,
  commandRestartAll,
  commandRestartBatch,
  commandSync,
  commandStopAll,
  commandUpBatch,
  replaceInstanceRuntimeData,
} from "./lifecycle";

vi.mock("../process", () => ({ runCommand: vi.fn() }));
const mockedRunCommand = vi.mocked(runCommand);

describe("instance runtime materialization", () => {
  test("cleanly replaces managed data while preserving runtime-owned paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "papucs-lifecycle-"));
    const sourceDirectory = path.join(root, "source");
    const runtimeDirectory = path.join(root, "runtime");
    await mkdir(sourceDirectory, { recursive: true });
    await mkdir(path.join(runtimeDirectory, "libraries"), { recursive: true });
    await mkdir(path.join(runtimeDirectory, ".cache"), { recursive: true });
    await writeFile(path.join(sourceDirectory, "server.yml"), "name=${NAME}\n");
    await writeFile(path.join(runtimeDirectory, "server.yml"), "modified\n");
    await writeFile(path.join(runtimeDirectory, "generated.tmp"), "remove\n");
    await writeFile(
      path.join(runtimeDirectory, "libraries", "keep.jar"),
      "keep\n",
    );
    await writeFile(
      path.join(runtimeDirectory, ".cache", "runtime-cache"),
      "keep\n",
    );

    const context = {
      config: {
        preserve_paths: ["libraries", ".cache"],
        replaceable_text_extensions: [".yml"],
      },
    } as ProjectContext;
    const manifest: SourceManifest = {
      config: {} as SourceManifest["config"],
      overrides: [],
      files: new Map([
        [
          "server.yml",
          {
            absPath: path.join(sourceDirectory, "server.yml"),
            relPath: "server.yml",
            hash: "source-hash",
            source: "layer:base",
          },
        ],
      ]),
    };

    const cache = await replaceInstanceRuntimeData({
      context,
      runtimeDataDir: runtimeDirectory,
      manifest,
      replacementVariables: { NAME: "Papucs" },
    });

    expect(cache["server.yml"]?.hash).toBe("source-hash");
    expect(
      await readFile(path.join(runtimeDirectory, "server.yml"), "utf8"),
    ).toBe("name=Papucs\n");
    expect(existsSync(path.join(runtimeDirectory, "generated.tmp"))).toBe(
      false,
    );
    expect(
      await readFile(
        path.join(runtimeDirectory, "libraries", "keep.jar"),
        "utf8",
      ),
    ).toBe("keep\n");
    expect(
      await readFile(
        path.join(runtimeDirectory, ".cache", "runtime-cache"),
        "utf8",
      ),
    ).toBe("keep\n");
  });
});

interface ContainerState {
  Running: boolean;
  Restarting: boolean;
  Status: string;
  ExitCode: number;
  OOMKilled: boolean;
}
const reporter = { log: vi.fn(), warn: vi.fn(), verbose: vi.fn() };
let containers: Map<string, ContainerState>;
let events: string[];
let stopExit: Map<string, number>;
let stopOom: Set<string>;
let oneOff: Set<string>;
let failAction: string | undefined;

function runningState(): ContainerState {
  return {
    Running: true,
    Restarting: false,
    Status: "running",
    ExitCode: 0,
    OOMKilled: false,
  };
}

beforeEach(() => {
  containers = new Map();
  events = [];
  stopExit = new Map();
  stopOom = new Set();
  oneOff = new Set();
  failAction = undefined;
  mockedRunCommand.mockReset();
  mockedRunCommand.mockImplementation(async (command, args) => {
    const result = { code: 0, stdout: "", stderr: "" };
    if (command === "git") return { ...result, code: 1 };
    if (command !== "docker") throw new Error(`Unexpected command ${command}`);
    if (args[0] === "ps") {
      const selected = [...containers].filter(
        ([service, state]) =>
          (args.includes("-a") || state.Running) &&
          !(
            args.includes("label=com.docker.compose.oneoff=False") &&
            oneOff.has(service)
          ),
      );
      const format = args[args.indexOf("--format") + 1] ?? "";
      if (format.includes(".Names"))
        result.stdout = selected
          .map(([service]) => `example-${service}`)
          .join("\n");
      else if (format.includes(".ID"))
        result.stdout = selected
          .map(([service]) => `${service}\t${service}`)
          .join("\n");
      else result.stdout = selected.map(([service]) => service).join("\n");
      return result;
    }
    if (args[0] === "inspect")
      return {
        ...result,
        stdout: JSON.stringify(containers.get(args.at(-1)!) ?? {}),
      };
    if (args[0] === "wait") {
      for (const service of args.slice(1))
        containers.set(service, {
          ...runningState(),
          Running: false,
          Status: "exited",
        });
      events.push(`wait ${args.slice(1).join(" ")}`);
      return result;
    }
    if (args[0] !== "compose")
      throw new Error(`Unexpected Docker command ${args.join(" ")}`);
    const composeArgs = args.slice(args.indexOf("-f") + 2);
    const action = composeArgs[0]!;
    const services = composeArgs
      .slice(1)
      .filter((value) => !value.startsWith("-"));
    events.push(`${action} ${services.join(" ")}`.trim());
    if (failAction === action)
      return { ...result, code: 1, stderr: "injected Docker failure" };
    if (action === "stop") {
      for (const service of services) {
        if (containers.has(service))
          containers.set(service, {
            ...runningState(),
            Running: false,
            Status: "exited",
            ExitCode: stopExit.get(service) ?? 0,
            OOMKilled: stopOom.has(service),
          });
      }
    } else if (action === "rm") {
      for (const service of services) containers.delete(service);
    } else if (action === "up") {
      for (const service of services) containers.set(service, runningState());
    } else if (action === "down") containers.clear();
    return result;
  });
});

async function lifecycleProject(
  options: {
    declarations?: boolean;
    existing?: boolean;
    extraServices?: Record<string, unknown>;
  } = {},
): Promise<ProjectContext> {
  const root = await mkdtemp(path.join(os.tmpdir(), "papucs-order-"));
  await mkdir(path.join(root, "servers", "_template"), { recursive: true });
  await mkdir(path.join(root, "layers"), { recursive: true });
  await writeFile(
    path.join(root, "papucs.yml"),
    JSON.stringify({
      version: 1,
      project: "example",
      runtime: { dir: ".runtime" },
      sources: { layers: "layers", servers: "servers" },
      compose: {
        file: "docker-compose.yml",
        shared_server_template: "servers/_template/application.yml",
      },
      build: {
        dockerfile_template: "Dockerfile",
        image: "example/%server_type%",
        tags: ["%sha%"],
      },
      preserve_paths: ["world"],
      replaceable_text_extensions: [".yml"],
    }),
  );
  await writeFile(
    path.join(root, "docker-compose.yml"),
    JSON.stringify({
      services: {
        database: { image: "example/db" },
        cache: { image: "example/cache" },
        ...options.extraServices,
      },
    }),
  );
  await writeFile(
    path.join(root, "servers", "_template", "application.yml"),
    JSON.stringify({
      services: {
        application: {
          working_dir: "/data",
          depends_on: {
            database: { condition: "service_started" },
            cache: { condition: "service_started" },
          },
        },
      },
    }),
  );
  for (const server of ["worker", "gateway", "idle"]) {
    await mkdir(path.join(root, "servers", server, "data"), {
      recursive: true,
    });
    await writeFile(
      path.join(root, "servers", server, `${server}.yml`),
      JSON.stringify({
        name: server,
        image: `example/${server}`,
        compose_service: "application",
        instance_name: "example-%server_type%-%index%",
        papucs_port_base: 25565,
        ...(server === "worker" && options.declarations !== false
          ? {
              depends_on: [{ server: "gateway", condition: "service_started" }],
            }
          : {}),
      }),
    );
    await writeFile(
      path.join(root, "servers", server, "data", "value.yml"),
      "new: true\n",
    );
  }
  const context = await resolveProjectContext({ project: root });
  if (options.existing !== false) {
    const instances = ["worker", "gateway", "idle"].map(
      (server): RuntimeInstance => ({
        id: `${server}-1`,
        serverType: server,
        index: 1,
        serverName: `example-${server}-1`,
        serviceName: `${server}-1`,
        runtimeDataDir: `instances/${server}-1/data`,
        templateServiceName: "application",
        createdAt: "old",
        updatedAt: "old",
        composeService: {
          image: `example/${server}`,
          depends_on: {
            database: { condition: "service_started" },
            cache: { condition: "service_started" },
          },
        },
      }),
    );
    await persistStateAndCompose(context, { version: 1, instances });
    for (const instance of instances)
      await saveCache(context, {
        instanceId: instance.id,
        serverType: instance.serverType,
        updatedAt: "old",
        files: {},
      });
  }
  return context;
}

describe("runtime port configuration", () => {
  test("uses the root port base for startup, sync, and rebuilding an existing index", async () => {
    const context = await lifecycleProject({ existing: false });
    const configPath = path.join(context.serversDir, "idle", "idle.yml");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<
      string,
      unknown
    >;
    config.papucs_port_base = 26000;
    config.interpolate_variables = { PAPUCS_PORT_BASE: 41000 };
    await writeFile(configPath, JSON.stringify(config));
    await writeFile(context.envPath, "IDLE_PORT_BASE=42000\nPORT_BASE=43000\n");
    await writeFile(
      context.sharedServerComposeTemplatePath,
      JSON.stringify({
        services: {
          application: { ports: ["${PAPUCS_PORT}:${PAPUCS_PORT}"] },
        },
      }),
    );
    const sourcePath = path.join(
      context.serversDir,
      "idle",
      "data",
      "value.yml",
    );
    const portTemplate = "port: ${PAPUCS_PORT}\nserver_port: ${SERVER_PORT}\n";
    await writeFile(sourcePath, portTemplate);

    const instances = await commandUpBatch(context, ["idle", "idle"], reporter);
    expect(instances.map((instance) => instance.composeService.ports)).toEqual([
      ["26000:26000"],
      ["26001:26001"],
    ]);
    for (const [index, instance] of instances.entries()) {
      expect(
        await readFile(
          path.join(context.runtimeRoot, instance.runtimeDataDir, "value.yml"),
          "utf8",
        ),
      ).toBe(`port: ${26000 + index}\nserver_port: ${26000 + index}\n`);
    }

    await writeFile(sourcePath, `${portTemplate}updated: true\n`);
    const synced = await commandSync(context, "idle", false, reporter);
    expect(Object.keys(synced)).toEqual(["idle-1", "idle-2"]);
    for (const [index, instance] of instances.entries()) {
      expect(synced[instance.id]?.changed).toEqual(["value.yml"]);
      expect(
        await readFile(
          path.join(context.runtimeRoot, instance.runtimeDataDir, "value.yml"),
          "utf8",
        ),
      ).toBe(
        `port: ${26000 + index}\nserver_port: ${26000 + index}\nupdated: true\n`,
      );
    }

    config.papucs_port_base = 27000;
    await writeFile(configPath, JSON.stringify(config));
    const rebuilt = await commandRebuild(context, "idle-2", reporter);
    expect(rebuilt.index).toBe(2);
    expect(rebuilt.composeService.ports).toEqual(["27001:27001"]);
    expect(
      await readFile(
        path.join(context.runtimeRoot, rebuilt.runtimeDataDir, "value.yml"),
        "utf8",
      ),
    ).toBe("port: 27001\nserver_port: 27001\nupdated: true\n");
  });
});

describe("dependency lifecycle", () => {
  test("batch up resolves a later argument and starts the complete planned batch once", async () => {
    const context = await lifecycleProject({ existing: false });
    const instances = await commandUpBatch(
      context,
      ["worker", "gateway"],
      reporter,
    );
    expect(instances.map((instance) => instance.id)).toEqual([
      "worker-1",
      "gateway-1",
    ]);
    expect(events).toEqual(["up worker-1 gateway-1"]);
    expect(
      await readFile(
        path.join(context.runtimeInstancesDir, "worker-1", "data", "value.yml"),
        "utf8",
      ),
    ).toBe("new: true\n");
    const call = mockedRunCommand.mock.calls.find(([, args]) =>
      args.includes("up"),
    );
    expect(call?.[1]).toContain("--wait");
    expect(call?.[1]).toContain("--no-recreate");
  });

  test("missing provider fails before materialization, cache, state or Docker starts", async () => {
    const context = await lifecycleProject({ existing: false });
    await expect(commandUpBatch(context, ["worker"], reporter)).rejects.toThrow(
      "no managed or planned instance",
    );
    expect(events).toEqual([]);
    expect(existsSync(context.runtimeStatePath)).toBe(false);
    expect(await readdir(context.runtimeInstancesDir)).toEqual([]);
    expect(await readdir(context.runtimeCacheDir)).toEqual([]);
  });

  test("ambiguous provider batch fails before any data changes", async () => {
    const context = await lifecycleProject({ existing: false });
    await expect(
      commandUpBatch(context, ["worker", "gateway", "gateway"], reporter),
    ).rejects.toThrow("ambiguous");
    expect(events).toEqual([]);
    expect(await readdir(context.runtimeInstancesDir)).toEqual([]);
  });

  test("cycles fail before any batch starts", async () => {
    const context = await lifecycleProject({ existing: false });
    const gateway = path.join(context.serversDir, "gateway", "gateway.yml");
    const config = JSON.parse(await readFile(gateway, "utf8")) as Record<
      string,
      unknown
    >;
    config.depends_on = [{ server: "worker" }];
    await writeFile(gateway, JSON.stringify(config));
    await expect(
      commandUpBatch(context, ["worker", "gateway"], reporter),
    ).rejects.toThrow("cycle");
    expect(events).toEqual([]);
    expect(await readdir(context.runtimeInstancesDir)).toEqual([]);
  });

  test("stopall drains reverse dependency layers and clears metadata only after down succeeds", async () => {
    const context = await lifecycleProject();
    for (const service of ["worker-1", "gateway-1", "database", "cache"])
      containers.set(service, runningState());
    await commandStopAll(context, reporter);
    expect(events).toEqual([
      "stop worker-1",
      "stop gateway-1",
      "stop cache database",
      "down",
    ]);
    expect((await loadState(context)).instances).toEqual([]);
    expect(await readdir(context.runtimeCacheDir)).toEqual([]);
  });

  test.each([137, 1])(
    "failed consumer exit %s retains providers, state and cache",
    async (code) => {
      const context = await lifecycleProject();
      const state = await readFile(context.runtimeStatePath, "utf8");
      for (const service of ["worker-1", "gateway-1", "database", "cache"])
        containers.set(service, runningState());
      stopExit.set("worker-1", code);
      await expect(commandStopAll(context, reporter)).rejects.toThrow(
        "did not stop cleanly",
      );
      expect(events).toEqual(["stop worker-1"]);
      expect(containers.get("gateway-1")?.Running).toBe(true);
      expect(containers.get("database")?.Running).toBe(true);
      expect(await readFile(context.runtimeStatePath, "utf8")).toBe(state);
      expect(await readdir(context.runtimeCacheDir)).toHaveLength(3);
    },
  );

  test("OOM stop with zero exit is still unproven", async () => {
    const context = await lifecycleProject();
    containers.set("worker-1", runningState());
    stopOom.add("worker-1");
    await expect(commandStopAll(context, reporter)).rejects.toThrow("OOM=true");
    expect(events).toEqual(["stop worker-1"]);
  });

  test("normal signal exit 143 permits dependent shutdown", async () => {
    const context = await lifecycleProject();
    containers.set("worker-1", runningState());
    containers.set("gateway-1", runningState());
    stopExit.set("gateway-1", 143);
    await commandStopAll(context, reporter);
    expect(events).toEqual(["stop worker-1", "stop gateway-1", "down"]);
  });

  test("down failure propagates while metadata and cache remain", async () => {
    const context = await lifecycleProject();
    const state = await readFile(context.runtimeStatePath, "utf8");
    failAction = "down";
    await expect(commandStopAll(context, reporter)).rejects.toThrow(
      "injected Docker failure",
    );
    expect(await readFile(context.runtimeStatePath, "utf8")).toBe(state);
    expect(await readdir(context.runtimeCacheDir)).toHaveLength(3);
  });

  test("restartall stops every selected service before any startup and preserves stopped instances", async () => {
    const context = await lifecycleProject();
    for (const service of ["worker-1", "gateway-1", "database", "cache"])
      containers.set(service, runningState());
    const result = await commandRestartAll(context, reporter);
    expect(events).toEqual([
      "stop worker-1",
      "stop gateway-1",
      "stop cache database",
      "rm worker-1",
      "rm gateway-1",
      "up cache database",
      "up gateway-1",
      "up worker-1",
    ]);
    expect(events.some((event) => event.startsWith("restart"))).toBe(false);
    expect(containers.has("idle-1")).toBe(false);
    expect(
      (await loadState(context)).instances.find(
        (instance) => instance.id === "idle-1",
      )?.updatedAt,
    ).toBe("old");
    expect(result.instances).toEqual(["worker-1", "gateway-1"]);
    for (const [, args] of mockedRunCommand.mock.calls.filter(([, args]) =>
      args.includes("up"),
    ))
      expect(args).toContain("--no-deps");
  });

  test("restartall cannot bypass a failed stop", async () => {
    const context = await lifecycleProject();
    for (const service of ["worker-1", "gateway-1", "database", "cache"])
      containers.set(service, runningState());
    stopExit.set("worker-1", 137);
    await expect(commandRestartAll(context, reporter)).rejects.toThrow(
      "did not stop cleanly",
    );
    expect(events).toEqual(["stop worker-1"]);
  });

  test("new declarations govern stop even when generated Compose still has the older graph", async () => {
    const context = await lifecycleProject({ declarations: false });
    const worker = path.join(context.serversDir, "worker", "worker.yml");
    const config = JSON.parse(await readFile(worker, "utf8")) as Record<
      string,
      unknown
    >;
    config.depends_on = [{ server: "gateway" }];
    await writeFile(worker, JSON.stringify(config));
    for (const service of ["worker-1", "gateway-1", "database", "cache"])
      containers.set(service, runningState());
    await commandStopAll(context, reporter);
    expect(events.slice(0, 3)).toEqual([
      "stop worker-1",
      "stop gateway-1",
      "stop cache database",
    ]);
  });

  test("targeted provider down and rebuild reject running dependents without partial changes", async () => {
    const context = await lifecycleProject();
    containers.set("worker-1", runningState());
    containers.set("gateway-1", runningState());
    await expect(
      commandDown(context, "gateway-1", false, reporter),
    ).rejects.toThrow("dependent services are running: worker-1");
    await expect(
      commandRebuild(context, "gateway-1", reporter),
    ).rejects.toThrow("dependent services are running: worker-1");
    await expect(
      commandRestartBatch(context, ["worker-1", "gateway-1"], reporter),
    ).rejects.toThrow("dependent services are running: worker-1");
    expect(events).toEqual([]);
  });

  test("targeted ordinary consumer restart remains allowed", async () => {
    const context = await lifecycleProject();
    for (const service of ["worker-1", "gateway-1", "database", "cache"])
      containers.set(service, runningState());
    await commandRebuild(context, "worker-1", reporter);
    expect(events).toEqual(["stop worker-1", "rm worker-1", "up worker-1"]);
    expect(containers.get("gateway-1")?.Running).toBe(true);
  });

  test("restartall refuses to implicitly start a stopped required provider", async () => {
    const context = await lifecycleProject();
    containers.set("worker-1", runningState());
    await expect(commandRestartAll(context, reporter)).rejects.toThrow(
      "was not running",
    );
    expect(events).toEqual([]);
  });

  test("restartall leaves a successful stopped one-shot provider untouched", async () => {
    const context = await lifecycleProject({
      extraServices: {
        initializer: { image: "example/init" },
        client: {
          image: "example/client",
          depends_on: {
            initializer: { condition: "service_completed_successfully" },
          },
        },
      },
    });
    containers.set("initializer", {
      ...runningState(),
      Running: false,
      Status: "exited",
    });
    containers.set("client", runningState());
    await commandRestartAll(context, reporter);
    expect(events).toEqual(["stop client", "up client"]);
  });

  test("restartall preserves optional stopped providers", async () => {
    const context = await lifecycleProject({
      extraServices: {
        metrics: { image: "example/metrics" },
        client: {
          image: "example/client",
          depends_on: {
            metrics: { condition: "service_started", required: false },
          },
        },
      },
    });
    containers.set("client", runningState());
    await commandRestartAll(context, reporter);
    expect(events).toEqual(["stop client", "up client"]);
    expect(containers.has("metrics")).toBe(false);
  });

  test("one-shot completion requires zero, rather than a signal exit", async () => {
    const context = await lifecycleProject();
    containers.set("initializer", {
      ...runningState(),
      Running: false,
      Status: "exited",
      ExitCode: 143,
    });
    await expect(
      assertServicesStopped(context, ["initializer"], true),
    ).rejects.toThrow("did not stop cleanly");
  });

  test("running-state inspection failure is not treated as an empty project", async () => {
    const context = await lifecycleProject();
    mockedRunCommand.mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "daemon unavailable",
    });
    await expect(getRunningServices(context)).rejects.toThrow(
      "daemon unavailable",
    );
    expect((await loadState(context)).instances).toHaveLength(3);
  });

  test("retrying a forced stop retains failed consumer proof and does not stop providers", async () => {
    const context = await lifecycleProject();
    for (const service of ["worker-1", "gateway-1", "database", "cache"])
      containers.set(service, runningState());
    stopExit.set("worker-1", 137);
    await expect(commandStopAll(context, reporter)).rejects.toThrow(
      "did not stop cleanly",
    );
    await expect(commandStopAll(context, reporter)).rejects.toThrow(
      "unproven previous stop",
    );
    expect(events).toEqual(["stop worker-1"]);
    expect(containers.get("gateway-1")?.Running).toBe(true);
    expect((await loadState(context)).instances).toHaveLength(3);
  });

  test("stopall can clean a created container which never ran", async () => {
    const context = await lifecycleProject();
    containers.set("idle-1", {
      ...runningState(),
      Running: false,
      Status: "created",
    });
    await commandStopAll(context, reporter);
    expect(events).toEqual(["down"]);
    expect((await loadState(context)).instances).toEqual([]);
  });

  test("multi-target restart preflights prospective replacement dependencies before the first stop", async () => {
    const context = await lifecycleProject({ declarations: false });
    await writeFile(
      path.join(context.serversDir, "worker", "docker-compose.yml"),
      JSON.stringify({
        services: {
          application: {
            image: "example/worker",
            depends_on: { "gateway-1": { condition: "service_started" } },
          },
        },
      }),
    );
    for (const service of ["worker-1", "gateway-1", "database", "cache"])
      containers.set(service, runningState());
    await expect(
      commandRestartBatch(context, ["worker-1", "gateway-1"], reporter),
    ).rejects.toThrow("dependent services are running: worker-1");
    expect(events).toEqual([]);
  });

  test("restartall shutdown honors new raw template dependencies before any provider stop", async () => {
    const context = await lifecycleProject({ declarations: false });
    await writeFile(
      path.join(context.serversDir, "worker", "docker-compose.yml"),
      JSON.stringify({
        services: {
          application: {
            image: "example/worker",
            depends_on: { "gateway-1": { condition: "service_started" } },
          },
        },
      }),
    );
    for (const service of ["worker-1", "gateway-1", "database", "cache"])
      containers.set(service, runningState());
    await commandRestartAll(context, reporter);
    expect(events.slice(0, 3)).toEqual([
      "stop worker-1",
      "stop gateway-1",
      "stop cache database",
    ]);
  });

  test("running one-shot dependency is restarted and completed before its consumer starts", async () => {
    const context = await lifecycleProject({
      extraServices: {
        initializer: { image: "example/init" },
        client: {
          image: "example/client",
          depends_on: {
            initializer: { condition: "service_completed_successfully" },
          },
        },
      },
    });
    containers.set("initializer", runningState());
    containers.set("client", runningState());
    await commandRestartAll(context, reporter);
    expect(events).toEqual([
      "stop client",
      "stop initializer",
      "up initializer",
      "wait initializer",
      "up client",
    ]);
  });

  test("a stopped consumer does not turn its running provider into a restartall one-shot", async () => {
    const context = await lifecycleProject({
      extraServices: {
        storage: { image: "example/storage" },
        archive: {
          image: "example/archive",
          depends_on: {
            storage: { condition: "service_completed_successfully" },
          },
        },
      },
    });
    containers.set("storage", runningState());
    await commandRestartAll(context, reporter);
    expect(events).toEqual(["stop storage", "up storage"]);
  });

  test("stop command failure aborts before provider stop and metadata cleanup", async () => {
    const context = await lifecycleProject();
    containers.set("worker-1", runningState());
    containers.set("gateway-1", runningState());
    failAction = "stop";
    await expect(commandStopAll(context, reporter)).rejects.toThrow(
      "injected Docker failure",
    );
    expect(events).toEqual(["stop worker-1"]);
    expect((await loadState(context)).instances).toHaveLength(3);
    expect(containers.get("gateway-1")?.Running).toBe(true);
  });

  test("exit inspection requests only required fields and omits environment and health logs", async () => {
    const context = await lifecycleProject();
    containers.set("idle-1", {
      ...runningState(),
      Running: false,
      Status: "exited",
    });
    await assertServicesStopped(context, ["idle-1"]);
    const format = mockedRunCommand.mock.calls.find(
      ([, args]) => args[0] === "inspect",
    )?.[1][2];
    expect(format).toContain(".State.ExitCode");
    expect(format).not.toContain(".Env");
    expect(format).not.toContain(".Health");
    expect(format).not.toContain("{{json .State}}");
  });

  test("service inventory excludes ad-hoc Compose one-off containers from running and stopped checks", async () => {
    const context = await lifecycleProject();
    containers.set("gateway-1", runningState());
    containers.set("ad-hoc", { ...runningState(), ExitCode: 137 });
    oneOff.add("ad-hoc");
    expect(await getRunningServices(context)).toEqual(new Set(["gateway-1"]));
    containers.set("ad-hoc", {
      ...runningState(),
      Running: false,
      Status: "exited",
      ExitCode: 137,
    });
    await commandStopAll(context, reporter);
    expect(events).toEqual(["stop gateway-1", "down"]);
    for (const [, args] of mockedRunCommand.mock.calls.filter(
      ([, args]) => args[0] === "ps",
    )) {
      expect(args).toContain("label=com.docker.compose.oneoff=False");
    }
  });
});
