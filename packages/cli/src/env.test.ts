import { describe, expect, test } from "vitest";
import { buildRuntimeTemplateContext } from "./env";

function runtimeContext(
  options: Partial<Parameters<typeof buildRuntimeTemplateContext>[0]> = {},
): Record<string, string> {
  return buildRuntimeTemplateContext({
    serverType: "spawn",
    instanceId: "spawn-3",
    index: 3,
    instanceName: "example-spawn-3",
    portBase: 25565,
    mergedEnv: {},
    ...options,
  });
}

describe("runtime ports", () => {
  test.each([
    [1, "25565"],
    [2, "25566"],
    [3, "25567"],
  ])("allocates instance %i from the configured base", (index, port) => {
    const context = runtimeContext({ index });
    expect(context.PAPUCS_PORT).toBe(port);
    expect(context.SERVER_PORT).toBe(port);
  });

  test.each(["PAPUCS_PORT_BASE", "SPAWN_PORT_BASE", "PORT_BASE"])(
    "ignores the old %s base variable",
    (key) => {
      expect(
        runtimeContext({ mergedEnv: { [key]: "30000" } }).PAPUCS_PORT,
      ).toBe("25567");
    },
  );

  test("reserves PAPUCS_PORT while preserving an explicit SERVER_PORT", () => {
    const context = runtimeContext({
      mergedEnv: { PAPUCS_PORT: "30000", SERVER_PORT: "25565" },
    });
    expect(context.PAPUCS_PORT).toBe("25567");
    expect(context.SERVER_PORT).toBe("25565");
  });

  test.each([
    [{ PAPUCS_PORT_3: "26000", PORTS_3: "27000" }, "26000"],
    [{ PORTS_3: "27000" }, "27000"],
    [{ PAPUCS_PORT_2: "26000" }, "25567"],
  ])("retains per-instance port overrides %j", (mergedEnv, port) => {
    expect(runtimeContext({ mergedEnv }).PAPUCS_PORT).toBe(port);
  });

  test("accepts the highest port and rejects the next instance before launch", () => {
    expect(runtimeContext({ portBase: 65533 }).PAPUCS_PORT).toBe("65535");
    expect(() => runtimeContext({ portBase: 65534 })).toThrow(
      "Invalid port '65536' for instance 'spawn-3'",
    );
  });

  test.each(["0", "65536"])("rejects out-of-range port override %s", (port) => {
    expect(() =>
      runtimeContext({ mergedEnv: { PAPUCS_PORT_3: port } }),
    ).toThrow("expected an integer between 1 and 65535");
  });
});
