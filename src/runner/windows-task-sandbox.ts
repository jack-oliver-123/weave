import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { CapabilityPrimitive } from '../security/domain.js';
import {
  defaultTransactionRoot,
  TaskWorkspaceView,
  WorkspaceCommitBroker,
} from './workspace-transaction.js';
import type {
  ActionWorkerBackend,
  ActionWorkerLaunchInput,
  ActionWorkerResult,
  TaskSandboxBackend,
} from './supervisor.js';
import type { ResourceBudget } from './resources.js';
import { WindowsSandboxTaskVm, type WindowsSandboxCli } from './windows-backend.js';
import { provisionWindowsWorkerRuntime, WindowsJobObjectWorker } from './windows-worker-supervisor.js';

export interface WindowsTaskSandboxOptions {
  readonly taskId: string;
  readonly sandboxId: string;
  readonly budget: ResourceBudget;
  readonly workspaceRoot: string;
  readonly cli: WindowsSandboxCli;
  readonly certifiedCapabilities: readonly CapabilityPrimitive[];
  readonly createId?: () => string;
}

export class WindowsTaskSandbox implements TaskSandboxBackend {
  private closed = false;
  private constructor(
    private readonly workspaceRoot: string,
    private readonly vm: WindowsSandboxTaskVm,
    private readonly baselineView: TaskWorkspaceView,
    private readonly currentView: TaskWorkspaceView,
    private readonly bridgeGuestPath: string,
    private readonly certifiedCapabilities: ReadonlySet<CapabilityPrimitive>,
    private readonly createId: () => string,
  ) {}

  static async create(options: WindowsTaskSandboxOptions): Promise<WindowsTaskSandbox> {
    const baselineView = await TaskWorkspaceView.create(options.workspaceRoot);
    let view: TaskWorkspaceView | undefined;
    let vm: WindowsSandboxTaskVm | undefined;
    try {
      view = await TaskWorkspaceView.create(options.workspaceRoot);
      vm = await WindowsSandboxTaskVm.start(options.cli, {
        taskId: options.taskId,
        sandboxId: options.sandboxId,
        budget: options.budget,
        baselinePath: baselineView.root,
        cowPath: view.root,
      });
      const bridgeGuestPath = await provisionWindowsWorkerRuntime(vm, view.root);
      return new WindowsTaskSandbox(
        options.workspaceRoot,
        vm,
        baselineView,
        view,
        bridgeGuestPath,
        new Set(options.certifiedCapabilities),
        options.createId ?? randomUUID,
      );
    } catch (error) {
      await vm?.stop().catch(() => undefined);
      await Promise.allSettled([baselineView.close(), view?.close() ?? Promise.resolve()]);
      throw error;
    }
  }

  async openWorker(input: ActionWorkerLaunchInput): Promise<ActionWorkerBackend> {
    if (this.closed) throw new Error('TASK_SANDBOX_CLOSED');
    const requirements = input.action.manifest.requirements;
    for (const requirement of requirements) {
      if (!this.certifiedCapabilities.has(requirement.type)) throw new Error('SANDBOX_CAPABILITY_UNAVAILABLE');
    }
    const writes = requirements.some((requirement) => requirement.type === 'FilesystemWrite');
    if (!writes) {
      return new WindowsJobObjectWorker({
        vm: this.vm,
        cowHostRoot: this.currentView.root,
        guestWorkspaceRoot: 'C:\\Weave\\Cow',
        bridgeGuestPath: this.bridgeGuestPath,
        input,
        createId: this.createId,
      });
    }

    const actionViewsRoot = join(this.currentView.root, '.weave', 'action-views');
    await mkdir(actionViewsRoot, { recursive: true });
    const candidatePaths = structuredWriteCandidates(input);
    const actionView = await this.currentView.fork(actionViewsRoot, candidatePaths);
    const guestWorkspace = `C:\\Weave\\Cow\\.weave\\action-views\\${basename(actionView.root)}`;
    try {
      const allowedPaths = requirements.flatMap((requirement) => requirement.type === 'FilesystemWrite' ? requirement.paths : []);
      const broker = await WorkspaceCommitBroker.create({
        workspaceRoot: this.workspaceRoot,
        transactionRoot: defaultTransactionRoot(this.workspaceRoot),
        allowedPaths,
      });
      const delegate = new WindowsJobObjectWorker({
        vm: this.vm,
        cowHostRoot: actionView.root,
        guestWorkspaceRoot: guestWorkspace,
        bridgeGuestPath: this.bridgeGuestPath,
        input,
        createId: this.createId,
      });
      return new TransactionalWindowsWorker(
        delegate,
        actionView,
        broker,
        this.currentView,
        candidatePaths,
      );
    } catch (error) {
      await actionView.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const errors: unknown[] = [];
    try {
      await this.vm.stop();
    } catch (error) {
      errors.push(error);
    }
    const settled = await Promise.allSettled([this.baselineView.close(), this.currentView.close()]);
    errors.push(...settled.filter((item): item is PromiseRejectedResult => item.status === 'rejected').map((item) => item.reason));
    if (errors.length > 0) throw new AggregateError(errors, 'Failed to close Windows task sandbox');
  }
}

class TransactionalWindowsWorker implements ActionWorkerBackend {
  constructor(
    private readonly delegate: WindowsJobObjectWorker,
    private readonly view: TaskWorkspaceView,
    private readonly broker: WorkspaceCommitBroker,
    private readonly currentView: TaskWorkspaceView,
    private readonly candidatePaths: readonly string[] | undefined,
  ) {}

  async execute(signal: AbortSignal): Promise<ActionWorkerResult> {
    const outcome = await this.delegate.execute(signal);
    if (outcome.result.isError || signal.aborted) return outcome;
    try {
      const changeSet = await this.view.extractChangeSet(outcome.result.callId, this.candidatePaths);
      const committed = await this.broker.commit(changeSet);
      await this.currentView.refreshFrom(this.broker.workspaceRoot, committed.paths);
      return outcome;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Windows transaction failed';
      return {
        result: {
          callId: outcome.result.callId,
          providerCallId: outcome.result.providerCallId,
          toolName: outcome.result.toolName,
          isError: true,
          content: {
            summary: message,
            error: { code: transactionErrorCode(message), message, retryable: false },
          },
        },
      };
    }
  }

  async close(reason: 'action_completed' | 'cancelled' | 'failed'): Promise<void> {
    void reason;
    const settled = await Promise.allSettled([this.delegate.close(), this.view.close()]);
    const errors = settled.filter((item): item is PromiseRejectedResult => item.status === 'rejected').map((item) => item.reason);
    if (errors.length > 0) throw new AggregateError(errors, 'Failed to close Windows action worker');
  }
}

function structuredWriteCandidates(input: ActionWorkerLaunchInput): readonly string[] | undefined {
  if (input.call.name !== 'create_file' && input.call.name !== 'edit_file') return undefined;
  const payload = input.call.input;
  if (typeof payload !== 'object' || payload === null || !('path' in payload)) return undefined;
  const path = payload.path;
  return typeof path === 'string' ? Object.freeze([path]) : undefined;
}

function transactionErrorCode(message: string): string {
  return /^(RECOVERY_CONFLICT|FILE_CHANGED_DURING_EDIT|PERMISSION_DENIED|PATH_OUTSIDE_WORKSPACE)/.exec(message)?.[1]
    ?? 'TRANSACTION_COMMIT_FAILED';
}
