import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { readYamlObject } from "../config";
import { resolveServerComposeTemplatePath } from "../compose";
import { collectSourceManifest, listServerTypes } from "../manifest";
import { runCommand } from "../process";
import type { DoctorCheck, ProjectContext } from "../types";

function check(
  id: string,
  status: DoctorCheck["status"],
  message: string,
): DoctorCheck {
  return { id, status, message };
}

export async function commandDoctor(
  context: ProjectContext,
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const major = Number(process.versions.node.split(".")[0]);
  checks.push(
    check(
      "node",
      major >= 22 ? "ok" : "error",
      `Node.js ${process.versions.node}${major >= 22 ? "" : " is unsupported; 22+ required"}.`,
    ),
  );
  checks.push(
    check(
      "config",
      "ok",
      `papucs.yml v${context.config.version}: ${context.config.project}.`,
    ),
  );

  for (const [id, filePath] of [
    ["compose", context.composeFilePath],
    ["server-template", context.sharedServerComposeTemplatePath],
    ["dockerfile-template", context.dockerfileTemplatePath],
    ["runtime-script", context.runtimeReplaceScriptPath],
  ] as const) {
    checks.push(
      check(
        id,
        existsSync(filePath) ? "ok" : "error",
        existsSync(filePath) ? `${id} found.` : `${id} missing: ${filePath}`,
      ),
    );
  }
  checks.push(
    check(
      "env",
      existsSync(context.envPath) ? "ok" : "warn",
      existsSync(context.envPath)
        ? ".env found."
        : ".env missing; copy .env.example or rerun initializer with --accept-eula.",
    ),
  );

  const docker = await runCommand("docker", ["--version"], {
    cwd: context.root,
  });
  checks.push(
    check(
      "docker-cli",
      docker.code === 0 ? "ok" : "error",
      docker.code === 0
        ? docker.stdout
        : `Docker CLI unavailable: ${docker.stderr}`,
    ),
  );
  if (docker.code === 0) {
    const compose = await runCommand("docker", ["compose", "version"], {
      cwd: context.root,
    });
    checks.push(
      check(
        "docker-compose",
        compose.code === 0 ? "ok" : "error",
        compose.code === 0
          ? compose.stdout
          : `Docker Compose unavailable: ${compose.stderr}`,
      ),
    );
    const daemon = await runCommand(
      "docker",
      ["info", "--format", "{{.ServerVersion}}"],
      { cwd: context.root },
    );
    checks.push(
      check(
        "docker-daemon",
        daemon.code === 0 ? "ok" : "error",
        daemon.code === 0
          ? `Docker daemon ${daemon.stdout}.`
          : `Docker daemon unavailable: ${daemon.stderr}`,
      ),
    );
  }

  try {
    await readYamlObject(context.composeFilePath);
    const serverTypes = await listServerTypes(context);
    for (const serverType of serverTypes) {
      await collectSourceManifest(context, serverType);
      const composePath = resolveServerComposeTemplatePath(context, serverType);
      await readYamlObject(composePath);
    }
    checks.push(
      check(
        "project-sources",
        serverTypes.length > 0 ? "ok" : "error",
        `${serverTypes.length} server type(s) validated.`,
      ),
    );
  } catch (error) {
    checks.push(
      check(
        "project-sources",
        "error",
        error instanceof Error ? error.message : String(error),
      ),
    );
  }

  if (existsSync(context.runtimeReplaceScriptPath)) {
    const script = await readFile(context.runtimeReplaceScriptPath, "utf8");
    checks.push(
      check(
        "runtime-perl-contract",
        script.includes("perl ") && script.includes('exec "$@"')
          ? "ok"
          : "error",
        "Runtime script requires a Linux image with sh, find, grep, and perl.",
      ),
    );
  }
  return checks;
}

export async function commandConfigValidate(
  context: ProjectContext,
): Promise<{ project: string; serverTypes: string[] }> {
  await readYamlObject(context.composeFilePath);
  const serverTypes = await listServerTypes(context);
  for (const serverType of serverTypes) {
    await collectSourceManifest(context, serverType);
    await readYamlObject(resolveServerComposeTemplatePath(context, serverType));
  }
  return { project: context.config.project, serverTypes };
}

export function doctorHasErrors(checks: DoctorCheck[]): boolean {
  return checks.some((entry) => entry.status === "error");
}
