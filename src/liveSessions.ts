import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { escapeHtml, formatDateTime } from './format';
import { parseAgentMessage, records } from './sessionParser';

/**
 * Which sessions are running in a Claude Code process right now, and what they still have running in the background.
 *
 * Claude Code keeps a file per running process in `<config dir>/sessions/<pid>.json` (next to `projects/`), holding
 * the session it has open, where it runs (a terminal, `claude --bg`, `claude -p`), and whether it is busy or idle.
 * The file stays behind when the process crashes, so an entry only counts while its pid is alive and, where the
 * start time can be checked (Windows), the pid still belongs to the process that wrote it.
 *
 * Nothing here is written to; an entry or a record of a shape this does not know is skipped.
 */

/** A Claude Code process with a session open, from its registry file. */
export interface LiveProcess {
  pid: number;
  sessionId: string;
  cwd?: string;
  /** "interactive", or "bg" for `claude --bg`. */
  kind?: string;
  /** "cli" in a terminal, "sdk-cli" for `claude -p` (this extension's own chat is one). */
  entrypoint?: string;
  /** "busy" while a turn runs, "idle" at the prompt. */
  status?: string;
  name?: string;
  agent?: string;
  /** When the process started (ms since epoch). */
  startedAt?: number;
  /** The process's start time as the OS gives it (a Windows FILETIME), to tell a reused pid from the writer. */
  procStart?: string;
  /** "<platform>:<host>" the pid belongs to. */
  pidDomain?: string;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** One registry file's entry, or undefined for a file without a pid and a session id (or not JSON at all). */
export function parseRegistryEntry(text: string): LiveProcess | undefined {
  let j: any;
  try {
    j = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!j || typeof j !== 'object') {
    return undefined;
  }
  const pid = num(j.pid);
  const sessionId = str(j.sessionId);
  if (pid === undefined || pid <= 0 || !Number.isInteger(pid) || !sessionId) {
    return undefined;
  }
  const p: LiveProcess = { pid, sessionId };
  const fields: [keyof LiveProcess, unknown][] = [
    ['cwd', str(j.cwd)],
    ['kind', str(j.kind)],
    ['entrypoint', str(j.entrypoint)],
    ['status', str(j.status)],
    ['name', str(j.name)],
    ['agent', str(j.agent)],
    ['startedAt', num(j.startedAt)],
    ['procStart', str(j.procStart) ?? (typeof j.procStart === 'number' ? String(j.procStart) : undefined)],
    ['pidDomain', str(j.pidDomain)],
  ];
  for (const [k, v] of fields) {
    if (v !== undefined) {
      (p as any)[k] = v;
    }
  }
  return p;
}

/** The registry folder for a projects folder: `sessions` beside it, in the same Claude Code config folder. */
export function registryDirFor(projectsDir: string): string {
  return path.join(path.dirname(projectsDir), 'sessions');
}

/** Every entry in the registry folder, whether its process is alive or not; empty when the folder is missing. */
export async function readRegistry(dir: string): Promise<LiveProcess[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: LiveProcess[] = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) {
      continue;
    }
    const text = await fs.readFile(path.join(dir, name), 'utf8').catch(() => undefined);
    const entry = text === undefined ? undefined : parseRegistryEntry(text);
    if (entry) {
      out.push(entry);
    }
  }
  return out;
}

/** How to ask the OS about a process; a fake in tests. */
export interface ProcessProbe {
  platform: string;
  /** The pid names a running process (any process). */
  isAlive(pid: number): boolean;
  /**
   * The start time of each pid that is running, in the form registry files give it; undefined when they cannot be
   * looked up, so entries go unchecked rather than dropped.
   */
  startTimes?(pids: number[]): Promise<Map<number, string> | undefined>;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: there is a process, owned by someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Windows start times as FILETIMEs, which is what Claude Code writes as procStart there. */
function windowsStartTimes(pids: number[]): Promise<Map<number, string> | undefined> {
  const list = pids.filter((p) => Number.isInteger(p) && p > 0).join(',');
  if (!list) {
    return Promise.resolve(new Map());
  }
  const script = `Get-Process -Id ${list} -ErrorAction SilentlyContinue | ForEach-Object { try { "$($_.Id) $($_.StartTime.ToFileTimeUtc())" } catch {} }`;
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 15_000, windowsHide: true }, (err, stdout) => {
      if (err && !stdout) {
        resolve(undefined);
        return;
      }
      const out = new Map<number, string>();
      for (const line of String(stdout).split(/\r?\n/)) {
        const m = /^(\d+) (\d+)$/.exec(line.trim());
        if (m) {
          out.set(Number(m[1]), m[2]);
        }
      }
      resolve(out);
    });
  });
}

/** The real OS. Start times are only checked on Windows, where the registry's procStart has been seen to match. */
export const systemProbe: ProcessProbe = {
  platform: process.platform,
  isAlive,
  startTimes: process.platform === 'win32' ? windowsStartTimes : undefined,
};

/** Two start times for the same process; Windows gives 100 ns units, and one second either way is the same start. */
function sameStart(a: string, b: string): boolean {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    const d = BigInt(a) - BigInt(b);
    return (d < 0n ? -d : d) <= 10_000_000n;
  }
  return a === b;
}

/**
 * What earlier start-time checks found, so a process is not looked up on every refresh (on Windows a lookup is a
 * PowerShell spawn of about a second).
 */
export interface StartCheckCache {
  /** pid -> the procStart found to be that running process's own. */
  verified: Map<number, string>;
  /** pid -> when it was last found to be (ms since epoch); it is looked up again VERIFIED_RECHECK_MS later. */
  verifiedAt: Map<number, number>;
  /** pid -> a procStart found not to be (the pid was reused after a crash). Kept until the pid dies. */
  rejected: Map<number, string>;
  /** After a failed lookup, no new one is tried before this time (ms since epoch). */
  retryAt?: number;
}

export const newStartCheckCache = (): StartCheckCache => ({ verified: new Map(), verifiedAt: new Map(), rejected: new Map() });

/** How long a failed start-time lookup is not retried. Entries count as live meanwhile, as they do on failure. */
export const START_LOOKUP_BACKOFF_MS = 60_000;

/**
 * How long a verified pid is trusted before it is looked up again. Between two refreshes (10 s) the process can crash
 * and Windows hand its pid to another one, which `isAlive` cannot tell from the writer; this bounds how long such a
 * stale entry stays live.
 */
export const VERIFIED_RECHECK_MS = 5 * 60_000;

/**
 * The entries whose process is still the one that wrote them. A dead pid is dropped; so is a live pid whose start
 * time differs from the entry's (the pid was reused after a crash). `cache` remembers both answers until the pid dies,
 * looks a verified pid up again every VERIFIED_RECHECK_MS, and backs off after a failed lookup.
 */
export async function liveOnly(entries: LiveProcess[], probe: ProcessProbe, cache = newStartCheckCache(), now = Date.now()): Promise<LiveProcess[]> {
  const { verified, verifiedAt, rejected } = cache;
  const alive: LiveProcess[] = [];
  for (const e of entries) {
    // A registry folder shared with another system (a synced home folder, WSL) holds pids that mean nothing here.
    if (e.pidDomain && !e.pidDomain.startsWith(`${probe.platform}:`)) {
      continue;
    }
    if (probe.isAlive(e.pid)) {
      alive.push(e);
    }
  }
  // A pid that died, or whose file is gone, is forgotten: a later process may get it.
  const alivePids = new Set(alive.map((e) => e.pid));
  for (const m of [verified, verifiedAt, rejected]) {
    for (const pid of m.keys()) {
      if (!alivePids.has(pid)) {
        m.delete(pid);
      }
    }
  }
  // Verified, and recently enough that a crash and a reused pid since are unlikely.
  const fresh = (e: LiveProcess) => verified.get(e.pid) === e.procStart && now - (verifiedAt.get(e.pid) ?? -Infinity) < VERIFIED_RECHECK_MS;
  const known = (e: LiveProcess) => !e.procStart || fresh(e) || rejected.get(e.pid) === e.procStart;
  const unchecked = alive.filter((e) => !known(e));
  let times: Map<number, string> | undefined;
  if (unchecked.length && probe.startTimes && !(cache.retryAt !== undefined && now < cache.retryAt)) {
    times = await probe.startTimes([...new Set(unchecked.map((e) => e.pid))]).catch(() => undefined);
    cache.retryAt = times ? undefined : now + START_LOOKUP_BACKOFF_MS;
  }
  return alive.filter((e) => {
    if (!e.procStart || fresh(e)) {
      return true;
    }
    if (rejected.get(e.pid) === e.procStart) {
      return false;
    }
    if (!times) {
      // Not checked (no lookup on this system, it failed, or it is backing off): counted rather than hidden, as a
      // verified pid due for its re-check is until the lookup works.
      return true;
    }
    const actual = times.get(e.pid);
    if (actual === undefined) {
      // Not running by the time of the lookup, or its start time is not readable; asked again next time.
      return false;
    }
    if (sameStart(actual, e.procStart)) {
      verified.set(e.pid, e.procStart);
      verifiedAt.set(e.pid, now);
      return true;
    }
    // Verified before, perhaps, but the writer has since crashed and another process has its pid.
    verified.delete(e.pid);
    verifiedAt.delete(e.pid);
    rejected.set(e.pid, e.procStart);
    return false;
  });
}

// ---------- what a session still has running ----------

/** A background subagent or shell a session started and has not heard the end of. */
export interface RunningTask {
  kind: 'agent' | 'shell';
  /** The agent id, or the background task id. */
  id: string;
  /** A named agent's type; undefined for a built-in one-off agent. */
  name?: string;
  description?: string;
  /** When it was launched (ms since epoch). */
  since?: number;
  /** The agent has stopped but waits on background work of its own. */
  waiting?: boolean;
  /** When the main log was told it waits (ms since epoch). */
  waitingSince?: number;
}

const AGENT_ID = /\bagentId: ([\w-]+)/;
const isAgentTool = (name: unknown) => name === 'Agent' || name === 'Task';
const isStopTool = (name: unknown) => name === 'TaskStop' || name === 'KillShell' || name === 'KillBash';
const time = (ts: unknown): number | undefined => {
  const t = typeof ts === 'string' ? Date.parse(ts) : NaN;
  return Number.isNaN(t) ? undefined : t;
};
const tag = (text: string, name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim();

/**
 * The text of a record that may carry a task notification: a user message, or a prompt queued mid-turn. In a
 * subagent's own log the notification follows a "[SYSTEM NOTIFICATION ...]" preamble, and the record's origin says so.
 */
function notificationText(r: any): string | undefined {
  let raw: unknown;
  if (r.type === 'user') {
    const c = r.message?.content;
    raw = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p) => p?.type === 'text').map((p) => p.text).join('\n') : undefined;
  } else if (r.type === 'attachment' && r.attachment?.type === 'queued_command') {
    raw = r.attachment.prompt;
  }
  if (typeof raw !== 'string') {
    return undefined;
  }
  return /^\s*<task-notification>/.test(raw) || (r.origin?.kind === 'task-notification' && raw.includes('<task-notification>')) ? raw : undefined;
}

/**
 * Follows a log record by record and keeps the background subagents and shells it launched and has no word of ending
 * (see `runningTasks`), so a caller already reading the log for something else need not read it twice.
 */
export interface TaskTracker {
  add(record: any): void;
  tasks(): RunningTask[];
}

/** `sidechain`: the log is a subagent's own, whose records are all sidechain records; otherwise those are skipped. */
export function trackTasks(options: { sidechain?: boolean } = {}): TaskTracker {
  const calls = new Map<string, { name: unknown; input: any }>();
  const tasks = new Map<string, RunningTask & { toolUseId?: string }>();
  const end = (id: unknown) => {
    if (typeof id === 'string') {
      tasks.delete(id);
    }
  };
  const add = (r: any) => {
    if (!r || typeof r !== 'object' || (r.isSidechain && !options.sidechain)) {
      return;
    }
    const content = r.message?.content;
    if (r.type === 'assistant' && Array.isArray(content)) {
      for (const p of content) {
        if (p?.type === 'tool_use' && typeof p.id === 'string') {
          calls.set(p.id, { name: p.name, input: p.input && typeof p.input === 'object' ? p.input : {} });
        }
      }
      return;
    }
    const note = notificationText(r);
    if (note) {
      const id = tag(note, 'task-id');
      const toolUseId = tag(note, 'tool-use-id');
      const task = (id && tasks.get(id)) || [...tasks.values()].find((t) => toolUseId && t.toolUseId === toolUseId);
      if (task) {
        // "Agent "x" is waiting on its own background work": it stopped, but what it started still runs.
        if (/\bis waiting on\b/i.test(tag(note, 'summary') ?? '')) {
          task.waiting = true;
          task.waitingSince = time(r.timestamp);
        } else {
          tasks.delete(task.id);
        }
      }
      return;
    }
    if (r.type === 'attachment' || (r.type === 'user' && r.isMeta)) {
      const msg = parseAgentMessage(r);
      if (msg) {
        // A hand-back is the agent's last act.
        end(msg.from);
      }
      return;
    }
    if (r.type !== 'user' || !Array.isArray(content)) {
      return;
    }
    const result = r.toolUseResult && typeof r.toolUseResult === 'object' ? r.toolUseResult : {};
    for (const p of content) {
      if (p?.type !== 'tool_result') {
        continue;
      }
      const call = typeof p.tool_use_id === 'string' ? calls.get(p.tool_use_id) : undefined;
      const text = typeof p.content === 'string' ? p.content : Array.isArray(p.content) ? p.content.map((c: any) => c?.text ?? '').join('\n') : '';
      if (isAgentTool(call?.name) && (result.isAsync === true || result.status === 'async_launched' || /^Async agent launched\b/.test(text))) {
        const id = str(result.agentId) ?? AGENT_ID.exec(text)?.[1];
        if (id) {
          const type = str(call!.input.subagent_type);
          tasks.set(id, {
            kind: 'agent',
            id,
            name: type && type !== 'general-purpose' ? type : undefined,
            description: str(result.description) ?? str(call!.input.description),
            since: time(r.timestamp),
            toolUseId: p.tool_use_id,
          });
        }
      } else if (str(result.backgroundTaskId)) {
        const id = result.backgroundTaskId as string;
        const command = str(call?.input.command)?.split(/\r?\n/)[0];
        tasks.set(id, { kind: 'shell', id, description: str(call?.input.description) ?? command, since: time(r.timestamp), toolUseId: p.tool_use_id });
      } else if (isStopTool(call?.name) && !p.is_error) {
        end(str(result.task_id) ?? str(result.shell_id) ?? str(call!.input.task_id) ?? str(call!.input.shell_id));
      }
    }
  };
  return {
    add: (r) => {
      try {
        add(r);
      } catch {
        // A record of a shape this does not know is skipped.
      }
    },
    tasks: () => [...tasks.values()].map(({ toolUseId: _, ...t }) => t),
  };
}

/**
 * The background subagents and shells the main thread of a log launched and has no word of ending: no task
 * notification that they finished, failed or were stopped, no hand-back, no TaskStop. Whether they really still run
 * depends on the process that launched them being alive, which the log cannot say (see `tasksOf`). A subagent waiting
 * on its own background work stays listed until the main log hears from it again; `settleWaiting` asks its own log.
 */
export function runningTasks(log: string | Iterable<any>, options: { sidechain?: boolean } = {}): RunningTask[] {
  const tracker = trackTasks(options);
  for (const r of typeof log === 'string' ? records(log) : log) {
    tracker.add(r);
  }
  return tracker.tasks();
}

/** A tool call that is a subagent's last act; one after it does not mean it is working again. */
const isLastAct = (name: unknown) => name === 'SubagentHandback';

/**
 * Where a subagent that stopped to wait on its own background work stands, from its own log
 * (`subagents/agent-<id>.jsonl`): `working` when it has resumed since `since` and is mid-turn, `waiting` while
 * background work it started has no word of ending, and `done` when all of that has ended and it is not working: it
 * will not resume, or is about to stop, and the main log hears of it next.
 */
export function waitingState(ownLog: string, since: number | undefined): 'working' | 'waiting' | 'done' {
  const tracker = trackTasks({ sidechain: true });
  let last: any;
  for (const r of records(ownLog)) {
    tracker.add(r);
    if (r?.type === 'assistant' && Array.isArray(r.message?.content) && r.message.content.length) {
      last = r;
    }
  }
  const lastAt = time(last?.timestamp);
  const resumed = !!last && (since === undefined || (lastAt !== undefined && lastAt > since));
  if (resumed && last.message.content.some((p: any) => p?.type === 'tool_use' && !isLastAct(p.name))) {
    return 'working';
  }
  return tracker.tasks().length ? 'waiting' : 'done';
}

/**
 * `tasks` with each subagent marked waiting checked against its own log (`ownLog(agentId)`, undefined when it cannot
 * be read, which leaves the task as it is): dropped once its background work has all ended, and no longer marked
 * waiting once it is working again.
 */
export function settleWaiting(tasks: RunningTask[], ownLog: (agentId: string) => string | undefined): RunningTask[] {
  const out: RunningTask[] = [];
  for (const t of tasks) {
    const log = t.kind === 'agent' && t.waiting ? ownLog(t.id) : undefined;
    if (log === undefined) {
      out.push(t);
      continue;
    }
    const state = waitingState(log, t.waitingSince);
    if (state === 'working') {
      const { waiting: _w, waitingSince: _s, ...running } = t;
      out.push(running);
    } else if (state === 'waiting') {
      out.push(t);
    }
  }
  return out;
}

/** `settleWaiting`, reading the waiting subagents' own logs from `<sessionId>/subagents/` beside the session's log. */
export async function settleWaitingFromDisk(tasks: RunningTask[], sessionFile: string, sessionId: string): Promise<RunningTask[]> {
  const waiting = tasks.filter((t) => t.kind === 'agent' && t.waiting && /^[\w-]+$/.test(t.id));
  if (!waiting.length) {
    return tasks;
  }
  const dir = path.join(path.dirname(sessionFile), sessionId, 'subagents');
  const logs = new Map<string, string | undefined>(
    await Promise.all(waiting.map(async (t) => [t.id, await fs.readFile(path.join(dir, `agent-${t.id}.jsonl`), 'utf8').catch(() => undefined)] as const)),
  );
  return settleWaiting(tasks, (id) => logs.get(id));
}

/** What a session's log says still runs in the background, waiting subagents checked against their own logs. */
export function readRunningTasks(log: string, sessionFile: string, sessionId: string): Promise<RunningTask[]> {
  return settleWaitingFromDisk(runningTasks(log), sessionFile, sessionId);
}

/**
 * What still runs for a live process: the unfinished tasks launched since it started. Background work dies with the
 * process that started it, so a task from before a restart (the session resumed since) is not running.
 */
export function tasksOf(tasks: RunningTask[], proc: LiveProcess): RunningTask[] {
  const start = proc.startedAt;
  return start === undefined ? tasks : tasks.filter((t) => t.since === undefined || t.since >= start - 2000);
}

// ---------- words ----------

/** Where the process runs, as in "Live in a terminal". */
export function whereLive(p: LiveProcess): string {
  if (p.kind === 'bg') {
    return 'in the background (claude --bg)';
  }
  if (/vscode/i.test(p.entrypoint ?? '')) {
    return 'in the Claude Code chat';
  }
  if (/^sdk/i.test(p.entrypoint ?? '')) {
    return 'in another Claude Code process';
  }
  return 'in a terminal';
}

/** "working" while a turn runs, "idle" at the prompt, or whatever else the registry says. */
export function liveState(p: LiveProcess): string | undefined {
  return p.status === 'busy' ? 'working' : p.status;
}

/** "Live in a terminal · idle". */
export function liveLabel(p: LiveProcess): string {
  const state = liveState(p);
  return `Live ${whereLive(p)}${state ? ` · ${state}` : ''}`;
}

/** One task, as in `reviewer: "Review PR 77"` or `background shell "npm test"`. */
export function taskLabel(t: RunningTask): string {
  const what = t.kind === 'shell' ? 'background shell' : t.name ?? 'subagent';
  return t.description ? `${what} "${t.description}"` : what;
}

/** "1 subagent and 2 background shells", or undefined when nothing runs. */
export function countTasks(tasks: RunningTask[]): string | undefined {
  const agents = tasks.filter((t) => t.kind === 'agent').length;
  const shells = tasks.length - agents;
  const parts = [
    agents ? `${agents} subagent${agents === 1 ? '' : 's'}` : '',
    shells ? `${shells} background shell${shells === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' and ') : undefined;
}

/**
 * Why acting on the session now is a bad idea, naming what runs: `"T" is live in a terminal (idle), with 1 subagent
 * still running: reviewer "Review PR 77".` followed by `doing` (what the action would do) and the fork warning.
 */
export function liveWarning(title: string, p: LiveProcess, tasks: RunningTask[], doing: string): string {
  const state = liveState(p);
  const count = countTasks(tasks);
  const shown = tasks.slice(0, 3).map(taskLabel);
  const more = tasks.length > shown.length ? `, and ${tasks.length - shown.length} more` : '';
  const running = count ? `, with ${count} still running: ${shown.join(', ')}${more}` : '';
  const idleNote = count && p.status !== 'busy' ? ' It is idle at its prompt, but the work it started is not done.' : '';
  return (
    `"${title}" is live ${whereLive(p)}${state ? ` (${state})` : ''}${running}.${idleNote} ` +
    `${doing} would put a second Claude Code process on this session, and the two fork its log. Let it finish there, or close it there first.`
  );
}

/** A time of day for the notice, with the full date and time on hover. */
function timeHtml(ms: number): string {
  const short = new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `<time title="${escapeHtml(formatDateTime(ms))}">${escapeHtml(short)}</time>`;
}

/**
 * The transcript's notice above the message box. With `elsewhere`, the session is live in another Claude Code
 * process: where, idle or working, and the subagents and shells it still runs. Without, `own` is the tab's own chat
 * process and only what it still runs is listed. Empty when neither has anything to say.
 */
export function renderLiveNotice(elsewhere: LiveProcess[], own: LiveProcess | undefined, tasks: RunningTask[]): string {
  const proc = elsewhere[0] ?? own;
  if (!proc) {
    return '';
  }
  const running = tasksOf(tasks, proc);
  if (!elsewhere.length && !running.length) {
    return '';
  }
  const items = running
    .map((t) => {
      const since = t.since === undefined ? '' : ` <span class="since">since ${timeHtml(t.since)}</span>`;
      const waiting = t.waiting ? ' <span class="since">· waiting on its own background work</span>' : '';
      return `<li><i class="codicon codicon-${t.kind === 'shell' ? 'terminal' : 'hubot'}"></i><span>${escapeHtml(taskLabel(t))}</span>${since}${waiting}</li>`;
    })
    .join('');
  const others = elsewhere.length - 1;
  const more = others > 0 ? ` <span class="since">(and ${others} more process${others > 1 ? 'es' : ''})</span>` : '';
  const head = elsewhere.length
    ? `<div class="live-head${proc.status === 'busy' ? ' busy' : ''}"><i class="codicon codicon-broadcast"></i><strong>${escapeHtml(liveLabel(proc))}</strong>${more}</div>` +
      `<p>Another Claude Code process has this session open${running.length ? ', and these are still running in it' : ''}. ` +
      'Resume, Open in chat, Chat here and Send ask before adding a second one, which would fork its log.</p>'
    : '<div class="live-head"><i class="codicon codicon-broadcast"></i><strong>Still running in this chat</strong></div>';
  return `${head}${items ? `<ul class="live-tasks">${items}</ul>` : ''}`;
}

// ---------- the service ----------

/** The live processes, kept up to date by `refresh`; the extension calls it on a timer and when the folder changes. */
export class LiveSessions {
  private procs: LiveProcess[] = [];
  private shown = '';
  private readonly checked = newStartCheckCache();
  private readonly listeners = new Set<() => void>();
  private running?: Promise<void>;
  private again = false;

  constructor(
    private readonly dir: () => string,
    private readonly probe: ProcessProbe = systemProbe,
  ) {}

  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** Re-reads the registry. Calls made while one runs share the next read, so the result is never older than the call. */
  refresh(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        const procs = await liveOnly(await readRegistry(this.dir()), this.probe, this.checked).catch(() => this.procs);
        const key = JSON.stringify(procs.map((p) => [p.pid, p.sessionId, p.status, p.kind, p.entrypoint, p.startedAt]).sort());
        this.procs = procs;
        if (key !== this.shown) {
          this.shown = key;
          for (const l of this.listeners) {
            try {
              l();
            } catch {
              // One listener's failure is not the others'.
            }
          }
        }
      } while (this.again);
    })().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** The live processes that have the session open, other than those with a pid in `own` (this extension's chats). */
  forSession(sessionId: string, own: readonly number[] = []): LiveProcess[] {
    return this.procs.filter((p) => p.sessionId === sessionId && !own.includes(p.pid));
  }

  /** The live process among `own` that has the session open (this extension's chat), if any. */
  ownFor(sessionId: string, own: readonly number[]): LiveProcess | undefined {
    return this.procs.find((p) => p.sessionId === sessionId && own.includes(p.pid));
  }
}
