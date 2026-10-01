# Общие операции переноса состояния Trellis. Файл вызывается только командами
# backup.ps1 и restore.ps1; он не изменяет данные при загрузке.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:WorkspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$script:IdentityCompose = Join-Path $PSScriptRoot 'identity\keycloak\compose.yaml'
$script:KnowledgeCompose = Join-Path $PSScriptRoot 'compose.yaml'
$script:IdentityEnv = Join-Path $PSScriptRoot 'identity\keycloak\.env'
$script:KnowledgeEnv = Join-Path $PSScriptRoot '.env'
$script:MigrationsDirectory = Join-Path $PSScriptRoot 'server\migrations'

# Выполняет Docker CLI и считает ненулевой код завершения ошибкой. Вывод
# возвращается вызывающей команде, чтобы секреты Compose не печатались случайно.
function Invoke-Docker {
    param([Parameter(Mandatory)][string[]]$Arguments)
    $output = & docker @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Docker command failed (exit $LASTEXITCODE): docker $($Arguments -join ' ')"
    }
    return $output
}

# Читает фактическую конфигурацию Compose. Режим без интерполяции позволяет
# проверить чистый целевой ПК до создания локальных файлов с паролями.
function Get-ComposeConfig {
    param([Parameter(Mandatory)][string]$ComposeFile, [switch]$NoInterpolate)
    $arguments = @('compose', '-f', $ComposeFile, 'config')
    if ($NoInterpolate) { $arguments += '--no-interpolate' }
    $arguments += @('--format', 'json')
    $json = @(Invoke-Docker -Arguments $arguments) -join "`n"
    return $json | ConvertFrom-Json
}

# Возвращает точное имя тома из Compose, не полагаясь на рабочий каталог или
# случайно выбранный пользователем префикс проекта.
function Get-ComposeVolumeName {
    param([Parameter(Mandatory)]$Config, [Parameter(Mandatory)][string]$Key)
    $entry = $Config.volumes.PSObject.Properties[$Key]
    if ($null -eq $entry -or [string]::IsNullOrWhiteSpace($entry.Value.name)) {
        throw "Compose volume '$Key' has no resolved name"
    }
    return [string]$entry.Value.name
}

# Вычисляет контрольные суммы SQL-миграций по именам. Восстановление требует
# того же набора схем, чтобы API не запускался на несовместимой базе.
function Get-MigrationHashes {
    $result = [ordered]@{}
    Get-ChildItem -LiteralPath $script:MigrationsDirectory -File -Filter '*.sql' |
        Sort-Object Name | ForEach-Object {
            $result[$_.Name] = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    return $result
}

# Генерирует URL-safe пароль из криптографически случайных байтов. Символы
# подходят для Docker .env без кавычек и интерполяции Compose.
function New-TransferPassword {
    $bytes = New-Object byte[] 32
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

# Записывает локальный .env в UTF-8 без BOM, поскольку Windows PowerShell 5.1
# добавляет BOM при обычном Set-Content -Encoding UTF8.
function Write-TransferEnv {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Content)
    if (Test-Path -LiteralPath $Path) { throw "Refusing to replace existing file: $Path" }
    [IO.File]::WriteAllText($Path, $Content, (New-Object Text.UTF8Encoding($false)))
}

# Находит контейнер конкретного Compose-сервиса. Перенос работает только с
# уже существующим источником и не должен случайно создать пустую базу.
function Get-ComposeContainerId {
    param([Parameter(Mandatory)][string]$ComposeFile, [Parameter(Mandatory)][string]$Service)
    $id = @(Invoke-Docker -Arguments @('compose', '-f', $ComposeFile, 'ps', '-q', $Service)) -join ''
    if ([string]::IsNullOrWhiteSpace($id)) { throw "Container for service '$Service' does not exist" }
    return $id.Trim()
}

# Проверяет, что сервис действительно работает до остановки записи. Состояние
# исходных сервисов после снимка восстанавливается без создания новых томов.
function Assert-ContainerRunning {
    param([Parameter(Mandatory)][string]$ContainerId)
    $running = @(Invoke-Docker -Arguments @('inspect', '--format', '{{.State.Running}}', $ContainerId)) -join ''
    if ($running.Trim() -ne 'true') { throw "Container $ContainerId is not running" }
}

# Проверяет целостность ожидаемых файлов снимка до любого изменения целевого
# Docker. SHA-256 обнаруживает неполное копирование или повреждение архива.
function Assert-SnapshotFiles {
    param([Parameter(Mandatory)][string]$SnapshotPath, [Parameter(Mandatory)]$Manifest)
    foreach ($name in @('identity.dump', 'knowledge.dump', 'repositories.tar')) {
        $entry = $Manifest.files.PSObject.Properties[$name]
        if ($null -eq $entry -or [string]::IsNullOrWhiteSpace($entry.Value)) {
            throw "Snapshot manifest lacks checksum for $name"
        }
        $file = Join-Path $SnapshotPath $name
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Snapshot file is missing: $name" }
        $actual = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne [string]$entry.Value) { throw "Snapshot checksum mismatch: $name" }
    }
}
