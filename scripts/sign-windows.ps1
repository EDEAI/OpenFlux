param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$FilePath
)

$ErrorActionPreference = 'Stop'

$endpoint = 'https://eus.codesigning.azure.net'
$account = 'openflux'
$certificateProfile = 'OpenFlux-Production'
$description = 'OpenFlux'
$timestampUrl = 'http://timestamp.acs.microsoft.com'
$resolvedFile = (Resolve-Path -LiteralPath $FilePath).Path

$hasServicePrincipal =
    -not [string]::IsNullOrWhiteSpace($env:AZURE_TENANT_ID) -and
    -not [string]::IsNullOrWhiteSpace($env:AZURE_CLIENT_ID) -and
    -not [string]::IsNullOrWhiteSpace($env:AZURE_CLIENT_SECRET)

if ($hasServicePrincipal) {
    & artifact-signing-cli `
        -e $endpoint `
        -a $account `
        -c $certificateProfile `
        -d $description `
        $resolvedFile
    if ($LASTEXITCODE -ne 0) {
        throw "artifact-signing-cli failed with exit code $LASTEXITCODE"
    }
    exit 0
}

# Local release fallback: Azure's signing DLib can reuse an existing Azure CLI
# login, avoiding persistent service-principal secrets on a developer machine.
$userProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
$dlibPath = Join-Path $userProfile '.artifact-signing-cli\lib\bin\x64\Azure.CodeSigning.Dlib.dll'
if (-not (Test-Path -LiteralPath $dlibPath)) {
    throw "Azure Artifact Signing DLib was not found at $dlibPath"
}

$signToolPath = $env:SIGNTOOL_PATH
if ([string]::IsNullOrWhiteSpace($signToolPath)) {
    $windowsKitsRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
    $signToolPath = Get-ChildItem -LiteralPath $windowsKitsRoot -Filter 'signtool.exe' -Recurse -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' } |
        Sort-Object FullName -Descending |
        Select-Object -First 1 -ExpandProperty FullName
}
if ([string]::IsNullOrWhiteSpace($signToolPath) -or -not (Test-Path -LiteralPath $signToolPath)) {
    throw 'A Windows SDK x64 signtool.exe installation is required'
}

$metadataPath = Join-Path ([IO.Path]::GetTempPath()) ("openflux-artifact-signing-{0}.json" -f [Guid]::NewGuid().ToString('N'))
try {
    $metadataJson = [ordered]@{
        Endpoint = $endpoint
        CodeSigningAccountName = $account
        CertificateProfileName = $certificateProfile
    } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($metadataPath, $metadataJson, [Text.UTF8Encoding]::new($false))

    & $signToolPath sign `
        /v `
        /fd SHA256 `
        /tr $timestampUrl `
        /td SHA256 `
        /dlib $dlibPath `
        /dmdf $metadataPath `
        /d $description `
        $resolvedFile
    if ($LASTEXITCODE -ne 0) {
        throw "signtool failed with exit code $LASTEXITCODE"
    }
} finally {
    Remove-Item -LiteralPath $metadataPath -Force -ErrorAction SilentlyContinue
}
