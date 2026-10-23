# Troubleshooting

## No `papucs.yml` found

Run inside a project directory, pass `--project <directory>`, or pass
`--config <file>`.

## Docker daemon unavailable

- Windows/macOS: start Docker Desktop.
- Windows: verify the WSL2 backend is enabled.
- Linux: start Docker Engine and verify access to the Docker socket.

Run:

```bash
npx papucs doctor
```

## Project is locked

Another mutating Papucs command is running. The error identifies its PID,
command, and start time. Papucs reclaims dead or older-than-30-minute locks
automatically. Remove `.runtime/lock` manually only after confirming the owner
process no longer exists.

## Unresolved placeholder at container startup

Add the required value to `.env`, server `.env`, `interpolate_variables`, or the
container environment. Only extensions listed in `replaceable_text_extensions`
are scanned.

## Image cannot execute the runtime adapter

The bundled adapter requires Linux `sh`, `find`, `grep`, and `perl`. Use the
default tested base image or provide a compatible server-specific
`Dockerfile.template`.

For a different startup implementation, set the server's `build.runtime_script`
to an existing project-relative file and configure its entrypoint in the
Dockerfile. The selected file still appears as `papucs-runtime-replace.sh` in
the build context. `doctor` validates custom script paths but does not check
their interpreter or runtime dependencies; verify those in the image.

## Port conflict

Set a different top-level `papucs_port_base` in the server YAML file, using
separate port ranges for different server types. To change only one instance,
set `PAPUCS_PORT_<index>` in `.env` or server `interpolate_variables`, for
example `PAPUCS_PORT_2=26000`. The top-level base is still required.

Papucs does not automatically skip occupied ports. Old `PAPUCS_PORT_BASE`,
`PORT_BASE`, and `<SERVER_TYPE>_PORT_BASE` environment variables no longer
configure the base port.

## Failed or unproven shutdown

```bash
papucs diagnose spawn-1
papucs stopall --dry-run
```

Check the actual exit/OOM state, observed signals, configured stop timeout and
log excerpt. Exit `137` can follow a forced kill; exit `255` is not proof of a
successful application save. The preview shows which providers must remain
running and whether source settings differ from the generated Compose or actual
container. Increasing a timeout in a source file does not itself update an
existing container's configuration.

After fixing the cause, an existing stopped container can be recovered with
`papucs start spawn-1`; infrastructure service names such as `database` are also
accepted. This starts existing providers first and retains runtime data. It does
not apply source changes or recreate missing containers. Once the application is
ready, retry `stopall`. See [lifecycle commands](cli.md#local-lifecycle) for
readiness, diagnostic limitations and source-rematerialization behavior.
