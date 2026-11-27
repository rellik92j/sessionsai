// The in-view chat with a Claude Code session: one long-lived `claude -p --resume <id>` process in stream-json mode,
// owned by the transcript tab. See docs/dev/claude-stream-json.md for the protocol this follows.
// No VS Code imports here, so it can be unit-tested with plain Node.

import * as path from 'path';
import { toolHint } from './sessionParser';

/**
 * The permission modes the chat's picker offers. `ask` and `deny` both run Claude Code in its `default` mode and differ
 * only in how the chat answers a permission request: `ask` shows a card to allow or deny it, `deny` declines it at once
 * with a neutral message. The others are passed through as --permission-mode (doc section 7), and whatever they still
 * leave to ask shows a card too.
 */
export const PERMISSION_MODES = ['ask', 'acceptEdits', 'plan', 'auto', 'deny'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const isPermissionMode = (v: unknown): v is PermissionMode => typeof v === 'string' && (PERMISSION_MODES as readonly string[]).includes(v);

/** The --permission-mode Claude Code runs in for a mode of the picker. */
export const cliPermissionMode = (mode: PermissionMode): string => (mode === 'ask' || mode === 'deny' ? 'default' : mode);

/**
 * What the chat answers every `can_use_tool` request with in the decline-prompts mode. Deliberately neutral:
 * `--permission-prompts none` tells the model approvals are gone for the rest of the session, and it stops retrying
 * in later turns (doc section 5).
 */
export const DENY_MESSAGE = 'Not approved this time. The user can approve it in a later turn.';
/** Deny on a permission card: the tool result Claude sees, which it then carries on from. */
export const USER_DENY_MESSAGE = 'The user declined this tool call. Carry on without it, or ask the user if you need it.';
/** Deny on a plan card (ExitPlanMode). */
export const PLAN_DENY_MESSAGE = 'The user did not approve the plan yet. Stay in plan mode and wait for their feedback.';
/** A card still open when the user pressed Stop. */
export const STOP_DENY_MESSAGE = 'Not approved: the user stopped the turn before answering. They can approve it in a later turn.';
/** A card still open (or a request arriving) after the chat was ended: the tab closed, End chat, or the window closing. */
export const ENDED_DENY_MESSAGE = 'Not approved: the chat was closed before the user answered. They can approve it in a later turn.';

const OWN_DENY_MESSAGES = new Set([DENY_MESSAGE, USER_DENY_MESSAGE, PLAN_DENY_MESSAGE, STOP_DENY_MESSAGE, ENDED_DENY_MESSAGE]);

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
    cliPermissionMode(mode),
  ];
}

/**
 * Why a Claude Code session id cannot be typed into a terminal, or undefined when it can. The id is the log's file name
 * under projects/<folder>/, and Resume types `<claudeCommand> --resume <id>` into the terminal's shell (Copy Resume
 * Command puts the same line on the clipboard). A log named `x&calc.jsonl` would run calc, so anything beyond letters,
 * digits, `_`, `-` and `.` is refused before a terminal starts, the same rule as unsafeCopilotSessionId. Claude Code
 * names its logs with UUIDs, so a real id always passes. Chat here passes the id as an argument with no shell.
 */
export function unsafeClaudeSessionId(sessionId: string): string | undefined {
  if (/^[\w.-]+$/.test(sessionId)) {
    return undefined;
  }
  return (
    `This Claude Code session's id, ${JSON.stringify(sessionId)}, has characters a shell could run as a command, ` +
    `so it is not put on a command line and no terminal is started. Only letters, digits, "_", "-" and "." are ` +
    `allowed. The id is the name of the session's log file under Claude Code's projects folder, which Claude Code ` +
    `names with a UUID, so something else made or renamed it.`
  );
}

/** One user turn, as a stdin line. */
export function userLine(text: string): string {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' }) + '\n';
}

/** Stops the running turn; the process stays up for the next one (doc section 4). */
export function interruptLine(requestId: string): string {
  return JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'interrupt' } }) + '\n';
}

/** Declines a `can_use_tool` request: the tool result is an error whose text is `message` (doc section 6). */
export function denyLine(requestId: string, message = DENY_MESSAGE): string {
  return JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { behavior: 'deny', message } } }) + '\n';
}

/**
 * Allows a `can_use_tool` request: the tool runs with `input`, the input it asked for (doc section 6). `grants` go along
 * as `updatedPermissions` (doc section 6a): the "Allow for this session" button.
 */
export function allowLine(requestId: string, input: Record<string, unknown>, grants?: SessionGrant[]): string {
  const response: Record<string, unknown> = { behavior: 'allow', updatedInput: input };
  if (grants?.length) {
    response.updatedPermissions = grants;
  }
  return JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } }) + '\n';
}

/** A permission suggestion as the chat sends it back: one Claude Code honours, scoped to the running process. */
export type SessionGrant =
  | { type: 'addRules'; rules: { toolName: string; ruleContent?: string }[]; behavior: 'allow'; destination: 'session' }
  | { type: 'addDirectories'; directories: string[]; destination: 'session' }
  | { type: 'setMode'; mode: string; destination: 'session' };

/** The CLI modes a `setMode` grant may switch to: the ones the picker can show. */
const GRANTABLE_MODES = new Set(['acceptEdits', 'default', 'auto']);

/**
 * The request's `permission_suggestions` that "Allow for this session" sends: allow rules, directories and a mode
 * switch, each with `destination` rewritten to `session` so nothing is written to a settings file (doc section 6a).
 * Anything else (another type, a deny rule, a mode the picker does not know, a malformed entry) is left out.
 */
export function sessionGrants(suggestions: unknown): SessionGrant[] {
  const out: SessionGrant[] = [];
  for (const raw of Array.isArray(suggestions) ? suggestions : []) {
    const s = obj(raw);
    if (s?.type === 'addRules' && s.behavior === 'allow' && Array.isArray(s.rules)) {
      const rules = s.rules
        .map((r) => obj(r))
        .filter((r): r is Record<string, unknown> => typeof r?.toolName === 'string' && !!r.toolName)
        .map((r) => (typeof r.ruleContent === 'string' ? { toolName: r.toolName as string, ruleContent: r.ruleContent } : { toolName: r.toolName as string }));
      if (rules.length) {
        out.push({ type: 'addRules', rules, behavior: 'allow', destination: 'session' });
      }
    } else if (s?.type === 'addDirectories' && Array.isArray(s.directories)) {
      const directories = s.directories.filter((d): d is string => typeof d === 'string' && !!d);
      if (directories.length) {
        out.push({ type: 'addDirectories', directories, destination: 'session' });
      }
    } else if (s?.type === 'setMode' && typeof s.mode === 'string' && GRANTABLE_MODES.has(s.mode)) {
      out.push({ type: 'setMode', mode: s.mode, destination: 'session' });
    }
  }
  return out;
}

/**
 * The picker's mode for the CLI mode a process reports (or was switched to), keeping `current` when it already maps to
 * it ("Ask me" and decline-prompts both run as `default`). Undefined for a mode the picker has no entry for.
 */
export function pickerMode(cliMode: string, current: PermissionMode): PermissionMode | undefined {
  if (cliPermissionMode(current) === cliMode) {
    return current;
  }
  if (cliMode === 'default') {
    return 'ask';
  }
  return isPermissionMode(cliMode) && cliMode !== 'ask' && cliMode !== 'deny' ? cliMode : undefined;
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

/** Which CLI to find, and what to say when it is not there. */
export interface ExecutableSpec {
  /** The default command, and the executable's base name: `claude`, `copilot`. */
  base: string;
  /** The tool's name in messages. */
  tool: string;
  /** The setting that names the command. */
  setting: string;
  /** Where the tool's installer puts it, when the PATH may lack it; `~` is the home folder. */
  extraDirs: string[];
  /**
   * What to do with a Windows `.cmd` or `.bat` shim: refuse it, or run it through cmd.exe. Only a tool whose arguments
   * carry nothing cmd.exe could rewrite may take `shell` (Copilot CLI's chat sends the message on stdin).
   */
  shims: 'refuse' | 'shell';
}

export const CLAUDE_EXECUTABLE: ExecutableSpec = {
  base: 'claude',
  tool: 'Claude Code',
  setting: 'claudeSessions.claudeCommand',
  extraDirs: ['~/.local/bin'],
  shims: 'refuse',
};

/**
 * The CLI executable for the chat, which is spawned without a shell (doc section 8): the command setting when it is a
 * path to an executable, else the base name (`.exe` on Windows) on the PATH or in the installer's folder. A `.cmd` or
 * `.bat` shim is refused rather than run through cmd.exe, which rewrites arguments and, when killed, leaves the CLI
 * running; unless the spec takes shims (`shell: true` in the result), for a CLI whose arguments are safe there.
 */
export function resolveExecutable(command: string, env: ResolveEnv, spec: ExecutableSpec): { exe: string; shell?: boolean } | { error: string } {
  const win = env.platform === 'win32';
  const sep = win ? ';' : ':';
  const cmd = command.trim() || spec.base;
  const shim = /\.(cmd|bat|ps1)$/i;
  const exeName = `${spec.base}${win ? '.exe' : ''}`;
  const where = spec.extraDirs.length ? ` (its installer puts it in ${spec.extraDirs.join(' or ')})` : '';
  const shimResult = (p: string) =>
    spec.shims === 'shell' && /\.(cmd|bat)$/i.test(p)
      ? { exe: p, shell: true }
      : { error: `Chat here runs ${spec.tool} without a shell, and ${p} is a script shim. Set ${spec.setting} to the path of ${exeName}${where}.` };
  if (env.isFile(cmd)) {
    return win && shim.test(cmd) ? shimResult(cmd) : { exe: cmd };
  }
  if (/\s/.test(cmd) || /[\\/]/.test(cmd)) {
    return {
      error: `Chat here needs the ${spec.tool} executable itself, but ${spec.setting} is "${cmd}". Set it to the path of ${exeName}, or to "${spec.base}".`,
    };
  }
  const names = win ? (/\.exe$/i.test(cmd) ? [cmd] : [`${cmd}.exe`]) : [cmd];
  const dirs = env.pathEnv.split(sep).map((d) => d.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean);
  dirs.push(...spec.extraDirs.map((d) => d.replace(/^~(?=$|[\\/])/, env.home)));
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
    return shimResult(shimFound);
  }
  const places = ['the PATH', ...spec.extraDirs].join(spec.extraDirs.length > 1 ? ', ' : ' or in ');
  return {
    error: `${spec.tool} was not found: no ${names[0]} on ${places}. Install ${spec.tool}, or set ${spec.setting} to its path.`,
  };
}

/** The Claude Code executable for the chat (see resolveExecutable); an npm `.cmd` shim is refused. */
export function resolveClaudeExecutable(command: string, env: ResolveEnv): { exe: string } | { error: string } {
  return resolveExecutable(command, env, CLAUDE_EXECUTABLE);
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
  | { kind: 'notice'; id: number; text: string; tone: 'error' | 'info'; expire?: boolean }
  /** A permission request waiting for (or answered by) the user: a card with Allow and Deny. */
  | PermissionPiece;

export interface PermissionPiece {
  kind: 'permission';
  id: number;
  /** The control request's id, which the answer names. */
  requestId: string;
  toolName: string;
  /** The tool's input as the request gave it; Allow sends it back unchanged as `updatedInput`. */
  input: Record<string, unknown>;
  toolUseId?: string;
  /** Claude Code's own one-line description of the call, when it gives one. */
  description?: string;
  /** A path outside what the session may touch, when that is why it asks. */
  blockedPath?: string;
  /** What "Allow for this session" grants: the request's suggestions, scoped to the process. None: no such button. */
  grants?: SessionGrant[];
  state: 'pending' | 'allowed' | 'denied';
  /** Allowed with its grants, for the rest of the process. */
  forSession?: boolean;
  /** Why a card was denied without the user pressing Deny: Stop, the chat closing, the process exiting. */
  why?: string;
  expire?: boolean;
}

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
  protected nextId = 1;
  /** The field under which the log records a piece's uuid: Claude Code's `uuid`; Copilot CLI's records have an `id`. */
  protected logKey = 'uuid';
  /** The API message being streamed, for stream events that do not name it. */
  private streamingMessage?: string;
  /** Stop was pressed during the running turn, so its error result is the interrupt. */
  interrupting = false;
  /**
   * When set, every permission request is declined at once with this message instead of showing a card: the
   * decline-prompts mode, or a chat that has ended (nobody is left to answer, and the turn must not hang).
   */
  decline?: string;

  /** The cards still waiting for an answer, oldest first. Only the first can be answered: requests go in order. */
  pendingPermissions(): PermissionPiece[] {
    return this.pieces.filter((p): p is PermissionPiece => p.kind === 'permission' && p.state === 'pending');
  }

  /**
   * The user's answer to a card: the reply line for the process, or undefined when the card is not the one waiting
   * (already answered, or a later one while an earlier is still open). `forSession` allows with the card's grants (a
   * card without any is allowed once). `cliMode` is the mode the process switches to with this answer, if it does: the
   * grants' `setMode`, or `default` once a plan is approved (doc section 6a).
   */
  answerLine(requestId: string, allow: boolean, forSession = false): { line: string; cliMode?: string } | undefined {
    const card = this.pendingPermissions()[0];
    if (!card || card.requestId !== requestId) {
      return undefined;
    }
    if (allow) {
      card.state = 'allowed';
      const grants = forSession && card.grants?.length ? card.grants : undefined;
      card.forSession = !!grants || undefined;
      const setMode = grants?.find((g): g is Extract<SessionGrant, { type: 'setMode' }> => g.type === 'setMode');
      return {
        line: allowLine(card.requestId, card.input, grants),
        cliMode: setMode ? setMode.mode : card.toolName === 'ExitPlanMode' ? 'default' : undefined,
      };
    }
    return { line: this.denyCard(card, card.toolName === 'ExitPlanMode' ? PLAN_DENY_MESSAGE : USER_DENY_MESSAGE) };
  }

  /** answerLine's reply line alone. */
  answer(requestId: string, allow: boolean, forSession = false): string | undefined {
    return this.answerLine(requestId, allow, forSession)?.line;
  }

  /** Denies every open card with `message` (Stop, the chat ending), noting `why` on each; the reply lines, in order. */
  denyPending(message: string, why: string): string[] {
    return this.pendingPermissions().map((card) => {
      card.why = why;
      return this.denyCard(card, message);
    });
  }

  /** The process is gone, or the turn ended without an answer: open cards can no longer be answered. */
  abandonPending(why: string): boolean {
    const open = this.pendingPermissions();
    for (const card of open) {
      card.state = 'denied';
      card.why = why;
    }
    return open.length > 0;
  }

  private denyCard(card: PermissionPiece, message: string): string {
    card.state = 'denied';
    const tool = card.toolUseId ? this.pieces.find((p) => p.kind === 'tool' && p.toolUseId === card.toolUseId) : undefined;
    if (tool && tool.kind === 'tool') {
      tool.status = 'denied';
    }
    return denyLine(card.requestId, message);
  }

  addUser(text: string, queued: boolean): void {
    // A new turn clears errors and notes from earlier ones; one queued behind a running turn leaves that turn's alone.
    if (!queued) {
      this.pieces = this.pieces.filter((p) => p.kind !== 'notice' && !(p.kind === 'permission' && p.state !== 'pending'));
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
      if (piece.kind === 'text' || piece.kind === 'thinking' || piece.kind === 'tool') {
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
        tool.status = b.is_error === true ? (OWN_DENY_MESSAGES.has(resultText(b.content)) ? 'denied' : 'failed') : 'ok';
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
    // Every request is answered, or the turn hangs (doc section 6): by the user on a card, or at once when declining.
    const name = str(request.tool_name) ?? 'a tool';
    const toolUseId = str(request.tool_use_id);
    if (this.decline !== undefined) {
      const changed = this.denied(toolUseId, name, undefined, this.decline === DENY_MESSAGE ? 'mode' : 'ended');
      return { changed, reply: denyLine(requestId, this.decline) };
    }
    if (this.pieces.some((p) => p.kind === 'permission' && p.requestId === requestId)) {
      // The same request twice: the card is already up.
      return { changed: false };
    }
    const grants = sessionGrants(request.permission_suggestions);
    this.pieces.push({
      kind: 'permission',
      id: this.nextId++,
      requestId,
      toolName: name,
      input: obj(request.input) ?? {},
      toolUseId,
      description: str(request.description),
      blockedPath: str(request.blocked_path),
      grants: grants.length ? grants : undefined,
      state: 'pending',
    });
    return { changed: true };
  }

  /** Marks a tool call declined, and says so; the log records it only as a failed tool result. */
  private denied(toolUseId: string | undefined, name: string | undefined, reason: string | undefined, by: 'mode' | 'ended' | 'cli' = 'cli'): boolean {
    const tool = toolUseId ? this.pieces.find((p) => p.kind === 'tool' && p.toolUseId === toolUseId) : undefined;
    if (tool && tool.kind === 'tool') {
      tool.status = 'denied';
    }
    const what = name === 'ExitPlanMode' ? 'the plan' : (name ?? 'a tool');
    const text =
      by === 'mode'
        ? `Declined ${what}: the chat is set to decline what needs approval. Pick "Ask me" in the permission mode to approve it here.`
        : by === 'ended'
          ? `Declined ${what}: the chat was ended, so nobody was there to approve it.`
          : `Declined ${what}: it needs approval.${reason ? ` (${reason})` : ''}`;
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
    // Claude Code is no longer waiting on a card still open (an interrupted turn): it can no longer be answered.
    this.abandonPending('The turn ended before it was answered.');
    for (const p of this.pieces) {
      if ('streaming' in p) {
        p.streaming = false;
      }
      // What never got a uuid goes at the next log read: the log has the turn by then. So do the turn's cards.
      if (p.kind === 'permission' || (p.kind !== 'notice' && !p.uuid)) {
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
      if (p.kind === 'permission') {
        // A card stays while it is open, and goes with its turn once answered: the log then shows what happened.
        return p.state === 'pending' || !p.expire;
      }
      if (p.uuid) {
        return !logText.includes(`"${this.logKey}":"${p.uuid}"`);
      }
      return !p.expire;
    });
    return this.pieces.length !== before;
  }

  /** A turn's notes to drop at the next log read (an interrupted or crashed turn). */
  expireAll(): void {
    for (const p of this.pieces) {
      if (p.kind !== 'notice' && !(p.kind === 'user' && p.queued) && !(p.kind === 'permission' && p.state === 'pending')) {
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
  /** Permission cards waiting for the user's answer: the turn is held until they are answered. */
  awaiting?: number;
  /** The permission mode: a PermissionMode for Claude Code, a CopilotMode (copilotChat.ts) for Copilot CLI. */
  mode: string;
  /** The chat was ended during a turn: the reply finishes, then the process exits. */
  finishing?: boolean;
  /** The last finished turn. */
  lastTurn?: { cost?: number; durationMs?: number; error?: boolean; interrupted?: boolean };
}

/**
 * What a transcript tab needs of its chat, whichever CLI runs it: ClaudeChat (one long-lived Claude Code process) or
 * CopilotChat (one Copilot CLI process per turn).
 */
export interface SessionChat {
  readonly live: { pieces: LivePiece[]; forget(logText: string): boolean };
  readonly status: ChatStatus;
  /** A turn is running (including one finishing after the chat was ended). */
  readonly replying: boolean;
  /** The running process's pid. */
  readonly pid: number | undefined;
  /** A process is up or a turn is pending: the session has a writer. */
  readonly active: boolean;
  /** When this chat last heard from its process; its own writes to the log are not another writer's. */
  readonly lastActivity: number;
  send(text: string): void;
  /** The user's answer to a permission card, `forSession` for "Allow for this session"; false when nothing was waiting on it. */
  answer(requestId: string, allow: boolean, forSession?: boolean): boolean;
  /** Stop: ends the running turn; messages still waiting go back to the message box. */
  interrupt(): void;
  setMode(mode: string): void;
  /** Ends the chat and lets a running turn finish. Resolves once its process has exited. */
  end(graceMs?: number): Promise<void>;
  /** Ends the chat now, stopping a running turn. */
  stopNow(graceMs?: number): Promise<void>;
  /** The window is closing: a running turn gets `turnGraceMs` to finish. */
  dispose(turnGraceMs?: number, graceMs?: number): Promise<void>;
}

/** How long a closing process gets to exit after its stdin closes before it is killed. */
const CLOSE_GRACE_MS = 3000;
/** How long to wait for the exit after a kill before giving up on hearing it. */
const KILL_WAIT_MS = 1000;
/** Window close: how long a running turn may carry on before it is interrupted. */
const TURN_GRACE_MS = 1500;

/**
 * One chat: a `claude` process kept between turns, the messages waiting for it, and what the tab shows meanwhile.
 * Messages go one turn at a time; one typed during a turn waits here (shown as queued) until the turn's `result`, so a
 * mode change can restart the process between turns. Stop sends the interrupt control request and never kills; the
 * process is killed only when it will not exit after its stdin closes.
 *
 * Ending the chat during a turn lets the turn finish: stdin stays open until its `result` (so tool requests are still
 * answered and Stop can still interrupt it), then closes, and the process exits.
 */
export class ClaudeChat implements SessionChat {
  readonly live = new LiveChat();
  private child?: ChatChild;
  private queue: string[] = [];
  private busy = false;
  private restartAfterTurn = false;
  private closing?: Promise<void>;
  /** Closes stdin and arms the kill timer; waiting for the running turn's result while it is set. */
  private letGo?: () => void;
  /** How long the process gets to exit after its stdin closes. */
  private graceMs = CLOSE_GRACE_MS;
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
  /** The mode the picker shows: the one picked, or one the running process switched itself to (followCliMode). */
  mode: PermissionMode;
  /**
   * The mode the user picked. Every new process starts in it: a mode Claude Code switched to by itself (an "Allow for
   * this session" grant, a plan approved) ends with the process that switched (doc section 6a).
   */
  private picked: PermissionMode;
  /** The --permission-mode the running process was started with. */
  private runningCliMode?: string;

  constructor(private readonly opts: ChatOptions) {
    this.mode = opts.mode;
    this.picked = opts.mode;
    this.live.decline = opts.mode === 'deny' ? DENY_MESSAGE : undefined;
  }

  get status(): ChatStatus {
    return {
      running: !!this.child && !this.closing,
      busy: this.busy,
      queued: this.queue.length,
      awaiting: this.live.pendingPermissions().length || undefined,
      mode: this.mode,
      finishing: (this.disposed && this.busy && !!this.child) || undefined,
      lastTurn: this.lastTurn,
    };
  }

  /** A turn is running (including one finishing after the chat was ended). */
  get replying(): boolean {
    return this.busy && !!this.child;
  }

  /** The running process's pid, so its entry in Claude Code's registry of live sessions is known to be this chat. */
  get pid(): number | undefined {
    return this.child?.pid;
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

  /**
   * The user answered a permission card: Allow lets the tool run, Deny declines it and Claude carries on. Only the
   * oldest open card can be answered, so requests go in order; an answer to any other is ignored. "Allow for this
   * session" (`forSession`) also sends the card's grants, which last as long as this process.
   */
  answer(requestId: string, allow: boolean, forSession = false): boolean {
    const answered = this.live.answerLine(requestId, allow, forSession);
    if (!answered) {
      return false;
    }
    this.write(answered.line);
    if (answered.cliMode) {
      this.followCliMode(answered.cliMode);
    }
    this.opts.onChange();
    return true;
  }

  /**
   * The process is now in `cliMode`, by its own doing: a `setMode` grant, a plan approved, or what a turn's `init`
   * reports. The picker follows it (doc section 6a), so it does not say Plan once the plan is approved, and so a mode
   * change that matches it does not restart the process. A change the user picked during the turn still wins: the
   * process restarts into it after the turn. The picked mode stays as it was, so the next process starts in it
   * (backToPicked). True when the picker's mode changed.
   */
  private followCliMode(cliMode: string): boolean {
    if (cliMode === this.runningCliMode || !this.child) {
      return false;
    }
    this.opts.log(`Claude Code is now in ${cliMode} mode (was ${this.runningCliMode}).`);
    this.runningCliMode = cliMode;
    if (this.restartAfterTurn) {
      this.restartAfterTurn = cliPermissionMode(this.mode) !== cliMode;
      return false;
    }
    const mode = pickerMode(cliMode, this.mode);
    if (!mode || mode === this.mode) {
      return false;
    }
    this.mode = mode;
    if (!this.disposed) {
      // Never decline-prompts here (that runs as `default`, which keeps it), so cards are shown again.
      this.live.decline = undefined;
    }
    return true;
  }

  /**
   * The process that followCliMode followed is gone: the picker goes back to the mode the user picked, the one the next
   * process starts in. A grant's mode or an approved plan's never carries over to a new process.
   */
  private backToPicked(): void {
    if (this.mode === this.picked) {
      return;
    }
    this.opts.log(`Back to the picked mode, ${this.picked}: the process that switched to ${this.mode} has ended.`);
    this.mode = this.picked;
    if (!this.disposed) {
      this.live.decline = this.picked === 'deny' ? DENY_MESSAGE : undefined;
    }
  }

  /**
   * Stops the running turn with the interrupt control request; messages still waiting go back to the message box. Open
   * permission cards are denied first, since the turn is blocked on them.
   */
  interrupt(): void {
    const dropped = this.queue.splice(0);
    if (dropped.length) {
      this.live.dropQueued();
      this.opts.onUnsent(dropped);
    }
    if (this.busy && this.child) {
      this.denyPending(STOP_DENY_MESSAGE, 'Stopped before it was answered.');
      this.live.interrupting = true;
      this.write(interruptLine(`interrupt-${++this.requestSeq}`));
    }
    this.opts.onChange();
  }

  /**
   * A new permission mode. Claude Code takes a new process for a new --permission-mode: now when idle, after the
   * running turn otherwise. Between "Ask me" and decline-prompts only the answer changes, so the process stays (and
   * open cards are declined when switching to decline).
   */
  setMode(mode: PermissionMode): void {
    if (mode === this.mode) {
      // Already the running process's mode, maybe by its own doing: now it is the user's pick too.
      this.picked = mode;
      return;
    }
    this.mode = mode;
    this.picked = mode;
    if (!this.disposed) {
      this.live.decline = mode === 'deny' ? DENY_MESSAGE : undefined;
      if (mode === 'deny') {
        this.denyPending(DENY_MESSAGE, 'Declined: the permission mode was changed to decline.');
      }
    }
    if (this.child && !this.closing) {
      const restart = cliPermissionMode(mode) !== this.runningCliMode;
      if (this.busy) {
        this.restartAfterTurn = restart;
      } else if (restart) {
        void this.close();
      }
    }
    this.opts.onChange();
  }

  private denyPending(message: string, why: string): void {
    for (const line of this.live.denyPending(message, why)) {
      this.write(line);
    }
  }

  /**
   * Ends the chat and lets a running turn finish: no more turns start, messages still waiting go back to the message
   * box, and once the turn's `result` is in, stdin closes and the process exits (killed if it will not). Resolves once
   * it has exited.
   */
  end(graceMs = CLOSE_GRACE_MS): Promise<void> {
    this.graceMs = Math.min(this.graceMs, graceMs);
    if (!this.disposed) {
      this.disposed = true;
      // Nobody is left to answer a card: open ones are denied, and so is any request the finishing turn still makes.
      this.live.decline = ENDED_DENY_MESSAGE;
      this.denyPending(ENDED_DENY_MESSAGE, 'The chat was ended before it was answered.');
      const unsent = this.queue.splice(0);
      this.live.dropQueued();
      if (unsent.length) {
        this.opts.onUnsent(unsent);
      }
    }
    return this.close(true);
  }

  /** Ends the chat now: a running turn is interrupted and stdin closes at once. Resolves once the process has exited. */
  stopNow(graceMs = CLOSE_GRACE_MS): Promise<void> {
    const done = this.end(graceMs);
    if (this.busy && this.child && !this.live.interrupting) {
      this.live.interrupting = true;
      this.write(interruptLine(`interrupt-${++this.requestSeq}`));
    }
    this.letGo?.();
    return done;
  }

  /**
   * The window is closing: a running turn gets `turnGraceMs` to finish and is then interrupted, and the process is
   * killed if it has not exited `graceMs` after its stdin closed. Never waits longer than that.
   */
  dispose(turnGraceMs = TURN_GRACE_MS, graceMs = CLOSE_GRACE_MS): Promise<void> {
    const done = this.end(graceMs);
    if (turnGraceMs <= 0) {
      void this.stopNow(graceMs);
    } else if (this.letGo) {
      const timer = setTimeout(() => void this.stopNow(graceMs), turnGraceMs);
      void done.then(() => clearTimeout(timer));
    }
    return done;
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
    this.backToPicked();
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
    this.runningCliMode = cliPermissionMode(this.mode);
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
    // What the process switched itself to ended with it.
    this.backToPicked();
    // A card still open can no longer be answered: nothing hangs on it, and it says why.
    this.live.abandonPending('Claude Code exited before it was answered.');
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
      if (r.init?.permissionMode && this.followCliMode(r.init.permissionMode)) {
        changed = true;
      }
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
    // An ended chat's last turn is in: now its stdin closes.
    this.letGo?.();
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

  /**
   * Ends the process: stdin closed, then killed if it does not exit within the grace period. With a turn running,
   * `finishTurn` keeps stdin open until the turn's result (letting it finish); otherwise the turn is interrupted first.
   */
  private close(finishTurn = false): Promise<void> {
    const child = this.child;
    if (!child) {
      return Promise.resolve();
    }
    if (this.closing) {
      return this.closing;
    }
    if (this.busy && !finishTurn) {
      // Closing stdin alone lets the running turn finish (doc section 4), so it is interrupted first.
      this.live.interrupting = true;
      this.write(interruptLine(`interrupt-${++this.requestSeq}`));
    }
    this.closing = new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let fallback: ReturnType<typeof setTimeout> | undefined;
      child.on('exit', () => {
        this.letGo = undefined;
        clearTimeout(timer);
        clearTimeout(fallback);
        resolve();
      });
      this.letGo = () => {
        this.letGo = undefined;
        timer = setTimeout(() => {
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
        }, this.graceMs);
        try {
          child.stdin?.end();
        } catch {
          // Already closed.
        }
      };
      if (!(this.busy && finishTurn)) {
        this.letGo();
      }
    }).then(() => {
      this.closing = undefined;
      this.letGo = undefined;
      this.busy = false;
      this.opts.onChange();
    });
    this.opts.onChange();
    return this.closing;
  }
}
