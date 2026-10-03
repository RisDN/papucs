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

`--skip-build` keeps a layer and its nested layers in local runtimes but removes
that reference's entire subtree from image build contexts.

### Runtime dependencies

An optional `depends_on` list declares providers needed by a managed workload:

```yaml
depends_on:
  - service: database
    condition: service_healthy
  - server: gateway
    condition: service_healthy
```

Each entry has exactly one target:

- `service`: an exact service key from the root or server Compose templates.
- `server`: a server type with exactly one existing or planned managed instance.
- `instance`: an exact managed instance ID, such as `gateway-2`.

`condition` defaults to `service_started`. `service_healthy` and
`service_completed_successfully` have the standard Compose meanings. A healthy
provider must define a healthcheck. Papucs merges declarations with the
service's existing Compose `depends_on`; incompatible duplicate definitions are
rejected.

Dependencies resolve to generated Compose service keys, not container names.
Missing providers, ambiguous server selections, self-dependencies, and cycles
fail before workloads are stopped or started. Provider instances are not created
implicitly: include their server types in the same `up` command, or create them
first. The full `up` batch is planned before startup, so argument order does not
determine dependency order.

The resulting graph controls startup and shutdown. Providers start first and
consumers stop first. Independent services within a graph layer may run
together. Papucs does not infer dependencies from server names, plugins, or game
modes.

## Layer definition

Each layer requires `_layer.yml` with a `name` matching its directory name. An
optional `layers` list includes other reusable layers using the same syntax as a
server definition. For example, `layers/network/_layer.yml`:

```yaml
name: network
layers:
  - base
  - shared-plugins
  - local-tools --skip-build
```

A server can then select the bundle:

```yaml
layers:
  - network
  - spawn-overrides
```

Layer names resolve under the configured `sources.layers` directory, including
references declared inside another layer. In this example, `base` resolves to
`layers/base`, not `layers/network/base`.

Papucs recursively applies listed layers in order, then the containing layer's
own files. Here, `base`, `shared-plugins`, and `local-tools` are applied before
`network`, followed by `spawn-overrides`. Each of those layers may include
further layers, which are applied before its own files. Later files override
earlier files, and the server's `data` directory is applied last. `_layer.yml`
is metadata and is not copied into runtime or build data.

Repeated or shared references are applied at every occurrence; they are not
deduplicated. `--skip-build` affects only the flagged reference and its subtree
during image builds. An unflagged reference to the same layer elsewhere still
includes it. Local runtimes and synchronization include flagged layers.

Validation rejects missing `_layer.yml`, mismatched names, invalid `layers`
lists, and circular references, reporting the cycle's layer chain.

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
- `PAPUCS_HOST_UID`
- `PAPUCS_HOST_GID`

Add `x-papucs: { inject_environment: true }` to the primary service to inject
the merged environment. Explicit Compose environment values win.

On Linux, `PAPUCS_HOST_UID` and `PAPUCS_HOST_GID` default to the current host
user and group. Other platforms default to `1000`. Set either value in `.env`
when a rootless or remote Docker daemon requires a different mapping.

## Environment precedence

1. project `.env`
2. `servers/<type>/.env`
3. server `interpolate_variables`
4. reserved Papucs instance values

`.env` is local and should remain gitignored. `.env.example` is versioned.
