import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { ProjectContext, SourceManifest } from "../types";
import { replaceInstanceRuntimeData } from "./lifecycle";

describe("instance runtime materialization", () => {
  test("cleanly replaces managed data while preserving runtime-owned paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "papucs-lifecycle-"));
    const sourceDirectory = path.join(root, "source");
    const runtimeDirectory = path.join(root, "runtime");
    await mkdir(sourceDirectory, { recursive: true });
    await mkdir(path.join(runtimeDirectory, "libraries"), { recursive: true });
    await writeFile(path.join(sourceDirectory, "server.yml"), "name=${NAME}\n");
    await writeFile(path.join(runtimeDirectory, "server.yml"), "modified\n");
    await writeFile(path.join(runtimeDirectory, "generated.tmp"), "remove\n");
    await writeFile(
      path.join(runtimeDirectory, "libraries", "keep.jar"),
      "keep\n",
    );

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
  });
});
