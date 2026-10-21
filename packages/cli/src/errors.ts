import type { StopDiagnostics } from "./diagnostics";

export class PapucsError extends Error {
  public readonly exitCode: number;

  public constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "PapucsError";
    this.exitCode = exitCode;
  }
}

export class UsageError extends PapucsError {
  public constructor(message: string) {
    super(message, 2);
    this.name = "UsageError";
  }
}

export class StopFailure extends PapucsError {
  public diagnostics?: StopDiagnostics;
  public diagnosticsWarning?: string;

  public constructor(
    message: string,
    public readonly services: string[],
    public readonly previousStop = false,
  ) {
    super(message);
    this.name = "StopFailure";
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
