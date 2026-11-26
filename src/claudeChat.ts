// The in-view chat with a Claude Code session: one long-lived `claude -p --resume <id>` process in stream-json mode,
// owned by the transcript tab. See docs/dev/claude-stream-json.md for the protocol this follows.
// No VS Code imports here, so it can be unit-tested with plain Node.

import * as path from 'path';
import { toolHint } from './sessionParser';

/** The permission modes the chat offers, passed explicitly as --permission-mode (doc section 7). */
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const isPermissionMode = (v: unknown): v is PermissionMode => typeof v === 'string' && (PERMISSION_MODES as readonly string[]).includes(v);

/**
 * What the extension answers every `can_use_tool` request with until permission cards exist. Deliberately neutral:
 * `--permission-prompts none` tells the model approvals are gone for the rest of the session, and it stops retrying
 * in later turns (doc section 5).
 */
export const DENY_MESSAGE = 'Not approved this time. The user can approve it in a later turn.';

/** The command line of the chat process (doc section 9). */
export function chatArgs(sessionId: string, mode: PermissionMode): string[] {
  return [
    '-p',
    '--resume',
    sessionId,
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    // Echoes each user line back with the uuid it got in the log, so the pending bubble can give way to the logged one.
    '--replay-user-messages',
    '--permission-prompt-tool',
    'stdio',
    '--permission-mode',
    mode,
  ];
}

/** One user turn, as a stdin line. */
export function userLine(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' }) + '\n';
}

/** Stops the running turn; the process stays up for the next one (doc section 4). */
export function interruptLine(requestId: string): string {
  return JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } }) + '\n';
}

/** The automatic answer to a `can_use_tool` request. */
export function denyLine(requestId: string): string {
  return (
    JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { behavior: 'deny', message: DENY_MESSAGE } } }) +
    '\n'
  );
}

/** The answer to a control request this chat does not handle, so the CLI is never left waiting on it. */
export function unsupportedLine(requestId: string, subtype: string): string {
  return JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: `Unsupported request: ${subtype}` } }) + '\n';
}

/**
 * This turn's cost: the sum over models of `model_usage_since_last_result`. `total_cost_usd` is a running total for the
 * whole session (doc section 2), so it is never used. Undefined when the result carries no per-turn usage.
 */
export function turnCost(result: unknown): number | undefined {
  const usage = obj(result)?.model_usage_since_last_result;
  if (!obj(usage)) {
    return undefined;
  }
  let sum = 0;
  let any = false;
  for (const m of Object.values(usage as Record<string, unknown>)) {
    const c = obj(m)?.costUSD;
    if (typeof c === 'number' && Number.isFinite(c)) {
      sum += c;
      any = true;
    }
  }
  return any ? sum : undefined;
}

/** What a failed turn's `result` says went wrong: its `errors`, else its `result` text. */
export function resultError(result: Record<string, unknown>): string {
  const errors = Array.isArray(result.errors) ? result.errors.filter((e): e is string => typeof e === 'string' && !!e.trim()) : [];
  if (errors.length) {
    return errors.join('\n');
  }
  if (typeof result.result === 'string' && result.result.trim()) {
    return result.result.trim();
  }
  return typeof result.subtype === 'string' ? `The turn failed (${result.subtype}).` : 'The turn failed.';
}

// ---------- finding claude.exe ----------

export interface ResolveEnv {
  platform: NodeJS.Platform;
  /** The PATH variable. */
  pathEnv: string;
  home: string;
  isFile: (p: string) => boolean;
}

/**
 * The Claude Code executable for the chat, which is spawned without a shell (doc section 8): the claudeCommand setting
 * when it is a path to an executable, else `claude` (`claude.exe` on Windows) on the PATH or in ~/.local/bin, where the
 * native installer puts it. An npm `.cmd` shim is refused rather than run through cmd.exe, which rewrites arguments
 * and, when killed, leaves Claude running.
 */
export function resolveClaudeExecutable(command: string, env: ResolveEnv): { exe: string } | { error: string } {
  const win = env.platform === 'win32';
  const sep = win ? ';' : ':';
  const cmd = command.trim() || 'claude';
  const shim = /\.(cmd|bat|ps1)$/i;
  const shimError = (p: string) => ({
    error: `Chat here runs Claude Code without a shell, and ${p} is a script shim. Set claudeSessions.claudeCommand to the path of claude${win ? '.exe' : ''} (the native installer puts it in ~/.local/bin).`,
  });
  if (env.isFile(cmd)) {
    return win && shim.test(cmd) ? shimError(cmd) : { exe: cmd };
  }
  if (/\s/.test(cmd) || /[\\/]/.test(cmd)) {
    return {
      error: `Chat here needs the Claude Code executable itself, but claudeSessions.claudeCommand is "${cmd}". Set it to the path of claude${win ? '.exe' : ''}, or to "claude".`,
    };
  }
  const names = win ? (/\.exe$/i.test(cmd) ? [cmd] : [`${cmd}.exe`]) : [cmd];
  const dirs = env.pathEnv.split(sep).map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  dirs.push(path.join(env.home, '.local', 'bin'));
  let shimFound: string | undefined;
  for (const dir of dirs) {
    for (const name of names) {
      const p = path.join(dir, name);
      if (env.isFile(p)) {
        return { exe: p };
      }
    }
    if (win && !shimFound) {
      shimFound = ['.cmd', '.bat'].map((ext) => path.join(dir, cmd + ext)).find((p) => env.isFile(p));
    }
  }
  if (shimFound) {
    return shimError(shimFound);
  }
  return {
    error: `Claude Code was not found: no ${names[0]} on the PATH or in ~/.local/bin. Install Claude Code, or set claudeSessions.claudeCommand to its path.`,
  };
}

// ---------- what the chat shows while the log catches up ----------

export type LivePiece =
  | { kind: 'user'; id: number; text: string; uuid?: string; queued?: boolean; expire?: boolean }
  | { kind: 'text' | 'thinking'; id: number; text: string; messageId?: string; index?: number; uuid?: string; streaming: boolean; expire?: boolean }
  | {
      kind: 'tool';
      id: number;
      name: string;
      /** The input as JSON: partial while it streams in. */
      input: string;
      hint?: string;
      toolUseId?: string;
      messageId?: string;
      index?: number;
      uuid?: string;
      status: 'running' | 'ok' | 'failed' | 'denied';
      streaming: boolean;
      expire?: boolean;
    }
  /** Something the log does not record in this form: a declined request, a failed turn, a crash. */
  | { kind: 'notice'; id: number; text: string; tone: 'error' | 'info'; expire?: boolean };

/** What a turn's `result` said. */
export interface TurnEnd {
  isError: boolean;
  error?: string;
  /** This turn's cost in USD, from model_usage_since_last_result. */
  cost?: number;
  durationMs?: number;
  interrupted: boolean;
}

/** What applying one stdout event asks of the process: a line to write back, a turn that ended, the session's mode. */
export interface ApplyResult {
  reply?: string;
  turnEnd?: TurnEnd;
  init?: { permissionMode?: string; model?: string };
  /** The live pieces changed. */
  changed: boolean;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function inputJson(input: unknown): string {
  try {
    return JSON.stringify(input ?? {}, null, 2);
  } catch {
    return '';
  }
}

/** The text of a tool result's content: a string, or text blocks. */
function resultText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  return Array.isArray(content) ? content.map((c) => str(obj(c)?.text) ?? '').join('\n') : '';
}

/**
 * The turn as it streams in: the user's messages straight away, the reply as it arrives, and what the log will not
 * show (a declined request, an error). A piece the log has recorded (by uuid) is dropped, since the transcript above
 * now shows it; pieces that never get a uuid are dropped at the first log read after their turn ends.
 */
export class LiveChat {
  pieces: LivePiece[] = [];
  private nextId = 1;
  /** The API message being streamed, for stream events that do not name it. */
  private streamingMessage?: string;
  /** Stop was pressed during the running turn, so its error result is the interrupt. */
  interrupting = false;

  addUser(text: string, queued: boolean): void {
    // A new turn clears errors and notes from earlier ones; one queued behind a running turn leaves that turn's alone.
    if (!queued) {
      this.pieces = this.pieces.filter((p) => p.kind !== 'notice');
    }
    this.pieces.push({ kind: 'user', id: this.nextId++, text, queued: queued || undefined });
  }

  /** The oldest queued message is now on its way to Claude. */
  markSent(): void {
    const p = this.pieces.find((x) => x.kind === 'user' && x.queued);
    if (p && p.kind === 'user') {
      p.queued = undefined;
    }
  }

  /** Messages still waiting are taken back (Stop): their bubbles go. */
  dropQueued(): void {
    this.pieces = this.pieces.filter((p) => !(p.kind === 'user' && p.queued));
  }

  /** Nothing reached Claude (the process would not start): every message not yet in the log goes. */
  dropUnsent(): void {
    this.pieces = this.pieces.filter((p) => !(p.kind === 'user' && !p.uuid));
  }

  notice(text: string, tone: 'error' | 'info'): void {
    // Shown until the next message is sent, not dropped at the next log read.
    this.pieces.push({ kind: 'notice', id: this.nextId++, text, tone });
  }

  /** Applies one parsed stdout line. Unknown types and shapes are skipped. */
  apply(line: unknown): ApplyResult {
    const ev = obj(line);
    const none: ApplyResult = { changed: false };
    if (!ev) {
      return none;
    }
    // A permission request is answered whoever asks, a subagent included, or the turn hangs (doc section 6).
    if (ev.type === 'control_request') {
      return this.controlRequest(ev);
    }
    // A subagent's own stream: its records go to its own log, not this session's.
    if (ev.parent_tool_use_id) {
      return none;
    }
    switch (ev.type) {
      case 'stream_event':
        return { changed: this.streamEvent(obj(ev.event), str(ev.api_message_id)) };
      case 'assistant':
        return { changed: this.assistant(ev) };
      case 'user':
        return { changed: this.user(ev) };
      case 'result':
        return this.result(ev);
      case 'system': {
        if (ev.subtype === 'init') {
          return { changed: false, init: { permissionMode: str(ev.permissionMode), model: str(ev.model) } };
        }
        if (ev.subtype === 'permission_denied') {
          return { changed: this.denied(str(ev.tool_use_id), str(ev.tool_name), str(ev.decision_reason) ?? str(ev.message)) };
        }
        return none;
      }
      default:
        return none;
    }
  }

  private streamEvent(e: Record<string, unknown> | undefined, apiMessageId: string | undefined): boolean {
    if (!e) {
      return false;
    }
    if (e.type === 'message_start') {
      this.streamingMessage = str(obj(e.message)?.id) ?? apiMessageId;
      return false;
    }
    const messageId = apiMessageId ?? this.streamingMessage;
    const index = typeof e.index === 'number' ? e.index : undefined;
    if (e.type === 'content_block_start') {
      const block = obj(e.content_block);
      const id = this.nextId++;
      if (block?.type === 'text') {
        this.pieces.push({ kind: 'text', id, text: str(block.text) ?? '', messageId, index, streaming: true });
      } else if (block?.type === 'thinking') {
        this.pieces.push({ kind: 'thinking', id, text: '', messageId, index, streaming: true });
      } else if (block?.type === 'tool_use') {
        this.pieces.push({
          kind: 'tool',
          id,
          name: str(block.name) ?? 'Tool',
          input: '',
          toolUseId: str(block.id),
          messageId,
          index,
          status: 'running',
          streaming: true,
        });
      } else {
        return false;
      }
      return true;
    }
    if (e.type === 'content_block_delta') {
      const delta = obj(e.delta);
      const piece = this.pieces.find((p) => 'streaming' in p && p.streaming && p.messageId === messageId && p.index === index);
      if (!piece || !delta) {
        return false;
      }
      if (delta.type === 'text_delta' && piece.kind === 'text' && typeof delta.text === 'string') {
        piece.text += delta.text;
        return true;
      }
      if (delta.type === 'input_json_delta' && piece.kind === 'tool' && typeof delta.partial_json === 'string') {
        piece.input += delta.partial_json;
        return true;
      }
      return false;
    }
    return false;
  }

  /** A finished content block (one per event, grouped by message id): it replaces its streamed piece. */
  private assistant(ev: Record<string, unknown>): boolean {
    const message = obj(ev.message);
    const uuid = str(ev.uuid);
    const messageId = str(message?.id);
    const blocks = Array.isArray(message?.content) ? message.content : [];
    let changed = false;
    for (const raw of blocks) {
      const b = obj(raw);
      const kind = b?.type === 'text' ? 'text' : b?.type === 'thinking' ? 'thinking' : b?.type === 'tool_use' ? 'tool' : undefined;
      if (!b || !kind) {
        continue;
      }
      // The streamed piece this block finishes: the first one of the same kind from the same message without a uuid.
      let piece = this.pieces.find((p) => p.kind === kind && 'streaming' in p && !p.uuid && (p.messageId === messageId || p.messageId === undefined));
      if (!piece) {
        const id = this.nextId++;
        piece =
          kind === 'tool'
            ? { kind, id, name: str(b.name) ?? 'Tool', input: '', toolUseId: str(b.id), messageId, status: 'running', streaming: false }
            : { kind, id, text: '', messageId, streaming: false };
        this.pieces.push(piece);
      }
      if (piece.kind === 'tool') {
        piece.name = str(b.name) ?? piece.name;
        piece.toolUseId = str(b.id) ?? piece.toolUseId;
        piece.input = inputJson(b.input);
        piece.hint = toolHint(b.input);
      } else if (piece.kind === 'text') {
        piece.text = str(b.text) ?? piece.text;
      }
      if (piece.kind !== 'user' && piece.kind !== 'notice') {
        piece.streaming = false;
        piece.uuid = uuid;
        piece.messageId = messageId ?? piece.messageId;
      }
      changed = true;
    }
    return changed;
  }

  /** A replayed user message (its log uuid), or tool results for the calls shown. */
  private user(ev: Record<string, unknown>): boolean {
    const uuid = str(ev.uuid);
    if (ev.isReplay === true) {
      const p = this.pieces.find((x) => x.kind === 'user' && !x.uuid);
      if (p && p.kind === 'user' && uuid) {
        p.uuid = uuid;
        p.queued = undefined;
        return true;
      }
      return false;
    }
    const content = obj(ev.message)?.content;
    let changed = false;
    for (const raw of Array.isArray(content) ? content : []) {
      const b = obj(raw);
      if (b?.type !== 'tool_result') {
        continue;
      }
      const tool = this.pieces.find((p) => p.kind === 'tool' && p.toolUseId === str(b.tool_use_id));
      if (tool && tool.kind === 'tool' && tool.status !== 'denied') {
        tool.status = b.is_error === true ? (resultText(b.content) === DENY_MESSAGE ? 'denied' : 'failed') : 'ok';
        changed = true;
      }
    }
    return changed;
  }

  private controlRequest(ev: Record<string, unknown>): ApplyResult {
    const requestId = str(ev.request_id);
    const request = obj(ev.request);
    if (!requestId || !request) {
      return { changed: false };
    }
    if (request.subtype !== 'can_use_tool') {
      return { changed: false, reply: unsupportedLine(requestId, str(request.subtype) ?? 'unknown') };
    }
    // Every request is answered, or the turn hangs (doc section 6). Permission cards (SA-26) replace this.
    const name = str(request.tool_name) ?? 'a tool';
    const changed = this.denied(str(request.tool_use_id), name, undefined);
    return { changed, reply: denyLine(requestId) };
  }

  /** Marks a tool call declined, and says so; the log records it only as a failed tool result. */
  private denied(toolUseId: string | undefined, name: string | undefined, reason: string | undefined): boolean {
    const tool = toolUseId ? this.pieces.find((p) => p.kind === 'tool' && p.toolUseId === toolUseId) : undefined;
    if (tool && tool.kind === 'tool') {
      tool.status = 'denied';
    }
    const text =
      name === 'ExitPlanMode'
        ? 'Declined the plan: approving a plan from this chat is not available yet. Change the permission mode to let Claude carry on.'
        : `Declined ${name ?? 'a tool'}: it needs approval, and approving from this chat is not available yet. Change the permission mode to allow it.${reason ? ` (${reason})` : ''}`;
    this.pieces.push({ kind: 'notice', id: this.nextId++, text, tone: 'info', expire: true });
    return true;
  }

  private result(ev: Record<string, unknown>): ApplyResult {
    const isError = ev.is_error === true;
    // An interrupted turn ends with an error result (`error_during_execution`, `terminal_reason: "aborted_streaming"`,
    // and an `errors` entry that is a diagnostic, not a message for the user). Stop asked for it, so it is no error.
    const interrupted =
      isError &&
      (this.interrupting || /^aborted/.test(str(ev.terminal_reason) ?? '') || (ev.subtype === 'error_during_execution' && ev.stop_reason == null && !(Array.isArray(ev.errors) && ev.errors.length)));
    this.interrupting = false;
    const end: TurnEnd = {
      isError: isError && !interrupted,
      error: isError && !interrupted ? resultError(ev) : undefined,
      cost: turnCost(ev),
      durationMs: typeof ev.duration_ms === 'number' ? ev.duration_ms : undefined,
      interrupted,
    };
    for (const p of this.pieces) {
      if ('streaming' in p) {
        p.streaming = false;
      }
      // What never got a uuid goes at the next log read: the log has the turn by then.
      if (p.kind !== 'notice' && !p.uuid) {
        p.expire = true;
      }
    }
    // A user message still waiting stays: it is the next turn.
    for (const p of this.pieces) {
      if (p.kind === 'user' && p.queued) {
        p.expire = undefined;
      }
    }
    if (end.isError && end.error) {
      this.notice(end.error, 'error');
    }
    return { changed: true, turnEnd: end };
  }

  /**
   * The log was read: drops what it now records (by uuid) and what was waiting for it. `logText` is the raw log.
   * True when anything was dropped.
   */
  forget(logText: string): boolean {
    const before = this.pieces.length;
    this.pieces = this.pieces.filter((p) => {
      if (p.kind === 'notice') {
        // Declined-tool notes go with their turn; errors stay until the next message.
        return !p.expire;
      }
      if (p.uuid) {
        return !logText.includes(`"uuid":"${p.uuid}"`);
      }
      return !p.expire;
    });
    return this.pieces.length !== before;
  }

  /** A turn's notes to drop at the next log read (an interrupted or crashed turn). */
  expireAll(): void {
    for (const p of this.pieces) {
      if (p.kind !== 'notice' && !(p.kind === 'user' && p.queued)) {
        p.expire = true;
      }
    }
  }
}

// ---------- the process ----------

/** The parts of a child process the chat uses; a fake in tests. */
export interface ChatChild {
  stdin: { write(s: string): unknown; end(): unknown; on(event: 'error', f: (err: Error) => void): unknown } | null;
  stdout: { on(event: 'data', f: (chunk: Buffer | string) => void): unknown } | null;
  stderr: { on(event: 'data', f: (chunk: Buffer | string) => void): unknown } | null;
  on(event: 'exit', f: (code: number | null, signal: string | null) => void): unknown;
  on(event: 'error', f: (err: Error) => void): unknown;
  kill(): unknown;
  pid?: number;
}

export type Spawner = (exe: string, args: string[], cwd: string | undefined) => ChatChild;

export interface ChatOptions {
  sessionId: string;
  /** Where to start the process: the executable and the session's folder, or why it cannot start. Asked at each start. */
  launch: () => { exe: string; cwd?: string } | { error: string };
  mode: PermissionMode;
  spawn: Spawner;
  /** The live pieces or the status changed. */
  onChange: () => void;
  /** Messages that were taken back unsent (Stop, or a process that would not start), for the message box. */
  onUnsent: (texts: string[]) => void;
  /** Diagnostics: stderr, spawns and exits. */
  log: (line: string) => void;
}

export interface ChatStatus {
  /** A process is up. */
  running: boolean;
  /** A turn is in flight. */
  busy: boolean;
  /** Messages waiting for the running turn to end. */
  queued: number;
  mode: PermissionMode;
  /** The last finished turn. */
  lastTurn?: { cost?: number; durationMs?: number; error?: boolean; interrupted?: boolean };
}

/** How long a closing process gets to exit after its stdin closes before it is killed. */
const CLOSE_GRACE_MS = 3000;
/** How long to wait for the exit after a kill before giving up on hearing it. */
const KILL_WAIT_MS = 1000;

/**
 * One chat: a `claude` process kept between turns, the messages waiting for it, and what the tab shows meanwhile.
 * Messages go one turn at a time; one typed during a turn waits here (shown as queued) until the turn's `result`, so a
 * mode change can restart the process between turns. Stop sends the interrupt control request and never kills; the
 * process is killed only when it will not exit after its stdin closes.
 */
export class ClaudeChat {
  readonly live = new LiveChat();
  private child?: ChatChild;
  private queue: string[] = [];
  private busy = false;
  private restartAfterTurn = false;
  private closing?: Promise<void>;
  private disposed = false;
  private stdout = '';
  private stderrTail: string[] = [];
  private lastTurn?: ChatStatus['lastTurn'];
  private requestSeq = 0;
  /** The message of the running turn, and whether the process has said anything since it was sent. */
  private inFlight?: string;
  private heard = false;
  /** When this chat last heard from its process; its own writes to the log are not another writer's. */
  lastActivity = 0;
  mode: PermissionMode;

  constructor(private readonly opts: ChatOptions) {
    this.mode = opts.mode;
  }

  get status(): ChatStatus {
    return { running: !!this.child && !this.closing, busy: this.busy, queued: this.queue.length, mode: this.mode, lastTurn: this.lastTurn };
  }

  /** A process is up or a turn is pending: the session has a writer. */
  get active(): boolean {
    return !!this.child || this.busy || this.queue.length > 0;
  }

  send(text: string): void {
    if (this.disposed || !text.trim()) {
      return;
    }
    this.live.addUser(text, this.busy || this.queue.length > 0 || !!this.closing);
    this.queue.push(text);
    this.opts.onChange();
    void this.pump();
  }

  /** Stops the running turn with the interrupt control request; messages still waiting go back to the message box. */
  interrupt(): void {
    const dropped = this.queue.splice(0);
    if (dropped.length) {
      this.live.dropQueued();
      this.opts.onUnsent(dropped);
    }
    if (this.busy && this.child) {
      this.live.interrupting = true;
      this.write(interruptLine(`interrupt-${++this.requestSeq}`));
    }
    this.opts.onChange();
  }

  /** A new permission mode takes a new process: now when idle, after the running turn otherwise. */
  setMode(mode: PermissionMode): void {
    if (mode === this.mode) {
      return;
    }
    this.mode = mode;
    if (this.child && !this.closing) {
      if (this.busy) {
        this.restartAfterTurn = true;
      } else {
        void this.close();
      }
    }
    this.opts.onChange();
  }

  /** Ends the process: stdin closed (any running turn interrupted first), then killed if it does not exit. */
  dispose(graceMs = CLOSE_GRACE_MS): Promise<void> {
    this.disposed = true;
    this.queue = [];
    this.live.dropQueued();
    return this.close(graceMs);
  }

  private async pump(): Promise<void> {
    if (this.busy || !this.queue.length || this.disposed) {
      return;
    }
    if (this.closing) {
      // A restart: the old process exits before the new one opens the same log.
      await this.closing;
      return this.pump();
    }
    if (!this.child && !this.start()) {
      return;
    }
    const text = this.queue.shift()!;
    this.busy = true;
    this.inFlight = text;
    this.heard = false;
    this.live.markSent();
    this.write(userLine(text));
    this.opts.onChange();
  }

  private start(): boolean {
    const where = this.opts.launch();
    if ('error' in where) {
      this.failStart(where.error, false);
      return false;
    }
    const args = chatArgs(this.opts.sessionId, this.mode);
    this.opts.log(`Starting: ${where.exe} ${args.join(' ')}${where.cwd ? ` (in ${where.cwd})` : ''}`);
    let child: ChatChild;
    try {
      child = this.opts.spawn(where.exe, args, where.cwd);
    } catch (err) {
      // Node throws EINVAL synchronously for a .cmd shim without a shell (doc section 8).
      this.failStart((err as Error).message);
      return false;
    }
    this.child = child;
    this.stdout = '';
    this.stderrTail = [];
    child.stdin?.on('error', (err) => this.opts.log(`stdin: ${err.message}`));
    child.stdout?.on('data', (chunk) => this.onStdout(String(chunk)));
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk);
      this.opts.log(`stderr: ${text.trimEnd()}`);
      this.stderrTail = [...this.stderrTail, ...text.split(/\r?\n/).filter((l) => l.trim())].slice(-5);
    });
    child.on('error', (err) => {
      // ENOENT and the like arrive here, after spawn() returned.
      if (this.child === child) {
        this.child = undefined;
        this.failStart(err.message);
      }
    });
    child.on('exit', (code, signal) => this.onExit(child, code, signal));
    return true;
  }

  /** The process could not start: nothing was sent, so every message goes back to the message box. */
  private failStart(message: string, prefix = true): void {
    const text = prefix ? `Could not start Claude Code: ${message}` : message;
    this.opts.log(text);
    const unsent = [...(this.inFlight !== undefined && !this.heard ? [this.inFlight] : []), ...this.queue];
    this.busy = false;
    this.inFlight = undefined;
    this.queue = [];
    this.live.dropUnsent();
    this.live.notice(text, 'error');
    if (unsent.length) {
      this.opts.onUnsent(unsent);
    }
    this.opts.onChange();
  }

  private onExit(child: ChatChild, code: number | null, signal: string | null): void {
    this.opts.log(`Exited: code ${code}${signal ? `, signal ${signal}` : ''}`);
    // A process may write to the log as it exits; that is still this chat's own write.
    this.lastActivity = Date.now();
    if (this.child !== child) {
      return;
    }
    this.child = undefined;
    const expected = !!this.closing || this.disposed;
    if (!expected) {
      const tail = this.stderrTail.length ? ` ${this.stderrTail.join(' ')}` : '';
      // A process that died without a word never took the message it was given, so that one comes back too.
      const unsent = [...(this.inFlight !== undefined && !this.heard ? [this.inFlight] : []), ...this.queue.splice(0)];
      if (!this.heard) {
        this.live.dropUnsent();
      }
      this.live.notice(
        this.busy
          ? `Claude Code stopped in the middle of the turn (exit code ${code ?? signal}).${tail} The next message starts it again.`
          : `Claude Code exited (exit code ${code ?? signal}).${tail} The next message starts it again.`,
        code === 0 && !this.busy ? 'info' : 'error',
      );
      this.live.dropQueued();
      this.live.expireAll();
      this.busy = false;
      this.inFlight = undefined;
      if (unsent.length) {
        this.opts.onUnsent(unsent);
      }
    }
    this.opts.onChange();
  }

  private onStdout(chunk: string): void {
    this.lastActivity = Date.now();
    this.heard = true;
    this.stdout += chunk;
    let nl: number;
    let changed = false;
    while ((nl = this.stdout.indexOf('\n')) >= 0) {
      const line = this.stdout.slice(0, nl).trim();
      this.stdout = this.stdout.slice(nl + 1);
      if (!line) {
        continue;
      }
      let ev: unknown;
      try {
        ev = JSON.parse(line);
      } catch {
        // Not a JSON line (a stray diagnostic): one bad line must not stop the chat.
        this.opts.log(`stdout (not JSON): ${line.slice(0, 200)}`);
        continue;
      }
      const r = this.live.apply(ev);
      changed ||= r.changed;
      if (r.reply) {
        this.write(r.reply);
      }
      if (r.turnEnd) {
        changed = true;
        this.turnEnded(r.turnEnd);
      }
    }
    if (changed) {
      this.opts.onChange();
    }
  }

  private turnEnded(end: TurnEnd): void {
    this.busy = false;
    this.inFlight = undefined;
    this.lastTurn = { cost: end.cost, durationMs: end.durationMs, error: end.isError || undefined, interrupted: end.interrupted || undefined };
    if (this.restartAfterTurn) {
      this.restartAfterTurn = false;
      void this.close();
    }
    void this.pump();
  }

  private write(line: string): void {
    try {
      this.child?.stdin?.write(line);
    } catch (err) {
      this.opts.log(`stdin: ${(err as Error).message}`);
    }
  }

  private close(graceMs = CLOSE_GRACE_MS): Promise<void> {
    const child = this.child;
    if (!child) {
      return Promise.resolve();
    }
    if (this.closing) {
      return this.closing;
    }
    if (this.busy) {
      // Closing stdin alone lets the running turn finish (doc section 4), so it is interrupted first.
      this.live.interrupting = true;
      this.write(interruptLine(`interrupt-${++this.requestSeq}`));
    }
    this.closing = new Promise<void>((resolve) => {
      let fallback: ReturnType<typeof setTimeout> | undefined;
      const timer = setTimeout(() => {
        this.opts.log('Did not exit after stdin closed; killing it.');
        try {
          child.kill();
        } catch {
          // Already gone.
        }
        // A kill whose exit is never reported must not hold up whoever waits for this (window close above all).
        fallback = setTimeout(() => {
          this.opts.log('No exit reported after the kill; no longer waiting for it.');
          resolve();
        }, KILL_WAIT_MS);
      }, graceMs);
      child.on('exit', () => {
        clearTimeout(timer);
        clearTimeout(fallback);
        resolve();
      });
      try {
        child.stdin?.end();
      } catch {
        // Already closed.
      }
    }).then(() => {
      this.closing = undefined;
      this.busy = false;
      this.opts.onChange();
    });
    this.opts.onChange();
    return this.closing;
  }
}
