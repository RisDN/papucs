# Papucs

Papucs is a local-first Minecraft server development and OCI image build CLI. It
turns versioned layers and server definitions into disposable local Docker
Compose runtimes, supports incremental synchronization, and builds images for
handoff to any runtime platform.

Papucs is not a production control plane. It does not deploy, roll back,
monitor, back up, or operate production servers.

## Requirements

- Node.js 22 or newer
- Docker with the `docker compose` plugin
- Git is optional, but recommended for deterministic image tags
- The bundled Minecraft build adapter expects a Linux image containing `sh`,
  `find`, `grep`, and `perl`

Bun is not required.

## Quick start

```bash
npm create papucs@latest my-network -- --accept-eula
cd my-network
npx papucs doctor
npx papucs dev spawn
```

`--accept-eula` explicitly accepts the
[Minecraft EULA](https://aka.ms/MinecraftEULA). Without it, the initializer
creates only `.env.example`; review the EULA before creating `.env`.

Install into an existing project:

```bash
npm install --save-dev papucs
npx papucs config validate
```

## Project model

Every project has a `papucs.yml`:

```yaml
version: 1
project: my-network

runtime:
  dir: .runtime

sources:
  layers: layers
  servers: servers

compose:
  file: docker-compose.yml
  shared_server_template: servers/_template/minecraft-server-base.yml

build:
  dockerfile_template: Dockerfile.template
  image: "ghcr.io/example/mc-%server_type%"
  tags: ["%ref%", "%sha%"]

preserve_paths: [libraries, libs]
replaceable_text_extensions: [.yml, .yaml, .json, .properties]
```

- `layers/<name>` contains reusable files and mandatory `_layer.yml`.
- `servers/<type>/<type>.yml` selects layers, container image, Compose service,
  naming, and build behavior.
- `servers/<type>/data` overrides layer files.
- `.runtime` contains generated local state and must not be edited or committed.
- The source `docker-compose.yml` remains user-owned.

## Main commands

```text
papucs doctor
papucs config validate
papucs dev <server_type>
papucs up <server_type...>
papucs attach <instance_id>
papucs down <instance_id>
papucs down <server_type> --all
papucs restart <instance_id...>
papucs restartall
papucs rebuild <instance_id>
papucs pull <instance_id> <runtime_path|dir/*> <layer>
papucs sync <server_type> [--dry-run]
papucs status [server_type] [--json]
papucs stopall
papucs build <server_type...>
papucs build --actions [--push] [--json]
papucs workflow add ghcr-build [--dry-run]
```

`stopall` is project-scoped. It never enumerates or stops unrelated Docker
Compose projects.

## Automation contract

Commands supporting `--json` write only a versioned JSON envelope to stdout:

```json
{
  "schemaVersion": 1,
  "ok": true,
  "command": "status",
  "data": {},
  "warnings": []
}
```

Exit codes:

- `0`: success
- `1`: project validation or runtime failure
- `2`: invalid CLI usage

## Documentation

- [Configuration](docs/configuration.md)
- [CLI reference](docs/cli.md)
- [GitHub Actions and GHCR](docs/github-actions.md)
- [Platform support](docs/platforms.md)
- [Troubleshooting](docs/troubleshooting.md)

## Packages

- [`papucs`](packages/cli): CLI
- [`create-papucs`](packages/create-papucs): project initializer

## License

MIT
