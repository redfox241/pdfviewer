SHELL := /bin/bash
.DEFAULT_GOAL := help

# 用法: make mac CLEAN=1  ->  ./scripts/build.sh mac --clean
CLEAN_FLAG := $(if $(filter 1 true yes on,$(CLEAN)),--clean,)

.PHONY: help dev mac macos mac-universal mac-amd64 mac-arm64 win windows win-arm64 win-installer all test release doctor plugins ecdict clean

help:
	@echo "用法: make <target>"
	@echo ""
	@echo "  mac / macos       macOS 分架构包 (arm64 + amd64，各一个 zip)"
	@echo "  mac-arm64         macOS Apple Silicon"
	@echo "  mac-amd64         macOS Intel"
	@echo "  mac-universal     macOS 通用包 (Intel + Apple Silicon)"
	@echo "  win / windows     Windows x64 exe"
	@echo "  win-arm64         Windows ARM64 exe"
	@echo "  win-installer     Windows x64 NSIS 安装包（需要 makensis）"
	@echo "  all               macOS arm64 + amd64 + Windows x64（需要 macOS 主机）"
	@echo "  release           构建并发布到 GitHub Releases（需 GITHUB_TOKEN、TAG）"
	@echo "  dev               wails dev"
	@echo "  test              go test ./..."
	@echo "  doctor            wails doctor"
	@echo "  plugins           打包 plugins/* 为 build/plugins/*.pdfplugin"
	@echo "  ecdict            下载并构建高精度离线词典（ECDICT，约 54 MB 下载，9 万词条）"
	@echo "  clean             删除 build/bin、build/plugins 和 frontend/dist"
	@echo ""
	@echo "  CLEAN=1           传给 wails build 的 -clean"
	@echo "  WAILS=/path       指定 Wails CLI"
	@echo "  TAG=v1.2.3        release 使用的版本标签"
	@echo ""
	@echo "Windows 请使用: powershell -ExecutionPolicy Bypass -File scripts/build.ps1 <target>"

dev:
	@./scripts/build.sh dev

mac macos:
	@./scripts/build.sh mac $(CLEAN_FLAG)

mac-universal:
	@./scripts/build.sh mac-universal $(CLEAN_FLAG)

mac-amd64:
	@./scripts/build.sh mac-amd64 $(CLEAN_FLAG)

mac-arm64:
	@./scripts/build.sh mac-arm64 $(CLEAN_FLAG)

win windows:
	@./scripts/build.sh win $(CLEAN_FLAG)

win-arm64:
	@./scripts/build.sh win-arm64 $(CLEAN_FLAG)

win-installer:
	@./scripts/build.sh win-installer $(CLEAN_FLAG)

all:
	@./scripts/build.sh all $(CLEAN_FLAG)

release:
	@./scripts/release.sh "$(TAG)"

test:
	@./scripts/build.sh test

doctor:
	@./scripts/build.sh doctor

plugins:
	@./scripts/pack-plugins.sh

ecdict:
	@./scripts/build-ecdict-pack.sh

clean:
	@./scripts/build.sh clean
	@rm -rf build/plugins
