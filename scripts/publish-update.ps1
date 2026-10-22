# Build Windows installers and delegate publishing to the shared guarded CLI.
# Requires the aliyun CLI and ALIBABA_CLOUD_ACCESS_KEY_ID/SECRET environment variables.
# Use -InitialRelease only for a new channel whose feeds return HTTP 404.
param(
    [ValidateSet('stable', 'beta', 'test')]
    [string]$Channel = 'stable',
    [switch]$SkipBuild,
    [string]$BuildDir = 'dist',
    [switch]$InitialRelease
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

$Bucket = 'fangtang-office-updates'
$HttpBase = "https://$Bucket.oss-cn-hangzhou.aliyuncs.com/$Channel"
$env:FANGTANG_BUILD_ENV = if ($Channel -eq 'test') { 'test' } else { 'production' }
$env:FANGTANG_UPDATE_URL = $HttpBase
$env:BUILD_DIR = if ([IO.Path]::IsPathRooted($BuildDir)) {
    $BuildDir
} else {
    Join-Path $RepoRoot $BuildDir
}

if (-not $SkipBuild) {
    $env:WINDOWS_KITS_DIR = 'D:\Windows Kits\10\UnionMetadata'
    npm run dist:win
    if ($LASTEXITCODE -ne 0) { throw "dist:win failed with exit code $LASTEXITCODE" }
}

# Both entry points must reject unknown remote state before any OSS write.
$stageArguments = @(
    'scripts/stage-release.cjs', '--artifacts', $env:BUILD_DIR,
    '--channel', $Channel, '--publish'
)
if ($InitialRelease) { $stageArguments += '--initial-release' }
node @stageArguments
if ($LASTEXITCODE -ne 0) { throw "release publishing failed with exit code $LASTEXITCODE" }
