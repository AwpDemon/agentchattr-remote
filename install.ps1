# agentchattr Remote Agent Installer (Windows)
# Usage: powershell -ExecutionPolicy Bypass -File install.ps1 -AgentName "awppc" -Token "your-token"

param(
    [Parameter(Mandatory=$true)]
    [string]$AgentName,

    [Parameter(Mandatory=$true)]
    [string]$Token,

    [string]$HubUrl = "https://agents.awpdemon.com"
)

Write-Host "`n=== agentchattr Remote Agent Installer ===" -ForegroundColor Cyan
Write-Host "Agent: $AgentName"
Write-Host "Hub: $HubUrl`n"

# Check Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Node.js not found. Installing..." -ForegroundColor Yellow
    winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    $env:PATH = "C:\Program Files\nodejs;$env:PATH"
}

# Install to user directory
$installDir = "$env:USERPROFILE\.agentchattr-remote"
New-Item -ItemType Directory -Force -Path $installDir | Out-Null

# Copy daemon
Copy-Item "$PSScriptRoot\daemon.js" "$installDir\daemon.js" -Force
Copy-Item "$PSScriptRoot\package.json" "$installDir\package.json" -Force

# Create start script
@"
@echo off
set PATH=C:\Program Files\nodejs;%PATH%
cd /d "$installDir"
node daemon.js --agent $AgentName --hub $HubUrl --token $Token
pause
"@ | Set-Content "$installDir\start-agent.bat"

# Create scheduled task for auto-start
$action = New-ScheduledTaskAction -Execute "$installDir\start-agent.bat"
$trigger = New-ScheduledTaskTrigger -AtLogon
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "AgentChattrRemote-$AgentName" -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -User $env:USERNAME -Force | Out-Null

Write-Host "`n=== Installation Complete ===" -ForegroundColor Green
Write-Host ""
Write-Host "Agent '$AgentName' installed at: $installDir"
Write-Host "Start script: $installDir\start-agent.bat"
Write-Host "Auto-starts on login via scheduled task."
Write-Host ""
Write-Host "To start now: $installDir\start-agent.bat"
Write-Host "To test: node $installDir\daemon.js --agent $AgentName --hub $HubUrl --token $Token"
Write-Host ""
