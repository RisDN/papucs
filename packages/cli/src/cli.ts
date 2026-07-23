import { Command, CommanderError } from "commander";
import { commandBuildServer, resolveBuildServerTypes } from "./commands/build";
import {
  commandConfigValidate,
  commandDoctor,
  doctorHasErrors,
} from "./commands/doctor";
import {
  commandDev,
  commandDown,
  commandPull,
  commandRebuild,
  commandRestart,
  commandRestartAll,
  commandStatus,
  commandStopAll,
  commandSync,
  commandUp,
} from "./commands/lifecycle";
import { commandWorkflowAdd } from "./commands/workflow";
import { resolveProjectContext } from "./context";
import { runCompose } from "./docker";
import { errorMessage, PapucsError, UsageError } from "./errors";
import { withProjectLock } from "./lock";
import { createReporter, jsonEnvelope, printJson } from "./output";
import type { ProjectContext, Reporter } from "./types";
import { VERSION } from "./version";

interface GlobalOptions {
  project?: string;
  config?: string;
  verbose?: boolean;
  color?: boolean;
}

interface JsonOption {
  json?: boolean;
}

function buildProgram(): Command {
  const program = new Command();
  program
    .name("papucs")
    .description(
      "Local-first Minecraft server development and OCI image build CLI",
    )
    .version(VERSION)
    .option("--project <directory>", "use project directory")
    .option("--config <file>", "use explicit papucs.yml")
    .option("--verbose", "print verbose diagnostics")
    .option("--no-color", "disable ANSI color output")
    .showHelpAfterError()
    .exitOverride();

  const context = async (): Promise<ProjectContext> => {
    const options = program.opts<GlobalOptions>();
    return await resolveProjectContext({
      project: options.project,
      config: options.config,
    });
  };
  const reporter = (options: JsonOption = {}): Reporter =>
    createReporter({
      json: options.json,
      verbose: program.opts<GlobalOptions>().verbose,
    });
  const mutate = async <T>(
    commandName: string,
    action: (project: ProjectContext) => Promise<T>,
  ): Promise<T> => {
    const project = await context();
    return await withProjectLock(project, commandName, async () => {
      return await action(project);
    });
  };

  program
    .command("doctor")
    .description("diagnose the local project and Docker environment")
    .option("--json", "emit stable JSON")
    .action(async (options: JsonOption) => {
      const project = await context();
      const checks = await commandDoctor(project);
      const failed = doctorHasErrors(checks);
      if (options.json) {
        printJson({
          ...jsonEnvelope("doctor", { checks }),
          ok: !failed,
        });
      } else {
        for (const entry of checks) {
          console.log(
            `${entry.status.toUpperCase().padEnd(5)} ${entry.message}`,
          );
        }
      }
      if (failed) {
        process.exitCode = 1;
      }
    });

  const configCommand = program
    .command("config")
    .description("project config tools");
  configCommand
    .command("validate")
    .description("validate papucs.yml and all project sources")
    .option("--json", "emit stable JSON")
    .action(async (options: JsonOption) => {
      const result = await commandConfigValidate(await context());
      if (options.json) {
        printJson(jsonEnvelope("config validate", result));
      } else {
        console.log(
          `Valid project '${result.project}' with ${result.serverTypes.length} server type(s).`,
        );
      }
    });

  program
    .command("dev <serverType>")
    .description("start or reuse an idempotent development instance")
    .option("--no-logs", "do not follow container logs")
    .action(async (serverType: string, options: { logs: boolean }) => {
      const project = await context();
      const commandReporter = reporter();
      const instance = await withProjectLock(project, "dev", async () => {
        return await commandDev(project, serverType, commandReporter);
      });
      if (options.logs) {
        await runCompose(project, ["logs", "--follow", instance.serviceName], {
          stream: true,
        });
      }
    });

  program
    .command("up <serverTypes...>")
    .description("start one ad-hoc instance for each server type")
    .action(async (serverTypes: string[]) => {
      await mutate("up", async (project) => {
        for (const serverType of serverTypes) {
          await commandUp(project, serverType, reporter());
        }
      });
    });

  program
    .command("down <target>")
    .description("stop one instance, or every instance of a server type")
    .option("--all", "treat target as server type")
    .action(async (target: string, options: { all?: boolean }) => {
      await mutate("down", async (project) => {
        await commandDown(project, target, options.all === true, reporter());
      });
    });

  program
    .command("restart <targets...>")
    .description("rebuild and restart managed instances")
    .action(async (targets: string[]) => {
      await mutate("restart", async (project) => {
        for (const target of targets) {
          await commandRestart(project, target, reporter());
        }
      });
    });

  program
    .command("restartall")
    .description("restart running services in the current Papucs project")
    .action(async () => {
      await mutate("restartall", async (project) => {
        await commandRestartAll(project, reporter());
      });
    });

  program
    .command("rebuild <target>")
    .description("rebuild and start one managed instance")
    .action(async (target: string) => {
      await mutate("rebuild", async (project) => {
        await commandRebuild(project, target, reporter());
      });
    });

  program
    .command("pull <instance> <runtimePath> <layer>")
    .description("copy runtime file content back into a source layer")
    .option("--force", "overwrite existing source files")
    .option("--dry-run", "show changes without writing files")
    .action(
      async (
        instance: string,
        runtimePath: string,
        layer: string,
        options: { force?: boolean; dryRun?: boolean },
      ) => {
        await mutate("pull", async (project) => {
          await commandPull(
            project,
            instance,
            runtimePath,
            layer,
            {
              force: options.force === true,
              dryRun: options.dryRun === true,
            },
            reporter(),
          );
        });
      },
    );

  program
    .command("sync <serverType>")
    .description("incrementally synchronize running instances")
    .option("--dry-run", "show changes without writing")
    .option("--json", "emit stable JSON")
    .action(
      async (
        serverType: string,
        options: { dryRun?: boolean; json?: boolean },
      ) => {
        const result = await mutate("sync", async (project) => {
          return await commandSync(
            project,
            serverType,
            options.dryRun === true,
            reporter(options),
          );
        });
        if (options.json) {
          printJson(jsonEnvelope("sync", { instances: result }));
        }
      },
    );

  program
    .command("status [serverType]")
    .description("show managed local runtime status")
    .option("--json", "emit stable JSON")
    .action(async (serverType: string | undefined, options: JsonOption) => {
      const result = await commandStatus(await context(), serverType);
      if (options.json) {
        printJson(jsonEnvelope("status", { instances: result }));
      } else if (result.length === 0) {
        console.log("No managed instances found.");
      } else {
        for (const instance of result) {
          console.log(
            `${instance.id}: ${instance.running ? "running" : "stopped"}, runtime=${instance.runtimeExists ? "yes" : "no"}, pending=${instance.pendingChanges ? "yes" : "no"}, lastSync=${instance.lastSync ?? "n/a"}`,
          );
        }
      }
    });

  program
    .command("stopall")
    .description("stop only the current Papucs project")
    .action(async () => {
      await mutate("stopall", async (project) => {
        await commandStopAll(project, reporter());
      });
    });

  program
    .command("build [serverTypes...]")
    .description("build OCI images")
    .option("--actions", "select only actions_build servers")
    .option("--push", "push every configured image tag")
    .option("--dry-run", "resolve build without Docker changes")
    .option("--json", "emit stable JSON")
    .action(
      async (
        serverTypes: string[],
        options: {
          actions?: boolean;
          push?: boolean;
          dryRun?: boolean;
          json?: boolean;
        },
      ) => {
        const images = await mutate("build", async (project) => {
          const commandReporter = reporter(options);
          const selected = await resolveBuildServerTypes(
            project,
            serverTypes,
            options.actions === true,
            commandReporter,
          );
          const results = [];
          for (const serverType of selected) {
            results.push(
              await commandBuildServer(
                project,
                serverType,
                {
                  push: options.push === true,
                  dryRun: options.dryRun === true,
                },
                commandReporter,
              ),
            );
          }
          return results;
        });
        if (options.json) {
          printJson(jsonEnvelope("build", { images }));
        }
      },
    );

  const workflowCommand = program
    .command("workflow")
    .description("project workflow generators");
  workflowCommand
    .command("add <name>")
    .description("add a workflow template")
    .option("--dry-run", "show intent without writing")
    .option("--force", "overwrite changed workflow")
    .action(
      async (name: string, options: { dryRun?: boolean; force?: boolean }) => {
        await mutate("workflow add", async (project) => {
          await commandWorkflowAdd(
            project,
            name,
            {
              dryRun: options.dryRun === true,
              force: options.force === true,
            },
            reporter(),
          );
        });
      },
    );

  program
    .command("version")
    .description("print Papucs version")
    .action(() => {
      console.log(VERSION);
    });

  return program;
}

function commandName(argv: string[]): string {
  return argv.find((value) => !value.startsWith("-")) ?? "papucs";
}

function wantsJson(argv: string[]): boolean {
  return argv.includes("--json");
}

export async function runCli(argv: string[]): Promise<void> {
  const program = buildProgram();
  try {
    await program.parseAsync(["node", "papucs", ...argv]);
  } catch (error) {
    if (error instanceof CommanderError) {
      if (
        error.code === "commander.helpDisplayed" ||
        error.code === "commander.version"
      ) {
        return;
      }
      throw new UsageError(error.message);
    }
    throw error;
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  try {
    await runCli(argv);
  } catch (error) {
    const message = errorMessage(error);
    if (wantsJson(argv)) {
      printJson({
        schemaVersion: 1,
        ok: false,
        command: commandName(argv),
        data: null,
        warnings: [],
        error: { message },
      });
    } else {
      console.error(message);
    }
    process.exitCode = error instanceof PapucsError ? error.exitCode : 1;
  }
}
