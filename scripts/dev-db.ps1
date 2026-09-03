<#
.SYNOPSIS
    Manages the throwaway PostgreSQL cluster used by Learno's tests.

.DESCRIPTION
    The developer machine already runs a PostgreSQL service on port 5432 that
    belongs to the person using it, and whose superuser password is none of our
    business. So the test suite gets its own cluster instead: a separate data
    directory on port 5433, listening on loopback only, with trust
    authentication and no password anywhere.

    Nothing here touches the machine's existing PostgreSQL service. Deleting the
    data directory is always safe: 'reset' recreates it from nothing.

    fsync and full_page_writes are off. That trades crash durability for test
    speed, which is the right trade for a database whose entire contents are
    disposable — never copy this configuration to anything that holds real data.

.EXAMPLE
    ./scripts/dev-db.ps1 start
    ./scripts/dev-db.ps1 status
    ./scripts/dev-db.ps1 reset
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('start', 'stop', 'status', 'reset', 'url', 'psql')]
    [string]$Command = 'status'
)

$ErrorActionPreference = 'Stop'

$PgBin = 'C:/Program Files/PostgreSQL/18/bin'
$DataDir = 'C:/dev/learno-testdb'
$Port = 5433
$SuperUser = 'learno'
$DevDatabase = 'learno_dev'
$TestDatabase = 'learno_test'

$DevUrl = "postgres://$SuperUser@127.0.0.1:$Port/$DevDatabase"
$TestUrl = "postgres://$SuperUser@127.0.0.1:$Port/$TestDatabase"

function Test-Running {
    & "$PgBin/pg_isready.exe" -h 127.0.0.1 -p $Port *> $null
    return $LASTEXITCODE -eq 0
}

function Start-Cluster {
    if (Test-Running) {
        Write-Host "already accepting connections on port $Port"
        return
    }
    if (-not (Test-Path $DataDir)) {
        throw "data directory $DataDir does not exist - run 'reset' to create it"
    }
    # pg_ctl -w can stay attached to the console on Windows, so start it
    # detached and poll pg_isready ourselves instead.
    Start-Process -FilePath "$PgBin/pg_ctl.exe" `
        -ArgumentList @('-D', $DataDir, '-l', "$DataDir/server.log", 'start') `
        -WindowStyle Hidden
    foreach ($attempt in 1..30) {
        Start-Sleep -Milliseconds 400
        if (Test-Running) {
            Write-Host "started on port $Port after $attempt attempt(s)"
            return
        }
    }
    throw "cluster did not accept connections within 12s - see $DataDir/server.log"
}

function Stop-Cluster {
    if (-not (Test-Running)) {
        Write-Host 'not running'
        return
    }
    & "$PgBin/pg_ctl.exe" -D $DataDir -m fast stop
    Write-Host 'stopped'
}

function Reset-Cluster {
    if (Test-Running) { Stop-Cluster }
    if (Test-Path $DataDir) { Remove-Item -Recurse -Force $DataDir }
    & "$PgBin/initdb.exe" -D $DataDir -U $SuperUser -A trust -E UTF8 --locale=C
    Add-Content -Path "$DataDir/postgresql.conf" -Encoding utf8 -Value @(
        "port = $Port"
        "listen_addresses = '127.0.0.1'"
        'fsync = off'
        'synchronous_commit = off'
        'full_page_writes = off'
    )
    Start-Cluster
    & "$PgBin/createdb.exe" -h 127.0.0.1 -p $Port -U $SuperUser $DevDatabase
    & "$PgBin/createdb.exe" -h 127.0.0.1 -p $Port -U $SuperUser $TestDatabase
    Write-Host "recreated $DevDatabase and $TestDatabase"
}

switch ($Command) {
    'start' { Start-Cluster }
    'stop' { Stop-Cluster }
    'reset' { Reset-Cluster }
    'url' {
        Write-Host "DATABASE_URL=$DevUrl"
        Write-Host "LEARNO_TEST_DATABASE_URL=$TestUrl"
    }
    'psql' { & "$PgBin/psql.exe" -h 127.0.0.1 -p $Port -U $SuperUser -d $DevDatabase }
    'status' {
        if (Test-Running) {
            Write-Host "running on port $Port"
            & "$PgBin/psql.exe" -h 127.0.0.1 -p $Port -U $SuperUser -d $DevDatabase -t `
                -c 'select current_database(), version();'
        }
        else {
            Write-Host "not running (data directory: $DataDir)"
        }
    }
}
