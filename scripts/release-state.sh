#!/bin/sh

set -eu

write_output() {
  if [ -z "${GITHUB_OUTPUT:-}" ]; then
    echo "Release state output is unavailable." >&2
    exit 1
  fi
  printf '%s\n' "$1" >> "$GITHUB_OUTPUT"
}

resolve_npm() {
  package_name="$1"
  package_version="$2"
  set +e
  result="$(npm view "$package_name@$package_version" version --json 2>&1)"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    write_output "publish=false"
    return
  fi
  if printf '%s' "$result" | grep -q 'E404'; then
    write_output "publish=true"
    return
  fi
  echo "Unable to determine npm publication state." >&2
  exit 1
}

inspect_digest() {
  reference="$1"
  set +e
  result="$(docker buildx imagetools inspect "$reference" --format '{{.Manifest.Digest}}' 2>&1)"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    case "$result" in
      sha256:*) printf '%s' "$result"; return ;;
      *) echo "GHCR returned an invalid image digest." >&2; exit 1 ;;
    esac
  fi
  if printf '%s' "$result" | grep -Eqi 'not found|manifest unknown'; then
    printf 'missing'
    return
  fi
  echo "Unable to determine GHCR publication state." >&2
  exit 1
}

resolve_image() {
  image="$1"
  version="$2"
  sha_tag="$3"
  version_digest="$(inspect_digest "$image:$version")"
  sha_digest="$(inspect_digest "$image:$sha_tag")"

  if [ "$version_digest" != "missing" ] && [ "$sha_digest" != "missing" ]; then
    if [ "$version_digest" != "$sha_digest" ]; then
      echo "Existing GHCR release tags resolve to different digests." >&2
      exit 1
    fi
    write_output "build=false"
    write_output "repair=false"
    write_output "digest=$version_digest"
    return
  fi

  if [ "$version_digest" != "missing" ] || [ "$sha_digest" != "missing" ]; then
    if [ "$version_digest" != "missing" ]; then
      digest="$version_digest"
      missing_tag="$image:$sha_tag"
    else
      digest="$sha_digest"
      missing_tag="$image:$version"
    fi
    write_output "build=false"
    write_output "repair=true"
    write_output "digest=$digest"
    write_output "missing_tag=$missing_tag"
    return
  fi

  write_output "build=true"
  write_output "repair=false"
}

publish_release() {
  tag="$1"
  notes_file="$2"
  set +e
  result="$(gh release view "$tag" 2>&1)"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    gh release edit "$tag" --title "$tag" --notes-file "$notes_file"
    return
  fi
  if printf '%s' "$result" | grep -Eqi 'release not found'; then
    gh release create "$tag" --title "$tag" --notes-file "$notes_file"
    return
  fi
  echo "Unable to determine GitHub Release publication state." >&2
  exit 1
}

case "${1:-}" in
  npm)
    [ "$#" -eq 3 ] || { echo "Usage: release-state.sh npm package version" >&2; exit 2; }
    resolve_npm "$2" "$3"
    ;;
  image)
    [ "$#" -eq 4 ] || { echo "Usage: release-state.sh image image version sha" >&2; exit 2; }
    resolve_image "$2" "$3" "$4"
    ;;
  release)
    [ "$#" -eq 3 ] || { echo "Usage: release-state.sh release tag notes-file" >&2; exit 2; }
    publish_release "$2" "$3"
    ;;
  *)
    echo "Unknown release-state command." >&2
    exit 2
    ;;
esac
