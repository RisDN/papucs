import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { readServerConfig } from "./config";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function config(extra: Record<string, unknown> = {}): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "papucs-config-"));
  directories.push(directory);
  const file = path.join(directory, "worker.yml");
  await writeFile(
    file,
    JSON.stringify({
      name: "worker",
      image: "example/worker",
      compose_service: "application",
      instance_name: "example-worker-%index%",
      papucs_port_base: 25565,
      ...extra,
    }),
  );
  return file;
}

describe("server port base schema", () => {
  test.each([1, 25565, 65535])("accepts port base %i", async (portBase) => {
    expect(
      (await readServerConfig(await config({ papucs_port_base: portBase })))
        .papucs_port_base,
    ).toBe(portBase);
  });

  test.each([undefined, null, "25565", "", true, 0, -1, 65536, 25565.5])(
    "rejects a missing or invalid port base %j with its field and file path",
    async (portBase) => {
      const file = await config({ papucs_port_base: portBase });
      await expect(readServerConfig(file)).rejects.toMatchObject({
        name: "PapucsError",
        message: expect.stringContaining(
          `Invalid configuration '${file}': papucs_port_base:`,
        ),
      });
    },
  );

  test.each(["PAPUCS_PORT_BASE", "PORT_BASE", "WORKER_PORT_BASE"])(
    "requires the top-level field even when interpolate_variables contains %s",
    async (legacyName) => {
      await expect(
        readServerConfig(
          await config({
            papucs_port_base: undefined,
            interpolate_variables: { [legacyName]: 25565 },
          }),
        ),
      ).rejects.toThrow("papucs_port_base");
    },
  );
});

describe("server dependency schema", () => {
  test("preserves existing manifests without dependencies", async () => {
    expect(
      (await readServerConfig(await config({ custom: "value" }))).depends_on,
    ).toBeUndefined();
  });

  test("accepts the three explicit target kinds and defaults their conditions", async () => {
    const value = await readServerConfig(
      await config({
        depends_on: [
          { service: "database", condition: "service_healthy" },
          { server: "gateway" },
          {
            instance: "bootstrap-2",
            condition: "service_completed_successfully",
          },
        ],
      }),
    );
    expect(value.depends_on).toEqual([
      { service: "database", condition: "service_healthy" },
      { server: "gateway", condition: "service_started" },
      { instance: "bootstrap-2", condition: "service_completed_successfully" },
    ]);
  });

  test.each([
    {},
    { server: "gateway", service: "database" },
    { instance: "gateway-1", server: "gateway" },
    { server: "" },
    { server: "gateway", condition: "ready" },
    { server: "gateway", restart: true },
  ])("rejects invalid or ambiguous dependency entry %j", async (entry) => {
    await expect(
      readServerConfig(await config({ depends_on: [entry] })),
    ).rejects.toThrow("Invalid configuration");
  });

  test("rejects an untyped dependency list", async () => {
    await expect(
      readServerConfig(await config({ depends_on: ["gateway"] })),
    ).rejects.toThrow("Invalid configuration");
  });
});
