#Requires -Version 5.1
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$Target,

    [switch]$Clean
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Show-Usage {
    @'
用法: scripts/build.ps1 <target> [-Clean]

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
  -Clean          传给 wails build 的 -clean，构建前清理输出目录
  也可使用环境变量 WAILS=/path/to/wails
'@ | Write-Host
}

function Get-HostOS {
    if ($env:OS -eq 'Windows_NT') { return 'windows' }
    if ($PSVersionTable.PSVersion.Major -ge 6 -and $IsMacOS) { return 'macos' }
    return 'linux'
}

function Find-Wails {
    if ($env:WAILS) { return $env:WAILS }

    $cmd = Get-Command wails -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }

    $gopath = $null
    try {
        $gopath = & go env GOPATH 2>$null
        if ($LASTEXITCODE -ne 0) { $gopath = $null }
    } catch {
        $gopath = $null
    }

    if ($gopath) {
        $exe = if ($env:OS -eq 'Windows_NT') { 'wails.exe' } else { 'wails' }
        $candidate = Join-Path (Join-Path $gopath 'bin') $exe
        if (Test-Path $candidate) { return $candidate }
    }

    return $null
}

function Invoke-Wails {
    param([string[]]$WailsArgs)

    $wails = Find-Wails
    if (-not $wails) {
        $message = @'
找不到 Wails CLI。
  安装: go install github.com/wailsapp/wails/v2/cmd/wails@latest
  如果已安装: 把 "$(go env GOPATH)/bin" 加入 PATH，或设置 WAILS=/path/to/wails
'@
        throw $message
    }

    & $wails @WailsArgs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

function Build-Target {
    param(
        [string]$Platform,
        [bool]$DoClean,
        [switch]$Nsis
    )

    $wailsArgs = @('build', '-platform', $Platform)
    if ($DoClean) { $wailsArgs += '-clean' }
    if ($Nsis) { $wailsArgs += '-nsis' }
    Invoke-Wails $wailsArgs
}

function Assert-MacHost {
    if ((Get-HostOS) -ne 'macos') {
        throw 'macOS 包只能在 macOS 上构建。'
    }
}

function Remove-Artifacts {
    Remove-Item -Recurse -Force 'build/bin', 'frontend/dist' -ErrorAction SilentlyContinue
    Write-Host '已清理 build/bin 和 frontend/dist'
}

if (-not $Target) {
    $Target = if ((Get-HostOS) -eq 'macos') { 'mac' } else { 'win' }
}

switch ($Target) {
    'help' {
        Show-Usage
    }
    'dev' {
        Invoke-Wails @('dev')
    }
    'test' {
        & go test ./...
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    'doctor' {
        Invoke-Wails @('doctor')
    }
    'clean' {
        Remove-Artifacts
    }
    { $_ -in 'mac', 'macos' } {
        Assert-MacHost
        Build-Target -Platform 'darwin/universal' -DoClean $Clean
    }
    'mac-amd64' {
        Assert-MacHost
        Build-Target -Platform 'darwin/amd64' -DoClean $Clean
    }
    'mac-arm64' {
        Assert-MacHost
        Build-Target -Platform 'darwin/arm64' -DoClean $Clean
    }
    'win' {
        Build-Target -Platform 'windows/amd64' -DoClean $Clean
    }
    'windows' {
        Build-Target -Platform 'windows/amd64' -DoClean $Clean
    }
    'win-arm64' {
        Build-Target -Platform 'windows/arm64' -DoClean $Clean
    }
    'win-installer' {
        if (-not (Get-Command makensis -ErrorAction SilentlyContinue)) {
            throw '未找到 makensis。请先安装 NSIS：https://wails.io/docs/guides/windows-installer/'
        }
        Build-Target -Platform 'windows/amd64' -DoClean $Clean -Nsis
    }
    'all' {
        Assert-MacHost
        # 只在第一次构建时清理，避免第二次构建删掉刚生成的 macOS 包。
        Build-Target -Platform 'darwin/universal' -DoClean $Clean
        Build-Target -Platform 'windows/amd64' -DoClean $false
    }
    default {
        Write-Host "未知目标: $Target" -ForegroundColor Red
        Write-Host ''
        Show-Usage
        exit 1
    }
}
