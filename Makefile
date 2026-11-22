SHELL := /bin/bash
.DEFAULT_GOAL := help

# 用法: make mac CLEAN=1  ->  ./scripts/build.sh mac --clean
CLEAN_FLAG := $(if $(filter 1 true yes on,$(CLEAN)),--clean,)

.PHONY: help dev mac macos mac-amd64 mac-arm64 win windows win-arm64 win-installer all test doctor clean

help:
	@echo "用法: make <target>"
	@echo ""
	@echo "  mac / macos       macOS 通用包 (Intel + Apple Silicon)"
	@echo "  mac-amd64         macOS Intel"
	@echo "  mac-arm64         macOS Apple Silicon"
	@echo "  win / windows     Windows x64 exe"
	@echo "  win-arm64         Windows ARM64 exe"
	@echo "  win-installer     Windows x64 NSIS 安装包（需要 makensis）"
	@echo "  all               macOS 通用包 + Windows x64（需要 macOS 主机）"
	@echo "  dev               wails dev"
	@echo "  test              go test ./..."
	@echo "  doctor            wails doctor"
	@echo "  clean             删除 build/bin 和 frontend/dist"
	@echo ""
	@echo "  CLEAN=1           传给 wails build 的 -clean"
	@echo "  WAILS=/path       指定 Wails CLI"
	@echo ""
	@echo "Windows 请使用: powershell -ExecutionPolicy Bypass -File scripts/build.ps1 <target>"

dev:
	@./scripts/build.sh dev

mac macos:
	@./scripts/build.sh mac $(CLEAN_FLAG)

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

test:
	@./scripts/build.sh test

doctor:
	@./scripts/build.sh doctor

clean:
	@./scripts/build.sh clean
