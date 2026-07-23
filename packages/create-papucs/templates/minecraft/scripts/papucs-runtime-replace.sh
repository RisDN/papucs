#!/bin/sh
set -eu

EXTENSIONS_FILE="/etc/papucs/replaceable_extensions.txt"
INTERPOLATE_ENV_FILE="/etc/papucs/interpolate_variables.env"
PLACEHOLDER_REGEX='\$\{[A-Za-z_][A-Za-z0-9_]*\}'

if [ ! -f "$EXTENSIONS_FILE" ]; then
  echo "[papucs] Missing extensions file: $EXTENSIONS_FILE"
  exit 1
fi

if [ -f "$INTERPOLATE_ENV_FILE" ]; then
  set -a
  . "$INTERPOLATE_ENV_FILE"
  set +a
fi

matches_extension() {
  file="$1"
  while IFS= read -r ext || [ -n "$ext" ]; do
    [ -z "$ext" ] && continue
    case "$file" in
      *"$ext") return 0 ;;
    esac
  done < "$EXTENSIONS_FILE"
  return 1
}

unresolved_marker="/tmp/papucs-unresolved.$$"
rm -f "$unresolved_marker"
find /data -type f | while IFS= read -r file; do
  if ! matches_extension "$file"; then
    continue
  fi
  if grep -Eq "$PLACEHOLDER_REGEX" "$file"; then
    tmp_file="${file}.papucs-tmp"
    perl -pe 's/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/exists $ENV{$1} ? $ENV{$1} : $&/ge' "$file" > "$tmp_file"
    mv "$tmp_file" "$file"
  fi
  if grep -Eq "$PLACEHOLDER_REGEX" "$file"; then
    echo "[papucs] Unresolved placeholder(s) in: $file"
    : > "$unresolved_marker"
  fi
done

if [ -f "$unresolved_marker" ]; then
  rm -f "$unresolved_marker"
  echo "[papucs] Startup failed: unresolved placeholders remain."
  exit 1
fi

exec "$@"
