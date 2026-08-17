#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "Usage: $0 NEW_APK [PREVIOUS_APK]" >&2
  exit 2
fi

new_apk=$1
previous_apk=${2:-}
command -v apksigner >/dev/null || { echo "apksigner is required" >&2; exit 2; }
[[ -s "$new_apk" ]] || { echo "APK does not exist: $new_apk" >&2; exit 2; }

apksigner verify --verbose --print-certs "$new_apk"
new_digest=$(apksigner verify --print-certs "$new_apk" 2>/dev/null \
  | sed -n 's/^Signer #1 certificate SHA-256 digest: //p' | head -n1)
[[ -n "$new_digest" ]] || { echo "Could not read signer digest" >&2; exit 1; }
echo "New signer SHA-256: $new_digest"

if [[ -n "$previous_apk" ]]; then
  [[ -s "$previous_apk" ]] || { echo "Previous APK does not exist: $previous_apk" >&2; exit 2; }
  apksigner verify --verbose "$previous_apk"
  previous_digest=$(apksigner verify --print-certs "$previous_apk" 2>/dev/null \
    | sed -n 's/^Signer #1 certificate SHA-256 digest: //p' | head -n1)
  if [[ "$new_digest" != "$previous_digest" ]]; then
    echo "ERROR: APK signing certificate changed" >&2
    echo "Previous: $previous_digest" >&2
    echo "New:      $new_digest" >&2
    exit 1
  fi
  echo "Signer continuity: OK"
fi

sha256sum "$new_apk"
