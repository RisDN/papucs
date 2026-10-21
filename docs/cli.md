# CLI reference

Global options:

```text
--project <directory>
--config <papucs.yml>
--verbose
--no-color
```

Resolution order is explicit `--config`, explicit `--project`, then upward
`papucs.yml` discovery.

## Environment and validation

- `papucs doctor [--json]`: validates Node, Docker, Compose, daemon, project
  files, source manifests, and runtime adapter contract.
- `papucs config validate [--json]`: validates configuration and every server
  source without starting Docker workloads.

## Local lifecycle

- `papucs dev <type> [--no-logs]`: reuses the lowest running development
  instance; otherwise restarts a stopped managed instance or creates one.
- `papucs up <type...>`: plans all ad-hoc numbered instances, resolves
  dependencies, then starts providers before consumers and waits for configured
  readiness.
- `papucs attach <id>`: attaches the terminal to the instance's Docker container
  without requiring its generated container name.
- `papucs start <target...> [--wait-timeout <seconds>] [--json]`: starts
  existing managed containers or infrastructure services and their transitive
  providers, without rebuilding runtime data. The readiness timeout defaults to
  120 seconds.
- `papucs down <id>`: removes one managed container while keeping runtime data.
- `papucs down <type> --all`: removes all instances of one type.
- `papucs restart <id...>`: rematerializes and restarts instances.
- `papucs restartall`: snapshots running project services, stops consumers
  before providers, rematerializes running instances, then starts providers
  before consumers. Services with `x-papucs.restartall: false` are excluded;
  previously stopped workloads remain stopped.
- `papucs rebuild <id>`: rebuilds and starts one instance.
- `papucs stopall [--json]`: stops consumers before providers in the current
  project, then removes project containers. Named volumes and instance data
  remain.
- `papucs stopall --dry-run [--json]`: reads the shutdown plan, blockers and
  lifecycle configuration differences without stopping containers or writing
  files.
- `papucs diagnose [target] [--tail <lines>] [--json]`: reads project container
  state, recent Docker events and bounded log excerpts. Targets accept a managed
  instance ID, its container name, or an infrastructure service name.

Targeted `down`, `restart`, and `rebuild` refuse to stop a provider while its
dependents are running. Stop the dependents first or use `restartall` for a full
restart. Listing a consumer and its provider in one targeted `restart` does not
implicitly turn that operation into a whole-network restart.

Set `x-papucs.restartall: false` on a Compose service to keep it running during
`restartall`, for example a local database or cache. The nested form
`x-papucs: { restartall: false }` is also supported. Omitted flags and `true`
include the service. Current templates are read on every invocation, so existing
instances pick up policy changes without being recreated first. Excluded managed
instances keep their runtime files, sync cache, and saved instance state.

Running excluded providers still satisfy dependencies. A `service_healthy`
provider must already be healthy; Papucs waits for an excluded running
`service_completed_successfully` provider to finish successfully before stopping
any service. If a running excluded consumer depends directly or indirectly on a
service selected for restart, the command fails before stopping anything.
Exclude its providers too, or stop that consumer explicitly first. A stopped
required provider is never started as a side effect. The flag only affects
`restartall`; targeted `restart`, `rebuild`, `up`, and `stopall` retain their
usual behavior. See the
[configuration examples](configuration.md#restartall-exclusions).

Shutdown waits for each dependency layer to exit before stopping its providers.
A failed, OOM-killed, or unexpected container exit stops the operation and
retains runtime state and providers for diagnosis. Exit codes `0` and `143`
(SIGTERM) are accepted; exit `137` is rejected. Compose failures are reported,
not converted into successful cleanup. A clean container exit is a process-level
check; applications remain responsible for completing their own save/drain
before exiting successfully.

### Start existing containers

```bash
papucs start spawn-1
papucs start database spawn-1 --wait-timeout 60 --json
```

`start` uses saved instance state and the generated runtime Compose dependency
graph. It does not apply changed source templates, create containers, regenerate
Compose, copy files, or alter sync caches. Container IDs and runtime data remain
the same. Providers start before consumers; health and successful-completion
conditions are honored. Previously successful one-shot dependencies are reused.
Already-running services remain running. The readiness deadline applies across
all selected dependency layers, rather than resetting for each service.

Every target, required container and managed runtime data directory is checked
before starting anything. A missing container or data directory is an error.
After `stopall` or `down` removes containers, `start` cannot recreate them. Use
`up` for new instances or `rebuild` for a still-managed instance only when
rematerializing runtime data from source is intended. After a startup failure,
already-started providers remain running; Papucs does not roll them back.

### Preview shutdown

```bash
papucs stopall --dry-run
papucs stopall --dry-run --json
```

The plan uses the same conservative union of saved and current dependency edges
as real shutdown. It lists reverse dependency layers, prior unsafe exits,
missing runtime information, and cleanup scope. For each service it compares
current source settings, generated Compose settings, and the actual container's
stop timeout, stop signal, init, restart policy and healthcheck state.
Dependency changes are compared between source and generated Compose; Docker
inspection does not establish actual dependency edges.

Inherited image settings and unspecified daemon stop timeouts remain
unknown/inherited; the report never invents their effective values. An explicit
generated setting missing from Docker configuration is a configuration
difference, even when the effective fallback is unknown. Differences are
advisory; they are not applied by the preview. The report is a point-in-time
read without a mutation lock. Exit code `1` and JSON `ok: false` mean the plan
has blockers. A clear plan cannot guarantee that a future application shutdown
will succeed.

### Diagnose a shutdown

```bash
papucs diagnose spawn-1 --json
papucs diagnose database --tail 0
```

The report includes exit/OOM state, configured Docker stop settings, restart
policy, recent stop/start signals and exit events, and observed signal-to-exit
or signal-to-kill timing when the events are available. Unspecified daemon
timeouts remain unknown. Docker only retains limited event history; missing
events are not proof that a signal was never sent.

By default the report looks back one hour and includes up to 20 log lines per
container. `--tail` accepts 0 through 100. Reads have time and output limits;
unavailable or truncated evidence is reported as a warning. Rejected stop exits,
previous unsafe stops, missing stop targets and Compose stop failures trigger
automatic diagnostics when available. Failure to collect them never replaces the
original error or makes cleanup successful. JSON stop errors expose the report
at `error.diagnostics` when available. One-shot completion still requires exit
`0`, which is stricter than the ordinary stop check.

Reports omit container environments and commands. Logs are sanitized and known
credential values are redacted from project/server environment files and saved
runtime configuration, with additional credential-pattern masking. Redaction is
best effort: review reports before sharing. Unlabelled short or numeric values
cannot reliably be identified as secrets; use `--tail 0` to omit logs.

## Source synchronization

- `papucs sync <type> [--dry-run] [--json]`: copies changed files and removes
  deleted files from running instances, excluding preserved paths.
- `papucs pull <id> <path|dir/*> <layer> [--dry-run] [--force]`: copies runtime
  content back into a source layer. Existing files require `--force`.
- `papucs status [type] [--json]`: reports running, runtime, last-sync, and
  pending-change state.

## Image build

- `papucs build <type...>`: build selected server images.
- `papucs build --actions`: select definitions with `actions_build: true`.
- `--push`: push every configured tag.
- `--dry-run`: resolve images and tags without Docker changes.
- `--json`: emit stable machine output.

The command builds and optionally pushes OCI images. It does not deploy them.

## Generators

`papucs workflow add ghcr-build [--dry-run] [--force]` creates
`.github/workflows/papucs-build.yml`. Existing changed files are never
overwritten without `--force`.
