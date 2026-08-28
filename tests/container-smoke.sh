#!/bin/sh
set -eu

image="${1:?usage: tests/container-smoke.sh IMAGE}"
root_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
container_id=""

cleanup() {
  if [ -n "$container_id" ]; then
    docker rm -f "$container_id" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

test "$(docker image inspect --format '{{.Config.User}}' "$image")" = "10001:10001"

container_id=$(docker run --detach --read-only --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --publish 127.0.0.1::3000 \
  --volume "$root_dir/mcp.config.example.yaml:/config/mcp.config.yaml:ro" \
  "$image")

port=$(docker port "$container_id" 3000/tcp | sed -n '1s/.*://p')
attempt=0
until curl --fail --silent "http://127.0.0.1:$port/healthz" >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -eq 20 ]; then
    docker logs "$container_id"
    exit 1
  fi
  sleep 1
done

curl --fail --silent --show-error "http://127.0.0.1:$port/readyz" >/dev/null
