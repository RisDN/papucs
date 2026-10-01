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
      ...extra,
    }),
  );
  return file;
}

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
