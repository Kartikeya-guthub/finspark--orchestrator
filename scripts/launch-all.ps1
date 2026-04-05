param(
    [switch]$ForceRestart
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $repoRoot

function Load-DotEnv {
    param(
        [Parameter(Mandatory = $true)]
        [string]$EnvFilePath
    )

    if (-not (Test-Path $EnvFilePath)) {
        Write-Warning ".env file not found at $EnvFilePath. Continuing with existing shell environment values."
        return
    }

    Get-Content $EnvFilePath | ForEach-Object {
        $line = $_.Trim()
        if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith("#")) {
            return
        }

        $parts = $line.Split("=", 2)
        if ($parts.Count -ne 2) {
            return
        }

        $key = $parts[0].Trim()
        $value = $parts[1].Trim()

        if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
            $value = $value.Substring(1, $value.Length - 2)
        }

        [System.Environment]::SetEnvironmentVariable($key, $value, "Process")
    }
}

function Stop-ListenerOnPort {
    param(
        [Parameter(Mandatory = $true)]
        [int]$Port
    )

    $connections = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
    if (-not $connections) {
        return
    }

    $pids = $connections | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($processId in $pids) {
        try {
            Stop-Process -Id $processId -Force -ErrorAction Stop
            Write-Host "Stopped PID $processId on port $Port"
        } catch {
            Write-Warning "Failed to stop PID $processId on port ${Port}: $($_.Exception.Message)"
        }
    }
}

if ($ForceRestart) {
    Write-Host "Force restart requested. Stopping compose stack and known service ports..."
    docker compose down | Out-Host

    @(3000, 3001, 8000, 8002, 8003, 5432, 6379, 9000, 9001) | ForEach-Object {
        Stop-ListenerOnPort -Port $_
    }
}

Load-DotEnv -EnvFilePath (Join-Path $repoRoot ".env")

$pythonExe = Join-Path $repoRoot ".venv\Scripts\python.exe"
if (-not (Test-Path $pythonExe)) {
    throw "Python executable not found at $pythonExe. Create or activate .venv first."
}

Write-Host "Starting infrastructure containers..."
docker compose up -d | Out-Host

$serviceCommands = @(
    @{
        Name = "Finspark API"
        Command = "Set-Location '$repoRoot'; npm run dev:api"
    },
    @{
        Name = "Finspark AI Service"
        Command = "Set-Location '$repoRoot\apps\ai-service'; & '$pythonExe' main.py --port 8002"
    },
    @{
        Name = "Finspark Simulator"
        Command = "Set-Location '$repoRoot'; npm --workspace @finspark/simulator run dev"
    },
    @{
        Name = "Finspark Web"
        Command = "Set-Location '$repoRoot'; npm --workspace @finspark/web run dev"
    }
)

foreach ($service in $serviceCommands) {
    Write-Host "Starting $($service.Name)..."
    Start-Process powershell -ArgumentList @("-NoExit", "-Command", $service.Command) | Out-Null
}

Write-Host "All launch commands dispatched."
Write-Host "Use scripts/launch-all.ps1 -ForceRestart if you want a clean restart next time."
