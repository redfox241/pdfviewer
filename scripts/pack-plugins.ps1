# Pack every plugins/<id>/ directory into build\plugins\<id>.pdfplugin.
# Dictionary sources with entries.csv are converted to dict.sqlite first.
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root "plugins"
$out = Join-Path $root "build\plugins"
New-Item -ItemType Directory -Force -Path $out | Out-Null

$generated = [System.Collections.Generic.List[string]]::new()
Get-ChildItem -Path $src -Directory | ForEach-Object {
    $dir = $_.FullName
    $id = $_.Name
    if (-not (Test-Path (Join-Path $dir "manifest.json"))) { return }

    $csv = Join-Path $dir "entries.csv"
    if (Test-Path $csv) {
        $db = Join-Path $dir "dict.sqlite"
        python (Join-Path $root "scripts\build-dict.py") $csv $db
        if ($LASTEXITCODE -ne 0) { throw "build-dict.py failed for $id" }
        $generated.Add($db)
    }

    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("pdfviewer-pack-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    Copy-Item -Path (Join-Path $dir "*") -Destination $tmp -Recurse -Force
    Remove-Item -Path (Join-Path $tmp "entries.csv") -Force -ErrorAction SilentlyContinue
    Get-ChildItem -Path $tmp -Filter ".DS_Store" -Recurse -Force -ErrorAction SilentlyContinue | Remove-Item -Force

    $zip = Join-Path $out "$id.pdfplugin"
    Remove-Item -Path $zip -Force -ErrorAction SilentlyContinue
    Compress-Archive -Path (Join-Path $tmp "*") -DestinationPath $zip -Force
    Remove-Item -Path $tmp -Recurse -Force
    Write-Host "created build\plugins\$id.pdfplugin"
}

foreach ($db in $generated) {
    Remove-Item -Path $db -Force -ErrorAction SilentlyContinue
}
