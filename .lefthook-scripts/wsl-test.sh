#!/usr/bin/env bash
# Run the test suite on Linux via WSL Ubuntu to catch platform-specific failures. The pushed commit is exported with git archive into a Linux-side work dir, so the Windows node_modules (Windows native binaries) is never used and uncommitted files never leak in. Node comes from a login-shell install when it is new enough, else from a checksum-verified official tarball cached per user. Skips (exit 0, one line) when WSL, Ubuntu, or the Node download is unavailable; a failing test run fails the push.
set -euo pipefail

# Pinned in one place: the Node release used when the login shell has none new enough. CI runs Node 22 (setup-node '22'); package.json engines wants >=22.16.0.
NODE_VERSION="22.23.3"
NODE_MAJOR_MIN=22
# Override for tests of the download-failure path.
NODE_MIRROR="${PREPUSH_NODE_MIRROR:-https://nodejs.org/dist}"
DISTRO="${PREPUSH_WSL_DISTRO:-Ubuntu}"

SKIP_STATUS=75

skip() {
    echo "wsl-test: $1, skipping"
    exit 0
}

command -v wsl.exe &>/dev/null || skip "WSL not available"
# wsl.exe writes its own messages as UTF-16, so only its exit status is trusted.
wsl.exe -d "$DISTRO" -- true &>/dev/null || skip "WSL distro $DISTRO not available"

TMPD="$(mktemp -d "${TMPDIR:-/tmp}/token-goat-wsl-test.XXXXXX")"

# Export exactly the committed tree being pushed.
git archive --format=tar -o "$(cygpath -m "$TMPD")/src.tar" HEAD
# History for the guards that read it (commit messages), as a bundle of the same commit.
git bundle create "$(cygpath -m "$TMPD")/history.bundle" HEAD &>/dev/null
# The confidential-name guard needs its machine-local denylist, which WSL's home does not have.
names="${TOKEN_GOAT_CONFIDENTIAL_NAMES:-$HOME/.token-goat/confidential-names.txt}"
if [[ -f "$names" ]]; then
    cp -- "$names" "$TMPD/confidential-names.txt"
fi

# Convert a Windows-style path (C:/...) to its WSL mount form.
to_wsl_path() {
    local p
    p="$(cygpath -m "$1")"
    echo "/mnt/${p:0:1}${p:2}" | sed 's|^/mnt/\(.\)|/mnt/\L\1|'
}

# The Linux-side half. Positional values arrive as a generated header so nothing needs quoting through wsl.exe.
{
    printf 'TAR=%q\nBUNDLE=%q\nNAMES=%q\nNODE_VERSION=%q\nNODE_MAJOR_MIN=%q\nNODE_MIRROR=%q\nSKIP_STATUS=%q\n' \
        "$(to_wsl_path "$TMPD/src.tar")" "$(to_wsl_path "$TMPD/history.bundle")" "$(to_wsl_path "$TMPD/confidential-names.txt")" "$NODE_VERSION" "$NODE_MAJOR_MIN" "$NODE_MIRROR" "$SKIP_STATUS"
    cat <<'INNER'
set -euo pipefail

skip() {
    echo "wsl-test: $1, skipping"
    rm -rf -- "${dl:-/nonexistent-download-dir}"
    exit "$SKIP_STATUS"
}

ROOT="${XDG_CACHE_HOME:-$HOME/.cache}/token-goat-prepush"
WORK="$ROOT/work"
mkdir -p "$ROOT" "$WORK"

# One run at a time per work dir.
exec 9>"$ROOT/lock"
if ! flock -n 9; then
    echo "wsl-test: another run holds the work dir, waiting"
    flock 9
fi

# Prefer a login-shell node that is new enough.
NODE_BIN=""
if command -v node &>/dev/null; then
    major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    if [[ "$major" -ge "$NODE_MAJOR_MIN" ]]; then
        NODE_BIN="$(dirname "$(command -v node)")"
    fi
fi

if [[ -z "$NODE_BIN" ]]; then
    case "$(uname -m)" in
        x86_64) arch=x64 ;;
        aarch64) arch=arm64 ;;
        *) skip "unsupported CPU $(uname -m) for the Node tarball" ;;
    esac
    name="node-v$NODE_VERSION-linux-$arch"
    if [[ ! -x "$ROOT/$name/bin/node" ]]; then
        echo "wsl-test: downloading $name from $NODE_MIRROR"
        dl="$(mktemp -d "$ROOT/download.XXXXXX")"
        curl -fsSL --retry 2 --connect-timeout 15 -o "$dl/$name.tar.xz" "$NODE_MIRROR/v$NODE_VERSION/$name.tar.xz" || skip "could not download Node $NODE_VERSION from $NODE_MIRROR"
        curl -fsSL --retry 2 --connect-timeout 15 -o "$dl/SHASUMS256.txt" "$NODE_MIRROR/v$NODE_VERSION/SHASUMS256.txt" || skip "could not download SHASUMS256.txt from $NODE_MIRROR"
        grep " $name.tar.xz\$" "$dl/SHASUMS256.txt" >"$dl/expected.txt" || skip "SHASUMS256.txt has no entry for $name.tar.xz"
        (cd "$dl" && sha256sum -c expected.txt >/dev/null) || skip "checksum mismatch for $name.tar.xz"
        tar -xJf "$dl/$name.tar.xz" -C "$dl"
        rm -rf -- "${ROOT:?}/$name"
        mv "$dl/$name" "$ROOT/$name"
        rm -rf -- "$dl"
    fi
    NODE_BIN="$ROOT/$name/bin"
fi
export PATH="$NODE_BIN:$PATH"
echo "wsl-test: using node $(node -v) from $NODE_BIN"

# Replace everything except node_modules with the pushed commit.
find "$WORK" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf -- {} +
tar -xf "$TAR" -C "$WORK"
cd "$WORK"
# Tests and guards read the tracked file list and history, so give the copy a repository at the pushed commit like a CI checkout has.
git init -q
git fetch -q "$BUNDLE" HEAD
git reset -q FETCH_HEAD
if [[ -f "$NAMES" ]]; then
    cp -- "$NAMES" "$ROOT/confidential-names.txt"
    export TOKEN_GOAT_CONFIDENTIAL_NAMES="$ROOT/confidential-names.txt"
fi

# npm ci only when the lock file or Node changed since the last good install.
stamp="$(sha256sum package-lock.json | cut -d' ' -f1)-$(node -v)"
if [[ ! -d node_modules || ! -f "$ROOT/ci.stamp" || "$(cat "$ROOT/ci.stamp")" != "$stamp" ]]; then
    echo "wsl-test: npm ci"
    rm -f "$ROOT/ci.stamp"
    npm ci
    echo "$stamp" >"$ROOT/ci.stamp"
else
    echo "wsl-test: node_modules is current, skipping npm ci"
fi

echo "wsl-test: running npm test in $WORK"
# TOKEN_GOAT_NO_WORKER_SPAWN and TOKEN_GOAT_HARNESS_OVERRIDE are pinned by tests/setup/isolate-home.ts (vitest setupFiles) so local pre-push and CI run under the same defaults. Don't re-export them here.
npm test
INNER
} >"$TMPD/inner.sh"

status=0
# A login shell gives the inner script the user's PATH; exec leaves ~/.bash_logout out of the exit status (Ubuntu's ends in a failing test).
wsl.exe -d "$DISTRO" -- bash -lc "exec bash '$(to_wsl_path "$TMPD/inner.sh")'" || status=$?
rm -rf -- "$TMPD"
if [[ "$status" -eq "$SKIP_STATUS" ]]; then
    exit 0
fi
if [[ "$status" -ne 0 ]]; then
    echo "wsl-test: FAILED (exit $status); Linux work dir: ~/.cache/token-goat-prepush/work in WSL $DISTRO"
fi
exit "$status"
