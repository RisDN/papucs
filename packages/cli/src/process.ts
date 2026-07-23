import { spawn } from "node:child_process";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function runCommand(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    stream?: boolean;
  },
): Promise<CommandResult> {
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: options.stream ? "inherit" : ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      resolve({ code: -1, stdout: "", stderr: error.message });
    });
    child.once("close", (code) => {
      resolve({
        code: code ?? -1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}
