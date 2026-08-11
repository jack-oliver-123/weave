$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$session = "weave-win-$PID-$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
$smallSession = "$session-small"
$node = (Get-Command node -ErrorAction Stop).Source
$fixture = Join-Path $root '.e2e-dist\tests\fixtures\tui-app.js'
$cancelledText = -join ([char]0x5DF2, [char]0x4E2D, [char]0x65AD)
$sizeText = -join ([char]0x7EC8, [char]0x7AEF, [char]0x7A97, [char]0x53E3, [char]0x8FC7, [char]0x5C0F)

function Invoke-Psmux {
  $psmuxArgs = @($args)
  $output = & psmux @psmuxArgs 2>&1
  if ($LASTEXITCODE -ne 0) { throw "psmux failed: $($psmuxArgs -join ' ')`n$output" }
  return ($output -join "`n")
}

function Capture-Pane { return Invoke-Psmux capture-pane -p -t $session }

function Wait-PaneText {
  param([string]$Text, [int]$TimeoutSeconds = 8)
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    $pane = Capture-Pane
    if ($pane.Contains($Text)) { return $pane }
    Start-Sleep -Milliseconds 150
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "timed out waiting for pane text: $Text`n$pane"
}

function Send-Literal([string]$Text) { Invoke-Psmux send-keys -t $session -l $Text | Out-Null }
function Send-Key([string]$Key) { Invoke-Psmux send-keys -t $session $Key | Out-Null }

try {
  & npm.cmd run build:e2e | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'build failed' }

  $command = "cd /d `"$root`" && `"$node`" `"$fixture`" && echo WEAVE_E2E_EXITED"
  Invoke-Psmux new-session -d -s $session -x 100 -y 30 -- cmd.exe /d /k | Out-Null
  Invoke-Psmux set-option -t $session status off | Out-Null
  Start-Sleep -Milliseconds 500
  Send-Literal $command
  Send-Key 'Enter'

  $pane = Wait-PaneText 'Weave ve2e'
  if (($pane | Select-String -Pattern 'Weave ve2e' -AllMatches).Matches.Count -ne 1) { throw 'header count is not one' }
  if (-not $pane.Contains('openai-responses / fixture-model')) { throw 'protocol and model are missing' }

  Send-Literal 'first-question'
  Send-Key 'Enter'
  $partial = Wait-PaneText 'first-chunk'
  if ($partial.Contains('second-chunk')) { throw 'first turn was not observably streamed' }
  Wait-PaneText 'first-chunk-second-chunk' | Out-Null

  Send-Literal 'line-one'
  Send-Literal (([char]27) + '[13;2u')
  Send-Literal 'line-two'
  $draft = Wait-PaneText 'line-two'
  if (-not $draft.Contains('line-one')) { throw 'Shift+Enter did not preserve the multiline draft' }
  Send-Key 'Enter'
  Wait-PaneText 'history-ok' | Out-Null
  $longPane = Wait-PaneText 'long-line-32'
  if ($longPane.Contains('history-missing')) { throw 'second turn did not receive complete history' }

  Send-Key 'PageUp'
  Start-Sleep -Milliseconds 200
  $scrolled = Capture-Pane
  if ($scrolled.Contains('long-line-32')) { throw 'PageUp did not pause bottom following' }
  Send-Key 'C-End'
  Wait-PaneText 'long-line-32' | Out-Null

  Invoke-Psmux new-session -d -s $smallSession -x 79 -y 23 -- cmd.exe /d /k | Out-Null
  Invoke-Psmux set-option -t $smallSession status off | Out-Null
  Start-Sleep -Milliseconds 500
  Invoke-Psmux send-keys -t $smallSession -l $command | Out-Null
  Invoke-Psmux send-keys -t $smallSession Enter | Out-Null
  $smallDeadline = [DateTime]::UtcNow.AddSeconds(5)
  do {
    $smallPane = Invoke-Psmux capture-pane -p -t $smallSession
    if ($smallPane.Contains($sizeText)) { break }
    Start-Sleep -Milliseconds 150
  } while ([DateTime]::UtcNow -lt $smallDeadline)
  if (-not $smallPane.Contains($sizeText)) { throw "79x23 pane did not render size-only view`n$smallPane" }
  Invoke-Psmux kill-session -t $smallSession | Out-Null
  Wait-PaneText 'long-line-32' | Out-Null

  Send-Literal 'cancel-me'
  Send-Key 'Enter'
  Wait-PaneText 'cancel-partial' | Out-Null
  Send-Literal ([string][char]3)
  $cancelled = Wait-PaneText $cancelledText 2
  if ($cancelled.Contains('late-event-must-not-render')) { throw 'late event rendered after cancellation' }
  Send-Literal ([string][char]3)

  Wait-PaneText 'WEAVE_E2E_EXITED' 5 | Out-Null
  Send-Literal 'exit'
  Send-Key 'Enter'
  Write-Host 'Windows psmux TUI E2E passed.'
}
finally {
  & psmux kill-session -t $smallSession *> $null
  & psmux kill-session -t $session *> $null
}
