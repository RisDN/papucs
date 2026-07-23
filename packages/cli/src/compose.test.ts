import { describe, expect, test } from "vitest";
import { buildRuntimeServiceDefinition } from "./compose";
import { buildRuntimeTemplateContext } from "./env";

describe("Compose service materialization", () => {
  test("preserves service fields and resolves reserved context", () => {
    const variables = buildRuntimeTemplateContext({
      serverType: "spawn",
      instanceId: "spawn-1",
      index: 1,
      instanceName: "example-spawn-1",
      mergedEnv: { PAPUCS_PORT_BASE: "25565", SECRET: "hidden" },
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
