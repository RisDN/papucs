import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { withProjectLock } from "./lock";
import type { ProjectContext } from "./types";

describe("project lock", () => {
  test("creates and releases lock", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "papucs-lock-"));
    const context = {
      runtimeRoot: path.join(root, ".runtime"),
      runtimeLockPath: path.join(root, ".runtime", "lock"),
    } as ProjectContext;
    await withProjectLock(context, "test", async () => {
      expect(existsSync(context.runtimeLockPath)).toBe(true);
    });
    expect(existsSync(context.runtimeLockPath)).toBe(false);
  });

  test("reclaims malformed stale lock", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "papucs-lock-"));
    const context = {
      runtimeRoot: path.join(root, ".runtime"),
      runtimeLockPath: path.join(root, ".runtime", "lock"),
    } as ProjectContext;
    await mkdir(context.runtimeRoot, { recursive: true });
    await writeFile(context.runtimeLockPath, "not-json", "utf8");
    await expect(
      withProjectLock(context, "test", async () => "ok"),
    ).resolves.toBe("ok");
  });
});
