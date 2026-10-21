import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { readYamlObject } from "./config";
import { normalizeEnvironment, parseEnvContent } from "./env";
import { inspectProjectContainers, type ContainerSnapshot } from "./inspection";
import { runCommand } from "./process";
import { loadStateReadOnly } from "./state";
import type { ComposeDocument, ProjectContext } from "./types";

const MAX_EVENTS = 64;
const MAX_LOG_BYTES = 8192;
const MAX_LINE_BYTES = 2048;
const MAX_ENV_BYTES = 128 * 1024;
const SENSITIVE_KEY =
  /password|passwd|pwd|token|secret|api[_-]?key|authorization/i;
// A scheme may contain dots and hyphens: a word boundary still retries at every
// punctuation-separated suffix. Only the start of the entire token is a candidate.
const URI_CREDENTIALS = /(?<![a-z\d+.-])([a-z][a-z\d+.-]*:\/\/)([^\s/@]+)@/gi;
const STOP_EXIT_CODES = [0, 143];
const EVENT_ACTIONS = new Set(["kill", "die", "stop", "start"]);
const EVENT_FORMAT =
  '{"id":{{json .Actor.ID}},"action":{{json .Action}},"timeNano":{{json .TimeNano}},"time":{{json .Time}},' +
  '"project":{{json (index .Actor.Attributes "com.docker.compose.project")}},' +
  '"service":{{json (index .Actor.Attributes "com.docker.compose.service")}},' +
  '"oneoff":{{json (index .Actor.Attributes "com.docker.compose.oneoff")}},' +
  '"signal":{{json (index .Actor.Attributes "signal")}},"exitCode":{{json (index .Actor.Attributes "exitCode")}}}';

export interface StopDiagnosticEvent {
  at: string;
  action: "kill" | "die" | "stop" | "start";
  signal: string | null;
  exitCode: number | null;
}

export interface ObservedStop {
  signal: string | null;
  signalAt: string | null;
  killAt: string | null;
  exitedAt: string | null;
  signalToKillMs: number | null;
  signalToExitMs: number | null;
  exitCode: number | null;
}

export interface ContainerStopDiagnostics {
  snapshot: ContainerSnapshot;
  stopPolicy: {
    acceptedExitCodes: number[];
    exitCodeAccepted: boolean;
    stoppedCleanly: boolean;
    previousStopSafe: boolean;
  };
  effectiveStopSignal: string;
  stopSignalAssumption: string | null;
  daemonStopTimeout: null;
  events: StopDiagnosticEvent[];
  observedStop: ObservedStop | null;
  logs: string[];
  warnings: string[];
}

export interface StopDiagnosticsReport {
  project: string;
  collectedAt: string;
  since: string;
  until: string;
  containers: ContainerStopDiagnostics[];
  warnings: string[];
}

export type StopDiagnostics = StopDiagnosticsReport;

function cleanText(value: string): string {
  return stripVTControlCharacters(value).replace(
    /[\p{Cc}\p{Cf}]/gu,
    (character) => (character === "\n" || character === "\t" ? character : ""),
  );
}

function limitBytes(value: string, limit: number): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= limit) return value;
  if (limit <= 3) return ".".repeat(Math.max(0, limit));
  const prefix = bytes
    .subarray(0, limit - 3)
    .toString("utf8")
    .replace(/\ufffd$/, "");
  return `${prefix}...`;
}

interface RedactionRange {
  start: number;
  end: number;
  replacement: string;
}

function findCredentialFields(value: string, ranges: RedactionRange[]): void {
  // Parse a key once, then classify it. Putting the sensitive-key alternatives
  // between two greedy key prefixes repeatedly rescans keys such as secretsecret.
  const fields = /(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]+)["']?\s*[:=]\s*/g;
  for (let match = fields.exec(value); match; match = fields.exec(value)) {
    if (!SENSITIVE_KEY.test(match[1]!)) continue;
    const start = fields.lastIndex;
    let end = start;
    const quote = value[start];
    if (quote === '"' || quote === "'") {
      end++;
      while (end < value.length && value[end] !== "\n") {
        if (value[end] === quote) {
          end++;
          break;
        }
        if (
          value[end] === "\\" &&
          end + 1 < value.length &&
          value[end + 1] !== "\n"
        )
          end++;
        end++;
      }
    } else {
      while (end < value.length && !/[\s,;&]/.test(value[end]!)) end++;
    }
    if (end === start) continue;
    ranges.push({ start, end, replacement: "[REDACTED]" });
    fields.lastIndex = end;
  }
}

function redact(value: string, secrets: string[]): string {
  const text = cleanText(value);
  const ranges: RedactionRange[] = [];
  const addMatches = (
    pattern: RegExp,
    options: {
      prefixGroup?: number;
      suffixLength?: number;
      replacement?: string;
    } = {},
  ) => {
    for (const match of text.matchAll(pattern)) {
      ranges.push({
        start:
          match.index +
          (options.prefixGroup ? match[options.prefixGroup]!.length : 0),
        end: match.index + match[0].length - (options.suffixLength ?? 0),
        replacement: options.replacement ?? "[REDACTED]",
      });
    }
  };
  // Find every range on the same text. Replacing a literal first can hide a PEM
  // header; replacing structure first can split a known secret and expose its
  // remaining parts. Union overlapping ranges before making any replacement.
  addMatches(
    /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z ]+ )?PRIVATE KEY-----|$)/g,
    { replacement: "[REDACTED PRIVATE KEY]" },
  );
  addMatches(URI_CREDENTIALS, { prefixGroup: 1, suffixLength: 1 });
  addMatches(/(\b(?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]+/gi, {
    prefixGroup: 1,
  });
  findCredentialFields(text, ranges);
  addMatches(
    /(?<![A-Za-z0-9_.-])eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?![A-Za-z0-9_-])/g,
  );
  if (secrets.length > 0) {
    const pattern = secrets
      .map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|");
    addMatches(new RegExp(pattern, "g"));
  }
  ranges.sort(
    (left, right) => left.start - right.start || right.end - left.end,
  );
  const merged: RedactionRange[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end)
      previous.end = Math.max(previous.end, range.end);
    else merged.push(range);
  }
  const parts: string[] = [];
  let cursor = 0;
  for (const range of merged) {
    parts.push(text.slice(cursor, range.start), range.replacement);
    cursor = range.end;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
}

function withinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function knownSecrets(
  context: ProjectContext,
): Promise<{ values: string[]; safe: boolean; contextualOnly?: boolean }> {
  const root = await realpath(context.root);
  const files = [context.envPath];
  if (context.serversDir) {
    try {
      const servers = await realpath(context.serversDir);
      if (!withinRoot(root, servers)) return { values: [], safe: false };
      for (const entry of await readdir(servers, { withFileTypes: true })) {
        if (entry.isDirectory())
          files.push(path.join(servers, entry.name, ".env"));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        return { values: [], safe: false };
    }
  }
  const values = new Set<string>();
  let contextualOnly = false;
  const addSecret = (value: string) => {
    const normalized = cleanText(value);
    if (!normalized) return;
    // Bare short/scalar values cannot be distinguished from timestamps, exit codes
    // or flags. The credential-key, authorization and URI redactors still mask them.
    if (
      normalized.length < 4 ||
      /^(?:[+-]?(?:\d+\.?\d*|\.\d+)|true|false|yes|no|on|off|null|undefined)$/i.test(
        normalized,
      )
    ) {
      contextualOnly = true;
      return;
    }
    values.add(normalized);
    values.add(encodeURIComponent(value));
  };
  const decoded = (value: string) => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };
  const addValues = (environment: Record<string, string>) => {
    for (const [key, value] of Object.entries(environment)) {
      if (!value) continue;
      if (SENSITIVE_KEY.test(key)) addSecret(value);
      // Connection URLs may contain credentials even under a non-secret key such
      // as DATABASE_URL. Retain passwords and sensitive query values for masking.
      for (const match of value.matchAll(URI_CREDENTIALS)) {
        const userinfo = match[2]!;
        const separator = userinfo.indexOf(":");
        if (separator >= 0) addSecret(decoded(userinfo.slice(separator + 1)));
      }
      if (value.includes("://")) {
        for (const match of value.matchAll(/[?&]([^=&#]+)=([^&#]*)/g)) {
          if (SENSITIVE_KEY.test(decoded(match[1]!)))
            addSecret(decoded(match[2]!));
        }
      }
    }
  };
  for (const file of files) {
    try {
      const resolved = await realpath(file);
      if (
        !withinRoot(root, resolved) ||
        (await stat(resolved)).size > MAX_ENV_BYTES
      )
        return { values: [], safe: false };
      addValues(parseEnvContent(await readFile(resolved, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        return { values: [], safe: false };
    }
  }
  if (context.runtimeStatePath) {
    try {
      const resolved = await realpath(context.runtimeStatePath);
      if (
        !withinRoot(root, resolved) ||
        (await stat(resolved)).size > MAX_ENV_BYTES * 8
      )
        return { values: [], safe: false };
      for (const instance of (await loadStateReadOnly(context)).instances)
        addValues(normalizeEnvironment(instance.composeService.environment));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        return { values: [], safe: false };
    }
  }
  if (context.runtimeComposePath) {
    try {
      const resolved = await realpath(context.runtimeComposePath);
      if (
        !withinRoot(root, resolved) ||
        (await stat(resolved)).size > MAX_ENV_BYTES * 8
      )
        return { values: [], safe: false };
      const compose = await readYamlObject<ComposeDocument>(resolved);
      for (const service of Object.values(compose.services ?? {}))
        addValues(normalizeEnvironment(service.environment));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        return { values: [], safe: false };
    }
  }
  if (
    values.size > 1024 ||
    [...values].reduce((total, value) => total + Buffer.byteLength(value), 0) >
      MAX_ENV_BYTES
  )
    return { values: [], safe: false };
  return {
    values: [...values].filter(Boolean).sort((a, b) => b.length - a.length),
    safe: true,
    contextualOnly,
  };
}

function eventTime(event: Record<string, unknown>): string | null {
  const nano = Number(event.timeNano);
  const seconds = Number(event.time);
  const milliseconds =
    Number.isFinite(nano) && nano > 0 ? nano / 1e6 : seconds * 1000;
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return null;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function signalName(signal: unknown): string | null {
  if (typeof signal !== "string" && typeof signal !== "number") return null;
  const value = String(signal).toUpperCase();
  if (value.length > 32 || !/^(?:SIG)?[A-Z0-9]+$/.test(value)) return null;
  return (
    (
      {
        "15": "SIGTERM",
        TERM: "SIGTERM",
        "9": "SIGKILL",
        KILL: "SIGKILL",
        "2": "SIGINT",
        INT: "SIGINT",
      } as Record<string, string>
    )[value] ?? value
  );
}

function observedStop(events: StopDiagnosticEvent[]): ObservedStop | null {
  let end = events.length - 1;
  while (end >= 0 && !["die", "kill"].includes(events[end]!.action)) end--;
  if (end < 0) return null;
  let begin = end;
  while (begin > 0 && !["start", "die"].includes(events[begin - 1]!.action))
    begin--;
  const episode = events.slice(begin, end + 1);
  const signal = episode.find(
    (event) =>
      event.action === "kill" && event.signal && event.signal !== "SIGKILL",
  );
  const kill = episode.find(
    (event) => event.action === "kill" && event.signal === "SIGKILL",
  );
  const exit = episode.find((event) => event.action === "die");
  const elapsed = (event: StopDiagnosticEvent | undefined) =>
    signal && event ? Date.parse(event.at) - Date.parse(signal.at) : null;
  return {
    signal: signal?.signal ?? null,
    signalAt: signal?.at ?? null,
    killAt: kill?.at ?? null,
    exitedAt: exit?.at ?? null,
    signalToKillMs: elapsed(kill),
    signalToExitMs: elapsed(exit),
    exitCode: exit?.exitCode ?? null,
  };
}

/** Read-only, project-scoped evidence. Unavailable evidence never replaces a stop failure. */
export async function collectStopDiagnostics(
  context: ProjectContext,
  options: { services?: string[]; since?: string; tail?: number } = {},
): Promise<StopDiagnosticsReport> {
  const now = new Date();
  const report: StopDiagnosticsReport = {
    project: limitBytes(cleanText(context.composeProjectName), 256),
    collectedAt: now.toISOString(),
    since: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
    until: now.toISOString(),
    containers: [],
    warnings: [],
  };
  if (options.since) {
    const parsed = Date.parse(options.since);
    if (Number.isFinite(parsed) && parsed <= now.getTime())
      report.since = new Date(parsed).toISOString();
    else report.warnings.push("Invalid event start time; using the last hour.");
  }
  const tail = Number.isFinite(options.tail)
    ? Math.min(100, Math.max(0, Math.trunc(options.tail!)))
    : 20;
  let snapshots: ContainerSnapshot[];
  try {
    snapshots = (await inspectProjectContainers(context)).filter(
      (item) => !options.services || options.services.includes(item.service),
    );
  } catch {
    report.warnings.push(
      "Project container inspection unavailable; no stop verdict can be established.",
    );
    return report;
  }
  for (const service of options.services ?? []) {
    if (!snapshots.some((snapshot) => snapshot.service === service))
      report.warnings.push(
        "A requested service has no project container; its previous stop cannot be established.",
      );
  }
  if (snapshots.length === 0) return report;

  let secrets: Awaited<ReturnType<typeof knownSecrets>> = {
    values: [],
    safe: false,
  };
  try {
    secrets = await knownSecrets(context);
  } catch {
    /* Keep diagnostics available without unsafe logs. */
  }
  if (!secrets.safe)
    report.warnings.push(
      "Environment redaction data unavailable; log excerpts withheld.",
    );
  else if (secrets.contextualOnly && tail > 0)
    report.warnings.push(
      "Short or scalar secrets are masked in credential fields, authorization headers and URI credentials; unlabelled occurrences cannot be identified safely.",
    );
  let eventLines: string[] = [];
  try {
    const result = await runCommand(
      "docker",
      [
        "events",
        "--since",
        report.since,
        "--until",
        report.until,
        "--filter",
        "type=container",
        "--filter",
        `label=com.docker.compose.project=${context.composeProjectName}`,
        "--filter",
        "label=com.docker.compose.oneoff=False",
        ...[...EVENT_ACTIONS].flatMap((action) => [
          "--filter",
          `event=${action}`,
        ]),
        "--format",
        EVENT_FORMAT,
      ],
      { cwd: context.root, timeoutMs: 5000, maxOutputBytes: 256 * 1024 },
    );
    if (result.code === 0)
      eventLines = result.stdout.split(/\r?\n/).filter(Boolean).slice(-256);
    else
      report.warnings.push(
        "Docker event history unavailable; stop timing cannot be fully established.",
      );
  } catch {
    report.warnings.push(
      "Docker event history unavailable; stop timing cannot be fully established.",
    );
  }

  const events = new Map<string, StopDiagnosticEvent[]>();
  let invalidEvent = false;
  for (const line of eventLines) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (!event || typeof event !== "object") throw new Error();
      const snapshot = snapshots.find(
        (item) => item.id === event.id && item.service === event.service,
      );
      if (
        !snapshot ||
        event.project !== context.composeProjectName ||
        event.oneoff !== "False" ||
        !EVENT_ACTIONS.has(String(event.action))
      )
        continue;
      const at = eventTime(event);
      if (!at) {
        invalidEvent = true;
        continue;
      }
      if (at < report.since || at > report.until) continue;
      const exit =
        event.exitCode === "" || event.exitCode == null
          ? null
          : Number(event.exitCode);
      const list = events.get(snapshot.id) ?? [];
      list.push({
        at,
        action: event.action as StopDiagnosticEvent["action"],
        signal: signalName(event.signal),
        exitCode: exit !== null && Number.isInteger(exit) ? exit : null,
      });
      events.set(snapshot.id, list);
    } catch {
      invalidEvent = true;
    }
  }
  if (invalidEvent)
    report.warnings.push(
      "Some Docker events were unreadable and were omitted.",
    );

  report.containers = await Promise.all(
    snapshots.map(async (snapshot) => {
      const inactive = !snapshot.running && !snapshot.restarting;
      const exitCodeAccepted = STOP_EXIT_CODES.includes(snapshot.exitCode);
      const history = (events.get(snapshot.id) ?? [])
        .sort((a, b) => a.at.localeCompare(b.at))
        .slice(-MAX_EVENTS);
      const safe = (value: string) =>
        limitBytes(redact(value, []), 512).replace(/\s+/g, " ");
      const safeSnapshot: ContainerSnapshot = {
        id: safe(snapshot.id),
        service: safe(snapshot.service),
        name: safe(snapshot.name),
        status: safe(snapshot.status),
        running: snapshot.running,
        restarting: snapshot.restarting,
        exitCode: snapshot.exitCode,
        oomKilled: snapshot.oomKilled,
        startedAt: safe(snapshot.startedAt),
        finishedAt: safe(snapshot.finishedAt),
        healthStatus:
          snapshot.healthStatus === null ? null : safe(snapshot.healthStatus),
        healthcheckEnabled: snapshot.healthcheckEnabled,
        stopSignal:
          snapshot.stopSignal === null ? null : safe(snapshot.stopSignal),
        stopTimeout: snapshot.stopTimeout,
        init: snapshot.init,
        restartPolicy: safe(snapshot.restartPolicy),
        image: safe(snapshot.image),
      };
      const container: ContainerStopDiagnostics = {
        snapshot: safeSnapshot,
        stopPolicy: {
          acceptedExitCodes: [...STOP_EXIT_CODES],
          exitCodeAccepted,
          stoppedCleanly:
            inactive &&
            snapshot.status === "exited" &&
            !snapshot.oomKilled &&
            exitCodeAccepted,
          previousStopSafe:
            inactive &&
            ["exited", "created"].includes(snapshot.status) &&
            !snapshot.oomKilled &&
            exitCodeAccepted,
        },
        effectiveStopSignal: signalName(snapshot.stopSignal) ?? "SIGTERM",
        stopSignalAssumption: snapshot.stopSignal
          ? null
          : "SIGTERM is the Docker default for Linux containers; container OS was not inspected.",
        daemonStopTimeout: null,
        events: history,
        observedStop: observedStop(history),
        logs: [],
        warnings: [],
      };
      if (history.length === 0)
        container.warnings.push(
          "No matching events retained in this window; a missing signal is not evidence of a clean stop.",
        );
      if (secrets.safe && tail > 0) {
        try {
          const result = await runCommand(
            "docker",
            ["logs", "--tail", String(tail), "--timestamps", snapshot.id],
            { cwd: context.root, timeoutMs: 5000, maxOutputBytes: 64 * 1024 },
          );
          if (result.code !== 0)
            container.warnings.push("Container logs unavailable.");
          else {
            const output = redact(
              [result.stdout, result.stderr].filter(Boolean).join("\n"),
              secrets.values,
            );
            const lines = output
              .split(/\r?\n/)
              .filter(Boolean)
              .slice(-tail)
              .map((line) => limitBytes(line, MAX_LINE_BYTES));
            let remaining = MAX_LOG_BYTES;
            for (const line of lines.reverse()) {
              if (remaining <= 1) break;
              const bounded = limitBytes(line, remaining - 1);
              container.logs.unshift(bounded);
              remaining -= Buffer.byteLength(bounded) + 1;
            }
            if (
              Buffer.byteLength(output) > MAX_LOG_BYTES ||
              lines.length < output.split(/\r?\n/).filter(Boolean).length
            )
              container.warnings.push(
                "Log excerpt truncated to diagnostic limits.",
              );
          }
        } catch {
          container.warnings.push("Container logs unavailable.");
        }
      }
      return container;
    }),
  );
  return report;
}

export function formatStopDiagnostics(report: StopDiagnosticsReport): string[] {
  const lines = [
    `Stop diagnostics for '${report.project}' (${report.since} to ${report.until}).`,
  ];
  for (const warning of report.warnings) lines.push(`Warning: ${warning}`);
  if (report.containers.length === 0)
    lines.push("No project containers available for diagnosis.");
  for (const item of report.containers) {
    const state = item.snapshot;
    lines.push(
      `[${state.service}] status=${state.status}, running=${state.running}, restarting=${state.restarting}, exit=${state.exitCode}, OOM=${state.oomKilled}`,
    );
    lines.push(
      `  Stop policy: allowed exits 0, 143; exit accepted=${item.stopPolicy.exitCodeAccepted}; clean stop=${item.stopPolicy.stoppedCleanly}; previous stop safe=${item.stopPolicy.previousStopSafe}.`,
    );
    lines.push(
      `  Docker: stopTimeout=${state.stopTimeout === null ? "unset (daemon default unknown)" : `${state.stopTimeout}s`}; stopSignal=${item.effectiveStopSignal}; restart=${state.restartPolicy}; init=${state.init === null ? "unset" : state.init}.`,
    );
    if (item.stopSignalAssumption) lines.push(`  ${item.stopSignalAssumption}`);
    lines.push(
      `  startedAt=${state.startedAt}; finishedAt=${state.finishedAt}.`,
    );
    for (const event of item.events)
      lines.push(
        `  Event ${event.at}: ${event.action}${event.signal ? ` signal=${event.signal}` : ""}${event.exitCode !== null ? ` exit=${event.exitCode}` : ""}.`,
      );
    const observed = item.observedStop;
    if (
      observed?.signalToKillMs !== null &&
      observed?.signalToKillMs !== undefined
    )
      lines.push(
        `  Observed ${observed.signal} to SIGKILL: ${(observed.signalToKillMs / 1000).toFixed(3)}s; configured timeout does not establish the cause.`,
      );
    if (
      observed?.signalToExitMs !== null &&
      observed?.signalToExitMs !== undefined
    )
      lines.push(
        `  Observed ${observed.signal} to exit: ${(observed.signalToExitMs / 1000).toFixed(3)}s.`,
      );
    for (const warning of item.warnings) lines.push(`  Warning: ${warning}`);
    if (item.logs.length > 0)
      lines.push(
        "  Recent logs (redacted):",
        ...item.logs.map((line) => `    ${line}`),
      );
  }
  return lines;
}
