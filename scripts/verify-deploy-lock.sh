#!/usr/bin/env bash
# Independent fixture only: never opens the real deployment lock or runs deploy.sh.
set -euo pipefail
command -v flock >/dev/null
fixture_dir="$(mktemp -d)"
cleanup() {
  rm -f "$fixture_dir/events" "$fixture_dir/ready" "$fixture_dir/lock"
  rmdir "$fixture_dir"
}
trap cleanup EXIT
export fixture_dir

flock --wait 2 --close "$fixture_dir/lock" bash -c '
  echo first-start >> "$fixture_dir/events"
  touch "$fixture_dir/ready"
  sleep 0.2
  echo first-end >> "$fixture_dir/events"
' &
first_pid=$!
for attempt in $(seq 1 200); do
  if [ -f "$fixture_dir/ready" ]; then break; fi
  sleep 0.01
done
test -f "$fixture_dir/ready"
flock --wait 2 --close "$fixture_dir/lock" bash -c '
  echo second-start >> "$fixture_dir/events"
  echo second-end >> "$fixture_dir/events"
' &
second_pid=$!
wait "$first_pid"
wait "$second_pid"
expected=$'first-start\nfirst-end\nsecond-start\nsecond-end'
test "$(cat "$fixture_dir/events")" = "$expected"

# Detached descendants must not retain the lock after their launcher exits.
flock --wait 2 --close "$fixture_dir/lock" bash -c '(sleep 1 >/dev/null 2>&1) &'
flock --nonblock "$fixture_dir/lock" true
echo 'PASS: overlapping deployment commands serialize; detached children do not retain the lock.'
