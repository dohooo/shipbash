#!/usr/bin/env bash
# Runs one heavy command while holding the machine-wide lock, and exits with
# that command's own status.
#
# Several processes can share one machine, and a `build:web` saturates it. So every
# web build takes the same lock the pre-push gate takes.
#
# Re-entrant on purpose: `bun run gate:prepush` already holds the lock while it
# runs build:web underneath, so a nested call must not wait for a lock its own
# process tree is holding.
#
# The lock must cover the whole heavy stretch, not each half of it. A paired
# before/after measurement that takes the lock twice leaves the machine open
# in between: wrap the whole measuring script in one heavy-lock instead.
set -euo pipefail

LOCK=/tmp/shipbash-staging-push.lock
WAIT_SECONDS=20
MAX_WAIT_SECONDS=900
STALE_SECONDS=1200

if [ "$#" -eq 0 ]; then
  echo "usage: heavy-lock.sh <command> [args...]" >&2
  exit 2
fi

if [ -n "${SHIPBASH_HEAVY_LOCK_HELD:-}" ]; then
  exec "$@"
fi

# Taking over a lock is the one operation that can hand the machine to two
# runs at once, so it needs all three of: an owner file to read, a dead pid,
# and twenty minutes of age. A missing owner file means the holder has taken
# the directory but has not written itself yet — a window of microseconds,
# during which the old rule ("no owner, so it must be junk") would have
# deleted a live lock. Wait it out instead.
stale_enough() {
  local owner_file="$LOCK/owner" pid stamp age
  [ -f "$owner_file" ] || return 1
  stamp=$(stat -f %m "$owner_file" 2>/dev/null || echo 0)
  age=$(( $(date +%s) - stamp ))
  [ "$age" -gt "$STALE_SECONDS" ] || return 1
  pid=$(sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' "$owner_file")
  [ -n "$pid" ] || return 0
  kill -0 "$pid" 2>/dev/null && return 1
  return 0
}

waited=0
while ! mkdir "$LOCK" 2>/dev/null; do
  owner=$(cat "$LOCK/owner" 2>/dev/null || echo "not yet written")
  if stale_enough; then
    echo "heavy-lock clearing a stale lock (owner: ${owner}, its process is gone)"
    rm -rf "$LOCK"
    continue
  fi
  if [ "$waited" -ge "$MAX_WAIT_SECONDS" ]; then
    echo "heavy-lock gave up waiting after ${waited}s (owner: ${owner})" >&2
    exit 1
  fi
  echo "heavy-lock waiting (owner: ${owner})"
  sleep "$WAIT_SECONDS"
  waited=$(( waited + WAIT_SECONDS ))
done
# Own it before anything else can run: the trap first, so a failure between
# here and the owner file still releases the directory, then the owner file
# itself, because a lock nobody can identify is a lock nobody can time out.
trap 'rm -rf "$LOCK"' EXIT
echo "${SHIPBASH_HEAVY_LOCK_LABEL:-heavy}:$(git config user.name || echo unknown) $(date -u +%FT%TZ) pid=$$" > "$LOCK/owner"
printf '\n=== heavy-lock held by %s ===\n' "$(cat "$LOCK/owner")"

# The command decides the exit status; `set -e` must not swallow a failure
# before the trap releases the lock.
status=0
SHIPBASH_HEAVY_LOCK_HELD=1 "$@" || status=$?
exit "$status"
