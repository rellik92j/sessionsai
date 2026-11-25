// Pure parsing of Claude Code session logs (~/.claude/projects/<project>/<sessionId>.jsonl).
// No VS Code imports here so it can be unit-tested with plain Node.

import { fileAccess, filePathOf, isCommitCommand, isShellTool } from './tools';
import { UsageCollector, UsageSummary } from './usage';

export type TitleSource = 'custom' | 'ai' | 'prompt' | 'command' | 'none';

/** Which tool wrote the session log. */
export type SessionSource = 'claude' | 'copilot-cli' | 'vscode-chat';

export interface SessionInfo {
  /** Raw session id, as the source's own resume command takes it. */
  id: string;
  source: SessionSource;
  /** Unique across sources: "<source>:<id>". */
  key: string;
  filePath: string;
  /** Encoded folder name under the projects dir, e.g. "C--Users-me-repo"; '' for non-Claude sources. */
  projectDir: string;
  /** Working directory the session was started in. */
  cwd?: string;
  title: string;
  titleSource: TitleSource;
  firstPrompt?: string;
  lastPrompt?: string;
  gitBranch?: string;
  startTime?: number;
  lastTime?: number;
  /** Number of real prompts typed by the user (tool results and meta messages excluded). */
  promptCount: number;
  /** Number of distinct assistant API messages. */
  assistantCount: number;
  /** Messages received from other Claude sessions (agent teams). */
  peerMessageCount: number;
  firstPeerMessage?: { from: string; text: string };
  prUrl?: string;
  prNumber?: number;
  prRepository?: string;
  /** The session's name as other sessions address it; Claude Code writes it alongside every rename, so it is not an agent. */
  agentName?: string;
  /** The agent definition the session ran under (`claude --agent <name>`), from its `agent-setting` record. */
  agent?: string;
  version?: string;
  model?: string;
  /** Prompts, peer messages and Claude's replies (no tool I/O or thinking), for full-text search. */
  searchText: string;
  /** Tokens, cost, context and cache state; undefined when the log records no API usage. */
  usage?: UsageSummary;
  /** Files its tools wrote or edited, for the `file:` search filter (Claude Code only). */
  changedFiles?: string[];
  /** Skills it loaded, for the `skill:` search filter (Claude Code only). */
  skills?: string[];
  /** Successful `git commit` runs, for `has:commits` (Claude Code only). */
  commitCount?: number;
}

export type TranscriptPart =
  | { kind: 'text'; text: string; from?: string }
  | { kind: 'thinking'; text: string }
  | {
      kind: 'tool_use';
      id?: string;
      name: string;
      /** Most telling input field (description, command, path…) for a one-line summary. */
      hint?: string;
      input: string;
      /** The input's short string fields (paths, commands, skill names…), for the insights sidebar. */
      args?: Record<string, string>;
      /** For edit-style tools: the replaced and replacement text. */
      diff?: { before: string; after: string };
      result?: { text: string; isError: boolean };
    }
  | { kind: 'tool_result'; text: string; isError: boolean };

/** What answering one prompt took: every request until the next prompt (subagents not included). */
export interface TurnStats {
  cost: number;
  requests: number;
  outputTokens: number;
  /** From the prompt to the last reply before the next prompt. */
  durationMs?: number;
}

export interface TranscriptEntry {
  role: 'user' | 'assistant' | 'tool' | 'system' | 'peer' | 'subagent';
  timestamp?: string;
  /** On a subagent entry: the reply, as text parts. */
  parts: TranscriptPart[];
  /** On a user prompt: what the reply to it cost (Claude Code only). */
  turn?: TurnStats;
  /**
   * On a user prompt: typed while Claude was mid-turn and folded into that turn, so it has no cost of its own
   * unless a user record repeating it later started a turn.
   */
  queued?: true;
  /** On a subagent entry: who ran and what it was asked (Claude Code only). */
  subagent?: {
    name?: string;
    description?: string;
    prompt?: string;
    toolUseId?: string;
    /** The run's agent id, set only when its log was read, so the transcript can offer to open the full run. */
    agentId?: string;
    /** Launched in the background: its reply comes back later, as its own hand-back entry. */
    background?: true;
    /** A reply that reached the main session where this entry sits (an `<agent-message>`), not a launch. */
    handback?: true;
  };
}

/** One subagent run, read from `<sessionId>/subagents/agent-<id>.jsonl` and the `.meta.json` beside it. */
export interface SubagentRun {
  agentId?: string;
  /** The session it answered, from its records' sessionId. */
  sessionId?: string;
  /** The Agent/Task tool call that started it, from the meta file. */
  toolUseId?: string;
  /** subagent_type: a named agent ("release-manager") or a built-in one ("general-purpose"). */
  agentType?: string;
  isBuiltIn?: boolean;
  description?: string;
  prompt?: string;
  reply?: string;
  /** When the reply was written. */
  timestamp?: string;
  /** The log file it was read from (set by readSubagentRuns). */
  file?: string;
}

const MAX_TITLE = 120;
const MAX_TOOL_TEXT = 4000;
/** Search text kept per session; tool-heavy logs can otherwise make every state update huge. */
export const MAX_SEARCH_TEXT = 200_000;

/** Lines that look like user messages but are generated by the CLI, not typed by the user. */
const NOISE_PATTERNS = [
  /^<local-command-(caveat|stdout|stderr)>/,
  /^<bash-(input|stdout|stderr)>/,
  /^<task-notification>/,
  /^<user-memory-input>/,
  /^\[Request interrupted by user/,
  /^Caveat: The messages below were generated by the user/,
];

type Classified =
  | { kind: 'prompt'; text: string }
  | { kind: 'command'; text: string }
  | { kind: 'noise' };

/** Classifies a user message's content as a real prompt, a slash command, or noise. */
export function classifyUserContent(content: unknown): Classified {
  let raw: string;
  if (typeof content === 'string') {
    raw = content;
  } else if (Array.isArray(content)) {
    if (content.some((p) => p && p.type === 'tool_result')) {
      return { kind: 'noise' };
    }
    raw = content
      .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text as string)
      .join('\n');
  } else {
    return { kind: 'noise' };
  }

  const text = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (!text) {
    return { kind: 'noise' };
  }

  if (text.startsWith('<command-name>') || text.startsWith('<command-message>')) {
    const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1]?.trim() ?? '';
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? '';
    const cmd = `${name} ${args}`.trim();
    return cmd ? { kind: 'command', text: cmd } : { kind: 'noise' };
  }

  if (NOISE_PATTERNS.some((re) => re.test(text))) {
    return { kind: 'noise' };
  }
  return { kind: 'prompt', text };
}

const PEER_MESSAGE = /<cross-session-message\b([^>]*)>([\s\S]*?)(?:<\/cross-session-message>|$)/;

/** Extracts a message sent by another Claude session (agent teams), which is logged as a meta user message. */
export function parsePeerMessage(content: unknown): { from: string; text: string } | undefined {
  const raw = typeof content === 'string' ? content : undefined;
  const m = raw ? PEER_MESSAGE.exec(raw) : null;
  if (!m) {
    return undefined;
  }
  const from = /from-name="([^"]*)"/.exec(m[1])?.[1] || 'another session';
  return { from, text: m[2].trim() };
}

/** A message from an agent (a background subagent's hand-back) that reached the main session. */
export interface AgentMessage {
  /** The sending agent's id. */
  from: string;
  /** Its agent type as Claude Code recorded it ("reviewer", "general-purpose"), if it did. */
  name?: string;
  text: string;
  /** Identifies this delivery, so one logged twice (as a record and as a queued command) shows once. */
  key: string;
}

const AGENT_MESSAGE = /<agent-message\b([^>]*)>([\s\S]*?)(?:<\/agent-message>|$)/;
/** The frame Claude Code puts around a hand-back; the report after it is indented two spaces. */
const HANDBACK_FRAME = /^\[Subagent hand-back\][\s\S]*?The report follows:[ \t]*\r?\n/;

/**
 * Extracts a message an agent sent to this session, from a meta user record whose content holds an
 * `<agent-message from="<agentId>">`, or from a `queued_command` attachment carrying one (delivered mid-turn).
 */
export function parseAgentMessage(r: any): AgentMessage | undefined {
  let raw: unknown;
  let origin: any;
  if (r?.type === 'user') {
    raw = r.message?.content;
    origin = r.origin;
  } else if (r?.type === 'attachment' && r.attachment?.type === 'queued_command') {
    raw = r.attachment.prompt;
    origin = r.attachment.origin;
  }
  const m = typeof raw === 'string' ? AGENT_MESSAGE.exec(raw) : null;
  if (!m) {
    return undefined;
  }
  origin = origin && typeof origin === 'object' ? origin : {};
  const from = /from="([^"]*)"/.exec(m[1])?.[1] || str(origin.from) || '';
  let text = str(origin.handbackReportText)?.trim();
  if (!text) {
    const body = m[2].replace(/^\r?\n/, '');
    const frame = HANDBACK_FRAME.exec(body);
    text = (frame ? body.slice(frame[0].length).replace(/^ {2}/gm, '') : body).trim();
  }
  if (!text) {
    return undefined;
  }
  return { from, name: str(origin.name), text, key: str(origin.handbackToolUseId) ?? `${from}\n${text}` };
}

/**
 * A prompt the user typed while Claude was mid-turn. Claude Code logs it as a `queued_command` attachment
 * (`commandMode: "prompt"`, `origin.kind: "human"`) and folds it into the running turn, so it usually never
 * gets a user record of its own. Task notifications, peer messages and hand-backs share the shape and are not prompts.
 */
export function parseQueuedPrompt(r: any): string | undefined {
  const a = r?.type === 'attachment' && !r.isMeta ? r.attachment : undefined;
  if (!a || a.type !== 'queued_command' || a.commandMode !== 'prompt' || a.isMeta || typeof a.prompt !== 'string') {
    return undefined;
  }
  if (a.origin != null && a.origin?.kind !== 'human') {
    return undefined;
  }
  const c = classifyUserContent(a.prompt);
  return c.kind === 'prompt' ? c.text : undefined;
}

export function oneLine(text: string, max = MAX_TITLE): string {
  const flat = text
    .replace(/<\/?pasted_content\b[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + '…' : flat;
}

export function parseTime(value: unknown): number | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : t;
}

/** Joins search text parts, stopping at MAX_SEARCH_TEXT characters. */
export function joinSearchText(parts: string[]): string {
  const text = parts.join('\n');
  return text.length > MAX_SEARCH_TEXT ? text.slice(0, MAX_SEARCH_TEXT) : text;
}

/** Parsed JSONL records, skipping blank and unparseable lines. */
export function* records(text: string): Generator<any> {
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end === -1) {
      end = text.length;
    }
    const line = text.slice(start, end).trim();
    start = end + 1;
    if (!line) {
      continue;
    }
    try {
      yield JSON.parse(line);
    } catch {
      // A partially written last line (session still running) or corrupt line; skip it.
    }
  }
}

/**
 * Extracts summary metadata for one session log. `subagentLogs` are the logs of its subagents
 * (`<sessionId>/subagents/*.jsonl`), which only add to its usage; one whose records name another session is skipped.
 */
export function parseSession(
  text: string,
  filePath: string,
  projectDir: string,
  id: string,
  subagentLogs: string[] = [],
): SessionInfo {
  const info: SessionInfo = {
    id,
    source: 'claude',
    key: `claude:${id}`,
    filePath,
    projectDir,
    title: '',
    titleSource: 'none',
    promptCount: 0,
    assistantCount: 0,
    peerMessageCount: 0,
    searchText: '',
  };
  const searchParts: string[] = [];
  let customTitle: string | undefined;
  let aiTitle: string | undefined;
  let firstCommand: string | undefined;
  let lastPromptRecord: string | undefined;
  const assistantIds = new Set<string>();
  const changedFiles = new Set<string>();
  const skills = new Set<string>();
  /** Ids of `git commit` tool calls, counted once their result comes back without an error. */
  const commitCalls = new Set<string>();
  let commitCount = 0;
  const usage = new UsageCollector();
  /** Hand-backs already added to the search text, by delivery. */
  const handbacks = new Set<string>();
  /** Prompts queued mid-turn since the last typed prompt, so a user record repeating one is not counted twice. */
  const queuedPrompts = new Set<string>();
  const countPrompt = (text: string) => {
    info.promptCount++;
    info.firstPrompt ??= text;
    info.lastPrompt = text;
    searchParts.push(text);
  };

  for (const r of records(text)) {
    if (!r || typeof r !== 'object') {
      continue;
    }
    switch (r.type) {
      case 'custom-title':
        if (typeof r.customTitle === 'string' && r.customTitle.trim()) {
          customTitle = r.customTitle.trim();
        }
        continue;
      case 'ai-title':
        if (typeof r.aiTitle === 'string' && r.aiTitle.trim()) {
          aiTitle = r.aiTitle.trim();
        }
        continue;
      case 'summary':
        // Older Claude Code versions stored the title as a "summary" record.
        if (typeof r.summary === 'string' && r.summary.trim() && !aiTitle) {
          aiTitle = r.summary.trim();
        }
        continue;
      case 'last-prompt':
        if (typeof r.lastPrompt === 'string') {
          lastPromptRecord = r.lastPrompt;
        }
        continue;
      case 'agent-name':
        if (typeof r.agentName === 'string') {
          info.agentName = r.agentName;
        }
        continue;
      case 'agent-setting':
        if (typeof r.agentSetting === 'string' && r.agentSetting.trim()) {
          info.agent = r.agentSetting.trim();
        }
        continue;
      case 'pr-link':
        if (typeof r.prUrl === 'string') {
          info.prUrl = r.prUrl;
          info.prNumber = typeof r.prNumber === 'number' ? r.prNumber : undefined;
          info.prRepository = typeof r.prRepository === 'string' ? r.prRepository : undefined;
        }
        continue;
      case 'attachment': {
        // A subagent's hand-back delivered while Claude was mid-turn; the transcript shows it, so search finds it.
        const handback = !r.isSidechain ? parseAgentMessage(r) : undefined;
        if (handback && !handbacks.has(handback.key)) {
          handbacks.add(handback.key);
          searchParts.push(handback.text);
        }
        // A prompt typed mid-turn counts like any other; a user record repeating it next is not counted again.
        const queued = !r.isSidechain && !handback ? parseQueuedPrompt(r) : undefined;
        if (queued) {
          queuedPrompts.add(queued);
          countPrompt(queued);
        }
        continue;
      }
      case 'user':
      case 'assistant':
        break;
      default:
        continue;
    }

    if (r.isSidechain) {
      if (r.type === 'assistant') {
        usage.add(r, true);
      }
      continue;
    }
    if (!info.cwd && typeof r.cwd === 'string') {
      info.cwd = r.cwd;
    }
    if (typeof r.gitBranch === 'string' && r.gitBranch && r.gitBranch !== 'HEAD') {
      info.gitBranch = r.gitBranch;
    }
    if (typeof r.version === 'string') {
      info.version = r.version;
    }
    const t = parseTime(r.timestamp);
    if (t !== undefined) {
      info.startTime = info.startTime === undefined ? t : Math.min(info.startTime, t);
      info.lastTime = info.lastTime === undefined ? t : Math.max(info.lastTime, t);
    }

    if (r.type === 'assistant') {
      usage.add(r, false);
      const msgId = r.message?.id ?? r.uuid;
      if (typeof msgId === 'string') {
        assistantIds.add(msgId);
      }
      const model = r.message?.model;
      if (typeof model === 'string' && !model.startsWith('<')) {
        info.model = model;
      }
      const content = r.message?.content;
      if (Array.isArray(content)) {
        for (const p of content) {
          if (p?.type === 'text' && typeof p.text === 'string' && p.text.trim()) {
            searchParts.push(p.text);
          } else if (p?.type === 'tool_use' && p.input && typeof p.input === 'object') {
            // Files a tool read or changed, so searching for a file finds sessions that touched it without naming it.
            for (const key of ['file_path', 'notebook_path', 'path']) {
              if (typeof p.input[key] === 'string' && p.input[key].trim()) {
                searchParts.push(p.input[key]);
              }
            }
            const name = String(p.name ?? '');
            const access = fileAccess(name, p.input);
            const file = access && access !== 'read' ? filePathOf(p.input) : undefined;
            if (file) {
              changedFiles.add(file);
            }
            if (name === 'Skill' && typeof p.input.skill === 'string') {
              skills.add(p.input.skill);
            }
            if (isShellTool(name) && typeof p.input.command === 'string' && isCommitCommand(p.input.command) && typeof p.id === 'string') {
              commitCalls.add(p.id);
            }
          }
        }
      }
      continue;
    }

    if (commitCalls.size && Array.isArray(r.message?.content)) {
      for (const p of r.message.content) {
        if (p?.type === 'tool_result' && commitCalls.delete(p.tool_use_id) && !p.is_error) {
          commitCount++;
        }
      }
    }
    if (r.isMeta) {
      const handback = parseAgentMessage(r);
      if (handback) {
        if (!handbacks.has(handback.key)) {
          handbacks.add(handback.key);
          searchParts.push(handback.text);
        }
        continue;
      }
      const peer = parsePeerMessage(r.message?.content);
      if (peer) {
        info.peerMessageCount++;
        info.firstPeerMessage ??= peer;
        searchParts.push(peer.text);
      }
      continue;
    }
    if (r.isCompactSummary) {
      continue;
    }
    const c = classifyUserContent(r.message?.content);
    if (c.kind === 'prompt') {
      if (!queuedPrompts.has(c.text)) {
        countPrompt(c.text);
      }
    } else if (c.kind === 'command') {
      firstCommand ??= c.text;
    }
    if (c.kind !== 'noise') {
      queuedPrompts.clear();
    }
  }

  for (const log of subagentLogs) {
    // A log whose records name another session is not this session's, as in the transcript: it adds nothing here.
    // One whose records name no session is still counted.
    const run = parseSubagentRun(log);
    if (run.sessionId && run.sessionId !== id) {
      continue;
    }
    for (const r of records(log)) {
      if (r?.type === 'assistant') {
        usage.add(r, true);
      }
    }
    // The transcript shows each subagent's reply, so a search for it should find the session.
    if (run.reply) {
      searchParts.push(run.reply);
    }
  }
  info.usage = usage.summary();
  info.assistantCount = assistantIds.size;
  info.searchText = searchParts.join('\n');
  info.changedFiles = [...changedFiles];
  info.skills = [...skills];
  info.commitCount = commitCount;
  if (!info.lastPrompt && lastPromptRecord) {
    info.lastPrompt = lastPromptRecord;
  }

  if (customTitle) {
    info.title = oneLine(customTitle);
    info.titleSource = 'custom';
    // A rename is shown as typed. Claude Code writes an equal agent-name next to every rename, so that alone says
    // nothing. Agent-team sessions are the exception: several share the agent's name ("Project Lead") and are told
    // apart only by what they were about, and they are the ones that receive messages from other sessions.
    if (info.peerMessageCount > 0 && info.agentName && customTitle === info.agentName) {
      const about = aiTitle ?? info.firstPrompt ?? info.firstPeerMessage?.text;
      if (about) {
        info.title = oneLine(`${customTitle} — ${about}`);
      }
    }
  } else if (aiTitle) {
    info.title = oneLine(aiTitle);
    info.titleSource = 'ai';
  } else if (info.firstPrompt) {
    info.title = oneLine(info.firstPrompt);
    info.titleSource = 'prompt';
  } else if (info.firstPeerMessage) {
    info.title = oneLine(`${info.firstPeerMessage.from}: ${info.firstPeerMessage.text}`);
    info.titleSource = 'prompt';
  } else if (firstCommand) {
    info.title = oneLine(firstCommand);
    info.titleSource = 'command';
  } else {
    info.title = '(empty session)';
  }
  return info;
}

function stringifyToolContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (p?.type === 'text' && typeof p.text === 'string') {
          return p.text;
        }
        if (p?.type === 'image') {
          return '[image]';
        }
        return JSON.stringify(p);
      })
      .join('\n');
  }
  return content === undefined ? '' : JSON.stringify(content, null, 2);
}

export function toolHint(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') {
    return undefined;
  }
  const o = input as Record<string, unknown>;
  for (const key of ['description', 'command', 'file_path', 'path', 'pattern', 'url', 'query', 'prompt', 'skill']) {
    const v = o[key];
    if (typeof v === 'string' && v.trim()) {
      return oneLine(v, 140);
    }
  }
  return undefined;
}

const MAX_ARG = 2000;

/** The short top-level string fields of a tool's input; long ones (file contents, patches) are left out. */
export function shortArgs(input: unknown): Record<string, string> | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof v === 'string' && v.length <= MAX_ARG) {
      out[k] = v;
    } else if (Array.isArray(v)) {
      // Lists such as a todo list's items, as JSON.
      const json = JSON.stringify(v);
      if (json.length <= MAX_ARG * 4) {
        out[k] = json;
      }
    }
  }
  return Object.keys(out).length ? out : undefined;
}

export function truncate(text: string, max = MAX_TOOL_TEXT): string {
  return text.length > max ? text.slice(0, max) + `\n… (${text.length - max} more characters)` : text;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

/**
 * Reads one subagent log and its meta file (JSON text, if any) into the prompt it was given and the reply it sent
 * back. The reply is its SubagentHandback message, or else the text of its last message.
 */
export function parseSubagentRun(log: string, metaText?: string): SubagentRun {
  let meta: any;
  try {
    meta = metaText ? JSON.parse(metaText) : undefined;
  } catch {
    // A meta file being written, or a shape we don't know; the log alone still gives prompt and reply.
  }
  const run: SubagentRun = {};
  if (meta && typeof meta === 'object') {
    run.toolUseId = str(meta.toolUseId);
    run.agentType = str(meta.agentType);
    run.isBuiltIn = typeof meta.isBuiltIn === 'boolean' ? meta.isBuiltIn : undefined;
    run.description = str(meta.description);
  }
  let handback: string | undefined;
  let lastId: unknown;
  let lastText: string[] = [];
  for (const r of records(log)) {
    if (!r || typeof r !== 'object') {
      continue;
    }
    run.agentId ??= str(r.agentId);
    run.sessionId ??= str(r.sessionId);
    if (r.type === 'user' && run.prompt === undefined && !r.isMeta) {
      const content = r.message?.content;
      const raw =
        typeof content === 'string'
          ? content
          : Array.isArray(content) && !content.some((p) => p?.type === 'tool_result')
            ? content.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n')
            : '';
      const prompt = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
      if (prompt) {
        run.prompt = prompt;
      }
      continue;
    }
    if (r.type !== 'assistant' || !Array.isArray(r.message?.content)) {
      continue;
    }
    const texts: string[] = [];
    for (const p of r.message.content) {
      if (p?.type === 'text' && typeof p.text === 'string' && p.text.trim()) {
        texts.push(p.text);
      } else if (p?.type === 'tool_use' && p.name === 'SubagentHandback' && typeof p.input?.message === 'string') {
        handback = p.input.message;
        run.timestamp = str(r.timestamp) ?? run.timestamp;
      }
    }
    if (texts.length) {
      // One message is logged as one line per content block; keep the blocks of the last message together.
      const id = r.message.id ?? r.uuid;
      lastText = id !== undefined && id === lastId ? [...lastText, ...texts] : texts;
      lastId = id;
      if (handback === undefined) {
        run.timestamp = str(r.timestamp) ?? run.timestamp;
      }
    }
  }
  const reply = handback ?? lastText.join('\n\n');
  if (reply.trim()) {
    run.reply = reply;
  }
  return run;
}

const AGENT_ID = /\bagentId: ([\w-]+)/;
const isAgentTool = (name: string) => name === 'Agent' || name === 'Task';
type ToolUsePart = Extract<TranscriptPart, { kind: 'tool_use' }>;
/** An Agent call's result that only says the agent started in the background. */
const isAsyncLaunch = (r: any, text: string) =>
  r?.toolUseResult?.isAsync === true || r?.toolUseResult?.status === 'async_launched' || /^Async agent launched\b/.test(text);

/** Options for parseTranscript. */
export interface TranscriptOptions {
  /** The session's own id; subagent runs that answered a different session are left out. */
  sessionId?: string;
  /** The session's subagent runs, shown after the tool call that started each one. */
  subagents?: SubagentRun[];
  /**
   * The log is a subagent's own (`subagents/agent-<id>.jsonl`), whose records are all sidechain records: keep them,
   * show the main session's follow-up messages as prompts, and its SubagentHandback call as its reply.
   */
  sidechain?: boolean;
}

/** A message the main session sent a running subagent; logged in the subagent's log as a meta user record. */
const isCoordinatorMessage = (r: any) => r?.isMeta === true && r.origin?.kind === 'coordinator';

/** Builds a readable transcript of the main conversation thread, with its subagents' prompts and replies. */
export function parseTranscript(text: string, options: TranscriptOptions = {}): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  // Only runs that answered this session; a run with no session id is still tied to it by its tool call below.
  const runs = (options.subagents ?? []).filter(
    (s) => (s.prompt || s.reply) && !(options.sessionId && s.sessionId && s.sessionId !== options.sessionId),
  );
  const placed = new Set<SubagentRun>();
  /** The tool call's run, by the meta file's toolUseId or the agentId its result names. */
  const runFor = (callId: string | undefined, agentId: string | undefined) =>
    runs.find((s) => !placed.has(s) && ((callId && s.toolUseId === callId) || (agentId && !s.toolUseId && s.agentId === agentId)));
  /** A named agent's type, or undefined for a built-in one-off agent (shown as "Subagent"). */
  const agentName = (run: SubagentRun | undefined, call: ToolUsePart | undefined, fallback?: string) => {
    const type = run?.agentType ?? call?.args?.subagent_type ?? fallback;
    const builtIn = run?.isBuiltIn ?? (!type || type === 'general-purpose');
    return builtIn ? undefined : type;
  };
  const subagentEntry = (run: SubagentRun, call: ToolUsePart | undefined, ts?: string, background = false): TranscriptEntry => {
    placed.add(run);
    const entry: TranscriptEntry = {
      role: 'subagent',
      // A background run's block marks its launch; its reply is shown where it arrived.
      timestamp: background ? ts ?? run.timestamp : run.timestamp ?? ts,
      parts: run.reply && !background ? [{ kind: 'text', text: run.reply }] : [],
      subagent: {
        name: agentName(run, call),
        description: run.description ?? call?.args?.description,
        prompt: run.prompt ?? call?.args?.prompt,
        toolUseId: call?.id,
      },
    };
    if (run.agentId) {
      entry.subagent!.agentId = run.agentId;
    }
    if (background) {
      entry.subagent!.background = true;
    }
    return entry;
  };
  /** Background launches by agentId, so each hand-back can be labelled with the agent that sent it. */
  const launches = new Map<string, { entry?: TranscriptEntry; run?: SubagentRun; call?: ToolUsePart }>();
  /** Agents whose hand-back reached the main session, and the deliveries already shown. */
  const handedBack = new Set<string>();
  const shownHandbacks = new Set<string>();
  const handbackEntry = (msg: AgentMessage, ts?: string): TranscriptEntry | undefined => {
    if (shownHandbacks.has(msg.key)) {
      return undefined;
    }
    shownHandbacks.add(msg.key);
    handedBack.add(msg.from);
    const launch = msg.from ? launches.get(msg.from) : undefined;
    const run = launch?.run ?? (msg.from ? runs.find((s) => s.agentId === msg.from) : undefined);
    const subagent: NonNullable<TranscriptEntry['subagent']> = {
      name: agentName(run, launch?.call, msg.name),
      description: run?.description ?? launch?.call?.args?.description,
      handback: true,
    };
    if (launch?.call?.id) {
      subagent.toolUseId = launch.call.id;
    }
    if (run?.agentId) {
      subagent.agentId = run.agentId;
    }
    return { role: 'subagent', timestamp: ts, parts: [{ kind: 'text', text: msg.text }], subagent };
  };
  // tool_use parts by id, so results (logged later as user messages) can be attached to their call.
  const toolUses = new Map<string, Extract<TranscriptPart, { kind: 'tool_use' }>>();
  // The entry each tool call went into, for runs whose call never got a result.
  const callEntries = new Map<string, TranscriptEntry>();
  // The prompt being answered, with the requests made since it, to give each prompt its cost.
  let turn: { entry: TranscriptEntry; usage: UsageCollector; start?: number; last?: number } | undefined;
  /** Prompts queued mid-turn since the last typed prompt, so a user record repeating one shows once. */
  let queuedEntries: TranscriptEntry[] = [];
  const endTurn = () => {
    const u = turn?.usage.summary();
    if (turn && u) {
      const start = turn.start;
      turn.entry.turn = {
        cost: u.cost,
        requests: u.requests,
        outputTokens: u.tokens.output,
        durationMs: start !== undefined && turn.last !== undefined && turn.last >= start ? turn.last - start : undefined,
      };
    }
    turn = undefined;
  };

  // In a subagent's own log: its SubagentHandback calls, shown as its reply, whose "delivered" results are dropped.
  const handbackCalls = new Set<string>();

  for (const r of records(text)) {
    if (!r || typeof r !== 'object' || (r.isSidechain && !options.sidechain)) {
      continue;
    }
    if (r.type === 'assistant' && turn) {
      turn.usage.add(r, false);
      turn.last = parseTime(r.timestamp) ?? turn.last;
    }

    if (r.type === 'system' && r.subtype === 'compact_boundary') {
      entries.push({ role: 'system', timestamp: r.timestamp, parts: [{ kind: 'text', text: 'Conversation compacted' }] });
      continue;
    }

    if (r.type === 'assistant') {
      const content = r.message?.content;
      if (!Array.isArray(content)) {
        continue;
      }
      const parts: TranscriptPart[] = [];
      for (const p of content) {
        if (p?.type === 'text' && typeof p.text === 'string' && p.text.trim()) {
          parts.push({ kind: 'text', text: p.text });
        } else if (p?.type === 'thinking' && typeof p.thinking === 'string' && p.thinking.trim()) {
          parts.push({ kind: 'thinking', text: p.thinking });
        } else if (options.sidechain && p?.type === 'tool_use' && p.name === 'SubagentHandback' && typeof p.input?.message === 'string') {
          if (typeof p.id === 'string') {
            handbackCalls.add(p.id);
          }
          if (p.input.message.trim()) {
            parts.push({ kind: 'text', text: p.input.message });
          }
        } else if (p?.type === 'tool_use') {
          const part: Extract<TranscriptPart, { kind: 'tool_use' }> = {
            kind: 'tool_use',
            id: typeof p.id === 'string' ? p.id : undefined,
            name: String(p.name ?? 'tool'),
            hint: toolHint(p.input),
            input: truncate(JSON.stringify(p.input ?? {}, null, 2)),
            args: shortArgs(p.input),
            diff:
              typeof p.input?.old_string === 'string' && typeof p.input?.new_string === 'string'
                ? { before: truncate(p.input.old_string), after: truncate(p.input.new_string) }
                : undefined,
          };
          if (part.id) {
            toolUses.set(part.id, part);
          }
          parts.push(part);
        }
      }
      if (!parts.length) {
        continue;
      }
      // Claude Code writes one line per content block and one message per tool round trip;
      // merge everything Claude does between two user prompts into a single turn.
      // A subagent's reply in between starts a new one, so the conversation reads main AI, subagent, main AI.
      let target = entries[entries.length - 1];
      if (target?.role === 'assistant') {
        target.parts.push(...parts);
      } else {
        target = { role: 'assistant', timestamp: r.timestamp, parts };
        entries.push(target);
      }
      if (runs.length) {
        for (const p of parts) {
          if (p.kind === 'tool_use' && p.id) {
            callEntries.set(p.id, target);
          }
        }
      }
      continue;
    }

    if (r.type === 'attachment' || (r.type === 'user' && r.isMeta)) {
      // A subagent's reply reaching this session: shown where it arrived, between what Claude did before and after.
      const msg = parseAgentMessage(r);
      if (msg) {
        const entry = handbackEntry(msg, r.timestamp ?? r.attachment?.timestamp);
        if (entry) {
          entries.push(entry);
        }
        continue;
      }
      // A prompt typed mid-turn: shown where Claude took it in. The running turn goes on, so its cost stays with
      // the prompt that started it.
      const queued = parseQueuedPrompt(r);
      if (queued) {
        const entry: TranscriptEntry = { role: 'user', timestamp: r.timestamp ?? r.attachment?.timestamp, parts: [{ kind: 'text', text: queued }], queued: true };
        entries.push(entry);
        queuedEntries.push(entry);
        continue;
      }
    }
    if (r.type !== 'user') {
      continue;
    }
    if (r.isMeta && !(options.sidechain && isCoordinatorMessage(r))) {
      const peer = parsePeerMessage(r.message?.content);
      if (peer) {
        entries.push({ role: 'peer', timestamp: r.timestamp, parts: [{ kind: 'text', text: peer.text, from: peer.from }] });
      }
      continue;
    }
    const content = r.message?.content;
    if (Array.isArray(content) && content.some((p) => p?.type === 'tool_result')) {
      const orphans: TranscriptPart[] = [];
      const answered: TranscriptEntry[] = [];
      for (const p of content) {
        if (p?.type !== 'tool_result' || handbackCalls.has(p.tool_use_id)) {
          continue;
        }
        const full = stringifyToolContent(p.content);
        const result = { text: truncate(full), isError: !!p.is_error };
        const call = typeof p.tool_use_id === 'string' ? toolUses.get(p.tool_use_id) : undefined;
        if (call) {
          call.result = result;
        } else {
          orphans.push({ kind: 'tool_result', ...result });
        }
        // A subagent's run goes where its call returned: when it finished, or when it was launched in the background.
        const spawned = !call || isAgentTool(call.name) ? str(r.toolUseResult?.agentId) ?? AGENT_ID.exec(full)?.[1] : undefined;
        const background = !!spawned && isAsyncLaunch(r, full);
        const run = runs.length ? runFor(p.tool_use_id, spawned) : undefined;
        // A background launch whose log is missing still gets its block, from what the call says.
        const entry = run || (background && call) ? subagentEntry(run ?? {}, call, r.timestamp, background) : undefined;
        if (entry) {
          answered.push(entry);
        }
        if (background) {
          // Kept even when the run's log is missing, so its hand-back can still be labelled from the call.
          launches.set(spawned!, { entry, run, call });
        }
      }
      if (orphans.length) {
        entries.push({ role: 'tool', timestamp: r.timestamp, parts: orphans });
      }
      entries.push(...answered);
      continue;
    }

    if (r.isCompactSummary) {
      continue;
    }
    const c = classifyUserContent(content);
    if (c.kind === 'noise') {
      continue;
    }
    // A prompt already shown where it was queued mid-turn is not shown again, but it still starts the turn it opens.
    const repeated = c.kind === 'prompt' ? queuedEntries.find((e) => e.parts[0]?.kind === 'text' && e.parts[0].text === c.text) : undefined;
    queuedEntries = [];
    const entry: TranscriptEntry = repeated ?? { role: 'user', timestamp: r.timestamp, parts: [{ kind: 'text', text: c.text }] };
    if (!repeated) {
      entries.push(entry);
    }
    endTurn();
    turn = { entry, usage: new UsageCollector(), start: parseTime(r.timestamp) };
  }
  endTurn();
  // A call whose result was never logged (interrupted): its run goes right after the call.
  for (const [id, entry] of callEntries) {
    const run = runFor(id, undefined);
    if (run) {
      let at = entries.indexOf(entry) + 1;
      // Past the other runs started from the same turn, but not past a reply that arrived later.
      while (entries[at]?.role === 'subagent' && !entries[at].subagent?.handback) {
        at++;
      }
      entries.splice(at, 0, subagentEntry(run, toolUses.get(id)));
    }
  }
  // A background run whose reply never reached this session (it ended first): show the reply from its log at the launch.
  for (const [agentId, { entry, run }] of launches) {
    if (entry && run?.reply && !handedBack.has(agentId)) {
      entry.parts = [{ kind: 'text', text: run.reply }];
      if (run.timestamp) {
        entry.timestamp = run.timestamp;
      }
    }
  }
  return entries;
}

/** Best-effort decode of a project folder name ("C--Users-me-repo") back to a path, for sessions without a cwd. */
export function decodeProjectDir(name: string): string {
  const win = /^([A-Za-z])--(.*)$/.exec(name);
  if (win) {
    return `${win[1]}:\\${win[2].replace(/-/g, '\\')}`;
  }
  return name.replace(/-/g, '/');
}
