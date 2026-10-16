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
    printf 'TAR=%q\nBUNDLE=%q\nNAMES=%q\nNODE_VERSION=%q\nNODE_MAJOR_MIN=%q\nNODE_MIRROR=%q\nSKIP_STATUS=%q\nPIDFILE=%q\n' \
        "$(to_wsl_path "$TMPD/src.tar")" "$(to_wsl_path "$TMPD/history.bundle")" "$(to_wsl_path "$TMPD/confidential-names.txt")" "$NODE_VERSION" "$NODE_MAJOR_MIN" "$NODE_MIRROR" "$SKIP_STATUS" "$(to_wsl_path "$TMPD/inner.pid")"
    # The focus list (see prepush-focus.sh) travels as an array in the generated header; empty means the whole suite.
    printf 'FOCUS_FILES=('
    if [[ -n "${TG_PREPUSH_FOCUS:-}" ]]; then
        while IFS= read -r focus_file; do [[ -n "$focus_file" ]] && printf '%q ' "$focus_file"; done <"$TG_PREPUSH_FOCUS"
    fi
    printf ')\n'
    cat <<'INNER'
set -euo pipefail

# The Windows side reads this pid to end the whole Linux process tree if the push is interrupted.
echo $$ >"$PIDFILE"

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

# Tests spawn `python` inside shell commands; Ubuntu ships only python3, so give the run a `python` that is first on PATH, but only when none exists.
if ! command -v python &>/dev/null && command -v python3 &>/dev/null; then
    mkdir -p "$ROOT/bin"
    ln -sf -- "$(command -v python3)" "$ROOT/bin/python"
    export PATH="$ROOT/bin:$PATH"
fi

# The native hook client tests build Rust with the toolchain pinned in the repo, provisioned once per user into the cache (never the user's own ~/.cargo).
export RUSTUP_HOME="$ROOT/rustup"
export CARGO_HOME="$ROOT/cargo"
export PATH="$CARGO_HOME/bin:$PATH"
rust_channel="$(sed -n 's/^channel *= *"\(.*\)"/\1/p' native/tg-hook/rust-toolchain.toml)"
NATIVE_EXCLUDES=()
provision_rust() {
    [[ -n "$rust_channel" ]] || { echo "no channel in native/tg-hook/rust-toolchain.toml"; return 1; }
    if [[ -x "$CARGO_HOME/bin/rustup" ]] && rustup toolchain list 2>/dev/null | grep -q "^$rust_channel-"; then
        return 0
    fi
    command -v cc &>/dev/null || { echo "no C linker (cc) in this distro; install build-essential"; return 1; }
    case "$(uname -m)" in
        x86_64) triple=x86_64-unknown-linux-gnu ;;
        aarch64) triple=aarch64-unknown-linux-gnu ;;
        *) echo "unsupported CPU $(uname -m) for rustup-init"; return 1 ;;
    esac
    local rdl
    rdl="$(mktemp -d "$ROOT/download.XXXXXX")"
    local base="https://static.rust-lang.org/rustup/dist/$triple"
    if ! curl -fsSL --retry 2 --connect-timeout 15 -o "$rdl/rustup-init" "$base/rustup-init" || ! curl -fsSL --retry 2 --connect-timeout 15 -o "$rdl/rustup-init.sha256" "$base/rustup-init.sha256"; then
        rm -rf -- "$rdl"
        echo "could not download rustup-init from $base"
        return 1
    fi
    # The published file names it ./rustup-init, so verify from inside the download dir.
    if ! (cd "$rdl" && sha256sum -c rustup-init.sha256 >/dev/null); then
        rm -rf -- "$rdl"
        echo "checksum mismatch for rustup-init"
        return 1
    fi
    chmod +x "$rdl/rustup-init"
    "$rdl/rustup-init" -y --profile minimal --no-modify-path --default-toolchain "$rust_channel" >&2 || { rm -rf -- "$rdl"; echo "rustup-init failed to install $rust_channel"; return 1; }
    rm -rf -- "$rdl"
}
if rust_why="$(provision_rust)"; then
    echo "wsl-test: rust $(rustc --version) from $CARGO_HOME"
else
    # Without a toolchain the native build cannot run. Name that to the test setup, and leave out only the files that need the native client so the rest of the Linux suite still gates the push.
    export TG_TEST_NATIVE_BUILD_ERROR="rust toolchain unavailable in WSL: $rust_why"
    echo "wsl-test: ################################################################"
    echo "wsl-test: WARNING: $TG_TEST_NATIVE_BUILD_ERROR"
    echo "wsl-test: the native hook client tests are NOT run on this push"
    echo "wsl-test: ################################################################"
    mapfile -t native_files < <(grep -lE "buildNative\(" tests/*.test.ts)
    for f in "${native_files[@]}"; do NATIVE_EXCLUDES+=(--exclude "$f"); done
fi

echo "wsl-test: running npm test in $WORK"
# TOKEN_GOAT_NO_WORKER_SPAWN and TOKEN_GOAT_HARNESS_OVERRIDE are pinned by tests/setup/isolate-home.ts (vitest setupFiles) so local pre-push and CI run under the same defaults. Don't re-export them here.
if [[ "${#FOCUS_FILES[@]}" -gt 0 ]]; then
    echo "wsl-test: re-running ${#FOCUS_FILES[@]} focused file(s) with vitest related"
    npx vitest related --run "${FOCUS_FILES[@]}" "${NATIVE_EXCLUDES[@]}"
elif [[ "${#NATIVE_EXCLUDES[@]}" -gt 0 ]]; then
    npm test -- "${NATIVE_EXCLUDES[@]}"
else
    npm test
fi
INNER
} >"$TMPD/inner.sh"

status=0
# Kill the Linux tree rooted at the pid the inner script recorded, children first. Bounded to that one tree.
kill_linux_tree() {
    [[ -s "$TMPD/inner.pid" ]] || return 0
    wsl.exe -d "$DISTRO" -- bash -c 'kt() { local c; for c in $(pgrep -P "$1" 2>/dev/null); do kt "$c"; done; kill -KILL "$1" 2>/dev/null || true; }; kt "$(cat "$1")"' _ "$(to_wsl_path "$TMPD/inner.pid")" &>/dev/null || true
}
WSL_PID=""
# owner: this script; the trap runs when run-all-checks.sh sends TERM or INT on an interrupted push, and wsl.exe is waited on below so the trap fires at once.
on_signal() {
    trap - INT TERM
    kill_linux_tree
    if [[ -n "$WSL_PID" ]]; then kill "$WSL_PID" 2>/dev/null || true; fi
    rm -rf -- "$TMPD"
    exit 143
}
trap on_signal INT TERM
# A login shell gives the inner script the user's PATH; exec leaves ~/.bash_logout out of the exit status (Ubuntu's ends in a failing test). Backgrounded and waited on so a signal reaches the trap while the suite runs.
wsl.exe -d "$DISTRO" -- bash -lc "exec bash '$(to_wsl_path "$TMPD/inner.sh")'" &
WSL_PID=$!
wait "$WSL_PID" || status=$?
trap - INT TERM
rm -rf -- "$TMPD"
if [[ "$status" -eq "$SKIP_STATUS" ]]; then
    exit 0
fi
if [[ "$status" -ne 0 ]]; then
    echo "wsl-test: FAILED (exit $status); Linux work dir: ~/.cache/token-goat-prepush/work in WSL $DISTRO"
fi
exit "$status"
