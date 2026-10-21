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
    timeoutMs?: number;
    maxOutputBytes?: number;
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
    let capturedBytes = 0;
    let failure: string | undefined;
    let finished = false;
    let exceeded = false;
    const finish = (code: number, message?: string): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: stdout.trim(),
        stderr: message ?? stderr.trim(),
      });
    };
    const abort = (message: string): void => {
      if (failure) return;
      failure = message;
      child.kill("SIGKILL");
      // A descendant can keep inherited pipes open after the direct child exits.
      // Bounded read-only commands must not wait indefinitely for those pipes.
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish(-1, message);
    };
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => abort("Command timed out."), options.timeoutMs);
    timer?.unref();
    const capture = (chunk: string): string => {
      if (failure) return "";
      const bytes = Buffer.from(chunk);
      const remaining =
        options.maxOutputBytes === undefined
          ? bytes.length
          : Math.max(0, options.maxOutputBytes - capturedBytes);
      capturedBytes += bytes.length;
      if (remaining < bytes.length) exceeded = true;
      return bytes.subarray(0, remaining).toString("utf8");
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += capture(chunk);
      if (exceeded) abort("Command output exceeded the capture limit.");
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += capture(chunk);
      if (exceeded) abort("Command output exceeded the capture limit.");
    });
    child.once("error", (error) => {
      finish(-1, error.message);
    });
    child.once("close", (code) => {
      finish(failure ? -1 : (code ?? -1), failure);
    });
  });
}
