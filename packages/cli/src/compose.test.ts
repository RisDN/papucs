import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  buildRuntimeCompose,
  buildRuntimeServiceDefinition,
  persistStateAndCompose,
} from "./compose";
import { buildRuntimeTemplateContext } from "./env";
import { dependencyLayers, buildDependencyGraph } from "./dependencies";
import type {
  ProjectContext,
  RuntimeComposeService,
  RuntimeInstance,
  RuntimeState,
} from "./types";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function runtimeInstance(
  serverType: string,
  index: number,
  composeService: RuntimeComposeService = {},
): RuntimeInstance {
  const id = `${serverType}-${index}`;
  return {
    id,
    serverType,
    index,
    serverName: id,
    serviceName: id,
    runtimeDataDir: `instances/${id}/data`,
    templateServiceName: "application",
    composeService,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

async function fixture(): Promise<{
  context: ProjectContext;
  state: RuntimeState;
  writeServer: (
    serverType: string,
    extra?: Record<string, unknown>,
  ) => Promise<void>;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "papucs-compose-"));
  temporaryDirectories.push(root);
  const context = {
    root,
    runtimeRoot: path.join(root, ".runtime"),
    serversDir: path.join(root, "servers"),
    composeFilePath: path.join(root, "docker-compose.yml"),
    sharedServerComposeTemplatePath: path.join(root, "template.yml"),
  } as ProjectContext;
  await writeFile(
    context.composeFilePath,
    JSON.stringify({
      services: {
        database: { image: "example/database" },
        cache: { image: "example/cache" },
      },
    }),
  );
  await writeFile(
    context.sharedServerComposeTemplatePath,
    JSON.stringify({
      services: { application: { image: "example/application" } },
    }),
  );
  const writeServer = async (
    serverType: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> => {
    const directory = path.join(context.serversDir, serverType);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, `${serverType}.yml`),
      JSON.stringify({
        name: serverType,
        image: "example/application",
        compose_service: "application",
        instance_name: `${serverType}-%index%`,
        papucs_port_base: 25565,
        ...extra,
      }),
    );
  };
  await writeServer("worker", {
    depends_on: [{ server: "gateway", condition: "service_healthy" }],
  });
  await writeServer("gateway", { depends_on: [{ service: "cache" }] });
  const worker = runtimeInstance("worker", 7, {
    depends_on: { database: { condition: "service_healthy", restart: true } },
  });
  const gateway = runtimeInstance("gateway", 3);
  return {
    context,
    state: { version: 1, instances: [worker, gateway] },
    writeServer,
  };
}

describe("Compose service materialization", () => {
  test("preserves service fields and resolves reserved context", () => {
    const variables = buildRuntimeTemplateContext({
      serverType: "spawn",
      instanceId: "spawn-1",
      index: 1,
      instanceName: "example-spawn-1",
      portBase: 25565,
      mergedEnv: { SECRET: "hidden" },
    });
    const service = buildRuntimeServiceDefinition({
      templateService: {
        "x-papucs": { inject_environment: true },
        ports: ["${PAPUCS_PORT}:${PAPUCS_PORT}"],
        volumes: ["${PAPUCS_DATA_PATH}:/data"],
        command: ["serve"],
        environment: { SECRET: "compose-wins" },
      },
      image: "example/server",
      serverName: "example-spawn-1",
      variables,
    });
    expect(service.image).toBe("example/server");
    expect(service.container_name).toBe("example-spawn-1");
    expect(service.ports).toEqual(["25565:25565"]);
    expect(service.volumes).toEqual(["./instances/spawn-1/data:/data"]);
    expect(service.command).toEqual(["serve"]);
    expect(service["x-papucs"]).toBeUndefined();
    expect(service.environment).toContain("SECRET=compose-wins");
    expect(variables.PAPUCS_HOST_UID).toMatch(/^\d+$/);
    expect(variables.PAPUCS_HOST_GID).toMatch(/^\d+$/);
  });

  test("allows explicit host identity overrides", () => {
    const variables = buildRuntimeTemplateContext({
      serverType: "spawn",
      instanceId: "spawn-1",
      index: 1,
      instanceName: "example-spawn-1",
      portBase: 25565,
      mergedEnv: {
        PAPUCS_HOST_UID: "2001",
        PAPUCS_HOST_GID: "2002",
      },
    });
    expect(variables.PAPUCS_HOST_UID).toBe("2001");
    expect(variables.PAPUCS_HOST_GID).toBe("2002");
  });

  test("rejects unresolved reserved variables", () => {
    expect(() =>
      buildRuntimeServiceDefinition({
        templateService: { command: ["${PAPUCS_UNKNOWN}"] },
        image: "example/server",
        serverName: "example",
        variables: {},
      }),
    ).toThrow("Unresolved Papucs Compose placeholders");
  });
});

describe("resolved runtime Compose dependencies", () => {
  test("resolves every planned instance before ordering, without baking edges into state", async () => {
    const { context, state } = await fixture();
    const original = JSON.stringify(state);
    const document = await buildRuntimeCompose(context, state);
    expect(document.services?.["worker-7"]?.depends_on).toEqual({
      database: { condition: "service_healthy", restart: true },
      "gateway-3": { condition: "service_healthy" },
    });
    expect(document.services?.["gateway-3"]?.depends_on).toEqual({
      cache: { condition: "service_started" },
    });
    expect(
      dependencyLayers(buildDependencyGraph(document.services ?? {})),
    ).toEqual([["cache", "database"], ["gateway-3"], ["worker-7"]]);
    expect(JSON.stringify(state)).toBe(original);
  });

  test("rereads manifest dependencies so removed edges do not survive in stored templates", async () => {
    const { context, state, writeServer } = await fixture();
    const first = await buildRuntimeCompose(context, state);
    expect(first.services?.["worker-7"]?.depends_on).toHaveProperty(
      "gateway-3",
    );
    await writeServer("worker", { depends_on: [] });
    const second = await buildRuntimeCompose(context, state);
    expect(second.services?.["worker-7"]?.depends_on).toEqual({
      database: { condition: "service_healthy", restart: true },
    });
  });

  test("keeps short raw dependencies unchanged when a manifest declares none", async () => {
    const { context, state, writeServer } = await fixture();
    await writeServer("worker");
    state.instances[0]!.composeService.depends_on = ["database"];
    expect(
      (await buildRuntimeCompose(context, state)).services?.["worker-7"]
        ?.depends_on,
    ).toEqual(["database"]);
  });

  test("rejects cycles across raw infrastructure dependencies and declared server dependencies", async () => {
    const { context, state } = await fixture();
    await writeFile(
      context.composeFilePath,
      JSON.stringify({
        services: {
          database: {},
          cache: { depends_on: ["worker-7"] },
        },
      }),
    );
    await expect(buildRuntimeCompose(context, state)).rejects.toThrow(
      "Dependency cycle",
    );
  });

  test("rejects source service collisions and duplicate managed service names", async () => {
    const { context, state } = await fixture();
    await writeFile(
      context.composeFilePath,
      JSON.stringify({ services: { "worker-7": {} } }),
    );
    await expect(buildRuntimeCompose(context, state)).rejects.toThrow(
      "Conflicting Compose service",
    );
    await writeFile(
      context.composeFilePath,
      JSON.stringify({ services: { cache: {}, database: {} } }),
    );
    state.instances[1]!.serviceName = "worker-7";
    await expect(buildRuntimeCompose(context, state)).rejects.toThrow(
      "Conflicting Compose service",
    );
  });

  test("rejects missing and ambiguous instance providers without changing state", async () => {
    const { context, state } = await fixture();
    state.instances = [state.instances[0]!];
    const original = JSON.stringify(state);
    await expect(buildRuntimeCompose(context, state)).rejects.toThrow(
      "has no managed or planned instance",
    );
    expect(JSON.stringify(state)).toBe(original);
    state.instances.push(runtimeInstance("gateway", 3));
    state.instances.push(runtimeInstance("gateway", 8));
    await expect(buildRuntimeCompose(context, state)).rejects.toThrow(
      "is ambiguous",
    );
  });

  test("rejects invalid persistence before overwriting an existing Compose or state", async () => {
    const { context, state } = await fixture();
    context.runtimeComposePath = path.join(
      context.runtimeRoot,
      "docker-compose.yml",
    );
    context.runtimeStatePath = path.join(context.runtimeRoot, "state.json");
    await mkdir(context.runtimeRoot, { recursive: true });
    await writeFile(context.runtimeComposePath, "previous-compose");
    await writeFile(context.runtimeStatePath, "previous-state");
    state.instances = [state.instances[0]!];
    const original = JSON.stringify(state);
    await expect(persistStateAndCompose(context, state)).rejects.toThrow(
      "has no managed or planned instance",
    );
    expect(await readFile(context.runtimeComposePath, "utf8")).toBe(
      "previous-compose",
    );
    expect(await readFile(context.runtimeStatePath, "utf8")).toBe(
      "previous-state",
    );
    expect(JSON.stringify(state)).toBe(original);
  });
});
