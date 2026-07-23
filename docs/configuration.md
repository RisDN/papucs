# Configuration

## `papucs.yml`

`version` must be `1`. All configured paths are relative to the directory
containing `papucs.yml` and may not escape that directory.

| Field                            | Meaning                                                    |
| -------------------------------- | ---------------------------------------------------------- |
| `project`                        | Filesystem-safe project name and Compose project prefix    |
| `runtime.dir`                    | Generated local runtime directory                          |
| `sources.layers`                 | Reusable source layer directory                            |
| `sources.servers`                | Server type directory                                      |
| `compose.file`                   | User-owned infrastructure Compose file                     |
| `compose.shared_server_template` | Default workload Compose template                          |
| `build.dockerfile_template`      | Default Dockerfile template                                |
| `build.image`                    | Output image repository template                           |
| `build.tags`                     | One or more output tag templates                           |
| `preserve_paths`                 | Runtime paths preserved during rebuild and ignored by sync |
| `replaceable_text_extensions`    | Files eligible for `${ENV_KEY}` replacement                |

Canonical YAML fields use `snake_case`.

## Server definition

`servers/spawn/spawn.yml`:

```yaml
name: spawn
image: itzg/minecraft-server:stable-java24-graalvm
compose_service: minecraft
instance_name: "%project%-%server_type%-%index%"
actions_build: true

build:
  image: "ghcr.io/example/special-%server_type%"
  tags: ["%ref%", "%sha%"]

interpolate_variables:
  PAPUCS_PORT_BASE: 25565

layers:
  - base
  - local-tools --skip-build
```

Required fields:

- `name`
- `image`
- `compose_service`
- `instance_name`, containing exactly one `%index%`

`--skip-build` keeps a layer in local runtimes but removes it from image build
contexts.

## Placeholders

Instance names can use `%project%`, `%server_type%`, `%index%`, and scalar
top-level server fields.

Build image and tag templates also receive:

- `%ref%`
- `%sha%`
- `%github_owner%`

`%ref%` is normalized to a Docker-tag-safe value when used by the image build
pipeline. For example, `feature/network` becomes `feature-network`.

- `%build_from%`

`%github_owner%` reads `GITHUB_REPOSITORY_OWNER` or `GHCR_OWNER`.

Compose templates receive reserved `${PAPUCS_*}` values:

- `PAPUCS_INSTANCE_ID`
- `PAPUCS_INSTANCE_NAME`
- `PAPUCS_INSTANCE_INDEX`
- `PAPUCS_SERVER_TYPE`
- `PAPUCS_DATA_PATH`
- `PAPUCS_PORT`, when a port mapping can be resolved

Add `x-papucs: { inject_environment: true }` to the primary service to inject
the merged environment. Explicit Compose environment values win.

## Environment precedence

1. project `.env`
2. `servers/<type>/.env`
3. server `interpolate_variables`
4. reserved Papucs instance values

`.env` is local and should remain gitignored. `.env.example` is versioned.
