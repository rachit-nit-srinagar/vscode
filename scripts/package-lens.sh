#!/usr/bin/env bash
# Package Lens (Code-OSS gulp build) and bundle the local opencode engine.
# Usage: ./scripts/package-lens.sh
# Optional: LENS_SKIP_GULP=1 to only copy opencode into an existing VSCode-* folder.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OPENSOURCE="$(cd "$ROOT/.." && pwd)"
OPENCODE="$OPENSOURCE/opencode"

platform="$(uname -s)"
arch="$(uname -m)"
case "$platform" in
	Darwin) gulp_platform="darwin" ;;
	Linux) gulp_platform="linux" ;;
	MINGW*|MSYS*|CYGWIN*) gulp_platform="win32" ;;
	*)
		echo "Unsupported platform: $platform" >&2
		exit 1
		;;
esac
case "$arch" in
	arm64|aarch64) gulp_arch="arm64" ;;
	x86_64|amd64) gulp_arch="x64" ;;
	*)
		echo "Unsupported arch: $arch" >&2
		exit 1
		;;
esac

gulp_task="vscode-${gulp_platform}-${gulp_arch}"
dest_name="VSCode-${gulp_platform}-${gulp_arch}"
dest="$ROOT/../$dest_name"

cd "$ROOT"

if [[ "${LENS_SKIP_GULP:-}" != "1" ]]; then
	echo "[package-lens] generating icons"
	python3 scripts/generate-lens-icons.py || true
	echo "[package-lens] compiling Lens Chat"
	npm run compile-lens-chat
	echo "[package-lens] gulp ${gulp_task} (this can take a long time)"
	npm run gulp -- "$gulp_task"
fi

if [[ ! -d "$dest" ]]; then
	echo "[package-lens] packaged app not found at $dest" >&2
	echo "Run without LENS_SKIP_GULP=1, or set dest after a successful gulp build." >&2
	exit 1
fi

app_dir="$dest"
if [[ "$gulp_platform" == "darwin" ]]; then
	app_dir="$(find "$dest" -maxdepth 1 -name '*.app' | head -n 1)"
	resources="$app_dir/Contents/Resources"
else
	resources="$dest/resources"
fi

mkdir -p "$resources"
engine_dest="$resources/opencode"
echo "[package-lens] copying opencode -> $engine_dest"
rm -rf "$engine_dest"
mkdir -p "$engine_dest"
if command -v rsync >/dev/null 2>&1; then
	rsync -a --delete \
		--exclude '.git' \
		--exclude '.turbo' \
		--exclude 'packages/app/dist' \
		--exclude 'packages/desktop/dist' \
		"$OPENCODE/" "$engine_dest/"
else
	cp -R "$OPENCODE/." "$engine_dest/"
fi

bun_src="$(command -v bun || true)"
if [[ -n "$bun_src" ]]; then
	mkdir -p "$resources/bun"
	cp "$bun_src" "$resources/bun/bun"
	chmod +x "$resources/bun/bun"
	echo "[package-lens] bundled bun at $resources/bun/bun"
else
	echo "[package-lens] bun not on PATH; packaged app needs bun installed or LENS_BUN_PATH"
fi

echo
echo "Packaged Lens at: $dest"
echo "Code signing / notarization is not run here (needs Apple/Windows credentials)."
echo "Dev launch remains: ./scripts/code.sh"
echo "Setup and architecture: see README.md in the lens repository."
