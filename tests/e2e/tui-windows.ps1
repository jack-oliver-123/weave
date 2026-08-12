$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$session = "weave-win-$PID-$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
$smallSession = "$session-small"
$powerShellSession = "$session-powershell"
$powerShellSmallSession = "$session-powershell-small"
$node = (Get-Command node -ErrorAction Stop).Source
$fixture = Join-Path $root '.e2e-dist\tests\fixtures\tui-app.js'
$cancelledText = -join ([char]0x5DF2, [char]0x4E2D, [char]0x65AD)
$sizeText = -join ([char]0x7EC8, [char]0x7AEF, [char]0x7A97, [char]0x53E3, [char]0x8FC7, [char]0x5C0F)
$queuedText = -join ([char]0x5DF2, [char]0x6392, [char]0x961F)
$pausedText = -join ([char]0x961F, [char]0x5217, [char]0x5DF2, [char]0x6682, [char]0x505C)
$historyText = -join ([char]0x6B63, [char]0x5728, [char]0x67E5, [char]0x770B, [char]0x4E0A, [char]0x6587)

function Invoke-Psmux {
  $psmuxArgs = @($args)
  $output = & psmux @psmuxArgs 2>&1
  if ($LASTEXITCODE -ne 0) { throw "psmux failed: $($psmuxArgs -join ' ')`n$output" }
  return ($output -join "`n")
}

function Capture-Pane { return Invoke-Psmux capture-pane -p -t $session }

function Wait-PaneText {
  param([string]$Text, [int]$TimeoutSeconds = 12)
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

function Capture-Target([string]$Target) { return Invoke-Psmux capture-pane -p -t $Target }
function Wait-TargetText {
  param([string]$Target, [string]$Text, [int]$TimeoutSeconds = 15)
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    $pane = Capture-Target $Target
    if ($pane.Contains($Text)) { return $pane }
    Start-Sleep -Milliseconds 150
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "timed out waiting for pane text in $Target`: $Text`n$pane"
}
function Send-TargetLiteral([string]$Target, [string]$Text) { Invoke-Psmux send-keys -t $Target -l $Text | Out-Null }
function Send-TargetKey([string]$Target, [string]$Key) { Invoke-Psmux send-keys -t $Target $Key | Out-Null }

try {
  & npm.cmd run build:e2e | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'build failed' }

  $command = "cd /d `"$root`" && `"$node`" `"$fixture`" && echo WEAVE_E2E_EXITED"
  Invoke-Psmux new-session -d -s $session -x 100 -y 30 -- cmd.exe /d /k | Out-Null
  Invoke-Psmux set-option -t $session status off | Out-Null
  Start-Sleep -Milliseconds 500
  Send-Literal $command
  Send-Key 'Enter'
  Start-Sleep -Milliseconds 250
  Send-Key 'Enter'

  $pane = Wait-PaneText 'Weave ve2e'
  if (($pane | Select-String -Pattern 'Weave ve2e' -AllMatches).Matches.Count -ne 1) { throw 'header count is not one' }
  if (-not $pane.Contains('openai-responses / fixture-model')) { throw 'protocol and model are missing' }
  $cursorPosition = Invoke-Psmux display-message -p -t $session '#{cursor_x},#{cursor_y}'
  if ($cursorPosition.Trim() -ne '4,27') { throw "native cursor is outside composer content row: $cursorPosition" }
  Send-Literal (([char]27) + '[<0;55;6M')
  Send-Literal (([char]27) + '[<0;55;6m')

  Send-Literal 'first-question'
  Send-Key 'Enter'
  $partial = Wait-PaneText 'first-chunk'
  if ($partial.Contains('second-chunk')) { throw 'first turn was not observably streamed' }
  Send-Literal 'queued-one'
  Send-Key 'Enter'
  Wait-PaneText "$queuedText 1" | Out-Null
  Send-Literal 'queued-two'
  Send-Key 'Enter'
  Wait-PaneText "$queuedText 2" | Out-Null
  $markdownPane = Wait-PaneText 'queue-ok'
  if ($markdownPane.Contains('queue-missing')) { throw 'queued messages were not merged into one turn' }
  if (-not $markdownPane.Contains('Weave')) { throw 'Markdown table content is missing' }
  if ($markdownPane.Contains('```') -or $markdownPane.Contains('**second-chunk**')) { throw 'Markdown markers were not rendered' }

  Send-Literal 'line-one'
  Send-Key 'C-j'
  Send-Literal 'line-two'
  $draft = Wait-PaneText 'line-two'
  if (-not $draft.Contains('line-one')) { throw 'Ctrl+J did not preserve the multiline draft in CMD' }
  $beforeUp = (Invoke-Psmux display-message -p -t $session '#{cursor_x},#{cursor_y}').Trim().Split(',')
  Send-Key 'Up'
  Start-Sleep -Milliseconds 150
  $afterUp = (Invoke-Psmux display-message -p -t $session '#{cursor_x},#{cursor_y}').Trim().Split(',')
  if ([int]$afterUp[0] -ne [int]$beforeUp[0] -or [int]$afterUp[1] -ne ([int]$beforeUp[1] - 1)) {
    throw "Up from the second-line end did not land at the first-line end: before=$($beforeUp -join ',') after=$($afterUp -join ',')"
  }
  Send-Key 'Down'
  Start-Sleep -Milliseconds 150
  Send-Key 'Enter'
  Wait-PaneText 'history-ok' | Out-Null
  $longPane = Wait-PaneText 'long-line-32'
  if ($longPane.Contains('history-missing')) { throw 'second turn did not receive complete history' }

  1..8 | ForEach-Object { Send-Literal (([char]27) + '[<64;10;10M') }
  Start-Sleep -Milliseconds 200
  $scrolled = Capture-Pane
  if ($scrolled.Contains('long-line-32')) { throw 'mouse wheel did not pause bottom following' }
  if (-not $scrolled.Contains($historyText)) { throw 'scroll status is missing' }
  Send-Key 'C-End'
  Wait-PaneText 'long-line-32' | Out-Null

  Invoke-Psmux new-session -d -s $smallSession -x 79 -y 23 -- cmd.exe /d /k | Out-Null
  Invoke-Psmux set-option -t $smallSession status off | Out-Null
  Start-Sleep -Milliseconds 500
  Invoke-Psmux send-keys -t $smallSession -l $command | Out-Null
  Invoke-Psmux send-keys -t $smallSession Enter | Out-Null
  Start-Sleep -Milliseconds 250
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
  Send-Literal 'after-cancel'
  Send-Key 'Enter'
  Wait-PaneText "$queuedText 1" | Out-Null
  Send-Literal ([string][char]3)
  $cancelled = Wait-PaneText $pausedText 2
  if ($cancelled.Contains('late-event-must-not-render')) { throw 'late event rendered after cancellation' }
  Send-Key 'Enter'
  $resumed = Wait-PaneText 'resume-ok' 5
  if ($resumed.Contains('resume-missing')) { throw 'paused queue did not resume exactly once' }
  Start-Sleep -Milliseconds 2100
  Send-Literal ([string][char]3)
  Send-Literal ([string][char]3)

  Wait-PaneText 'WEAVE_E2E_EXITED' 5 | Out-Null
  Send-Literal 'exit'
  Send-Key 'Enter'

  $powerShellCommand = "Set-Location -LiteralPath '$root'; & '$node' '$fixture'; Write-Output 'WEAVE_PS_EXITED'"
  Invoke-Psmux new-session -d -s $powerShellSession -x 100 -y 30 -- powershell.exe -NoLogo -NoProfile -NoExit | Out-Null
  Invoke-Psmux set-option -t $powerShellSession status off | Out-Null
  Start-Sleep -Milliseconds 500
  Send-TargetLiteral $powerShellSession $powerShellCommand
  Send-TargetKey $powerShellSession 'Enter'
  Start-Sleep -Milliseconds 250
  Send-TargetKey $powerShellSession 'Enter'
  Wait-TargetText $powerShellSession 'Weave ve2e' | Out-Null
  $powerShellCursor = Invoke-Psmux display-message -p -t $powerShellSession '#{cursor_x},#{cursor_y}'
  if ($powerShellCursor.Trim() -ne '4,27') { throw "PowerShell native cursor is outside composer content row: $powerShellCursor" }
  Send-TargetLiteral $powerShellSession (([char]27) + '[<0;55;6M')
  Send-TargetLiteral $powerShellSession (([char]27) + '[<0;55;6m')

  Send-TargetLiteral $powerShellSession 'first-question'
  Send-TargetKey $powerShellSession 'Enter'
  Wait-TargetText $powerShellSession 'first-chunk' | Out-Null
  Send-TargetLiteral $powerShellSession 'queued-one'
  Send-TargetKey $powerShellSession 'Enter'
  Wait-TargetText $powerShellSession "$queuedText 1" | Out-Null
  Send-TargetLiteral $powerShellSession 'queued-two'
  Send-TargetKey $powerShellSession 'Enter'
  Wait-TargetText $powerShellSession "$queuedText 2" | Out-Null
  $powerShellMarkdown = Wait-TargetText $powerShellSession 'queue-ok'
  if ($powerShellMarkdown.Contains('queue-missing') -or $powerShellMarkdown.Contains('```')) { throw 'PowerShell Markdown or queue check failed' }

  Send-TargetLiteral $powerShellSession 'line-one'
  Send-TargetLiteral $powerShellSession (([char]27) + '[13;2u')
  Send-TargetLiteral $powerShellSession 'line-two'
  Send-TargetKey $powerShellSession 'Enter'
  Wait-TargetText $powerShellSession 'long-line-32' | Out-Null
  1..8 | ForEach-Object { Send-TargetLiteral $powerShellSession (([char]27) + '[<64;10;10M') }
  Start-Sleep -Milliseconds 200
  $powerShellScrolled = Capture-Target $powerShellSession
  if ($powerShellScrolled.Contains('long-line-32') -or -not $powerShellScrolled.Contains($historyText)) { throw 'PowerShell wheel check failed' }
  Send-TargetKey $powerShellSession 'C-End'
  Wait-TargetText $powerShellSession 'long-line-32' | Out-Null

  Invoke-Psmux new-session -d -s $powerShellSmallSession -x 79 -y 23 -- powershell.exe -NoLogo -NoProfile -NoExit | Out-Null
  Invoke-Psmux set-option -t $powerShellSmallSession status off | Out-Null
  Start-Sleep -Milliseconds 500
  Send-TargetLiteral $powerShellSmallSession $powerShellCommand
  Send-TargetKey $powerShellSmallSession 'Enter'
  Start-Sleep -Milliseconds 250
  Send-TargetKey $powerShellSmallSession 'Enter'
  Wait-TargetText $powerShellSmallSession $sizeText | Out-Null
  Invoke-Psmux kill-session -t $powerShellSmallSession | Out-Null
  Send-TargetKey $powerShellSession 'C-c'
  Send-TargetKey $powerShellSession 'C-c'
  Wait-TargetText $powerShellSession "PS $root>" 5 | Out-Null
  Send-TargetLiteral $powerShellSession 'exit'
  Send-TargetKey $powerShellSession 'Enter'
  Write-Host 'Windows CMD and PowerShell psmux TUI E2E passed.'
}
finally {
  & psmux kill-session -t $powerShellSmallSession *> $null
  & psmux kill-session -t $powerShellSession *> $null
  & psmux kill-session -t $smallSession *> $null
  & psmux kill-session -t $session *> $null
}
