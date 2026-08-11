$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$config = (Resolve-Path (Join-Path $root 'weave.config.yaml')).Path
$environment = 'C:\Code\.env.test'
$linuxRoot = (& wsl.exe -e wslpath -a $root).Trim()
$linuxConfig = (& wsl.exe -e wslpath -a $config).Trim()
$linuxEnvironment = (& wsl.exe -e wslpath -a $environment).Trim()
if ($LASTEXITCODE -ne 0) { throw 'failed to map WSL paths' }
$command = "bash '$linuxRoot/tests/live/tui-wsl-smoke.sh' '$linuxRoot' '$linuxConfig' '$linuxEnvironment'"
& wsl.exe -e bash -lc $command
if ($LASTEXITCODE -ne 0) { throw "WSL live TUI smoke failed with exit code $LASTEXITCODE" }
