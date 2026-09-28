#!/bin/sh
# Installs the Tether server for this machine into ~/.tether/bin, checked against its release's
# SHA256SUMS, and points ~/.tether/bin/tether at it:
#
#   curl -fsSL https://github.com/AFRUITPIE/tether-server/releases/download/v<version>/install.sh | sh
#
# A release's copy has its version baked in (scripts/assets.ts). The environment can change the rest:
#
#   TETHER_VERSION        another version
#   TETHER_INSTALL_DIR    where to install (~/.tether/bin)
#   TETHER_DOWNLOAD_BASE  where releases come from: <base>/v<version>/<asset>
#   TETHER_PLATFORM       which binary (darwin-arm64, linux-x64, …) instead of this machine's
#   TETHER_BINARY         a binary already on this machine to install instead; not downloaded or checked
#
# Progress is `tether-install: …` lines on stdout, the last `Installed Tether <version>`; a failure
# is one `tether-install: error: …` line on stderr and exit status 1.
#
# POSIX sh only: it's piped to `sh`, whatever the login shell is.

set -u

nl='
'

say() { printf 'tether-install: %s\n' "$*"; }
fail() {
    printf 'tether-install: error: %s\n' "$*" >&2
    exit 1
}

# A semantic version, as release tags and dev builds spell them. Versions end up in file names and
# URLs, so nothing else gets through.
is_version() {
    core=${1%%[-+]*}
    case $core in
        *[!0-9.]* | .* | *. | *..* | *.*.*.*) return 1 ;;
        *.*.*) ;;
        *) return 1 ;;
    esac
    case ${1#"$core"} in
        *[!0-9A-Za-z.+-]*) return 1 ;;
    esac
    return 0
}

detect_platform() {
    if [ -n "${TETHER_PLATFORM:-}" ]; then
        platform=$TETHER_PLATFORM
    else
        machine=$(uname -sm) || fail "couldn't tell what this machine is"
        case ${machine% *} in
            Darwin) os=darwin ;;
            Linux) os=linux ;;
            *) fail "unsupported platform: $machine" ;;
        esac
        case ${machine##* } in
            arm64 | aarch64) arch=arm64 ;;
            x86_64 | amd64) arch=x64 ;;
            *) fail "unsupported platform: $machine" ;;
        esac
        platform=$os-$arch
    fi
    case $platform in
        darwin-arm64 | darwin-x64 | linux-arm64 | linux-x64) ;;
        *) fail "unsupported platform: $platform" ;;
    esac
}

download() { # <url> <file>
    if [ "$fetcher" = curl ]; then
        detail=$(curl -fsSL --retry 2 -o "$2" "$1" 2>&1) && return
    else
        detail=$(wget -q -O "$2" "$1" 2>&1) && return
    fi
    rm -f "$2"
    detail=${detail%%"$nl"*}
    detail=${detail#curl: (*) }
    fail "couldn't download $1${detail:+: $detail}"
}

sha256_of() { # <file>, into $sum. Read from stdin, so no file name is escaped into the output.
    if [ "$hasher" = sha256sum ]; then
        sum=$(sha256sum <"$1" 2>/dev/null)
    else
        sum=$(shasum -a 256 <"$1" 2>/dev/null)
    fi
    sum=${sum%% *}
}

main() {
    version=${TETHER_VERSION:-__TETHER_VERSION__}
    version=${version#v}
    if ! is_version "$version"; then
        [ -n "${TETHER_VERSION:-}" ] || fail "this install.sh names no version; set TETHER_VERSION"
        fail "not a version: $TETHER_VERSION"
    fi

    if [ -n "${TETHER_INSTALL_DIR:-}" ]; then
        dir=${TETHER_INSTALL_DIR%/}
    elif [ -n "${HOME:-}" ]; then
        dir=$HOME/.tether/bin
    else
        fail "HOME isn't set; set TETHER_INSTALL_DIR"
    fi
    target=$dir/tether-$version
    tmp=$dir/.tether-install.$$

    # A binary the caller already has needs no platform, download or checksum.
    if [ -z "${TETHER_BINARY:-}" ]; then
        detect_platform
        if command -v curl >/dev/null 2>&1; then
            fetcher=curl
        elif command -v wget >/dev/null 2>&1; then
            fetcher=wget
        else
            fail "curl or wget is needed to download Tether"
        fi
        # Never installed unchecked.
        if command -v sha256sum >/dev/null 2>&1; then
            hasher=sha256sum
        elif command -v shasum >/dev/null 2>&1; then
            hasher=shasum
        else
            fail "sha256sum or shasum is needed to check the download"
        fi
        base=${TETHER_DOWNLOAD_BASE:-https://github.com/AFRUITPIE/tether-server/releases/download}
        base=${base%/}/v$version
        asset=tether-$version-$platform
    elif [ ! -f "$TETHER_BINARY" ]; then
        fail "no file at $TETHER_BINARY"
    fi

    # ~/.tether holds the daemon's socket, log and schedules: private, as the daemon makes it.
    (umask 077 && mkdir -p "$dir") 2>/dev/null || fail "couldn't create $dir"
    [ ! -d "$dir/tether" ] || fail "$dir/tether is a directory"
    trap 'rm -f "$tmp.bin" "$tmp.sums" "$tmp.link"' EXIT
    trap 'exit 1' HUP INT TERM

    if [ -n "${TETHER_BINARY:-}" ]; then
        say "Installing Tether $version from $TETHER_BINARY"
        { cp "$TETHER_BINARY" "$tmp.bin" && chmod 755 "$tmp.bin" && mv -f "$tmp.bin" "$target"; } 2>/dev/null ||
            fail "couldn't install $TETHER_BINARY into $dir"
    else
        download "$base/SHA256SUMS" "$tmp.sums"
        expected=
        while read -r hash file || [ -n "${hash:-}" ]; do
            if [ "${file#\*}" = "$asset" ]; then
                expected=$hash
                break
            fi
        done <"$tmp.sums"
        case $expected in
            *[!0-9a-f]* | '') fail "SHA256SUMS has no checksum for $asset" ;;
        esac
        [ ${#expected} -eq 64 ] || fail "SHA256SUMS has no checksum for $asset"

        sum=
        [ ! -f "$target" ] || sha256_of "$target"
        if [ "$sum" = "$expected" ]; then
            say "Tether $version for $platform is already downloaded"
            chmod 755 "$target" 2>/dev/null || fail "couldn't install into $dir"
        else
            say "Downloading Tether $version for $platform"
            download "$base/$asset" "$tmp.bin"
            say "Verifying"
            sha256_of "$tmp.bin"
            [ "$sum" = "$expected" ] || fail "checksum mismatch for $asset: expected $expected, got ${sum:-nothing}"
            { chmod 755 "$tmp.bin" && mv -f "$tmp.bin" "$target"; } 2>/dev/null || fail "couldn't install into $dir"
        fi
    fi

    # Relative, so the directory can move; renamed into place, so `tether` always runs something.
    { rm -f "$tmp.link" && ln -s "tether-$version" "$tmp.link" && mv -f "$tmp.link" "$dir/tether"; } 2>/dev/null ||
        fail "couldn't link $dir/tether"

    # Other versions, dev builds and interrupted installs, but nothing else. A daemon still running
    # one keeps its deleted file until the next connect replaces it.
    for f in "$dir"/tether-* "$dir"/.tether-install.*; do
        name=${f##*/}
        [ "$name" != "tether-$version" ] || continue
        [ -f "$f" ] || [ -L "$f" ] || continue
        case $name in
            .tether-install.*) ;;
            *)
                v=${name#tether-}
                is_version "${v%.tmp}" || continue
                ;;
        esac
        rm -f "$f"
    done

    say "Installed Tether $version"
}

# Nothing runs until the whole script has arrived: `curl | sh` can be cut off midway.
main
