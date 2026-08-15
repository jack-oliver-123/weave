import { randomUUID } from 'node:crypto';
import type { CapabilityPrimitive } from '../security/domain.js';
import {
  captureWorkspaceSnapshots,
  defaultTransactionRoot,
  TaskWorkspaceView,
  WorkspaceCommitBroker,
  type FileSnapshot,
  type WorkspaceChangeSet,
} from './workspace-transaction.js';
import type {
  ActionWorkerBackend,
  ActionWorkerLaunchInput,
  ActionWorkerResult,
  TaskSandboxBackend,
} from './supervisor.js';
import type { ResourceBudget } from './resources.js';
import { WindowsSandboxTaskVm, type WindowsSandboxCli } from './windows-backend.js';
import { WindowsJobObjectWorker } from './windows-worker-supervisor.js';

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
    private currentView: TaskWorkspaceView,
    private currentGuestWorkspace: string,
    private readonly views: TaskWorkspaceView[],
    private readonly certifiedCapabilities: ReadonlySet<CapabilityPrimitive>,
    private readonly createId: () => string,
  ) {}

  static async create(options: WindowsTaskSandboxOptions): Promise<WindowsTaskSandbox> {
    const baselineView = await TaskWorkspaceView.create(options.workspaceRoot);
    let view: TaskWorkspaceView | undefined;
    try {
      view = await TaskWorkspaceView.create(options.workspaceRoot);
      const vm = await WindowsSandboxTaskVm.start(options.cli, {
        taskId: options.taskId,
        sandboxId: options.sandboxId,
        budget: options.budget,
        baselinePath: baselineView.root,
        cowPath: view.root,
      });
      return new WindowsTaskSandbox(
        options.workspaceRoot,
        vm,
        view,
        'C:\\Weave\\Cow',
        [baselineView, view],
        new Set(options.certifiedCapabilities),
        options.createId ?? randomUUID,
      );
    } catch (error) {
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
        guestWorkspaceRoot: this.currentGuestWorkspace,
        input,
        createId: this.createId,
      });
    }

    const actionView = await TaskWorkspaceView.create(this.currentView.root);
    const shareId = safeId(this.createId());
    const guestWorkspace = `C:\\Weave\\Action-${shareId}`;
    let shared = false;
    try {
      await this.vm.share(actionView.root, guestWorkspace, true);
      shared = true;
      this.views.push(actionView);
      const baselines = await captureWorkspaceSnapshots(this.workspaceRoot);
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
        input,
        createId: this.createId,
      });
      return new TransactionalWindowsWorker(delegate, actionView, baselines, broker, async () => {
        this.currentView = actionView;
        this.currentGuestWorkspace = guestWorkspace;
      });
    } catch (error) {
      if (!shared) await actionView.close();
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
    const settled = await Promise.allSettled(this.views.map((view) => view.close()));
    errors.push(...settled.filter((item): item is PromiseRejectedResult => item.status === 'rejected').map((item) => item.reason));
    if (errors.length > 0) throw new AggregateError(errors, 'Failed to close Windows task sandbox');
  }
}

class TransactionalWindowsWorker implements ActionWorkerBackend {
  constructor(
    private readonly delegate: WindowsJobObjectWorker,
    private readonly view: TaskWorkspaceView,
    private readonly baselines: ReadonlyMap<string, FileSnapshot>,
    private readonly broker: WorkspaceCommitBroker,
    private readonly adopt: () => Promise<void>,
  ) {}

  async execute(signal: AbortSignal): Promise<ActionWorkerResult> {
    const outcome = await this.delegate.execute(signal);
    if (outcome.result.isError || signal.aborted) return outcome;
    try {
      const extracted = await this.view.extractChangeSet(outcome.result.callId);
      const changeSet: WorkspaceChangeSet = {
        actionId: extracted.actionId,
        changes: extracted.changes.map((change) => ({
          ...change,
          baseline: this.baselines.get(change.path) ?? { exists: false },
        })),
      };
      await this.broker.commit(changeSet);
      await this.adopt();
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
    await this.delegate.close();
  }
}

function safeId(value: string): string {
  if (!/^[A-Za-z0-9-]{1,128}$/.test(value)) throw new Error('INVALID_WORKER_ID');
  return value;
}

function transactionErrorCode(message: string): string {
  return /^(RECOVERY_CONFLICT|FILE_CHANGED_DURING_EDIT|PERMISSION_DENIED|PATH_OUTSIDE_WORKSPACE)/.exec(message)?.[1]
    ?? 'TRANSACTION_COMMIT_FAILED';
}
