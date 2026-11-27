// The in-view chat with a GitHub Copilot CLI session. Copilot CLI has no long-lived streaming input, so each message
// is one process: `copilot --resume=<id> --output-format json --stream on`, with the message on its stdin. Its stdout
// is the session's own event records (the shapes events.jsonl holds, plus ephemeral deltas), one JSON object a line,
// ending with a `result`. Each turn appends to the same session log, so consecutive messages continue one session.
// No VS Code imports here, so it can be unit-tested with plain Node.

import { toolHint } from './sessionParser';
import { ChatChild, ChatStatus, ExecutableSpec, LiveChat, LivePiece, SessionChat } from './claudeChat';

/**
 * What the chat's picker offers. Copilot CLI cannot ask for approval in this mode (a request with no rule is declined
 * at once, "denied-no-approval-rule-and-could-not-request-from-user"), so each mode grants tools up front:
 *   read   nothing granted: reading and searching in the session's folder still runs, edits and commands are declined
 *   edits  --allow-tool=write: file edits run as well; shell commands are still declined
 *   all    --allow-all-tools: everything runs without asking, shell commands included (paths stay limited to the folder)
 */
export const COPILOT_MODES = ['read', 'edits', 'all'] as const;
export type CopilotMode = (typeof COPILOT_MODES)[number];

export const isCopilotMode = (v: unknown): v is CopilotMode => typeof v === 'string' && (COPILOT_MODES as readonly string[]).includes(v);

/** The most restrictive mode that still lets Copilot read the session's files. */
export const DEFAULT_COPILOT_MODE: CopilotMode = 'read';

/** The tool allowances a mode passes to Copilot CLI. */
export function copilotModeArgs(mode: CopilotMode): string[] {
  return mode === 'all' ? ['--allow-all-tools'] : mode === 'edits' ? ['--allow-tool=write'] : [];
}

/**
 * The command line of one turn. The message itself goes on stdin, which Copilot CLI takes as the prompt when it is
 * piped: no quoting, no length limit, and nothing a shell shim could rewrite. The `=` forms keep each value in one
 * argument whatever it starts with.
 */
export function copilotChatArgs(sessionId: string, mode: CopilotMode): string[] {
  return [`--resume=${sessionId}`, '--output-format', 'json', '--stream', 'on', ...copilotModeArgs(mode)];
}

/**
 * Why a Copilot CLI session id cannot go on a command line, or undefined when it can. The id is the session's folder
 * name under session-state (a UUID when Copilot CLI made it), and it goes onto a shell's command line unquoted: cmd.exe
 * for a .cmd shim in Chat here, the terminal's shell for Resume. A folder named `x&calc` would run calc, so anything
 * beyond letters, digits, `_`, `-` and `.` is refused before a process starts.
 */
export function unsafeCopilotSessionId(sessionId: string): string | undefined {
  if (/^[\w.-]+$/.test(sessionId)) {
    return undefined;
  }
  return (
    `This GitHub Copilot CLI session's id, ${JSON.stringify(sessionId)}, has characters a shell could run as a command, ` +
    `so it is not put on a command line and Copilot CLI is not started. Only letters, digits, "_", "-" and "." are ` +
    `allowed. The id is the session's folder name under Copilot's session-state folder, which Copilot CLI names with a ` +
    `UUID, so something else made or renamed it.`
  );
}

export const COPILOT_EXECUTABLE: ExecutableSpec = {
  base: 'copilot',
  tool: 'GitHub Copilot CLI',
  setting: 'claudeSessions.copilotCommand',
  extraDirs: [],
  // npm installs Copilot CLI as a .cmd shim on Windows. The chat passes it only fixed flags and the session id, and
  // the message on stdin, so cmd.exe has nothing to rewrite; Stop kills the whole process tree.
  shims: 'shell',
};

/** What a declined tool call says in the chat, by mode: what to pick to let it run. */
function declinedText(tool: string, mode: CopilotMode): string {
  const next = mode === 'read' ? '"Allow edits" lets file edits run; "Allow all tools" lets commands run too' : '"Allow all tools" lets it run';
  return `Declined ${tool}: Copilot CLI cannot ask for approval here, and the chat's tool setting does not allow it. ${next}, from the next message.`;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function inputText(args: unknown): string {
  if (typeof args === 'string') {
    return args;
  }
  try {
    return JSON.stringify(args ?? {}, null, 2);
  } catch {
    return '';
  }
}

/** A tool call's one-line hint: the usual input fields, or the first line of a free-form input (apply_patch). */
function hintOf(args: unknown): string | undefined {
  if (typeof args === 'string') {
    const line = args.split(/\r?\n/).find((l) => l.trim() && !/^\*\*\* Begin/.test(l));
    return line?.trim().slice(0, 140) || undefined;
  }
  return toolHint(args);
}

/**
 * A Copilot CLI turn as it streams in. Pieces carry the `id` of the record that finishes them (user.message,
 * assistant.message, assistant.reasoning), which is the same id the session log gives that record, so a piece goes
 * once the log has it and the transcript above shows it.
 */
export class CopilotLive extends LiveChat {
  protected logKey = 'id';
  /** The mode of the running turn, for what a declined tool says. */
  mode: CopilotMode = DEFAULT_COPILOT_MODE;

  /** Applies one parsed stdout line; true when the pieces changed. Unknown types and shapes are skipped. */
  applyCopilot(line: unknown): boolean {
    const ev = obj(line);
    const d = obj(ev?.data);
    if (!ev || typeof ev.type !== 'string' || !d) {
      return false;
    }
    const id = str(ev.id);
    switch (ev.type) {
      case 'user.message': {
        const p = this.pieces.find((x) => x.kind === 'user' && !x.uuid);
        if (p && p.kind === 'user' && id) {
          p.uuid = id;
          p.queued = undefined;
          return true;
        }
        return false;
      }
      case 'assistant.message_start': {
        const messageId = str(d.messageId);
        if (!messageId || this.textPiece(messageId)) {
          return false;
        }
        this.pieces.push({ kind: 'text', id: this.nextId++, text: '', messageId, streaming: true });
        return false;
      }
      case 'assistant.message_delta': {
        const messageId = str(d.messageId);
        const delta = str(d.deltaContent);
        if (!messageId || !delta) {
          return false;
        }
        let p = this.textPiece(messageId);
        if (!p) {
          p = { kind: 'text', id: this.nextId++, text: '', messageId, streaming: true };
          this.pieces.push(p);
        }
        p.text += delta;
        return true;
      }
      case 'assistant.reasoning_delta': {
        const reasoningId = str(d.reasoningId);
        if (!reasoningId || this.pieces.some((x) => x.kind === 'thinking' && x.messageId === reasoningId)) {
          return false;
        }
        this.pieces.push({ kind: 'thinking', id: this.nextId++, text: '', messageId: reasoningId, streaming: true });
        return true;
      }
      case 'assistant.reasoning': {
        const p = this.pieces.find((x) => x.kind === 'thinking' && x.messageId === str(d.reasoningId));
        if (p && p.kind === 'thinking') {
          p.streaming = false;
          p.uuid = id;
          return true;
        }
        return false;
      }
      case 'assistant.tool_call_delta': {
        const callId = str(d.toolCallId);
        if (!callId) {
          return false;
        }
        const p = this.toolPiece(callId, str(d.toolName));
        if (p.streaming && typeof d.inputDelta === 'string') {
          p.input += d.inputDelta;
        }
        return true;
      }
      case 'assistant.message':
        return this.message(d, id);
      case 'tool.execution_start': {
        const callId = str(d.toolCallId);
        if (!callId) {
          return false;
        }
        const p = this.toolPiece(callId, str(d.toolName));
        if (!p.hint) {
          p.hint = hintOf(d.arguments);
        }
        return true;
      }
      case 'tool.execution_complete': {
        const p = this.pieces.find((x) => x.kind === 'tool' && x.toolUseId === str(d.toolCallId));
        if (!p || p.kind !== 'tool') {
          return false;
        }
        const error = obj(d.error);
        if (d.success === true && !error) {
          p.status = 'ok';
        } else if (error?.code === 'denied') {
          p.status = 'denied';
          this.noteDeclined(p.name);
        } else {
          p.status = 'failed';
        }
        p.streaming = false;
        return true;
      }
      case 'session.error': {
        const message = str(d.message)?.trim();
        if (!message) {
          return false;
        }
        // The log records it too (the transcript shows it once read), so it goes with the turn.
        this.pieces.push({ kind: 'notice', id: this.nextId++, text: message, tone: 'error', expire: true });
        return true;
      }
      default:
        return false;
    }
  }

  /**
   * One note for the calls declined since the last message, naming each tool once. It stays until the next message,
   * like an error: what to pick to let the call run is worth reading after the reply has landed in the transcript.
   */
  private noteDeclined(tool: string): void {
    const note = this.declined && this.pieces.includes(this.declined.piece) ? this.declined : undefined;
    if (note) {
      if (!note.tools.includes(tool)) {
        note.tools.push(tool);
      }
    } else {
      const piece = { kind: 'notice' as const, id: this.nextId++, text: '', tone: 'info' as const };
      this.pieces.push(piece);
      this.declined = { piece, tools: [tool] };
    }
    const d = this.declined!;
    const names = d.tools.length > 1 ? `${d.tools.slice(0, -1).join(', ')} and ${d.tools[d.tools.length - 1]}` : d.tools[0];
    d.piece.text = declinedText(names, this.mode);
  }

  /** A new turn starts: its declined calls get a note of their own. */
  markSent(): void {
    super.markSent();
    this.declined = undefined;
  }

  private declined?: { piece: Extract<LivePiece, { kind: 'notice' }>; tools: string[] };

  private textPiece(messageId: string) {
    const p = this.pieces.find((x) => x.kind === 'text' && x.messageId === messageId && !x.uuid);
    return p && p.kind === 'text' ? p : undefined;
  }

  private toolPiece(callId: string, name: string | undefined) {
    let p = this.pieces.find((x) => x.kind === 'tool' && x.toolUseId === callId);
    if (!p || p.kind !== 'tool') {
      p = { kind: 'tool', id: this.nextId++, name: name ?? 'tool', input: '', toolUseId: callId, status: 'running', streaming: true };
      this.pieces.push(p);
    }
    return p;
  }

  /** A finished assistant message: its text and the tool calls it makes, all under the record's id. */
  private message(d: Record<string, unknown>, id: string | undefined): boolean {
    const messageId = str(d.messageId);
    const content = str(d.content) ?? '';
    let changed = false;
    const text = messageId ? this.textPiece(messageId) : undefined;
    if (text) {
      text.text = content || text.text;
      text.streaming = false;
      text.uuid = id;
      changed = true;
    } else if (content.trim()) {
      this.pieces.push({ kind: 'text', id: this.nextId++, text: content, messageId, uuid: id, streaming: false });
      changed = true;
    }
    for (const raw of Array.isArray(d.toolRequests) ? d.toolRequests : []) {
      const req = obj(raw);
      const callId = str(req?.toolCallId);
      if (!req || !callId) {
        continue;
      }
      const p = this.toolPiece(callId, str(req.name));
      p.name = str(req.name) ?? p.name;
      p.input = inputText(req.arguments);
      p.hint = hintOf(req.arguments);
      p.streaming = false;
      p.uuid = id;
      p.messageId = messageId;
      changed = true;
    }
    return changed;
  }

  /** The turn's process has exited: nothing streams any more, and what never got an id goes at the next log read. */
  endTurn(): void {
    for (const p of this.pieces) {
      if ('streaming' in p) {
        p.streaming = false;
      }
      if (p.kind === 'tool' && p.status === 'running') {
        // Stopped, or the process died, before the call finished.
        p.status = 'failed';
      }
      if (p.kind !== 'notice' && p.kind !== 'permission' && !p.uuid && !(p.kind === 'user' && p.queued)) {
        p.expire = true;
      }
    }
  }
}

/** One turn's process; `shell` when the executable is a Windows script shim. */
export type CopilotSpawner = (exe: string, args: string[], cwd: string | undefined, shell: boolean) => ChatChild;

export interface CopilotChatOptions {
  sessionId: string;
  /** Where to start a turn's process: the executable, the session's folder, whether it is a shim; or why it cannot. */
  launch: () => { exe: string; cwd?: string; shell?: boolean } | { error: string };
  mode: CopilotMode;
  spawn: CopilotSpawner;
  onChange: () => void;
  /** Messages taken back unsent (Stop, a process that would not start), for the message box. */
  onUnsent: (texts: string[]) => void;
  log: (line: string) => void;
}

/** How long to wait for the exit after a kill before giving up on hearing it. */
const KILL_WAIT_MS = 2000;
/** Window close: how long a running turn may carry on before it is stopped. */
const TURN_GRACE_MS = 1500;

/**
 * One chat with a Copilot CLI session: a process per message, run one at a time; a message typed during a turn waits
 * (shown as queued) until that turn's process has exited. Stop kills the running turn's process. Ending the chat lets
 * a running turn finish, and starts no more.
 */
export class CopilotChat implements SessionChat {
  readonly live = new CopilotLive();
  private child?: ChatChild;
  private queue: string[] = [];
  private busy = false;
  private disposed = false;
  /** Stop killed the running turn: its exit is no error. */
  private stopping = false;
  private stdout = '';
  /** The last lines that were not JSON (Copilot CLI prints its errors as text) and of stderr, for a failed turn. */
  private tail: string[] = [];
  private lastTurn?: ChatStatus['lastTurn'];
  private inFlight?: string;
  /** The session took the running turn's message (its user.message record came back). */
  private taken = false;
  private started = 0;
  /** Resolves when the running turn's process has exited. */
  private exited?: Promise<void>;
  private onExited?: () => void;
  lastActivity = 0;
  mode: CopilotMode;

  constructor(private readonly opts: CopilotChatOptions) {
    this.mode = opts.mode;
  }

  get status(): ChatStatus {
    return {
      running: !!this.child,
      busy: this.busy,
      queued: this.queue.length,
      mode: this.mode,
      finishing: (this.disposed && this.busy && !!this.child) || undefined,
      lastTurn: this.lastTurn,
    };
  }

  get replying(): boolean {
    return this.busy && !!this.child;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** Only while a turn runs or waits: between turns no process has the session open. */
  get active(): boolean {
    return !!this.child || this.busy || this.queue.length > 0;
  }

  send(text: string): void {
    if (this.disposed || !text.trim()) {
      return;
    }
    this.live.addUser(text, this.busy || this.queue.length > 0);
    this.queue.push(text);
    this.opts.onChange();
    this.pump();
  }

  /** Copilot CLI asks nothing in this mode, so there is never a card to answer. */
  answer(): boolean {
    return false;
  }

  /** Stop: the running turn's process is killed; messages still waiting go back to the message box. */
  interrupt(): void {
    const dropped = this.queue.splice(0);
    if (dropped.length) {
      this.live.dropQueued();
      this.opts.onUnsent(dropped);
    }
    this.kill();
    this.opts.onChange();
  }

  /** Applies from the next message: each turn is a new process with its own allowances. */
  setMode(mode: string): void {
    if (isCopilotMode(mode) && mode !== this.mode) {
      this.mode = mode;
      this.opts.onChange();
    }
  }

  /** Ends the chat: no more turns start, waiting messages go back to the box, and a running turn finishes. */
  end(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true;
      const unsent = this.queue.splice(0);
      this.live.dropQueued();
      if (unsent.length) {
        this.opts.onUnsent(unsent);
      }
      this.opts.onChange();
    }
    return this.exited ?? Promise.resolve();
  }

  /** Ends the chat and kills a running turn. */
  stopNow(): Promise<void> {
    const done = this.end();
    this.kill();
    return done;
  }

  dispose(turnGraceMs = TURN_GRACE_MS): Promise<void> {
    const done = this.end();
    if (this.child) {
      if (turnGraceMs <= 0) {
        this.kill();
      } else {
        const timer = setTimeout(() => this.kill(), turnGraceMs);
        void done.then(() => clearTimeout(timer));
      }
    }
    return done;
  }

  private kill(): void {
    const child = this.child;
    if (!child || this.stopping) {
      return;
    }
    this.stopping = true;
    this.opts.log('Stopping the turn: killing its process.');
    try {
      child.kill();
    } catch {
      // Already gone.
    }
    // A kill whose exit is never reported must not hold up whoever waits for it (window close above all).
    setTimeout(() => {
      if (this.child === child) {
        this.opts.log('No exit reported after the kill; no longer waiting for it.');
        this.onExit(child, null, 'SIGTERM');
      }
    }, KILL_WAIT_MS);
  }

  private pump(): void {
    if (this.busy || !this.queue.length || this.disposed) {
      return;
    }
    const unsafe = unsafeCopilotSessionId(this.opts.sessionId);
    const where = unsafe ? { error: unsafe } : this.opts.launch();
    if ('error' in where) {
      this.failStart(where.error, false);
      return;
    }
    const text = this.queue.shift()!;
    this.busy = true;
    this.inFlight = text;
    this.taken = false;
    this.stdout = '';
    this.tail = [];
    this.started = Date.now();
    this.live.mode = this.mode;
    this.live.markSent();
    const args = copilotChatArgs(this.opts.sessionId, this.mode);
    this.opts.log(`Starting: ${where.exe} ${args.join(' ')}${where.cwd ? ` (in ${where.cwd})` : ''}${where.shell ? ' through cmd.exe' : ''}`);
    let child: ChatChild;
    try {
      child = this.opts.spawn(where.exe, args, where.cwd, !!where.shell);
    } catch (err) {
      this.failStart((err as Error).message);
      return;
    }
    this.child = child;
    this.exited = new Promise<void>((resolve) => (this.onExited = resolve));
    child.stdin?.on('error', (err) => this.opts.log(`stdin: ${err.message}`));
    child.stdout?.on('data', (chunk) => this.onStdout(String(chunk)));
    child.stderr?.on('data', (chunk) => {
      const s = String(chunk);
      this.opts.log(`stderr: ${s.trimEnd()}`);
      this.keepTail(s);
    });
    child.on('error', (err) => {
      // ENOENT and the like arrive here, after spawn() returned.
      if (this.child === child) {
        this.child = undefined;
        this.settle();
        this.failStart(err.message);
      }
    });
    child.on('exit', (code, signal) => this.onExit(child, code, signal));
    try {
      child.stdin?.write(text);
      child.stdin?.end();
    } catch (err) {
      this.opts.log(`stdin: ${(err as Error).message}`);
    }
    this.opts.onChange();
  }

  private keepTail(text: string): void {
    this.tail = [...this.tail, ...text.split(/\r?\n/).filter((l) => l.trim())].slice(-5);
  }

  /** The process could not start: nothing was sent, so every message goes back to the message box. */
  private failStart(message: string, prefix = true): void {
    const text = prefix ? `Could not start GitHub Copilot CLI: ${message}` : message;
    this.opts.log(text);
    const unsent = [...(this.inFlight !== undefined && !this.taken ? [this.inFlight] : []), ...this.queue];
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

  private onStdout(chunk: string): void {
    this.lastActivity = Date.now();
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
        // Copilot CLI prints its errors as plain text; one such line must not stop the chat.
        this.opts.log(`stdout: ${line.slice(0, 300)}`);
        this.keepTail(line);
        continue;
      }
      if (obj(ev)?.type === 'user.message') {
        this.taken = true;
      }
      changed = this.live.applyCopilot(ev) || changed;
    }
    if (changed) {
      this.opts.onChange();
    }
  }

  private settle(): void {
    this.onExited?.();
    this.onExited = undefined;
    this.exited = undefined;
  }

  private onExit(child: ChatChild, code: number | null, signal: string | null): void {
    if (this.child !== child) {
      return;
    }
    if (this.stdout.trim()) {
      this.onStdout('\n');
    }
    this.opts.log(`Exited: code ${code}${signal ? `, signal ${signal}` : ''}`);
    this.lastActivity = Date.now();
    this.child = undefined;
    const stopped = this.stopping;
    this.stopping = false;
    const failed = !stopped && code !== 0;
    if (failed) {
      const tail = this.tail.length ? ` ${this.tail.join(' ')}` : '';
      this.live.notice(`GitHub Copilot CLI ${code === null ? `stopped (${signal})` : `exited with code ${code}`}.${tail}`, 'error');
      // A process that failed before the session took the message (no such session, not signed in) did nothing with
      // it, and would do the same with the next: they all go back to the box.
      if (!this.taken) {
        const unsent = [...(this.inFlight !== undefined ? [this.inFlight] : []), ...this.queue.splice(0)];
        this.live.dropUnsent();
        if (unsent.length) {
          this.opts.onUnsent(unsent);
        }
      }
    }
    this.live.endTurn();
    this.lastTurn = { durationMs: Date.now() - this.started, error: failed || undefined, interrupted: stopped || undefined };
    this.busy = false;
    this.inFlight = undefined;
    this.settle();
    this.opts.onChange();
    this.pump();
  }
}
