$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$linuxRoot = (& wsl.exe -e wslpath -a $root).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($linuxRoot)) { throw 'failed to map the WSL project path' }
$command = "bash '$linuxRoot/tests/e2e/tui-wsl.sh' '$linuxRoot'"
& wsl.exe -e bash -lc $command
if ($LASTEXITCODE -ne 0) { throw "WSL tmux TUI E2E failed with exit code $LASTEXITCODE" }
