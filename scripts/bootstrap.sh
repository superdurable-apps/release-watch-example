#!/usr/bin/env bash
# make bootstrap: restore the npm dependencies package-lock.json pins. One run
# at a time holds .local/bootstrap.lock where flock exists, so a run that
# starts while another restores waits for it and then finds nothing left to
# do; the other make targets wait for a run in progress the same way.
set -euo pipefail

root_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "${root_directory}"
mkdir -p .local
if command -v flock >/dev/null; then
  exec 9>>.local/bootstrap.lock
  flock 9
fi

# fingerprint prints one SHA-256 over the names and contents of the files.
fingerprint() {
  python3 -c 'import hashlib, sys
digest = hashlib.sha256()
for name in sys.argv[1:]:
    with open(name, "rb") as source:
        digest.update(name.encode() + b"\0" + source.read() + b"\0")
print(digest.hexdigest())' "$@"
}

# node_modules lives in the workspace, so it is restored again only when the
# lockfile changed or the installation is missing.
stamp=".local/bootstrap.sha256"
lock="$(fingerprint package.json package-lock.json)"
if [[ -f node_modules/.package-lock.json && -f "${stamp}" && "$(cat "${stamp}")" == "${lock}" ]]; then
  echo "bootstrap: node_modules already matches package-lock.json"
  exit 0
fi
# --ignore-scripts: no dependency's install script runs.
npm ci --prefer-offline --ignore-scripts
printf '%s\n' "${lock}" > "${stamp}"
echo "bootstrap: restored node_modules"
