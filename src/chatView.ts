// The in-view chat's pending messages, drawn below the logged transcript until the log catches up with them.
// No VS Code imports here, so it can be unit-tested with plain Node.

import { ChatStatus, LivePiece, PERMISSION_MODES, PermissionMode, PermissionPiece } from './claudeChat';
import { escapeHtml, formatUsd } from './format';
import { renderMarkdown } from './markdown';

const CLAUDE_MARK = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><g stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 3.5v17M3.5 12h17M6 6l12 12M18 6L6 18"/></g></svg>`;

/** The permission modes as the chat's picker shows them. */
export const MODE_LABELS: Record<PermissionMode, { label: string; title: string }> = {
  ask: { label: 'Ask me', title: 'Edits and commands that need approval show a card here, to allow or deny.' },
  acceptEdits: { label: 'Accept edits', title: 'File edits and file-system commands in the session folder run without asking; anything else asks you here.' },
  plan: { label: 'Plan', title: 'Claude only plans, then asks you here to approve the plan.' },
  auto: { label: 'Auto', title: "Claude Code's own classifier decides what runs; nothing is asked." },
  deny: { label: 'Decline prompts', title: 'Anything that needs approval is declined without asking, and Claude carries on without it.' },
};

export const chatModes = () => PERMISSION_MODES.map((id) => ({ id, ...MODE_LABELS[id] }));

const TOOL_STATUS: Record<'running' | 'ok' | 'failed' | 'denied', { icon: string; title: string; cls: string }> = {
  running: { icon: 'loading codicon-modifier-spin', title: 'Running', cls: 'pending' },
  ok: { icon: 'check', title: 'Succeeded', cls: 'ok' },
  failed: { icon: 'error', title: 'Failed', cls: 'error' },
  denied: { icon: 'circle-slash', title: 'Declined', cls: 'error' },
};

/** How many lines of a command, a file or a diff a card shows before it says how many more there are. */
const CARD_LINES = 12;

function clip(text: string, max = CARD_LINES): string {
  const lines = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  return lines.length > max ? `${lines.slice(0, max).join('\n')}\n… ${lines.length - max} more line${lines.length - max === 1 ? '' : 's'}` : lines.join('\n');
}

const strOf = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const lineCount = (s: string) => (s ? s.replace(/\n$/, '').split('\n').length : 0);
const pre = (text: string, cls = '') => `<pre class="perm-pre${cls ? ` ${cls}` : ''}">${escapeHtml(text)}</pre>`;
const pathRow = (p: string) => `<div class="perm-path"><i class="codicon codicon-file"></i><span>${escapeHtml(p)}</span></div>`;

/** A diff of one edit, as - and + lines, clipped. */
function editDiff(oldText: string, newText: string): string {
  const minus = oldText ? oldText.replace(/\n$/, '').split('\n').map((l) => `- ${l}`) : [];
  const plus = newText ? newText.replace(/\n$/, '').split('\n').map((l) => `+ ${l}`) : [];
  return clip([...minus, ...plus].join('\n'), CARD_LINES * 2);
}

/** What a permission card shows of the call: the command, the file and a preview of its content or diff, or the input. */
export function permissionDetail(toolName: string, input: Record<string, unknown>): string {
  const file = strOf(input.file_path) ?? strOf(input.notebook_path) ?? strOf(input.path);
  switch (toolName) {
    case 'Bash':
    case 'PowerShell': {
      const command = strOf(input.command);
      if (command !== undefined) {
        return pre(clip(command));
      }
      break;
    }
    case 'Write': {
      const content = strOf(input.content) ?? '';
      if (file) {
        return `${pathRow(file)}<div class="perm-sub">Writes ${lineCount(content)} line${lineCount(content) === 1 ? '' : 's'}</div>${content ? pre(clip(content)) : ''}`;
      }
      break;
    }
    case 'Edit': {
      const oldText = strOf(input.old_string) ?? '';
      const newText = strOf(input.new_string) ?? '';
      if (file) {
        const all = input.replace_all === true ? ', every occurrence' : '';
        return `${pathRow(file)}<div class="perm-sub">−${lineCount(oldText)} +${lineCount(newText)} lines${all}</div>${pre(editDiff(oldText, newText), 'diff')}`;
      }
      break;
    }
    case 'MultiEdit': {
      const edits = Array.isArray(input.edits) ? input.edits : [];
      if (file) {
        const diff = edits
          .map((e) => (e && typeof e === 'object' ? editDiff(strOf((e as Record<string, unknown>).old_string) ?? '', strOf((e as Record<string, unknown>).new_string) ?? '') : ''))
          .filter(Boolean)
          .join('\n…\n');
        return `${pathRow(file)}<div class="perm-sub">${edits.length} edit${edits.length === 1 ? '' : 's'}</div>${diff ? pre(clip(diff, CARD_LINES * 2), 'diff') : ''}`;
      }
      break;
    }
    case 'WebFetch':
    case 'WebSearch': {
      const target = strOf(input.url) ?? strOf(input.query);
      if (target) {
        return pre(target);
      }
      break;
    }
  }
  if (file && Object.keys(input).length === 1) {
    return pathRow(file);
  }
  let json = '';
  try {
    json = JSON.stringify(input, null, 2);
  } catch {
    // Not representable: the tool name and description have to do.
  }
  return json && json !== '{}' ? pre(clip(json)) : '';
}

/** A permission card: what Claude wants to run, with Allow and Deny while it is the one waiting (`active`). */
function renderPermission(p: PermissionPiece, active: boolean): string {
  const plan = p.toolName === 'ExitPlanMode';
  const head = plan
    ? '<i class="codicon codicon-checklist"></i><span>Claude has a plan and asks to start on it</span>'
    : `<i class="codicon codicon-shield"></i><span>Claude wants to use <strong>${escapeHtml(p.toolName)}</strong></span>`;
  const desc = p.description && !plan ? `<div class="perm-desc">${escapeHtml(p.description)}</div>` : '';
  const blocked = p.blockedPath ? `<div class="perm-sub">Outside the folders it may use: ${escapeHtml(p.blockedPath)}</div>` : '';
  const planText = strOf(p.input.plan);
  const body = plan ? (planText ? `<div class="perm-plan md">${renderMarkdown(planText, 'assistant')}</div>` : '') : permissionDetail(p.toolName, p.input);
  const rid = escapeHtml(p.requestId);
  let foot: string;
  if (p.state === 'pending') {
    foot = active
      ? `<div class="perm-actions"><button class="btn primary" data-perm="allow" data-request="${rid}" title="${plan ? 'Approve the plan: Claude starts on it' : 'Let it run this once'}"><i class="codicon codicon-check"></i><span>${plan ? 'Approve plan' : 'Allow'}</span></button><button class="btn" data-perm="deny" data-request="${rid}" title="${plan ? 'Keep planning: Claude waits for your feedback' : 'Decline it: Claude carries on without it'}"><i class="codicon codicon-close"></i><span>${plan ? 'Keep planning' : 'Deny'}</span></button></div>`
      : '<div class="perm-outcome waiting"><i class="codicon codicon-history"></i><span>Waiting: answer the request above first.</span></div>';
  } else if (p.state === 'allowed') {
    foot = `<div class="perm-outcome allowed"><i class="codicon codicon-check"></i><span>${plan ? 'Plan approved' : 'Allowed'}</span></div>`;
  } else {
    foot = `<div class="perm-outcome denied"><i class="codicon codicon-circle-slash"></i><span>${plan ? 'Plan not approved' : 'Denied'}${p.why ? `. ${escapeHtml(p.why)}` : ''}</span></div>`;
  }
  return `<div class="chat-permission ${p.state}${active ? ' active' : ''}" data-request="${rid}" role="group" aria-label="${plan ? 'Plan approval' : `Permission for ${escapeHtml(p.toolName)}`}"><div class="perm-head">${head}</div>${desc}${blocked}${body}${foot}</div>`;
}

function renderPiece(p: LivePiece, activeRequest?: string): string {
  switch (p.kind) {
    case 'text':
      return p.text ? `<div class="md">${renderMarkdown(p.text, 'assistant')}</div>` : '';
    case 'thinking':
      return p.streaming ? '<div class="chat-thinking"><i class="codicon codicon-lightbulb"></i>Thinking…</div>' : '';
    case 'tool': {
      const s = TOOL_STATUS[p.status];
      return `<div class="chat-tool${p.status === 'denied' ? ' denied' : ''}"><i class="codicon codicon-tools tool-icon"></i><span class="tool-name">${escapeHtml(p.name)}</span><span class="tool-hint">${escapeHtml(p.hint ?? '')}</span><i class="codicon codicon-${s.icon} status ${s.cls}" title="${s.title}"></i></div>`;
    }
    case 'notice':
      return `<div class="chat-notice ${p.tone}" role="${p.tone === 'error' ? 'alert' : 'status'}"><i class="codicon codicon-${p.tone === 'error' ? 'error' : 'info'}"></i><span>${escapeHtml(p.text)}</span></div>`;
    case 'permission':
      return renderPermission(p, p.requestId === activeRequest);
    default:
      return '';
  }
}

/**
 * The pending part of the conversation: the user's messages (marked queued while they wait), then Claude's reply as it
 * streams in, with what the log will not show (declined tools, errors). While Claude has said nothing yet, a typing
 * indicator.
 */
export function renderLive(pieces: LivePiece[], busy: boolean): string {
  const out: string[] = [];
  let reply: string[] = [];
  // Requests are answered in order: only the oldest open card has its buttons.
  const active = pieces.find((p): p is PermissionPiece => p.kind === 'permission' && p.state === 'pending')?.requestId;
  const flush = () => {
    const body = reply.filter(Boolean).join('');
    if (body) {
      out.push(
        `<div class="msg assistant chat-pending"><div class="avatar claude-avatar">${CLAUDE_MARK}</div><div class="msg-main"><div class="msg-meta"><strong>Claude</strong></div>${body}</div></div>`,
      );
    }
    reply = [];
  };
  for (const p of pieces) {
    if (p.kind === 'user') {
      flush();
      const pill = p.queued
        ? '<span class="pill" title="Sent after the running turn ends"><i class="codicon codicon-history"></i>queued</span>'
        : '';
      out.push(`<div class="msg user chat-pending"><div class="msg-meta">${pill}You</div><div class="bubble"><div class="md">${renderMarkdown(p.text, 'user')}</div></div></div>`);
    } else {
      reply.push(renderPiece(p, active));
    }
  }
  // Waiting for the first word: nothing of the reply shows yet.
  if (busy && !pieces.some((p) => p.kind !== 'user' && p.kind !== 'notice' && renderPiece(p))) {
    reply.push('<div class="chat-typing" aria-label="Claude is working"><span></span><span></span><span></span></div>');
  }
  flush();
  return out.join('');
}

/** The chat bar's state, as the page gets it. */
export function chatStateMessage(status: ChatStatus | undefined, mode: PermissionMode) {
  const t = status?.lastTurn;
  const last = t
    ? t.interrupted
      ? 'Last turn stopped'
      : t.error
        ? 'Last turn failed'
        : `Last turn ${t.cost !== undefined ? formatUsd(t.cost) : ''}${t.durationMs !== undefined ? `${t.cost !== undefined ? ' · ' : ''}${(t.durationMs / 1000).toFixed(1)}s` : ''}`.trim()
    : '';
  return {
    type: 'chatState' as const,
    running: !!status?.running,
    busy: !!status?.busy,
    queued: status?.queued ?? 0,
    awaiting: status?.awaiting ?? 0,
    finishing: !!status?.finishing,
    mode: status?.mode ?? mode,
    last,
  };
}
