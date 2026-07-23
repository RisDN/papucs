import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { createProject } from "./index";

describe("create-papucs", () => {
  test("creates a clean non-installed Minecraft project", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "create-papucs-"));
    const target = path.join(root, "example-network");
    await createProject(target, {
      template: "minecraft",
      yes: true,
      install: false,
      packageManager: "npm",
      acceptEula: true,
    });
    expect(existsSync(path.join(target, ".gitignore"))).toBe(true);
    expect(existsSync(path.join(target, ".env"))).toBe(true);
    expect(await readFile(path.join(target, ".env"), "utf8")).toContain(
      "EULA=TRUE",
    );
    expect(await readFile(path.join(target, "papucs.yml"), "utf8")).toContain(
      "project: example-network",
    );
    expect(
      await readFile(path.join(target, "package.json"), "utf8"),
    ).not.toContain("__PAPUCS_VERSION__");
  });

  test("refuses a non-empty target", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "create-papucs-"));
    await writeFile(path.join(root, "existing.txt"), "keep", "utf8");
    await expect(
      createProject(root, {
        template: "minecraft",
        yes: true,
        install: false,
        packageManager: "npm",
        acceptEula: false,
      }),
    ).rejects.toThrow("must not exist or must be empty");
  });
});
