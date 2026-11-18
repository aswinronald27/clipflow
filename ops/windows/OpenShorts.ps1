param(
    [ValidateSet('Start', 'Stop')]
    [string]$Action = 'Start'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
Set-Location -LiteralPath $repoRoot

function Test-DockerReady {
    # Windows PowerShell can turn native stderr into terminating errors when
    # Docker is still starting. Treat that state as not ready and keep polling.
    $ErrorActionPreference = 'Continue'
    & docker info *> $null
    return $LASTEXITCODE -eq 0
}

function Wait-Endpoint([string]$Url, [int]$TimeoutSeconds = 180) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        try {
            $response = Invoke-WebRequest -Uri $Url -Headers @{ Accept = 'text/html, application/json' } -UseBasicParsing -TimeoutSec 3
            if ($response.StatusCode -eq 200) { return }
        } catch { }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)
    throw "Timed out waiting for $Url. Check the services with: docker compose logs --tail 80"
}

try {
    if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
        throw 'Docker Desktop is required. Install it and complete its initial setup first.'
    }

    if (-not (Test-DockerReady)) {
        if ($Action -eq 'Stop') {
            Write-Host 'Docker is not running. There is nothing to stop.'
            exit 0
        }
        $dockerDesktop = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
        if (-not (Test-Path -LiteralPath $dockerDesktop)) {
            throw 'Docker Desktop was not found. Start Docker manually and try again.'
        }
        Write-Host 'Starting Docker Desktop...'
        Start-Process -FilePath $dockerDesktop -WindowStyle Hidden
        $deadline = (Get-Date).AddSeconds(180)
        while (-not (Test-DockerReady)) {
            if ((Get-Date) -ge $deadline) {
                throw 'Docker did not become ready. Open Docker Desktop and check its status.'
            }
            Start-Sleep -Seconds 3
        }
    }

    if ($Action -eq 'Stop') {
        Write-Host 'Stopping OpenShorts...'
        & docker compose stop
        if ($LASTEXITCODE -ne 0) { throw 'Could not stop OpenShorts.' }
        exit 0
    }

    Write-Host 'Starting OpenShorts using the existing local images...'
    & docker compose up -d --no-build --pull never
    if ($LASTEXITCODE -ne 0) {
        throw 'Startup failed. If the initial build has not finished, run docker compose up --build -d in the repository first. Otherwise check the Docker error above.'
    }
    Write-Host 'Waiting for the backend and dashboard...'
    Wait-Endpoint 'http://localhost:8000/health/ready'
    Wait-Endpoint 'http://localhost:5175'
    Start-Process 'http://localhost:5175'
} catch {
    Write-Host "`nOpenShorts: $($_.Exception.Message)" -ForegroundColor Red
    Read-Host 'Press Enter to close'
    exit 1
}
