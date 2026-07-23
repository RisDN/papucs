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

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
