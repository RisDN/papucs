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
- `papucs up <type...>`: creates ad-hoc numbered instances.
- `papucs attach <id>`: attaches the terminal to the instance's Docker container
  without requiring its generated container name.
- `papucs down <id>`: removes one managed container while keeping runtime data.
- `papucs down <type> --all`: removes all instances of one type.
- `papucs restart <id...>`: rematerializes and restarts instances.
- `papucs restartall`: restarts running project infrastructure and
  rematerializes running instances without service-name hardcoding.
- `papucs rebuild <id>`: rebuilds and starts one instance.
- `papucs stopall`: stops only the current Papucs Compose project.

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
