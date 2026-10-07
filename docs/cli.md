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
- `papucs down <id>`: removes one managed container while keeping runtime data.
- `papucs down <type> --all`: removes all instances of one type.
- `papucs restart <id...>`: rematerializes and restarts instances.
- `papucs restartall`: snapshots running project services, stops consumers
  before providers, rematerializes running instances, then starts providers
  before consumers. Services with `x-papucs.restartall: false` are excluded;
  previously stopped workloads remain stopped.
- `papucs rebuild <id>`: rebuilds and starts one instance.
- `papucs stopall`: stops consumers before providers in the current project,
  then removes project containers. Named volumes and instance data remain.

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
