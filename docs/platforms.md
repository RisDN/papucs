# Platform support

| Platform                                      | Support                        |
| --------------------------------------------- | ------------------------------ |
| Windows 11 with Docker Desktop WSL2           | Local development              |
| macOS Intel/Apple Silicon with Docker Desktop | Local development              |
| Linux x64/arm64 with Docker Engine/Desktop    | Local development and CI build |

Papucs uses Node filesystem APIs and starts child processes with `shell: false`.
Host-side Bash and PowerShell scripts are not part of core behavior.

Docker Compose paths are emitted in POSIX form; host filesystem paths remain
native.

Windows containers are not supported. The bundled Minecraft template builds a
Linux container image.
