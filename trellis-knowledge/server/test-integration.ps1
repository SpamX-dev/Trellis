# Запускает интеграционный сценарий в отдельной одноразовой базе Knowledge.
# Имя создаётся здесь, а база удаляется в finally; рабочая база не меняется.
$ErrorActionPreference = 'Stop'
$workspaceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$composeFile = Join-Path $workspaceRoot 'trellis-knowledge\compose.yaml'
$testFile = Join-Path $PSScriptRoot 'integration.test.mjs'
$testDatabase = 'knowledge_stage1_test_' + [guid]::NewGuid().ToString('N')
$created = $false

try {
    docker compose -f $composeFile up -d --wait postgres
    if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL failed to start' }
    docker compose -f $composeFile build api
    if ($LASTEXITCODE -ne 0) { throw 'API image build failed' }
    docker compose -f $composeFile exec -T postgres psql -U knowledge -d postgres -c "CREATE DATABASE $testDatabase"
    if ($LASTEXITCODE -ne 0) { throw 'Test database was not created' }
    $created = $true
    docker compose -f $composeFile run --rm -T --no-deps -e "PGDATABASE=$testDatabase" -v "${testFile}:/app/trellis-knowledge/server/integration.test.mjs:ro" api node --test trellis-knowledge/server/integration.test.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Integration test failed' }
} finally {
    if ($created) {
        docker compose -f $composeFile exec -T postgres psql -U knowledge -d postgres -c "DROP DATABASE $testDatabase WITH (FORCE)"
    }
}
