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

## Port conflict

Set `PAPUCS_PORT_BASE` or `PAPUCS_PORT_<index>` in `.env` or server
`interpolate_variables`.
