param(
    [string]$RuntimeDir = (Join-Path $PSScriptRoot '..\src-tauri\resources\windows\vc-runtime')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$expectedFiles = @(
    'concrt140.dll',
    'msvcp140.dll',
    'msvcp140_1.dll',
    'msvcp140_2.dll',
    'msvcp140_atomic_wait.dll',
    'msvcp140_codecvt_ids.dll',
    'vccorlib140.dll',
    'vcruntime140.dll',
    'vcruntime140_1.dll'
)

if (!(Test-Path $RuntimeDir)) {
    throw "VC runtime directory not found: $RuntimeDir"
}

$manifestPath = Join-Path $RuntimeDir 'manifest.json'
if (!(Test-Path $manifestPath)) {
    throw "VC runtime manifest not found: $manifestPath"
}

$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$runtimeFiles = @(Get-ChildItem $RuntimeDir -File -Filter *.dll | Sort-Object Name)
$runtimeNames = $runtimeFiles | ForEach-Object { $_.Name }
$diff = Compare-Object -ReferenceObject $expectedFiles -DifferenceObject $runtimeNames
if ($diff) {
    throw "VC runtime files do not match expected Microsoft.VC143.CRT x64 retail set."
}

$runtimeVersions = @($runtimeFiles | ForEach-Object { $_.VersionInfo.FileVersion } | Sort-Object -Unique)
if ($runtimeVersions.Count -ne 1) {
    throw "VC runtime files must all share the same version. Found: $($runtimeVersions -join ', ')"
}

if ($manifest.runtimeVersion -ne $runtimeVersions[0]) {
    throw "Manifest runtimeVersion '$($manifest.runtimeVersion)' does not match actual runtime version '$($runtimeVersions[0])'."
}

foreach ($expectedName in $expectedFiles) {
    $filePath = Join-Path $RuntimeDir $expectedName
    $manifestEntry = $manifest.files | Where-Object { $_.name -eq $expectedName } | Select-Object -First 1
    if ($null -eq $manifestEntry) {
        throw "Manifest is missing runtime entry for $expectedName."
    }

    $actualHash = (Get-FileHash $filePath -Algorithm SHA256).Hash.ToLower()
    if ($actualHash -ne $manifestEntry.sha256) {
        throw "SHA256 mismatch for $expectedName."
    }
}

Write-Host "[validate-vc-runtime] OK version=$($runtimeVersions[0]) files=$($runtimeFiles.Count)"
