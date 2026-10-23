import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { resolveProjectContext } from "../context";
import { runCommand } from "../process";
import { commandBuildServer, sanitizeDockerTagValue } from "./build";
import {
  commandConfigValidate,
  commandDoctor,
  doctorHasErrors,
} from "./doctor";

vi.mock("../process", () => ({ runCommand: vi.fn() }));

const directories: string[] = [];
const defaultScript = '#!/bin/sh\nperl -e "1"\nexec "$@"\n';
const customScript = '#!/bin/sh\nprintf "custom startup\\n"\nexec "$@"\n';
const reporter = { log: vi.fn(), warn: vi.fn(), verbose: vi.fn() };

beforeEach(() => {
  vi.mocked(runCommand).mockReset();
  vi.mocked(runCommand).mockResolvedValue({
    code: 0,
    stdout: "fixture",
    stderr: "",
  });
});

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(runtimeScript?: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "papucs-build-"));
  directories.push(root);
  const files: Record<string, string> = {
    "papucs.yml": JSON.stringify({
      version: 1,
      project: "build-test",
      runtime: { dir: ".runtime" },
      sources: { layers: "layers", servers: "servers" },
      compose: {
        file: "docker-compose.yml",
        shared_server_template: "servers/_template/server.yml",
      },
      build: {
        dockerfile_template: "Dockerfile.template",
        image: "example/%server_type%",
        tags: ["test"],
      },
      preserve_paths: [],
      replaceable_text_extensions: [".yml"],
    }),
    "docker-compose.yml": "services: {}\n",
    "servers/_template/server.yml": "services: {minecraft: {}}\n",
    "Dockerfile.template":
      "FROM %build_from%\nCOPY %runtime_script% /runtime.sh\n",
    "servers/spawn/spawn.yml": JSON.stringify({
      name: "spawn",
      image: "example/base",
      compose_service: "minecraft",
      instance_name: "test-spawn-%index%",
      papucs_port_base: 25565,
      build:
        runtimeScript === undefined
          ? undefined
          : { runtime_script: runtimeScript },
      layers: [],
    }),
    "scripts/papucs-runtime-replace.sh": defaultScript,
    "scripts/custom.sh": customScript,
  };
  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  return await resolveProjectContext({ project: root });
}

describe("sanitizeDockerTagValue", () => {
  test("converts Git refs into valid Docker tag values", () => {
    expect(sanitizeDockerTagValue("agent/papucs-v0.1")).toBe(
      "agent-papucs-v0.1",
    );
    expect(sanitizeDockerTagValue(" feature/ref with spaces ")).toBe(
      "feature-ref-with-spaces",
    );
    expect(sanitizeDockerTagValue("../")).toBe("unknown");
  });

  test("limits tag values to the Docker maximum", () => {
    expect(sanitizeDockerTagValue("a".repeat(200))).toHaveLength(128);
  });
});

describe("server runtime script selection", () => {
  test.each([undefined, "scripts/custom.sh"])(
    "packages the selected script under the stable context name: %s",
    async (runtimeScript) => {
      const context = await fixture(runtimeScript);
      if (runtimeScript !== undefined) {
        await rm(context.runtimeReplaceScriptPath);
      }
      let packagedScript: string | undefined;
      let packagedDockerfile: string | undefined;
      vi.mocked(runCommand).mockImplementation(async (command, args) => {
        if (command === "docker" && args[0] === "build") {
          packagedScript = await readFile(
            path.join(args.at(-1)!, "papucs-runtime-replace.sh"),
            "utf8",
          );
          packagedDockerfile = await readFile(
            path.join(args.at(-1)!, "Dockerfile"),
            "utf8",
          );
        }
        return { code: 0, stdout: "fixture", stderr: "" };
      });

      await commandBuildServer(
        context,
        "spawn",
        { push: false, dryRun: false },
        reporter,
      );
      expect(packagedScript).toBe(
        runtimeScript === undefined ? defaultScript : customScript,
      );
      expect(packagedDockerfile).toBe(
        "FROM example/base\nCOPY papucs-runtime-replace.sh /runtime.sh\n",
      );
      expect(existsSync(path.join(context.runtimeBuildDir, "spawn"))).toBe(
        false,
      );
      await expect(commandConfigValidate(context)).resolves.toMatchObject({
        serverTypes: ["spawn"],
      });
      const checks = await commandDoctor(context);
      expect(doctorHasErrors(checks)).toBe(false);
      expect(checks.some(({ id }) => id === "runtime-perl-contract")).toBe(
        runtimeScript === undefined,
      );
      expect(checks).toContainEqual(
        expect.objectContaining({
          id:
            runtimeScript === undefined
              ? "runtime-script"
              : "runtime-script:spawn",
          status: "ok",
        }),
      );
    },
  );

  test.each([
    {
      script: "scripts/missing.sh",
      message: "Runtime replacement script not found",
    },
    {
      script: "../outside.sh",
      message: "build.runtime_script escapes the project root",
    },
    {
      script: path.resolve(os.tmpdir(), "outside-runtime.sh"),
      message: "build.runtime_script must be relative",
    },
    { script: "scripts", message: "Runtime replacement script is not a file" },
  ])(
    "rejects invalid explicit script across validation, build and doctor: $script",
    async ({ script, message }) => {
      const context = await fixture(script);
      await expect(commandConfigValidate(context)).rejects.toThrow(message);
      await expect(
        commandBuildServer(
          context,
          "spawn",
          { push: false, dryRun: true },
          reporter,
        ),
      ).rejects.toThrow(message);
      expect(runCommand).not.toHaveBeenCalled();
      expect(existsSync(context.runtimeRoot)).toBe(false);
      const checks = await commandDoctor(context);
      expect(checks).toContainEqual(
        expect.objectContaining({
          id: "runtime-script:spawn",
          status: "error",
          message: expect.stringContaining(message),
        }),
      );
      expect(doctorHasErrors(checks)).toBe(true);
    },
  );

  test("keeps default-script validation and doctor contract behavior", async () => {
    const context = await fixture();
    await writeFile(context.runtimeReplaceScriptPath, customScript);
    expect(await commandDoctor(context)).toContainEqual(
      expect.objectContaining({
        id: "runtime-perl-contract",
        status: "error",
      }),
    );
    await rm(context.runtimeReplaceScriptPath);
    await expect(commandConfigValidate(context)).resolves.toMatchObject({
      serverTypes: ["spawn"],
    });
    await expect(
      commandBuildServer(
        context,
        "spawn",
        { push: false, dryRun: true },
        reporter,
      ),
    ).rejects.toThrow("Runtime replacement script not found");
    expect(await commandDoctor(context)).toContainEqual(
      expect.objectContaining({
        id: "runtime-script",
        status: "error",
      }),
    );
  });
});
