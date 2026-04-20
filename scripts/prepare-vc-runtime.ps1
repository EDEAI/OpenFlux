param(
    [string]$DestinationDir = (Join-Path $PSScriptRoot '..\src-tauri\resources\windows\vc-runtime'),
    [string]$SourceUrl = 'https://aka.ms/vc14/vc_redist.x64.exe',
    [string]$SourceExe = '',
    [string]$WixVersion = '6.0.2'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-ExpectedRuntimeFiles {
    @(
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
}

function Get-FileHeader {
    param([string]$Path)

    $stream = [System.IO.File]::OpenRead($Path)
    try {
        $buffer = New-Object byte[] 4
        $null = $stream.Read($buffer, 0, 4)
        [System.Text.Encoding]::ASCII.GetString($buffer)
    }
    finally {
        $stream.Dispose()
    }
}

function Ensure-WixTool {
    param([string]$Version)

    $toolRoot = Join-Path $env:TEMP 'openflux-wix-tool'
    $toolExe = Join-Path $toolRoot 'wix.exe'
    if (Test-Path $toolExe) {
        return $toolExe
    }

    New-Item -ItemType Directory -Path $toolRoot -Force | Out-Null
    Write-Host "[prepare-vc-runtime] Installing WiX toolset $Version..."
    dotnet tool install wix --version $Version --tool-path $toolRoot | Out-Host

    if (!(Test-Path $toolExe)) {
        throw "WiX tool install succeeded but wix.exe was not found: $toolExe"
    }

    return $toolExe
}

function New-TempDirectory {
    param([string]$Name)

    $path = Join-Path $env:TEMP ("openflux-{0}-{1}" -f $Name, [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $path | Out-Null
    $path
}

$expectedFiles = Get-ExpectedRuntimeFiles
$wixExe = Ensure-WixTool -Version $WixVersion
$workspace = New-TempDirectory -Name 'vc-runtime'

try {
    if ([string]::IsNullOrWhiteSpace($SourceExe)) {
        $SourceExe = Join-Path $workspace 'vc_redist.x64.exe'
        Write-Host "[prepare-vc-runtime] Downloading latest VC++ runtime from $SourceUrl..."
        Invoke-WebRequest -Uri $SourceUrl -OutFile $SourceExe
    } elseif (!(Test-Path $SourceExe)) {
        throw "Source exe not found: $SourceExe"
    }

    $bundleVersion = (Get-Item $SourceExe).VersionInfo.FileVersion
    Write-Host "[prepare-vc-runtime] Source bundle version: $bundleVersion"

    $extractDir = Join-Path $workspace 'bundle'
    & $wixExe burn extract $SourceExe -o $extractDir | Out-Host

    $candidateRoots = @()
    foreach ($item in Get-ChildItem $extractDir -File) {
        if ((Get-FileHeader -Path $item.FullName) -ne 'MSCF') {
            continue
        }

        $cabPath = Join-Path $workspace ($item.Name + '.cab')
        $cabDir = Join-Path $workspace ($item.Name + '-expand')
        Copy-Item $item.FullName $cabPath -Force
        New-Item -ItemType Directory -Path $cabDir -Force | Out-Null
        expand.exe $cabPath -F:* $cabDir | Out-Host

        $hasAllFiles = $true
        foreach ($name in $expectedFiles) {
            if (!(Test-Path (Join-Path $cabDir ($name + '_amd64')))) {
                $hasAllFiles = $false
                break
            }
        }

        if ($hasAllFiles) {
            $candidateRoots += $cabDir
        }
    }

    if ($candidateRoots.Count -ne 1) {
        throw "Expected exactly one x64 CRT payload candidate, found $($candidateRoots.Count)."
    }

    $selectedRoot = $candidateRoots[0]
    Write-Host "[prepare-vc-runtime] Using extracted payload: $selectedRoot"

    if (Test-Path $DestinationDir) {
        Remove-Item $DestinationDir -Recurse -Force
    }
    New-Item -ItemType Directory -Path $DestinationDir | Out-Null

    foreach ($name in $expectedFiles) {
        Copy-Item (Join-Path $selectedRoot ($name + '_amd64')) (Join-Path $DestinationDir $name) -Force
    }

    $runtimeFiles = @(Get-ChildItem $DestinationDir -File -Filter *.dll | Sort-Object Name)
    $runtimeVersions = @($runtimeFiles | ForEach-Object { $_.VersionInfo.FileVersion } | Sort-Object -Unique)
    if ($runtimeVersions.Count -ne 1) {
        throw "Expected a single CRT runtime version, found: $($runtimeVersions -join ', ')"
    }

    $manifest = [ordered]@{
        source = [ordered]@{
            kind = 'official_vc_redist_x64'
            url = $SourceUrl
            originalFilename = 'VC_redist.x64.exe'
            bundleVersion = $bundleVersion
            extractionMethod = 'wix burn extract + cab expand'
            selectionBasis = 'Microsoft.VC143.CRT x64 retail file set'
            preparedAtUtc = ((Get-Date).ToUniversalTime().ToString('o'))
        }
        runtimeVersion = $runtimeVersions[0]
        files = @(
            foreach ($file in $runtimeFiles) {
                [ordered]@{
                    name = $file.Name
                    size = $file.Length
                    sha256 = (Get-FileHash $file.FullName -Algorithm SHA256).Hash.ToLower()
                }
            }
        )
    }

    $manifestPath = Join-Path $DestinationDir 'manifest.json'
    $manifest | ConvertTo-Json -Depth 5 | Set-Content $manifestPath -Encoding UTF8
    Write-Host "[prepare-vc-runtime] Runtime prepared at $DestinationDir"
}
finally {
    if (Test-Path $workspace) {
        Remove-Item $workspace -Recurse -Force
    }
}
