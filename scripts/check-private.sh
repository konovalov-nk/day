#!/usr/bin/env bash
set -euo pipefail

tracked="$(git ls-files)"
failed=0
while IFS= read -r path; do
  [ -z "$path" ] && continue
  case "$path" in
    data/*|.env|*.sqlite|*.sqlite-wal|*.sqlite-shm|*.log)
      echo "private runtime file is tracked: $path" >&2
      failed=1
      ;;
  esac
done <<< "$tracked"

if [ "$failed" -ne 0 ]; then
  exit 1
fi
echo "repository check: no private runtime files are tracked"
