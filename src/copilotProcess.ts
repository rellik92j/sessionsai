// Starting and stopping one Copilot CLI chat turn's process tree. Copilot runs shell commands as its own children, and
// Stop has to end those too, not just copilot. No vscode import, so the tests can run it on any platform.

import { ChildProcess, execFile, SpawnOptions } from 'child_process';

/** How long a turn's process group gets to exit on SIGTERM before it is sent SIGKILL (macOS and Linux). */
export const GROUP_KILL_GRACE_MS = 3000;

/**
 * The spawn options for one turn. On macOS and Linux the turn is detached: it leads a process group of its own, which
 * every command copilot starts joins, so Stop can signal the whole group at once. On Windows nothing changes: detached
 * would open a console window there, and `taskkill /T` walks the tree instead.
 */
export function turnSpawnOptions(options: SpawnOptions, platform: NodeJS.Platform = process.platform): SpawnOptions {
  return platform === 'win32' ? options : { ...options, detached: true };
}

/** The process a turn runs as: the parts of a ChildProcess that killing its tree reads. */
export type TurnProcess = Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode' | 'kill'>;

export interface TreeKillDeps {
  platform: NodeJS.Platform;
  /** Runs taskkill (Windows). */
  execFile: (file: string, args: string[], options: { windowsHide: boolean }, callback: (err: Error | null) => void) => unknown;
  /** Signals a whole process group: process.kill(-pgid, signal). */
  killGroup: (pgid: number, signal: NodeJS.Signals) => void;
  graceMs: number;
  setTimeout: (f: () => void, ms: number) => unknown;
}

const defaultDeps: TreeKillDeps = {
  platform: process.platform,
  execFile: (file, args, options, callback) => execFile(file, args, options, (err) => callback(err)),
  killGroup: (pgid, signal) => process.kill(-pgid, signal),
  graceMs: GROUP_KILL_GRACE_MS,
  setTimeout: (f, ms) => setTimeout(f, ms),
};

const running = (child: TurnProcess) => child.exitCode === null && child.signalCode === null;

/**
 * Stops a turn started with turnSpawnOptions, and every process it started.
 *
 * - Windows: `taskkill /pid <pid> /T /F`, falling back to killing the turn's own process if taskkill fails.
 * - macOS and Linux: SIGTERM to the turn's process group, so copilot and the commands it runs get it at once; then,
 *   if copilot itself has not exited after graceMs, SIGKILL to the group. The SIGKILL is only sent while copilot is
 *   still running: while it runs, its pid is the group's id and cannot belong to anyone else. Once it has exited and
 *   been reaped, that id could in principle be reused by a process this extension did not start.
 */
export function killTurnTree(child: TurnProcess, deps: Partial<TreeKillDeps> = {}): void {
  const d = { ...defaultDeps, ...deps };
  const pid = child.pid;
  if (!pid) {
    child.kill();
    return;
  }
  if (d.platform === 'win32') {
    d.execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, (err) => {
      if (err) {
        child.kill();
      }
    });
    return;
  }
  if (!signalGroup(child, pid, 'SIGTERM', d)) {
    return;
  }
  d.setTimeout(() => {
    if (running(child)) {
      signalGroup(child, pid, 'SIGKILL', d);
    }
  }, d.graceMs);
}

/** Signals the turn's group; false when there is nothing left to wait for. */
function signalGroup(child: TurnProcess, pgid: number, signal: NodeJS.Signals, d: TreeKillDeps): boolean {
  try {
    d.killGroup(pgid, signal);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
      // No such group: everything in it has already exited.
      return false;
    }
    // Not a group of its own after all (or not ours to signal): signal copilot alone, as before.
    child.kill(signal);
    return true;
  }
}
