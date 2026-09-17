#!/bin/sh
# Runs as root (no USER directive): prepare bind-mounted files, then drop to vmp.
# Docker creates a missing host `./.env` as root:root on first mount, which the
# unprivileged app user can neither rename over (EBUSY) nor write (EACCES).
# Touching + chowning here fixes ownership on the host file once, at every start.
set -eu
for f in /app/.env /app/VMPanel.log; do
  touch "$f" 2>/dev/null || true
  chown vmp:vmp "$f" 2>/dev/null || true
done
exec su-exec vmp "$@"
