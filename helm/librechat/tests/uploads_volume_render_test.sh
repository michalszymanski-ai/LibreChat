#!/usr/bin/env bash
# Render test for librechat.uploadsVolume.
#
# /app/uploads holds files stored with `fileStrategy: local` and the temp directory
# every upload passes through. Left on the container filesystem it is wiped whenever
# the pod is replaced, while the file records survive in MongoDB and point at nothing.
#
# Asserts the volume is off by default (chart behavior unchanged), and that enabling
# it renders a PVC and mounts that claim at /app/uploads, alongside imageVolume or
# without it.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHART_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
VALUES_FILE="$(mktemp -t librechat-uploads-values.XXXXXX)"
RENDERED_FILE="$(mktemp -t librechat-uploads-render.XXXXXX)"
trap 'rm -f "${VALUES_FILE}" "${RENDERED_FILE}"' EXIT

cat > "${VALUES_FILE}" <<'YAML'
librechat:
  configEnv: {}
YAML

if ! command -v helm >/dev/null 2>&1; then
  echo "FAIL: helm not on PATH" >&2
  exit 1
fi

render() {
  helm template librechat "${CHART_DIR}" \
    --show-only templates/persistentvolumeclaim.yaml \
    --show-only templates/deployment.yaml \
    -f "${VALUES_FILE}" "$@" > "${RENDERED_FILE}" 2>/dev/null
}

fail() {
  echo "FAIL: $1" >&2
  cat "${RENDERED_FILE}" >&2
  exit 1
}

render
if grep -q 'librechat-librechat-uploads' "${RENDERED_FILE}"; then
  fail "uploadsVolume rendered while disabled by default"
fi
if grep -q 'mountPath: "/app/uploads"' "${RENDERED_FILE}"; then
  fail "/app/uploads mounted while uploadsVolume is disabled"
fi

for images in true false; do
  render --set librechat.uploadsVolume.enabled=true \
    --set librechat.uploadsVolume.size=7Gi \
    --set librechat.uploadsVolume.storageClassName=managed-csi \
    --set "librechat.imageVolume.enabled=${images}"

  grep -q 'name: librechat-librechat-uploads$' "${RENDERED_FILE}" \
    || fail "no uploads PVC rendered (imageVolume.enabled=${images})"
  grep -q 'storage: 7Gi' "${RENDERED_FILE}" \
    || fail "uploads PVC ignores uploadsVolume.size (imageVolume.enabled=${images})"
  grep -q 'storageClassName: managed-csi' "${RENDERED_FILE}" \
    || fail "uploads PVC ignores uploadsVolume.storageClassName (imageVolume.enabled=${images})"
  grep -A1 -- '- name: uploads-volume' "${RENDERED_FILE}" | grep -q 'mountPath: "/app/uploads"' \
    || fail "uploads-volume not mounted at /app/uploads (imageVolume.enabled=${images})"
  grep -q 'claimName: librechat-librechat-uploads$' "${RENDERED_FILE}" \
    || fail "deployment does not reference the uploads claim (imageVolume.enabled=${images})"
done

echo "PASS: uploadsVolume renders and mounts /app/uploads only when enabled"
