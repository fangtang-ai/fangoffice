# publish-update.ps1 — build the Windows NSIS installer with the update feed
# baked in and publish it (installer + latest.yml) to the OSS update bucket.
#
# Usage (from repo root or this folder):
#   powershell -File scripts/publish-update.ps1 -Channel stable
#   powershell -File scripts/publish-update.ps1 -Channel stable -SkipBuild   # reuse last build output
#
# Requires: aliyun CLI logged in (profile with OSS write on the bucket),
# Windows SDK at D:\Windows Kits\10 (see AGENTS.md), node toolchain built.
#
# Layout on OSS (bucket: fangtang-office-updates, region cn-hangzhou):
#   <channel>/latest.yml                        electron-updater feed
#   <channel>/FangTangOffice-Setup-<v>.exe      installer (ASCII name: URLs/yml stay encoding-safe)
#
# Bucket stays private; only the two published objects get public-read.
# The script writes ONLY into this bucket — every other bucket on the account
# is off-limits (production buckets must never be touched).

param(
    [ValidateSet('stable', 'beta')]
    [string]$Channel = 'stable',

    # reuse the previous BUILD_DIR output instead of rebuilding (publish-only)
    [switch]$SkipBuild,

    # build into a scratch dir so the developer's release/ win-unpacked
    # (the one they are testing) is never overwritten by a publish run
    [string]$BuildDir = 'apps/shell/release-publish'
)

$ErrorActionPreference = 'Stop'

# fixed targets — deliberately not parameters
$Bucket = 'fangtang-office-updates'
$OssBase = "oss://$Bucket/$Channel"
$HttpBase = "https://$Bucket.oss-cn-hangzhou.aliyuncs.com/$Channel"

$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

# --- build ------------------------------------------------------------------
if (-not $SkipBuild) {
    # AGENTS.md: Windows SDK lives on D:, not C:\Program Files (x86)
    $env:WINDOWS_KITS_DIR = 'D:\Windows Kits\10\UnionMetadata'
    # bakes resources/app-update.yml (generic provider) from this URL
    $env:FANGTANG_UPDATE_URL = $HttpBase
    $env:BUILD_DIR = (Join-Path $RepoRoot $BuildDir)
    npm run dist:win
    if ($LASTEXITCODE -ne 0) { throw "dist:win failed with exit code $LASTEXITCODE" }
} else {
    $env:BUILD_DIR = (Join-Path $RepoRoot $BuildDir)
    $env:FANGTANG_UPDATE_URL = $HttpBase
}

# --- locate artifacts --------------------------------------------------------
$version = (Get-Content apps/shell/package.json -Raw | ConvertFrom-Json).version
$installerSrc = Join-Path $RepoRoot "$BuildDir/方塘Office Setup $version.exe"
$ymlPath = Join-Path $RepoRoot "$BuildDir/latest.yml"
foreach ($f in @($installerSrc, $ymlPath)) {
    if (-not (Test-Path $f)) { throw "missing build artifact: $f" }
}

# ASCII name for the published object; latest.yml must point at it.
$installerName = "FangTangOffice-Setup-$version.exe"
$installerStaged = Join-Path $RepoRoot "$BuildDir/$installerName"
Copy-Item $installerSrc $installerStaged -Force

# rewrite the "path:" field (and the matching files[].url) to the ASCII name.
# PS 5.1: read/write as UTF-8 explicitly (no-BOM) — ANSI default would mojibake
# the Chinese name and the rewrite would silently no-op.
$yml = [IO.File]::ReadAllText($ymlPath, [Text.Encoding]::UTF8)
if ($yml -notmatch [regex]::Escape("path: $installerName")) {
    # PS 5.1: read/write as UTF-8 explicitly (no-BOM) — ANSI default would mojibake
    # the Chinese name and the rewrite would silently no-op.
    if ($yml -notmatch [regex]::Escape("path: 方塘Office Setup $version.exe")) {
        throw "latest.yml carries neither the Chinese nor the expected ASCII path; refusing to publish"
    }
    $yml = $yml -replace [regex]::Escape("path: 方塘Office Setup $version.exe"), "path: $installerName"
    $yml = $yml -replace [regex]::Escape("url: 方塘Office Setup $version.exe"), "url: $installerName"
    [IO.File]::WriteAllText($ymlPath, $yml, [Text.UTF8Encoding]::new($false))
}

# --- upload (installer first, feed last — yml must never dangle) -------------
aliyun oss cp $installerStaged "$OssBase/$installerName" --acl public-read --force
if ($LASTEXITCODE -ne 0) { throw "installer upload failed" }
aliyun oss cp $ymlPath "$OssBase/latest.yml" --acl public-read --force
if ($LASTEXITCODE -ne 0) { throw "latest.yml upload failed" }

# --- verify (anonymous requests: proves public-read actually works) --------
# -UseBasicParsing: PS 5.1 Invoke-WebRequest NPEs without it
$r = Invoke-WebRequest -Uri "$HttpBase/latest.yml" -TimeoutSec 30 -UseBasicParsing
$feedText = if ($r.Content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($r.Content) } else { $r.Content }
$feedVersion = [regex]::Match($feedText, '(?m)^version:\s*(\S+)').Groups[1].Value
if ($feedVersion -ne $version) { throw "feed version mismatch: $feedVersion != $version" }
if ($feedText -notmatch [regex]::Escape("path: $installerName")) { throw "feed path is not the ASCII installer name" }
# cross-check: the sha512 in the feed must match the staged installer bytes
$feedSha = [regex]::Match($feedText, '(?m)^sha512:\s*(\S+)').Groups[1].Value
$hashHex = (Get-FileHash $installerStaged -Algorithm SHA512).Hash
$localSha = [Convert]::ToBase64String(($hashHex -split '(..)' | Where-Object { $_ } | ForEach-Object { [Convert]::ToByte($_, 16) }))
if ($feedSha -ne $localSha) { throw "sha512 mismatch between feed and staged installer" }
$head = Invoke-WebRequest -Uri "$HttpBase/$installerName" -Method Head -TimeoutSec 30 -UseBasicParsing
if ($head.StatusCode -ne 200) { throw "installer HEAD failed: $($head.StatusCode)" }
Write-Host "published: $HttpBase/latest.yml (version $feedVersion, installer $($head.Headers.'Content-Length') bytes, sha512 ok)"
