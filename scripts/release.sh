#!/usr/bin/env bash
# Release build of fcd: the web client once, then fcd for each target.
#
#   scripts/release.sh                      # all targets (needs cargo-zigbuild or Docker for Linux)
#   scripts/release.sh --targets "aarch64-apple-darwin x86_64-unknown-linux-musl"
#   scripts/release.sh --skip-web           # reuse apps/web/dist (CI downloads it)
#   scripts/release.sh --no-checksums       # leave SHA256SUMS to a later step (CI)
#
# Output in dist/release/ (or --out DIR):
#   fcd-<version>-<target>.tar.gz   (Linux, macOS)  fcd, LICENSE, README.md, CHANGELOG.md
#   fcd-<version>-<target>.zip      (Windows)       fcd.exe and the same files
#   SHA256SUMS                      sha256sum format, one line per archive
#
# How each target is built (FCD_BUILDER=auto|cargo|zigbuild|docker, default auto):
#   cargo     the host itself, Apple targets on macOS, Windows MSVC on Windows
#             (rustup target add <target> first)
#   zigbuild  cargo-zigbuild (pip install cargo-zigbuild, or cargo install
#             cargo-zigbuild plus zig): Linux musl and Windows GNU from any host
#   docker    the official rust:alpine image for the target's platform (native
#             or through QEMU emulation): Linux musl only, slower
#
# Reproducibility: dependencies are locked (pnpm-lock.yaml, Cargo.lock,
# --frozen-lockfile, --locked); SOURCE_DATE_EPOCH is the commit time and is
# used for every timestamp in the archives; paths of the build machine are
# remapped out of the binary (--remap-path-prefix); embedded web files carry
# no timestamps (rust-embed deterministic-timestamps). The Rust toolchain and
# zig versions still matter: pin them to rebuild bit for bit.

set -euo pipefail

ALL_TARGETS="x86_64-unknown-linux-musl aarch64-unknown-linux-musl armv7-unknown-linux-musleabihf \
x86_64-apple-darwin aarch64-apple-darwin x86_64-pc-windows-msvc"

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="$repo/dist/release"
targets="$ALL_TARGETS"
skip_web=0
checksums=1
builder="${FCD_BUILDER:-auto}"

while [ $# -gt 0 ]; do
  case "$1" in
    --targets) targets="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    --skip-web) skip_web=1; shift ;;
    --no-checksums) checksums=0; shift ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

cd "$repo"
py="$(command -v python3 || command -v python || true)"
[ -n "$py" ] || { echo "python3 is needed for packaging" >&2; exit 1; }

# ---- version, commit, time ----
version="$(sed -n 's/^version = "\(.*\)"$/\1/p' server/Cargo.toml | head -n 1)"
web_version="$("$py" -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' apps/web/package.json)"
if [ "$version" != "$web_version" ]; then
  echo "version mismatch: server/Cargo.toml $version, apps/web/package.json $web_version" >&2
  exit 1
fi
tag="${RELEASE_TAG:-}"
if [ -n "$tag" ] && [ "$tag" != "v$version" ]; then
  echo "tag $tag does not match version $version (expected v$version)" >&2
  exit 1
fi
if [ -z "${FCD_GIT_COMMIT+x}" ]; then
  FCD_GIT_COMMIT="$(git rev-parse --short=12 HEAD 2>/dev/null || true)"
fi
export FCD_GIT_COMMIT
if [ -z "${SOURCE_DATE_EPOCH:-}" ]; then
  SOURCE_DATE_EPOCH="$(git log -1 --format=%ct 2>/dev/null || date +%s)"
fi
export SOURCE_DATE_EPOCH
if [ -n "$(git status --porcelain 2>/dev/null || true)" ]; then
  echo "note: the working tree has uncommitted changes; the commit ${FCD_GIT_COMMIT:-?} does not describe them" >&2
fi
echo "fcd $version, commit ${FCD_GIT_COMMIT:-unknown}, SOURCE_DATE_EPOCH $SOURCE_DATE_EPOCH"

# ---- web client, once ----
if [ "$skip_web" = 0 ]; then
  pnpm install --frozen-lockfile
  pnpm --filter "@family-chat/web..." run build
fi
[ -f apps/web/dist/index.html ] || { echo "apps/web/dist is missing: build the web client first" >&2; exit 1; }

# ---- fcd for each target ----
host="$(rustc -vV | sed -n 's/^host: //p')"
cargo_home="${CARGO_HOME:-$HOME/.cargo}"
remap="--remap-path-prefix=$repo=/build/family-chat --remap-path-prefix=$cargo_home=/cargo"
target_dir="$repo/server/target/release-dist"
mkdir -p "$out"
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT

pick_builder() {
  local t="$1"
  if [ "$builder" != auto ]; then echo "$builder"; return; fi
  case "$t" in
    "$host") echo cargo ;;
    *-apple-darwin) [ "$(uname -s)" = Darwin ] && echo cargo || echo none ;;
    *-pc-windows-msvc) case "$host" in *-windows-msvc) echo cargo ;; *) echo none ;; esac ;;
    *-linux-musl*|*-windows-gnu)
      if cargo zigbuild --help >/dev/null 2>&1; then echo zigbuild
      elif [ "${t#*-windows}" = "$t" ] && command -v docker >/dev/null 2>&1; then echo docker
      else echo none; fi ;;
    *) echo none ;;
  esac
}

docker_platform() {
  case "$1" in
    x86_64-unknown-linux-musl) echo linux/amd64 ;;
    aarch64-unknown-linux-musl) echo linux/arm64 ;;
    armv7-unknown-linux-musleabihf) echo linux/arm/v7 ;;
    *) echo "" ;;
  esac
}

build_one() {
  local t="$1" how bin
  how="$(pick_builder "$t")"
  echo "== $t ($how)"
  case "$how" in
    cargo)
      RUSTFLAGS="${RUSTFLAGS:-} $remap" CARGO_TARGET_DIR="$target_dir" \
        cargo build --release --locked --manifest-path server/Cargo.toml --target "$t"
      bin="$target_dir/$t/release/fcd" ;;
    zigbuild)
      (cd server && RUSTFLAGS="${RUSTFLAGS:-} $remap" CARGO_TARGET_DIR="$target_dir" \
        cargo zigbuild --release --locked --target "$t")
      bin="$target_dir/$t/release/fcd" ;;
    docker)
      local platform
      platform="$(docker_platform "$t")"
      [ -n "$platform" ] || { echo "no Docker platform for $t" >&2; exit 1; }
      docker run --rm --platform "$platform" \
        -v "$repo":/build/family-chat -w /build/family-chat/server \
        -e FCD_GIT_COMMIT -e SOURCE_DATE_EPOCH \
        -e CARGO_TARGET_DIR="/build/family-chat/server/target/release-dist/docker-$t" \
        -e RUSTFLAGS="--remap-path-prefix=/usr/local/cargo=/cargo" \
        rust:1-alpine sh -c "apk add --no-cache musl-dev >/dev/null && cargo build --release --locked --target $t"
      bin="$target_dir/docker-$t/$t/release/fcd" ;;
    *)
      echo "cannot build $t on $host: install cargo-zigbuild (Linux, Windows GNU) or build on the matching system" >&2
      exit 1 ;;
  esac
  case "$t" in *-windows-*) bin="$bin.exe" ;; esac
  [ -f "$bin" ] || { echo "missing $bin" >&2; exit 1; }

  local name="fcd-$version-$t" dir="$staging/fcd-$version-$t"
  rm -rf "$dir"
  mkdir -p "$dir"
  cp "$bin" "$dir/"
  cp LICENSE README.md CHANGELOG.md "$dir/"
  case "$t" in
    *-windows-*) "$py" "$repo/scripts/package.py" zip "$dir" "$out/$name.zip" ;;
    *) "$py" "$repo/scripts/package.py" tar "$dir" "$out/$name.tar.gz" ;;
  esac
}

for t in $targets; do
  build_one "$t"
done

if [ "$checksums" = 1 ]; then
  "$py" "$repo/scripts/package.py" sums "$out"
  echo "== $out/SHA256SUMS"
  cat "$out/SHA256SUMS"
fi
