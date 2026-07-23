import type { Reporter } from "./types";

export interface JsonEnvelope<T> {
  schemaVersion: 1;
  ok: boolean;
  command: string;
  data: T;
  warnings: string[];
}

export function jsonEnvelope<T>(
  command: string,
  data: T,
  warnings: string[] = [],
): JsonEnvelope<T> {
  return {
    schemaVersion: 1,
    ok: true,
    command,
    data,
    warnings,
  };
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function createReporter(options: {
  json?: boolean;
  verbose?: boolean;
}): Reporter {
  const silent = options.json === true;
  return {
    log(message) {
      if (!silent) {
        console.log(message);
      }
    },
    warn(message) {
      if (!silent) {
        console.warn(message);
      }
    },
    verbose(message) {
      if (!silent && options.verbose === true) {
        console.error(message);
      }
    },
  };
}
