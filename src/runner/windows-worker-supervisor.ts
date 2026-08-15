import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolCallResult } from '../shared/types.js';
import type {
  ActionWorkerBackend,
  ActionWorkerLaunchInput,
  ActionWorkerResult,
} from './supervisor.js';
import type { ResourceBudget } from './resources.js';
import {
  deriveWindowsWorkerPolicy,
  type WindowsSandboxTaskVm,
  type WindowsWorkerPolicy,
} from './windows-backend.js';

interface WindowsWorkerRequest {
  readonly schemaVersion: 1;
  readonly workspaceRoot: string;
  readonly call: ActionWorkerLaunchInput['call'];
  readonly profile: ResourceBudget;
}

export interface WindowsJobObjectWorkerOptions {
  readonly vm: WindowsSandboxTaskVm;
  readonly cowHostRoot: string;
  readonly guestWorkspaceRoot?: string;
  readonly input: ActionWorkerLaunchInput;
  readonly createId?: () => string;
}

export class WindowsJobObjectWorker implements ActionWorkerBackend {
  private readonly actionDirectory: string;
  private readonly guestDirectory: string;
  private readonly policy: WindowsWorkerPolicy;
  private readonly guestWorkspaceRoot: string;
  private closed = false;

  constructor(private readonly options: WindowsJobObjectWorkerOptions) {
    const id = safeId((options.createId ?? randomUUID)());
    this.actionDirectory = join(options.cowHostRoot, '.weave', 'windows-actions', id);
    this.guestWorkspaceRoot = options.guestWorkspaceRoot ?? 'C:\\Weave\\Cow';
    this.guestDirectory = `${this.guestWorkspaceRoot}\\.weave\\windows-actions\\${id}`;
    this.policy = deriveWindowsWorkerPolicy(options.input.profile);
  }

  async execute(signal: AbortSignal): Promise<ActionWorkerResult> {
    if (this.closed) throw new Error('ACTION_WORKER_CLOSED');
    if (signal.aborted) return { result: failure(this.options.input, 'TOOL_CANCELLED', 'Action was cancelled') };
    await mkdir(this.actionDirectory, { recursive: true });
    const request: WindowsWorkerRequest = {
      schemaVersion: 1,
      workspaceRoot: this.guestWorkspaceRoot,
      call: structuredClone(this.options.input.call),
      profile: workerBudget(this.options.input.profile),
    };
    await Promise.all([
      writeFile(join(this.actionDirectory, 'request.json'), JSON.stringify(request), { encoding: 'utf8', flag: 'wx' }),
      writeFile(join(this.actionDirectory, 'policy.json'), JSON.stringify(this.policy), { encoding: 'utf8', flag: 'wx' }),
      writeFile(join(this.actionDirectory, 'worker.ps1'), WINDOWS_ACTION_WORKER_SCRIPT, { encoding: 'utf8', flag: 'wx' }),
      writeFile(join(this.actionDirectory, 'supervisor.ps1'), WINDOWS_JOB_SUPERVISOR_SCRIPT, { encoding: 'utf8', flag: 'wx' }),
    ]);
    const command = [
      'powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass',
      `-File "${this.guestDirectory}\\supervisor.ps1"`,
      `-RequestPath "${this.guestDirectory}\\request.json"`,
      `-PolicyPath "${this.guestDirectory}\\policy.json"`,
      `-WorkerPath "${this.guestDirectory}\\worker.ps1"`,
      `-ResultPath "${this.guestDirectory}\\result.json"`,
    ].join(' ');
    try {
      await this.options.vm.exec(command, 'ExistingLogin', this.guestWorkspaceRoot, signal);
    } catch (error) {
      if (signal.aborted) return { result: failure(this.options.input, 'TOOL_CANCELLED', 'Action was cancelled') };
      throw error;
    }
    const encoded = await readFile(join(this.actionDirectory, 'result.json'));
    if (encoded.byteLength > this.options.input.profile.batchOutputBytes) {
      return { result: failure(this.options.input, 'OUTPUT_LIMIT_EXCEEDED', 'Worker result exceeded the action output budget') };
    }
    return { result: parseWorkerResult(encoded.toString('utf8'), this.options.input) };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await rm(this.actionDirectory, { recursive: true, force: true });
  }
}

function parseWorkerResult(value: string, input: ActionWorkerLaunchInput): ToolCallResult {
  let parsed: unknown;
  try { parsed = JSON.parse(value.replace(/^\uFEFF/, '')); } catch { throw new Error('WINDOWS_WORKER_PROTOCOL_ERROR'); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('WINDOWS_WORKER_PROTOCOL_ERROR');
  const result = parsed as Partial<ToolCallResult>;
  if (result.callId !== input.call.callId || result.providerCallId !== input.call.providerCallId
    || result.toolName !== input.call.name || typeof result.isError !== 'boolean'
    || typeof result.content !== 'object' || result.content === null) {
    throw new Error('WINDOWS_WORKER_PROTOCOL_ERROR');
  }
  return Object.freeze(structuredClone(result as ToolCallResult));
}

function safeId(value: string): string {
  if (!/^[A-Za-z0-9-]{1,128}$/.test(value)) throw new Error('INVALID_WORKER_ID');
  return value;
}

function workerBudget(profile: ActionWorkerLaunchInput['profile']): ResourceBudget {
  return Object.freeze({
    cpuCores: profile.cpuCores,
    memoryBytes: profile.memoryBytes,
    pids: profile.pids,
    actionTimeoutMs: profile.actionTimeoutMs,
    taskProcessTimeoutMs: profile.taskProcessTimeoutMs,
    diskBytes: profile.diskBytes,
    stdoutBytes: profile.stdoutBytes,
    stderrBytes: profile.stderrBytes,
    batchOutputBytes: profile.batchOutputBytes,
    networkBytes: profile.networkBytes,
  });
}

function failure(input: ActionWorkerLaunchInput, code: string, message: string): ToolCallResult {
  return {
    callId: input.call.callId,
    providerCallId: input.call.providerCallId,
    toolName: input.call.name,
    isError: true,
    content: { summary: message, error: { code, message, retryable: code === 'TOOL_CANCELLED' } },
  };
}

export const WINDOWS_ACTION_WORKER_SCRIPT = String.raw`param(
  [Parameter(Mandatory=$true)][string]$RequestPath,
  [Parameter(Mandatory=$true)][string]$ResultPath
)
$ErrorActionPreference = 'Stop'
$ExcludedNames = @('.git', '.weave', 'node_modules')

function Write-Result([bool]$IsError, [string]$Summary, $Data, [string]$Code = '') {
  $request = Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $content = @{ summary = $Summary }
  if ($null -ne $Data) { $content.data = $Data }
  if ($Code) { $content.error = @{ code = $Code; message = $Summary; retryable = $false } }
  @{
    callId = $request.call.callId
    providerCallId = $request.call.providerCallId
    toolName = $request.call.name
    isError = $IsError
    content = $content
  } | ConvertTo-Json -Depth 20 -Compress | Set-Content -LiteralPath $ResultPath -Encoding UTF8
}

function Fail([string]$Code, [string]$Message) { throw ($Code + '|' + $Message) }

function Resolve-WorkspacePath([string]$Relative, [bool]$MustExist) {
  if ($Relative -eq '.' -and -not $MustExist) { return [IO.Path]::GetFullPath($Workspace) }
  if ([string]::IsNullOrWhiteSpace($Relative) -or [IO.Path]::IsPathRooted($Relative) -or $Relative.Contains([char]0) -or $Relative.Contains(':')) {
    Fail 'PATH_OUTSIDE_WORKSPACE' 'Path must be workspace-relative'
  }
  $parts = $Relative.Replace('/', '\').Split('\')
  if ($parts | Where-Object { $_ -eq '' -or $_ -eq '.' -or $_ -eq '..' -or $ExcludedNames -contains $_ }) {
    Fail 'PATH_OUTSIDE_WORKSPACE' 'Path contains a forbidden segment'
  }
  $root = [IO.Path]::GetFullPath($Workspace).TrimEnd('\') + '\'
  $resolved = [IO.Path]::GetFullPath((Join-Path $Workspace ($parts -join '\')))
  if (-not $resolved.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { Fail 'PATH_OUTSIDE_WORKSPACE' 'Path escapes workspace' }
  $cursor = $Workspace
  foreach ($part in $parts) {
    $cursor = Join-Path $cursor $part
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.LinkType -eq 'HardLink') {
        Fail 'PATH_LINK_UNSAFE' 'Links are unavailable to the worker'
      }
    }
  }
  if ($MustExist -and -not (Test-Path -LiteralPath $resolved -PathType Leaf)) { Fail 'FILE_NOT_FOUND' 'File does not exist' }
  return $resolved
}

function Read-Utf8([string]$Path, [int64]$Limit) {
  $bytes = [IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -gt $Limit) { Fail 'FILE_TOO_LARGE' 'File exceeds the action output budget' }
  if ($bytes -contains 0) { Fail 'BINARY_FILE' 'Binary file is unavailable' }
  try { return (New-Object Text.UTF8Encoding($false, $true)).GetString($bytes) }
  catch { Fail 'INVALID_UTF8' 'File is not valid UTF-8' }
}

function Get-SafeFiles([string]$Root) {
  Get-ChildItem -LiteralPath $Root -File -Recurse -Force -ErrorAction SilentlyContinue | Where-Object {
    $relative = $_.FullName.Substring($Workspace.Length).TrimStart('\').Replace('\', '/')
    $segments = $relative.Split('/')
    -not ($segments | Where-Object { $ExcludedNames -contains $_ }) -and
      (($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) -and $_.LinkType -ne 'HardLink'
  }
}

function Glob-Regex([string]$Pattern) {
  $value = [Regex]::Escape($Pattern.Replace('\', '/'))
  $value = $value.Replace('\*\*/', '(?:.*/)?').Replace('\*', '[^/]*').Replace('\?', '[^/]')
  return New-Object Regex("^$value$", ([Text.RegularExpressions.RegexOptions]::IgnoreCase -bor [Text.RegularExpressions.RegexOptions]::CultureInvariant))
}

try {
  $request = Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($request.schemaVersion -ne 1) { Fail 'INVALID_ARGUMENT' 'Unsupported request schema' }
  $Workspace = [string]$request.workspaceRoot
  if (-not $Workspace.StartsWith('C:\Weave\', [StringComparison]::OrdinalIgnoreCase)) { Fail 'PATH_OUTSIDE_WORKSPACE' 'Invalid worker workspace root' }
  $call = $request.call
  $limit = [Math]::Min([int64]$request.profile.stdoutBytes, 1048576)
  switch ($call.name) {
    'read_file' {
      $path = Resolve-WorkspacePath ([string]$call.input.path) $true
      $text = Read-Utf8 $path $limit
      Write-Result $false 'File read' @{ path = [string]$call.input.path; content = $text }
    }
    'glob' {
      $root = if ($call.input.path) { Resolve-WorkspacePath ([string]$call.input.path) $false } else { $Workspace }
      if (-not (Test-Path -LiteralPath $root -PathType Container)) { Fail 'NOT_A_DIRECTORY' 'Glob root is not a directory' }
      $regex = Glob-Regex ([string]$call.input.pattern)
      $matches = @(Get-SafeFiles $root | ForEach-Object {
        $_.FullName.Substring($Workspace.Length).TrimStart('\').Replace('\', '/')
      } | Where-Object { $regex.IsMatch($_) } | Sort-Object -Unique | Select-Object -First 1000)
      Write-Result $false 'Glob completed' @{ matches = $matches }
    }
    'grep' {
      $root = if ($call.input.path) { Resolve-WorkspacePath ([string]$call.input.path) $false } else { $Workspace }
      $needle = [string]$call.input.pattern
      $grepMatches = New-Object Collections.Generic.List[object]
      foreach ($file in Get-SafeFiles $root) {
        if ($file.Length -gt 1048576) { continue }
        try { $text = Read-Utf8 $file.FullName 1048576 } catch { continue }
        $lineNumber = 0
        foreach ($line in [Regex]::Split($text, '\r?\n')) {
          $lineNumber++
          if ($line.Contains($needle)) {
            $relative = $file.FullName.Substring($Workspace.Length).TrimStart('\').Replace('\', '/')
            $grepMatches.Add(@{ path = $relative; line = $lineNumber; text = $line })
            if ($grepMatches.Count -ge 1000) { break }
          }
        }
        if ($grepMatches.Count -ge 1000) { break }
      }
      Write-Result $false 'Grep completed' @{ matches = $grepMatches.ToArray() }
    }
    'create_file' {
      $path = Resolve-WorkspacePath ([string]$call.input.path) $false
      if (Test-Path -LiteralPath $path) { Fail 'FILE_ALREADY_EXISTS' 'File already exists' }
      $content = [string]$call.input.content
      if ([Text.Encoding]::UTF8.GetByteCount($content) -gt [int64]$request.profile.diskBytes) { Fail 'DISK_LIMIT_EXCEEDED' 'Content exceeds disk budget' }
      [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path)) | Out-Null
      [IO.File]::WriteAllText($path, $content, (New-Object Text.UTF8Encoding($false)))
      Write-Result $false 'File created' @{ path = [string]$call.input.path }
    }
    'edit_file' {
      $path = Resolve-WorkspacePath ([string]$call.input.path) $true
      $text = Read-Utf8 $path 1048576
      foreach ($edit in $call.input.edits) {
        $old = [string]$edit.oldText
        $first = $text.IndexOf($old, [StringComparison]::Ordinal)
        if ($first -lt 0) { Fail 'TEXT_NOT_FOUND' 'Edit target was not found' }
        if ($text.IndexOf($old, $first + $old.Length, [StringComparison]::Ordinal) -ge 0) { Fail 'AMBIGUOUS_MATCH' 'Edit target is not unique' }
        $text = $text.Substring(0, $first) + [string]$edit.newText + $text.Substring($first + $old.Length)
      }
      if ([Text.Encoding]::UTF8.GetByteCount($text) -gt [int64]$request.profile.diskBytes) { Fail 'DISK_LIMIT_EXCEEDED' 'Edited file exceeds disk budget' }
      [IO.File]::WriteAllText($path, $text, (New-Object Text.UTF8Encoding($false)))
      Write-Result $false 'File edited' @{ path = [string]$call.input.path }
    }
    'weave_certification_probe' {
      $probes = @{}
      $identityProbe = New-Object Diagnostics.Process
      $identityProbe.StartInfo = New-Object Diagnostics.ProcessStartInfo('C:\Windows\System32\whoami.exe', '/groups /fo csv /nh')
      $identityProbe.StartInfo.UseShellExecute = $false
      $identityProbe.StartInfo.CreateNoWindow = $true
      $identityProbe.StartInfo.RedirectStandardOutput = $true
      $identityProbe.StartInfo.RedirectStandardError = $true
      $identityProbe.Start() | Out-Null
      $groups = $identityProbe.StandardOutput.ReadToEnd()
      $identityProbe.WaitForExit()
      $identityProbe.Dispose()
      $probes.process_identity = if ($groups -match 'Low Mandatory Level|S-1-16-4096') { 'passed' } else { 'failed' }
      $probes.host_paths_hidden = if (-not (Test-Path -LiteralPath ([string]$call.input.hostPathCanary))) { 'passed' } else { 'failed' }
      $registryCanary = [string]$call.input.hostRegistryCanary
      $probes.windows_registry_hidden = if (-not (Test-Path -LiteralPath $registryCanary)) { 'passed' } else { 'failed' }
      $environmentCanary = [string]$call.input.hostEnvironmentCanary
      $probes.environment_cleared = if (-not (Test-Path "Env:$environmentCanary")) { 'passed' } else { 'failed' }
      $hostDeviceOpened = $false
      try {
        $hostDevice = [IO.File]::Open([string]$call.input.hostDeviceCanary, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        $hostDeviceOpened = $true
        $hostDevice.Dispose()
      } catch {}
      $probes.devices_hidden = if ($hostDeviceOpened) { 'failed' } else { 'passed' }
      $client = New-Object Net.Sockets.TcpClient
      $networkConnected = $false
      try {
        $pending = $client.BeginConnect('1.1.1.1', 443, $null, $null)
        $networkConnected = $pending.AsyncWaitHandle.WaitOne(1000) -and $client.Connected
      } catch {} finally { $client.Dispose() }
      $probes.raw_network_blocked = if ($networkConnected) { 'failed' } else { 'passed' }
      $serviceCreated = $false
      try {
        $serviceProbe = New-Object Diagnostics.Process
        $serviceProbe.StartInfo = New-Object Diagnostics.ProcessStartInfo('C:\Windows\System32\sc.exe', 'create WeaveEscapeProbe binPath= "cmd.exe /c exit 0"')
        $serviceProbe.StartInfo.UseShellExecute = $false
        $serviceProbe.StartInfo.CreateNoWindow = $true
        $serviceProbe.StartInfo.RedirectStandardOutput = $true
        $serviceProbe.StartInfo.RedirectStandardError = $true
        if ($serviceProbe.Start()) {
          $serviceProbe.WaitForExit()
          $serviceCreated = $serviceProbe.ExitCode -eq 0
        }
        $serviceProbe.Dispose()
      } catch {}
      if ($serviceCreated) {
        try {
          $deleteProbe = [Diagnostics.Process]::Start((New-Object Diagnostics.ProcessStartInfo('C:\Windows\System32\sc.exe', 'delete WeaveEscapeProbe') -Property @{ UseShellExecute = $false; CreateNoWindow = $true }))
          $deleteProbe.WaitForExit()
          $deleteProbe.Dispose()
        } catch {}
      }
      $probes.privilege_escalation_blocked = if ($serviceCreated) { 'failed' } else { 'passed' }
      $pipeCanary = '\\.\pipe\' + [string]$call.input.hostPipeCanary
      $probes.control_ipc_hidden = if (-not (Test-Path -LiteralPath $pipeCanary)) { 'passed' } else { 'failed' }
      $probes.brokers_hidden = if (-not (Test-Path -LiteralPath 'C:\Weave\Broker') -and -not (Test-Path -LiteralPath 'C:\Weave\Control')) { 'passed' } else { 'failed' }

      $children = New-Object Collections.Generic.List[Diagnostics.Process]
      $limitObserved = $false
      for ($index = 0; $index -lt ([int]$request.profile.pids + 4); $index++) {
        try {
          $childInfo = New-Object Diagnostics.ProcessStartInfo('C:\Windows\System32\cmd.exe', '/d /c "ping.exe -t 127.0.0.1 >NUL"')
          $childInfo.UseShellExecute = $false
          $childInfo.CreateNoWindow = $true
          $child = [Diagnostics.Process]::Start($childInfo)
          $children.Add($child)
        } catch { $limitObserved = $true; break }
      }
      $treePid = if ($children.Count -gt 0) { $children[0].Id } else { 0 }
      for ($index = 1; $index -lt $children.Count; $index++) { try { $children[$index].Kill() } catch {} }
      $memoryLimitObserved = $false
      $memoryExitCode = $null
      $memoryOutput = ''
      $memoryError = ''
      try {
        $allocation = [Math]::Min([int64]$request.profile.memoryBytes * 2, 1073741824)
        $memoryCommand = '$value=New-Object byte[] ' + $allocation + '; for($i=0;$i-lt$value.Length;$i+=4096){$value[$i]=1}; Write-Output $value.Length; [GC]::KeepAlive($value)'
        $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($memoryCommand))
        $memoryInfo = New-Object Diagnostics.ProcessStartInfo('C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe', "-NoLogo -NoProfile -NonInteractive -EncodedCommand $encodedCommand")
        $memoryInfo.UseShellExecute = $false
        $memoryInfo.CreateNoWindow = $true
        $memoryInfo.RedirectStandardOutput = $true
        $memoryInfo.RedirectStandardError = $true
        $memoryChild = [Diagnostics.Process]::Start($memoryInfo)
        $memoryOutput = $memoryChild.StandardOutput.ReadToEnd()
        $memoryError = $memoryChild.StandardError.ReadToEnd()
        $memoryChild.WaitForExit()
        $memoryExitCode = $memoryChild.ExitCode
        $memoryChild.Dispose()
        $memoryLimitObserved = $memoryExitCode -ne 0 -or $memoryError.Contains('System.OutOfMemoryException')
      } catch { $memoryLimitObserved = $true }
      $probes.resource_limits = if ($limitObserved -and $memoryLimitObserved) { 'passed' } else { 'failed' }
      $probes.process_tree_cleanup = 'pending'
      Write-Result $false 'Windows isolation probes completed' @{ probes = $probes; processTreePid = $treePid }
    }
    'weave_certification_process_absent' {
      $pidToCheck = [int]$call.input.pid
      $exists = $null -ne (Get-Process -Id $pidToCheck -ErrorAction SilentlyContinue)
      Write-Result $false 'Process cleanup probe completed' @{ absent = (-not $exists) }
    }
    'weave_certification_timeout' {
      Start-Sleep -Milliseconds ([int]$request.profile.actionTimeoutMs + 5000)
      Write-Result $true 'Timeout was not enforced' $null 'RESOURCE_LIMIT_NOT_ENFORCED'
    }
    'weave_certification_structured_process' {
      $process = Start-Process -FilePath 'cmd.exe' -ArgumentList '/d','/c','exit 0' -PassThru -Wait -WindowStyle Hidden
      if ($process.ExitCode -ne 0) { Fail 'STRUCTURED_PROCESS_FAILED' 'Fixed process returned a nonzero status' }
      Write-Result $false 'Structured process completed' @{ exitCode = $process.ExitCode }
    }
    'weave_certification_bash_probe' {
      $bash = Get-Command bash.exe -ErrorAction SilentlyContinue
      $available = $false
      if ($null -ne $bash) {
        try {
          $process = Start-Process -FilePath $bash.Source -ArgumentList '--noprofile','--norc','-c','exit 0' -PassThru -Wait -WindowStyle Hidden
          $available = $process.ExitCode -eq 0
        } catch {}
      }
      Write-Result $false 'Bash availability probe completed' @{ available = $available }
    }
    default { Fail 'SANDBOX_CAPABILITY_UNAVAILABLE' 'Tool is not implemented by the Windows worker' }
  }
} catch {
  $parts = $_.Exception.Message.Split('|', 2)
  $code = if ($parts.Count -eq 2 -and $parts[0] -match '^[A-Z_]+$') { $parts[0] } else { 'WINDOWS_WORKER_FAILED' }
  $message = if ($parts.Count -eq 2) { $parts[1] } else { 'Windows worker failed' }
  Write-Result $true $message $null $code
}
`;

export const WINDOWS_JOB_SUPERVISOR_SCRIPT = String.raw`param(
  [Parameter(Mandatory=$true)][string]$RequestPath,
  [Parameter(Mandatory=$true)][string]$PolicyPath,
  [Parameter(Mandatory=$true)][string]$WorkerPath,
  [Parameter(Mandatory=$true)][string]$ResultPath
)
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;

public static class WeaveWindowsJob {
  const uint TOKEN_ALL_ACCESS = 0x000F01FF;
  const uint DISABLE_MAX_PRIVILEGE = 0x1;
  const uint CREATE_SUSPENDED = 0x4;
  const uint CREATE_UNICODE_ENVIRONMENT = 0x400;
  const uint CREATE_NO_WINDOW = 0x08000000;
  const uint JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x8;
  const uint JOB_OBJECT_LIMIT_JOB_MEMORY = 0x200;
  const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
  const uint JOB_OBJECT_CPU_RATE_CONTROL_ENABLE = 0x1;
  const uint JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP = 0x4;
  const uint SE_GROUP_INTEGRITY = 0x20;
  const int TokenIntegrityLevel = 25;
  const uint WAIT_TIMEOUT = 258;
  const uint WAIT_OBJECT_0 = 0;

  [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public int bInheritHandle; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO { public int cb; public string lpReserved; public string lpDesktop; public string lpTitle; public int dwX; public int dwY; public int dwXSize; public int dwYSize; public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public uint dwProcessId; public uint dwThreadId; }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong ReadOperationCount; public ulong WriteOperationCount; public ulong OtherOperationCount; public ulong ReadTransferCount; public ulong WriteTransferCount; public ulong OtherTransferCount; }
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_BASIC_LIMIT_INFORMATION { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public IntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION { public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }
  [StructLayout(LayoutKind.Sequential)] struct JOBOBJECT_CPU_RATE_CONTROL_INFORMATION { public uint ControlFlags; public uint CpuRate; }
  [StructLayout(LayoutKind.Sequential)] struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct TOKEN_MANDATORY_LABEL { public SID_AND_ATTRIBUTES Label; }

  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint desiredAccess, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool CreateRestrictedToken(IntPtr existing, uint flags, uint disableSidCount, IntPtr sidsToDisable, uint deletePrivilegeCount, IntPtr privilegesToDelete, uint restrictedSidCount, IntPtr sidsToRestrict, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool SetTokenInformation(IntPtr token, int tokenInformationClass, IntPtr tokenInformation, uint tokenInformationLength);
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcessAsUser(IntPtr token, string applicationName, string commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint creationFlags, IntPtr environment, string currentDirectory, ref STARTUPINFO startupInfo, out PROCESS_INFORMATION processInformation);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool ConvertStringSidToSid(string sid, out IntPtr sidPointer);
  [DllImport("advapi32.dll")] static extern uint GetLengthSid(IntPtr sid);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);

  static void Check(bool ok, string operation) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), operation); }
  static void SetJobInfo<T>(IntPtr job, int infoClass, T value) {
    int size = Marshal.SizeOf(typeof(T));
    IntPtr memory = Marshal.AllocHGlobal(size);
    try { Marshal.StructureToPtr(value, memory, false); Check(SetInformationJobObject(job, infoClass, memory, (uint)size), "SetInformationJobObject"); }
    finally { Marshal.FreeHGlobal(memory); }
  }
  static IntPtr EnvironmentBlock(IDictionary<string,string> values) {
    var entries = new List<string>();
    foreach (var item in values) entries.Add(item.Key + "=" + item.Value);
    entries.Sort(StringComparer.OrdinalIgnoreCase);
    string block = String.Join("\0", entries) + "\0\0";
    return Marshal.StringToHGlobalUni(block);
  }
  static void SetLowIntegrity(IntPtr token) {
    IntPtr sid;
    Check(ConvertStringSidToSid("S-1-16-4096", out sid), "ConvertStringSidToSid");
    try {
      int size = Marshal.SizeOf(typeof(TOKEN_MANDATORY_LABEL));
      int sidLength = (int)GetLengthSid(sid);
      IntPtr memory = Marshal.AllocHGlobal(size + sidLength);
      try {
        IntPtr copiedSid = IntPtr.Add(memory, size);
        var sidBytes = new byte[sidLength];
        Marshal.Copy(sid, sidBytes, 0, sidLength);
        Marshal.Copy(sidBytes, 0, copiedSid, sidLength);
        var label = new TOKEN_MANDATORY_LABEL { Label = new SID_AND_ATTRIBUTES { Sid = copiedSid, Attributes = SE_GROUP_INTEGRITY } };
        Marshal.StructureToPtr(label, memory, false);
        Check(SetTokenInformation(token, TokenIntegrityLevel, memory, (uint)(size + sidLength)), "SetTokenInformation");
      }
      finally { Marshal.FreeHGlobal(memory); }
    } finally { LocalFree(sid); }
  }

  static void CreateWorkerToken(IntPtr userToken, out IntPtr restrictedToken) {
    Check(CreateRestrictedToken(userToken, DISABLE_MAX_PRIVILEGE, 0, IntPtr.Zero, 0, IntPtr.Zero, 0, IntPtr.Zero, out restrictedToken), "CreateRestrictedToken");
  }

  public static int Run(string workerPath, string requestPath, string resultPath, string workingDirectory, int processLimit, ulong memoryBytes, int timeoutMs, int cpuCores) {
    IntPtr userToken = IntPtr.Zero, restrictedToken = IntPtr.Zero, job = IntPtr.Zero, environment = IntPtr.Zero;
    PROCESS_INFORMATION process = new PROCESS_INFORMATION();
    try {
      Check(OpenProcessToken(GetCurrentProcess(), TOKEN_ALL_ACCESS, out userToken), "OpenProcessToken");
      CreateWorkerToken(userToken, out restrictedToken);
      SetLowIntegrity(restrictedToken);
      job = CreateJobObject(IntPtr.Zero, null);
      if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject");
      var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_JOB_MEMORY;
      limits.BasicLimitInformation.ActiveProcessLimit = (uint)processLimit;
      limits.JobMemoryLimit = new UIntPtr(memoryBytes);
      SetJobInfo(job, 9, limits);
      uint hostCores = (uint)Math.Max(1, Environment.ProcessorCount);
      uint rate = Math.Max(1u, Math.Min(10000u, (uint)Math.Ceiling(10000.0 * Math.Max(1, cpuCores) / hostCores)));
      SetJobInfo(job, 15, new JOBOBJECT_CPU_RATE_CONTROL_INFORMATION { ControlFlags = JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP, CpuRate = rate });
      string profile = Path.Combine(workingDirectory, @".weave\profile");
      environment = EnvironmentBlock(new Dictionary<string,string> {
        { "PATH", @"C:\Windows\System32;C:\Windows\System32\WindowsPowerShell\v1.0" },
        { "SystemRoot", @"C:\Windows" }, { "WINDIR", @"C:\Windows" }, { "ComSpec", @"C:\Windows\System32\cmd.exe" },
        { "USERPROFILE", profile }, { "APPDATA", Path.Combine(profile, @"AppData\Roaming") },
        { "LOCALAPPDATA", Path.Combine(profile, @"AppData\Local") }, { "ProgramData", @"C:\ProgramData" },
        { "TEMP", workingDirectory + @"\.weave\temp" }, { "TMP", workingDirectory + @"\.weave\temp" },
        { "CI", "1" }, { "WEAVE_WORKER", "1" }
      });
      string powershell = @"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe";
      string command = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + workerPath + "\" -RequestPath \"" + requestPath + "\" -ResultPath \"" + resultPath + "\"";
      var startup = new STARTUPINFO { cb = Marshal.SizeOf(typeof(STARTUPINFO)) };
      Check(CreateProcessAsUser(restrictedToken, powershell, command, IntPtr.Zero, IntPtr.Zero, false, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW, environment, workingDirectory, ref startup, out process), "CreateProcessAsUser");
      Check(AssignProcessToJobObject(job, process.hProcess), "AssignProcessToJobObject");
      if (ResumeThread(process.hThread) == UInt32.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread");
      uint wait = WaitForSingleObject(process.hProcess, (uint)timeoutMs);
      if (wait == WAIT_TIMEOUT) { TerminateJobObject(job, 1460); throw new TimeoutException("WINDOWS_WORKER_TIMEOUT"); }
      if (wait != WAIT_OBJECT_0) { TerminateJobObject(job, 1); throw new Win32Exception(Marshal.GetLastWin32Error(), "WaitForSingleObject"); }
      uint exitCode;
      Check(GetExitCodeProcess(process.hProcess, out exitCode), "GetExitCodeProcess");
      return (int)exitCode;
    } finally {
      if (job != IntPtr.Zero) CloseHandle(job);
      if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
      if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
      if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
      if (restrictedToken != IntPtr.Zero) CloseHandle(restrictedToken);
      if (userToken != IntPtr.Zero) CloseHandle(userToken);
    }
  }
}
'@

try {
  $policy = Get-Content -LiteralPath $PolicyPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $request = Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $workspaceRoot = [string]$request.workspaceRoot
  if (-not $workspaceRoot.StartsWith('C:\Weave\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid worker workspace root' }
  New-Item -ItemType Directory -Path (Join-Path $workspaceRoot '.weave\temp') -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $workspaceRoot '.weave\profile\AppData\Local') -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $workspaceRoot '.weave\profile\AppData\Roaming') -Force | Out-Null
  & icacls.exe $workspaceRoot /setintegritylevel '(OI)(CI)L' /T /C /Q | Out-Null
  Add-Type -TypeDefinition $source -Language CSharp
  $workerExitCode = [WeaveWindowsJob]::Run(
    $WorkerPath,
    $RequestPath,
    $ResultPath,
    $workspaceRoot,
    [int]$policy.job.activeProcessLimit,
    [uint64]$policy.job.memoryBytes,
    [int]$policy.job.timeoutMs,
    [int]$policy.job.cpuCores
  )
  if (-not (Test-Path -LiteralPath $ResultPath)) { throw "Worker exited without a result (exit code $workerExitCode)" }
} catch {
  if (-not (Test-Path -LiteralPath $ResultPath)) {
    $request = Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $timedOut = $_.Exception.ToString().Contains('WINDOWS_WORKER_TIMEOUT')
    $errorCode = if ($timedOut) { 'TOOL_TIMEOUT' } else { 'WINDOWS_WORKER_SUPERVISOR_FAILED' }
    $summary = if ($timedOut) { 'Windows worker exceeded its action timeout' } else { 'Windows worker supervisor failed' }
    $errorPayload = @{ code = $errorCode; message = $summary; retryable = $false }
    @{
      callId = $request.call.callId
      providerCallId = $request.call.providerCallId
      toolName = $request.call.name
      isError = $true
      content = @{ summary = $summary; error = $errorPayload }
    } | ConvertTo-Json -Depth 10 -Compress | Set-Content -LiteralPath $ResultPath -Encoding UTF8
  }
}
`;
