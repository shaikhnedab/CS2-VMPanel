#!/bin/sh
# Runs as root (no USER directive): prepare bind-mounted files, then drop to vmp.
# Docker creates a missing host file as a root-owned DIRECTORY on first mount,
# which the app can neither replace (EBUSY) nor write (EACCES). Touching +
# chowning here fixes ownership on the host file once, at every start.
set -eu
for f in /app/.env /app/app/config/config.json /app/VMPanel.log; do
  if [ -d "$f" ]; then
    echo "WARNING: $f is a directory. The bind mount needs a FILE on the host" >&2
    echo "WARNING: create it first, e.g.: cp app/config/example_config.json config.json" >&2
  else
    touch "$f" 2>/dev/null || true
    chown vmp:vmp "$f" 2>/dev/null || true
  fi
done
exec su-exec vmp "$@"
