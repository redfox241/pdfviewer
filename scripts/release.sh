#!/usr/bin/env bash
# 构建分架构发布包并上传到 GitHub Releases。
#
#   GITHUB_TOKEN=... ./scripts/release.sh v1.0.4
#   GITHUB_TOKEN=... ./scripts/release.sh v1.0.4 --skip-build
#   GITHUB_TOKEN=... make release TAG=v1.0.4
#
# Token 需要目标仓库的 Contents: Read and write（经典 PAT 的 repo 权限）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
用法: scripts/release.sh <tag> [--skip-build] [--notes <file>]

  <tag>            发布标签，例如 v1.0.4
  --skip-build     直接使用 build/bin/artifacts 中已有的包
  --notes <file>   发布说明文件（默认 README 摘要）

环境变量:
  GITHUB_TOKEN / GH_TOKEN   GitHub 令牌（必需）
  VERSION                   覆盖发布包文件名中的版本（默认取 tag）

示例:
  GITHUB_TOKEN=ghp_xxx ./scripts/release.sh v1.0.4
EOF
}

tag=""
skip_build=0
notes_file=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build) skip_build=1 ;;
    --notes)
      [[ $# -ge 2 ]] || die "--notes 缺少文件参数"
      notes_file="$2"
      shift
      ;;
    help|-h|--help)
      usage
      exit 0
      ;;
    -*)
      die "未知选项: $1"
      ;;
    *)
      [[ -z "$tag" ]] || die "只能指定一个标签"
      tag="$1"
      ;;
  esac
  shift
done

[[ -n "$tag" ]] || {
  usage >&2
  exit 1
}

ver="${VERSION:-${tag#v}}"
export VERSION="$ver"

token="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
[[ -n "$token" ]] || die "缺少 GITHUB_TOKEN。请创建一个带 Contents: Read and write 权限的令牌后重试。"

slug="$(git remote get-url origin 2>/dev/null | sed -E 's#(git@|https://)github\.com[:/]##; s#\.git$##')"
[[ "$slug" == */* ]] || die "无法从 origin 解析 GitHub 仓库：$slug"
api="https://api.github.com/repos/$slug"

artifacts="$ROOT/build/bin/artifacts"
mac_arm="$artifacts/pdfviewer-$ver-macos-arm64.zip"
mac_intel="$artifacts/pdfviewer-$ver-macos-amd64.zip"
win_x64="$artifacts/pdfviewer-$ver-windows-x64.exe"

if [[ "$skip_build" == "0" ]]; then
  printf '构建 macOS arm64 / amd64...\n'
  ./scripts/build.sh mac
  printf '构建 Windows x64...\n'
  ./scripts/build.sh win
fi

for file in "$mac_arm" "$mac_intel" "$win_x64"; do
  [[ -f "$file" ]] || die "缺少发布包: $file（去掉 --skip-build 重新构建）"
done

manifest_ver="$(node -e 'process.stdout.write(require("./wails.json").info.productVersion)' 2>/dev/null || true)"
if [[ -n "$manifest_ver" && "$manifest_ver" != "$ver" ]]; then
  printf '提示: wails.json 版本为 %s，发布版本为 %s；如需一致请同步 wails.json 与 app.go。\n' \
    "$manifest_ver" "$ver" >&2
fi

if [[ -n "$(git status --porcelain -- . ':!build' ':!frontend/dist')" ]]; then
  printf '提示: 工作区有未提交的改动，发布包会包含这些内容。\n' >&2
fi

if ! git rev-parse --verify --quiet "refs/tags/$tag" >/dev/null; then
  git tag -a "$tag" -m "PDF Viewer $tag"
fi
if ! git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null 2>&1; then
  git push origin "refs/tags/$tag"
fi

notes=""
if [[ -n "$notes_file" ]]; then
  [[ -f "$notes_file" ]] || die "找不到发布说明: $notes_file"
  notes="$(cat "$notes_file")"
else
  notes="PDF Viewer $tag

- macOS Apple Silicon: pdfviewer-$ver-macos-arm64.zip
- macOS Intel: pdfviewer-$ver-macos-amd64.zip
- Windows x64: pdfviewer-$ver-windows-x64.exe"
fi

python3 - "$tag" "$notes" > /tmp/pdfviewer-release.json <<'PY'
import json, sys
tag, notes = sys.argv[1], sys.argv[2]
json.dump({
    "tag_name": tag,
    "name": f"PDF Viewer {tag}",
    "body": notes,
    "draft": False,
    "prerelease": False,
    "target_commitish": "main",
}, sys.stdout)
PY

auth=(-H "Authorization: Bearer $token" -H "Accept: application/vnd.github+json" -H "Content-Type: application/json")
release_json="$(curl -sS -X POST "$api/releases" "${auth[@]}" -d @/tmp/pdfviewer-release.json || true)"
release_id="$(printf '%s' "$release_json" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("id") or "")
except Exception: print("")')"

if [[ -z "$release_id" ]]; then
  # 已经存在同名 release 时复用；其它错误直接报出。
  release_json="$(curl -sS "$api/releases/tags/$tag" "${auth[@]}")" ||
    die "创建 release 失败：$release_json"
  release_id="$(printf '%s' "$release_json" | python3 -c 'import json,sys
print(json.load(sys.stdin).get("id") or "")')"
  [[ -n "$release_id" ]] || die "无法获取 release：$release_json"
  printf '复用已有 release: %s\n' "$tag"
fi

upload_base="https://uploads.github.com/repos/$slug/releases/$release_id/assets"

for file in "$mac_arm" "$mac_intel" "$win_x64"; do
  name="$(basename "$file")"
  encoded="$(python3 -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "$name")"
  # 同名旧包会被 GitHub 改名，先删掉再传。
  existing_id="$(printf '%s' "$release_json" | python3 -c 'import json,sys
name=sys.argv[1]
try:
    data=json.load(sys.stdin)
except Exception:
    data={}
for asset in data.get("assets", []):
    if asset.get("name")==name:
        print(asset.get("id")); break' "$name")"
  if [[ -n "$existing_id" ]]; then
    curl -sSf -X DELETE "$api/releases/assets/$existing_id" "${auth[@]}" >/dev/null
  fi
  printf '上传 %s...\n' "$name"
  curl -sSf -X POST "$upload_base?name=$encoded" \
    "${auth[@]}" \
    -H "Content-Type: application/octet-stream" \
    --data-binary @"$file" >/dev/null ||
    die "上传失败: $name"
done

html_url="$(curl -sS "$api/releases/tags/$tag" "${auth[@]}" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("html_url",""))')"
printf '已发布: %s\n' "${html_url:-https://github.com/$slug/releases/tag/$tag}"
