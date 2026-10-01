# Восстанавливает снимок Trellis только в чистое локальное Docker-окружение.
# Пример: powershell -File trellis-knowledge/restore.ps1 -SnapshotPath D:\backups\trellis-2026-10-01
param([Parameter(Mandatory)][string]$SnapshotPath)
. (Join-Path $PSScriptRoot 'transfer-common.ps1')

$snapshot = [IO.Path]::GetFullPath($SnapshotPath)
$manifestFile = Join-Path $snapshot 'manifest.json'
if (-not (Test-Path -LiteralPath $manifestFile -PathType Leaf)) { throw 'Snapshot manifest.json is missing' }
$manifest = Get-Content -LiteralPath $manifestFile -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.formatVersion -ne 1) { throw 'Unsupported snapshot format version' }
Assert-SnapshotFiles -SnapshotPath $snapshot -Manifest $manifest

$identity = Get-ComposeConfig -ComposeFile $script:IdentityCompose -NoInterpolate
$knowledge = Get-ComposeConfig -ComposeFile $script:KnowledgeCompose -NoInterpolate
if ([string]$manifest.versions.keycloak -ne [string]$identity.services.keycloak.image -or
    [string]$manifest.versions.identityPostgres -ne [string]$identity.services.postgres.image -or
    [string]$manifest.versions.knowledgePostgres -ne [string]$knowledge.services.postgres.image) {
    throw 'Snapshot database or Keycloak image versions differ from this checkout'
}
$localMigrations = Get-MigrationHashes
$savedMigrations = $manifest.versions.migrations
if ($null -eq $savedMigrations -or @($savedMigrations.PSObject.Properties).Count -ne $localMigrations.Count) {
    throw 'Snapshot migration set differs from this checkout'
}
foreach ($name in $localMigrations.Keys) {
    $entry = $savedMigrations.PSObject.Properties[$name]
    if ($null -eq $entry -or [string]$entry.Value -ne $localMigrations[$name]) {
        throw "Snapshot migration differs: $name"
    }
}
$issuer = [string]$manifest.issuer
$issuerUri = $null
if (-not [Uri]::TryCreate($issuer, [UriKind]::Absolute, [ref]$issuerUri) -or
    $issuerUri.Host -ne 'localhost' -or $issuerUri.Scheme -ne 'http' -or
    $issuerUri.AbsolutePath -ne '/realms/trellis') {
    throw 'Snapshot issuer must be a local Trellis realm'
}
if ([string]$knowledge.services.api.environment.OIDC_ISSUER -ne $issuer) {
    throw 'Knowledge OIDC issuer differs from the snapshot'
}

# Целевой ПК должен быть пустым до создания паролей и томов. Проверка точных
# имён не разрешает восстановлению перезаписать даже остановленные контейнеры.
$projects = @([string]$identity.name, [string]$knowledge.name)
foreach ($project in $projects) {
    $containers = @(Invoke-Docker -Arguments @('ps', '-a', '--filter', "label=com.docker.compose.project=$project", '--format', '{{.ID}}'))
    if ($containers.Count -gt 0) { throw "Trellis containers already exist in project $project" }
}
$identityVolume = Get-ComposeVolumeName -Config $identity -Key 'postgres-data'
$knowledgeVolume = Get-ComposeVolumeName -Config $knowledge -Key 'postgres-data'
$repositoryVolume = Get-ComposeVolumeName -Config $knowledge -Key 'repositories-data'
$existingVolumes = @(Invoke-Docker -Arguments @('volume', 'ls', '--format', '{{.Name}}'))
foreach ($volume in @($identityVolume, $knowledgeVolume, $repositoryVolume)) {
    if ($existingVolumes -contains $volume) { throw "Trellis volume already exists: $volume" }
}
foreach ($envFile in @($script:IdentityEnv, $script:KnowledgeEnv)) {
    if (Test-Path -LiteralPath $envFile) { throw "Local .env already exists: $envFile" }
}

$identityPassword = New-TransferPassword
$knowledgePassword = New-TransferPassword
$bootstrapPassword = New-TransferPassword
$identityEnvContent = "POSTGRES_PASSWORD=$identityPassword`nKC_BOOTSTRAP_ADMIN_USERNAME=admin`nKC_BOOTSTRAP_ADMIN_PASSWORD=$bootstrapPassword`nKEYCLOAK_PORT=$($issuerUri.Port)`n"
$knowledgeEnvContent = "KNOWLEDGE_DB_PASSWORD=$knowledgePassword`n"
$createdEnvironment = $false
$completed = $false
$identityDbId = $null
$knowledgeDbId = $null
$identityTemp = '/tmp/trellis-identity-' + [guid]::NewGuid().ToString('N') + '.dump'
$knowledgeTemp = '/tmp/trellis-knowledge-' + [guid]::NewGuid().ToString('N') + '.dump'
try {
    Write-TransferEnv -Path $script:IdentityEnv -Content $identityEnvContent
    $createdEnvironment = $true
    Write-TransferEnv -Path $script:KnowledgeEnv -Content $knowledgeEnvContent

    $resolvedIdentity = Get-ComposeConfig -ComposeFile $script:IdentityCompose
    if ([string]$resolvedIdentity.services.keycloak.environment.KC_HOSTNAME -ne $issuerUri.GetLeftPart([UriPartial]::Authority)) {
        throw 'Keycloak hostname differs from the snapshot issuer'
    }
    $null = Invoke-Docker -Arguments @('compose', '-f', $script:IdentityCompose, 'up', '-d', '--wait', 'postgres')
    $null = Invoke-Docker -Arguments @('compose', '-f', $script:KnowledgeCompose, 'up', '-d', '--wait', 'postgres')
    $identityDbId = Get-ComposeContainerId -ComposeFile $script:IdentityCompose -Service 'postgres'
    $knowledgeDbId = Get-ComposeContainerId -ComposeFile $script:KnowledgeCompose -Service 'postgres'

    $null = Invoke-Docker -Arguments @('cp', (Join-Path $snapshot 'identity.dump'), "${identityDbId}:$identityTemp")
    $null = Invoke-Docker -Arguments @('exec', $identityDbId, 'pg_restore', '--exit-on-error', '--single-transaction', '--no-owner', '--no-acl', '-U', 'keycloak', '-d', 'keycloak', $identityTemp)
    $null = Invoke-Docker -Arguments @('cp', (Join-Path $snapshot 'knowledge.dump'), "${knowledgeDbId}:$knowledgeTemp")
    $null = Invoke-Docker -Arguments @('exec', $knowledgeDbId, 'pg_restore', '--exit-on-error', '--single-transaction', '--no-owner', '--no-acl', '-U', 'knowledge', '-d', 'knowledge', $knowledgeTemp)

    # Compose должен владеть томом, чтобы повторный up и аварийный down -v
    # одинаково распознавали его как часть целевого Knowledge-проекта.
    $null = Invoke-Docker -Arguments @('volume', 'create', '--label', "com.docker.compose.project=$($knowledge.name)", '--label', 'com.docker.compose.volume=repositories-data', $repositoryVolume)
    $null = Invoke-Docker -Arguments @('run', '--rm', '--mount', "type=volume,source=$repositoryVolume,target=/data", '--mount', "type=bind,source=$snapshot,target=/backup,readonly", [string]$knowledge.services.postgres.image, 'tar', '-C', '/data', '-xf', '/backup/repositories.tar')

    $null = Invoke-Docker -Arguments @('compose', '-f', $script:IdentityCompose, 'up', '-d', '--wait', 'keycloak')
    $null = Invoke-Docker -Arguments @('compose', '-f', $script:KnowledgeCompose, 'up', '-d', '--build', '--wait', 'api', 'web')
    $completed = $true
} finally {
    if ($identityDbId) { $null = & docker exec $identityDbId rm -f $identityTemp }
    if ($knowledgeDbId) { $null = & docker exec $knowledgeDbId rm -f $knowledgeTemp }
    if (-not $completed -and $createdEnvironment) {
        # Эти проекты и тома отсутствовали до начала команды; удаляем только
        # созданное данным запуском, чтобы повтор восстановления был безопасен.
        $null = & docker compose -f $script:KnowledgeCompose down -v
        $null = & docker compose -f $script:IdentityCompose down -v
        foreach ($envFile in @($script:IdentityEnv, $script:KnowledgeEnv)) {
            if (Test-Path -LiteralPath $envFile) { Remove-Item -LiteralPath $envFile -Force }
        }
    }
}
Write-Output "Snapshot restored: $snapshot"
Write-Output 'Use the source Keycloak user and administrator passwords and existing agent tokens.'
