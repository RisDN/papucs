import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { ProjectContext, SourceManifest, SyncCache } from "./types";
import { applySync } from "./sync";

describe("incremental sync", () => {
  test("updates, deletes, interpolates, and preserves configured paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "papucs-sync-"));
    const source = path.join(root, "source");
    const runtime = path.join(root, "runtime");
    await mkdir(path.join(runtime, "libraries"), { recursive: true });
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "config.yml"), "name=${NAME}\n");
    await writeFile(path.join(runtime, "old.yml"), "old\n");
    await writeFile(path.join(runtime, "libraries", "keep.jar"), "keep\n");
    const context = {
      config: {
        preserve_paths: ["libraries"],
        replaceable_text_extensions: [".yml"],
      },
    } as ProjectContext;
    const manifest: SourceManifest = {
      config: {} as SourceManifest["config"],
      overrides: [],
      files: new Map([
        [
          "config.yml",
          {
            absPath: path.join(source, "config.yml"),
            relPath: "config.yml",
            hash: "new",
            source: "layer:base",
          },
        ],
      ]),
    };
    const cache: SyncCache = {
      instanceId: "spawn-1",
      serverType: "spawn",
      updatedAt: "",
      files: {
        "old.yml": { hash: "old", source: "layer:base" },
        "libraries/keep.jar": { hash: "old", source: "runtime" },
      },
    };

    const result = await applySync(context, runtime, manifest, cache, {
      dryRun: false,
      replacementVariables: { NAME: "Papucs" },
    });
    expect(result.changed).toEqual(["config.yml"]);
    expect(result.deleted).toEqual(["old.yml"]);
    expect(await readFile(path.join(runtime, "config.yml"), "utf8")).toBe(
      "name=Papucs\n",
    );
    expect(
      await readFile(path.join(runtime, "libraries", "keep.jar"), "utf8"),
    ).toBe("keep\n");
  });
});
