# publish-update.ps1 — build the Windows NSIS installer with the update feed
# baked in and publish it (installer + latest.yml) to the OSS update bucket.
#
# Usage (from repo root or this folder):
#   powershell -File scripts/publish-update.ps1 -Channel stable
#   powershell -File scripts/publish-update.ps1 -Channel stable -SkipBuild   # reuse last build output
#   powershell -File scripts/publish-update.ps1 -Channel test     # test-site line
#
# Requires: aliyun CLI logged in (profile with OSS write on the bucket),
# Windows SDK at D:\Windows Kits\10 (see AGENTS.md), node toolchain built.
#
# Layout on OSS (bucket: fangtang-office-updates, region cn-hangzhou):
#   <channel>/latest.yml                        electron-updater feed
#   <channel>/FangTangOffice-Setup-<v>.exe      installer (ASCII name: URLs/yml stay encoding-safe)
#   <channel=test>/FangTangOffice-Test-Setup-<v>.exe   test line carries a Test infix
#
# Bucket stays private; only the two published objects get public-read.
# The script writes ONLY into this bucket — every other bucket on the account
# is off-limits (production buckets must never be touched).

param(
    [ValidateSet('stable', 'beta', 'test')]
    [string]$Channel = 'stable',

    # reuse the previous BUILD_DIR output instead of rebuilding (publish-only)
    [switch]$SkipBuild,

    # build into a scratch dir so the developer's release/ win-unpacked
    # (the one they are testing) is never overwritten by a publish run
    [string]$BuildDir = 'dist'
)

$ErrorActionPreference = 'Stop'

# fixed targets — deliberately not parameters
$Bucket = 'fangtang-office-updates'
$OssBase = "oss://$Bucket/$Channel"
$HttpBase = "https://$Bucket.oss-cn-hangzhou.aliyuncs.com/$Channel"
# test channel packages the test-site factory config (committed defaults);
# stable/beta require the gitignored fangtang-defaults.prod.json —
# electron-builder.cjs hard-fails without it, so the lines can't be crossed
$env:FANGTANG_BUILD_ENV = if ($Channel -eq 'test') { 'test' } else { 'production' }

$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

# --- locate artifacts --------------------------------------------------------
$version = (Get-Content apps/shell/package.json -Raw | ConvertFrom-Json).version

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

# deployment-line guard (same rule as stage-release.cjs): with -SkipBuild the
# artifacts may predate this run's channel choice — never cross the lines.
# (Without -SkipBuild the fresh build just derived its env from $Channel, so
# the freshly written marker is matching by construction.)
if ($SkipBuild) {
    $marker = Join-Path $RepoRoot "$BuildDir/fangtang-build-env.txt"
    if (Test-Path $marker) {
        $built = (Get-Content $marker -Raw).Trim()
        $need = if ($Channel -eq 'test') { 'test' } else { 'production' }
        if ($built -ne $need) {
            throw "artifacts in $BuildDir were built for the '$built' line but -Channel $Channel publishes the '$need' line — rebuild with matching FANGTANG_BUILD_ENV"
        }
    }
}

$installerSrc = Join-Path $RepoRoot "$BuildDir/方塘Office Setup $version.exe"
$ymlPath = Join-Path $RepoRoot "$BuildDir/latest.yml"
foreach ($f in @($installerSrc, $ymlPath)) {
    if (-not (Test-Path $f)) { throw "missing build artifact: $f" }
}

# ASCII name for the published object; latest.yml must point at it.
# test channel gets a Test infix so the two release lines stay distinguishable
$installerName = if ($Channel -eq 'test') { "FangTangOffice-Test-Setup-$version.exe" } else { "FangTangOffice-Setup-$version.exe" }
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
