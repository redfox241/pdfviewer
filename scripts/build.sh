#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

WAILS_BIN="${WAILS:-}"

usage() {
  cat <<'EOF'
用法: scripts/build.sh <target> [--clean]

target:
  mac             macOS 通用包 (Intel + Apple Silicon)
  mac-amd64       macOS Intel
  mac-arm64       macOS Apple Silicon
  win             Windows x64 exe
  win-arm64       Windows ARM64 exe
  win-installer   Windows x64 NSIS 安装包（需要 makensis）
  all             macOS 通用包 + Windows x64（需要 macOS 主机）
  dev             wails dev
  test            go test ./...
  doctor          wails doctor
  clean           删除 build/bin 和 frontend/dist
  help            显示本帮助

选项:
  --clean         传给 wails build 的 -clean，构建前清理输出目录
  也可使用环境变量 CLEAN=1、WAILS=/path/to/wails
EOF
}

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

find_wails() {
  if [[ -n "${WAILS:-}" ]]; then
    printf '%s\n' "$WAILS"
    return 0
  fi
  if command -v wails >/dev/null 2>&1; then
    command -v wails
    return 0
  fi
  if command -v go >/dev/null 2>&1; then
    local gopath
    gopath="$(go env GOPATH 2>/dev/null || true)"
    if [[ -n "$gopath" && -x "$gopath/bin/wails" ]]; then
      printf '%s\n' "$gopath/bin/wails"
      return 0
    fi
  fi
  return 1
}

require_wails() {
  if [[ -z "$WAILS_BIN" ]]; then
    WAILS_BIN="$(find_wails || true)"
  fi
  if [[ -z "$WAILS_BIN" ]]; then
    cat >&2 <<'EOF'
找不到 Wails CLI。
  安装: go install github.com/wailsapp/wails/v2/cmd/wails@latest
  如果已安装: 把 "$(go env GOPATH)/bin" 加入 PATH，或设置 WAILS=/path/to/wails
EOF
    exit 1
  fi
}

run_wails() {
  require_wails
  "$WAILS_BIN" "$@"
}

build() {
  local do_clean="$1"
  local platform="$2"
  shift 2
  if [[ "$do_clean" == "1" ]]; then
    run_wails build -clean -platform "$platform" "$@"
  else
    run_wails build -platform "$platform" "$@"
  fi
}

is_mac_host() {
  [[ "$(uname -s)" == "Darwin" ]]
}

ensure_mac_host() {
  if ! is_mac_host; then
    die "macOS 包只能在 macOS 上构建。"
  fi
}

clean_artifacts() {
  rm -rf build/bin frontend/dist
  printf '已清理 build/bin 和 frontend/dist\n'
}

target="${1:-}"
clean=0

if [[ "${2:-}" == "--clean" || "${CLEAN:-0}" == "1" ]]; then
  clean=1
fi

if [[ -z "$target" ]]; then
  if is_mac_host; then
    target="mac"
  else
    target="win"
  fi
fi

case "$target" in
  help|-h|--help)
    usage
    ;;
  dev)
    run_wails dev
    ;;
  test)
    go test ./...
    ;;
  doctor)
    run_wails doctor
    ;;
  clean)
    clean_artifacts
    ;;
  mac|macos)
    ensure_mac_host
    build "$clean" darwin/universal
    ;;
  mac-amd64)
    ensure_mac_host
    build "$clean" darwin/amd64
    ;;
  mac-arm64)
    ensure_mac_host
    build "$clean" darwin/arm64
    ;;
  win|windows)
    build "$clean" windows/amd64
    ;;
  win-arm64)
    build "$clean" windows/arm64
    ;;
  win-installer)
    if ! command -v makensis >/dev/null 2>&1; then
      die "未找到 makensis。请先安装 NSIS：https://wails.io/docs/guides/windows-installer/"
    fi
    build "$clean" windows/amd64 -nsis
    ;;
  all)
    ensure_mac_host
    # 只在第一次构建时清理，避免第二次构建删掉刚生成的 macOS 包。
    build "$clean" darwin/universal
    build 0 windows/amd64
    ;;
  *)
    printf '未知目标: %s\n\n' "$target" >&2
    usage >&2
    exit 1
    ;;
esac
