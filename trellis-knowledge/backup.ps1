# Создаёт согласованный снимок двух баз и bare Git-репозиториев Trellis.
# Пример: powershell -File trellis-knowledge/backup.ps1 -OutputPath D:\backups\trellis-2026-10-01
param([Parameter(Mandatory)][string]$OutputPath)
. (Join-Path $PSScriptRoot 'transfer-common.ps1')

$target = [IO.Path]::GetFullPath($OutputPath)
$workspacePrefix = $script:WorkspaceRoot.TrimEnd([char]92, [char]47) + [IO.Path]::DirectorySeparatorChar
if ($target.StartsWith($workspacePrefix, [StringComparison]::OrdinalIgnoreCase) -or
    $target.Equals($script:WorkspaceRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Snapshot must be stored outside the Trellis repository'
}
if (Test-Path -LiteralPath $target) { throw "Snapshot path already exists: $target" }
$parent = Split-Path -Parent $target
if (-not (Test-Path -LiteralPath $parent -PathType Container)) { throw "Parent directory does not exist: $parent" }

$identity = Get-ComposeConfig -ComposeFile $script:IdentityCompose
$knowledge = Get-ComposeConfig -ComposeFile $script:KnowledgeCompose
$identityHost = [string]$identity.services.keycloak.environment.KC_HOSTNAME
$issuer = [string]$knowledge.services.api.environment.OIDC_ISSUER
if ($issuer -ne "$identityHost/realms/trellis") { throw 'Identity hostname and Knowledge OIDC issuer differ' }

$keycloakId = Get-ComposeContainerId -ComposeFile $script:IdentityCompose -Service 'keycloak'
$identityDbId = Get-ComposeContainerId -ComposeFile $script:IdentityCompose -Service 'postgres'
$knowledgeDbId = Get-ComposeContainerId -ComposeFile $script:KnowledgeCompose -Service 'postgres'
$apiId = Get-ComposeContainerId -ComposeFile $script:KnowledgeCompose -Service 'api'
$webId = Get-ComposeContainerId -ComposeFile $script:KnowledgeCompose -Service 'web'
foreach ($id in @($keycloakId, $identityDbId, $knowledgeDbId, $apiId, $webId)) {
    Assert-ContainerRunning -ContainerId $id
}

# Не останавливаем действующий Keycloak, если его контейнер всё ещё создан из
# старого Compose с принудительным импортом: повторный старт стёр бы realm.
$expectedHashLine = @(Invoke-Docker -Arguments @('compose', '-f', $script:IdentityCompose, 'config', '--hash', 'keycloak')) -join ''
$expectedHash = ($expectedHashLine.Trim() -split '\s+')[-1]
$runningConfig = (@(Invoke-Docker -Arguments @('inspect', $keycloakId)) -join "`n") | ConvertFrom-Json
$actualHash = [string]$runningConfig[0].Config.Labels.'com.docker.compose.config-hash'
if ($actualHash -ne $expectedHash) {
    throw 'Keycloak container is not using current Compose configuration; recreate it before backup'
}
$command = @(Invoke-Docker -Arguments @('inspect', '--format', '{{json .Config.Cmd}}', $keycloakId)) -join ''
if ($command -match 'override\s+true') { throw 'Keycloak still has destructive realm import enabled' }

$repositoryVolume = Get-ComposeVolumeName -Config $knowledge -Key 'repositories-data'
$availableVolumes = @(Invoke-Docker -Arguments @('volume', 'ls', '--format', '{{.Name}}'))
if ($availableVolumes -notcontains $repositoryVolume) { throw "Repository volume does not exist: $repositoryVolume" }

$identityTemp = '/tmp/trellis-identity-' + [guid]::NewGuid().ToString('N') + '.dump'
$knowledgeTemp = '/tmp/trellis-knowledge-' + [guid]::NewGuid().ToString('N') + '.dump'
$freezeAttempted = $false
$failure = $null
try {
    $freezeAttempted = $true
    $null = Invoke-Docker -Arguments @('compose', '-f', $script:KnowledgeCompose, 'stop', 'web', 'api')
    $null = Invoke-Docker -Arguments @('compose', '-f', $script:IdentityCompose, 'stop', 'keycloak')

    $null = New-Item -ItemType Directory -Path $target
    $null = Invoke-Docker -Arguments @('exec', $identityDbId, 'pg_dump', '-U', 'keycloak', '-d', 'keycloak', '-Fc', '-f', $identityTemp)
    $null = Invoke-Docker -Arguments @('cp', "${identityDbId}:$identityTemp", (Join-Path $target 'identity.dump'))
    $null = Invoke-Docker -Arguments @('exec', $knowledgeDbId, 'pg_dump', '-U', 'knowledge', '-d', 'knowledge', '-Fc', '-f', $knowledgeTemp)
    $null = Invoke-Docker -Arguments @('cp', "${knowledgeDbId}:$knowledgeTemp", (Join-Path $target 'knowledge.dump'))
    $null = Invoke-Docker -Arguments @('run', '--rm', '--mount', "type=volume,source=$repositoryVolume,target=/data,readonly", '--mount', "type=bind,source=$target,target=/backup", [string]$knowledge.services.postgres.image, 'tar', '-C', '/data', '-cf', '/backup/repositories.tar', '.')

    $files = [ordered]@{}
    foreach ($name in @('identity.dump', 'knowledge.dump', 'repositories.tar')) {
        $file = Join-Path $target $name
        if ((Get-Item -LiteralPath $file).Length -eq 0) { throw "Empty snapshot file: $name" }
        $files[$name] = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    $manifest = [ordered]@{
        formatVersion = 1
        createdUtc = [DateTime]::UtcNow.ToString('o')
        issuer = $issuer
        versions = [ordered]@{
            keycloak = [string]$identity.services.keycloak.image
            identityPostgres = [string]$identity.services.postgres.image
            knowledgePostgres = [string]$knowledge.services.postgres.image
            migrations = Get-MigrationHashes
        }
        files = $files
    }
    $json = $manifest | ConvertTo-Json -Depth 10
    [IO.File]::WriteAllText((Join-Path $target 'manifest.json'), $json + "`n", (New-Object Text.UTF8Encoding($false)))
} catch {
    $failure = $_
} finally {
    $null = & docker exec $identityDbId rm -f $identityTemp
    $null = & docker exec $knowledgeDbId rm -f $knowledgeTemp
    if ($freezeAttempted) {
        try {
            $null = Invoke-Docker -Arguments @('compose', '-f', $script:IdentityCompose, 'up', '-d', '--wait', '--no-recreate', 'keycloak')
            $null = Invoke-Docker -Arguments @('compose', '-f', $script:KnowledgeCompose, 'up', '-d', '--wait', '--no-recreate', 'api', 'web')
        } catch {
            if ($null -eq $failure) { $failure = $_ }
            else { Write-Warning "Source services could not be fully restarted: $_" }
        }
    }
}
if ($null -ne $failure) { throw $failure }
Write-Output "Snapshot created: $target"
