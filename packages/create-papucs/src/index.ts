import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Command, CommanderError } from "commander";

const VERSION = "0.1.2";
const supportedPackageManagers = ["npm", "pnpm", "bun"] as const;
type PackageManager = (typeof supportedPackageManagers)[number];

export interface CreateOptions {
  template: string;
  yes: boolean;
  install: boolean;
  packageManager: PackageManager;
  acceptEula: boolean;
  cwd?: string;
}

function validateProjectName(value: string): string {
  const name = path.basename(path.resolve(value));
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new Error(
      `Project name must match /^[A-Za-z0-9][A-Za-z0-9._-]*$/: '${name}'.`,
    );
  }
  return name;
}

async function targetIsEmpty(target: string): Promise<boolean> {
  if (!existsSync(target)) {
    return true;
  }
  if (!(await stat(target)).isDirectory()) {
    return false;
  }
  return (await readdir(target)).length === 0;
}

async function replaceTemplateMarkers(
  root: string,
  values: Record<string, string>,
): Promise<void> {
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolute);
      } else if (entry.isFile()) {
        const original = await readFile(absolute, "utf8");
        const replaced = Object.entries(values).reduce(
          (content, [marker, value]) => content.replaceAll(marker, value),
          original,
        );
        if (replaced !== original) {
          await writeFile(absolute, replaced, "utf8");
        }
      }
    }
  }
}

async function promptForEula(): Promise<boolean> {
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await prompt.question(
      "Accept the Minecraft EULA (https://aka.ms/MinecraftEULA)? [y/N] ",
    );
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    prompt.close();
  }
}

async function runInstall(
  packageManager: PackageManager,
  cwd: string,
): Promise<void> {
  const command =
    process.platform === "win32" ? `${packageManager}.cmd` : packageManager;
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(command, ["install"], {
      cwd,
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("close", (exitCode) => resolve(exitCode ?? 1));
  });
  if (code !== 0) {
    throw new Error(`${packageManager} install failed with exit code ${code}.`);
  }
}

export async function createProject(
  targetArgument: string,
  options: CreateOptions,
): Promise<string> {
  if (options.template !== "minecraft") {
    throw new Error(
      `Unknown template '${options.template}'. Available: minecraft.`,
    );
  }
  if (!supportedPackageManagers.includes(options.packageManager)) {
    throw new Error(
      `Unsupported package manager '${options.packageManager}'. Use npm, pnpm, or bun.`,
    );
  }

  const cwd = path.resolve(options.cwd ?? process.cwd());
  const target = path.resolve(cwd, targetArgument);
  if (!(await targetIsEmpty(target))) {
    throw new Error(`Target must not exist or must be empty: ${target}`);
  }
  const projectName = validateProjectName(target);
  await mkdir(target, { recursive: true });

  const templatesRoot = fileURLToPath(new URL("../templates", import.meta.url));
  const source = path.join(templatesRoot, options.template);
  if (!existsSync(source)) {
    throw new Error(`Bundled template not found: ${source}`);
  }
  await cp(source, target, { recursive: true, errorOnExist: true });
  await replaceTemplateMarkers(target, {
    __PROJECT_NAME__: projectName,
    __PAPUCS_VERSION__: VERSION,
  });

  const packedGitignore = path.join(target, "_gitignore");
  if (existsSync(packedGitignore)) {
    await rename(packedGitignore, path.join(target, ".gitignore"));
  }

  let acceptedEula = options.acceptEula;
  if (
    !acceptedEula &&
    !options.yes &&
    process.stdin.isTTY &&
    process.stdout.isTTY
  ) {
    acceptedEula = await promptForEula();
  }
  if (acceptedEula) {
    const example = await readFile(path.join(target, ".env.example"), "utf8");
    await writeFile(
      path.join(target, ".env"),
      example.replace(/^EULA=FALSE$/m, "EULA=TRUE"),
      "utf8",
    );
  }

  if (options.install) {
    await runInstall(options.packageManager, target);
  }
  return target;
}

function buildProgram(): Command {
  const program = new Command();
  program
    .name("create-papucs")
    .description("Create a ready-to-use Papucs Minecraft development project")
    .version(VERSION)
    .argument("<target>", "target project directory")
    .option("--template <name>", "project template", "minecraft")
    .option("--yes", "accept defaults without accepting Minecraft EULA")
    .option("--no-install", "skip dependency installation")
    .option("--package-manager <name>", "npm, pnpm, or bun", "npm")
    .option("--accept-eula", "explicitly accept the Minecraft EULA")
    .showHelpAfterError()
    .exitOverride()
    .action(
      async (
        target: string,
        raw: {
          template: string;
          yes?: boolean;
          install: boolean;
          packageManager: string;
          acceptEula?: boolean;
        },
      ) => {
        const packageManager = raw.packageManager as PackageManager;
        const created = await createProject(target, {
          template: raw.template,
          yes: raw.yes === true,
          install: raw.install,
          packageManager,
          acceptEula: raw.acceptEula === true,
        });
        console.log(`Created Papucs project in ${created}`);
        console.log("Next:");
        console.log(`  cd ${path.relative(process.cwd(), created) || "."}`);
        if (!raw.install) {
          console.log(`  ${packageManager} install`);
        }
        if (!raw.acceptEula) {
          console.log("  Review .env.example and accept the Minecraft EULA.");
        }
        console.log("  npx papucs doctor");
        console.log("  npx papucs dev spawn");
      },
    );
  return program;
}

async function main(): Promise<void> {
  try {
    await buildProgram().parseAsync(process.argv);
  } catch (error) {
    if (
      error instanceof CommanderError &&
      (error.code === "commander.helpDisplayed" ||
        error.code === "commander.version")
    ) {
      return;
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof CommanderError ? 2 : 1;
  }
}

if (
  process.argv[1] &&
  pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url
) {
  await main();
}
