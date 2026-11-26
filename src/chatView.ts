// The in-view chat's pending messages, drawn below the logged transcript until the log catches up with them.
// No VS Code imports here, so it can be unit-tested with plain Node.

import { ChatStatus, LivePiece, PERMISSION_MODES, PermissionMode } from './claudeChat';
import { escapeHtml, formatUsd } from './format';
import { renderMarkdown } from './markdown';

const CLAUDE_MARK = `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><g stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 3.5v17M3.5 12h17M6 6l12 12M18 6L6 18"/></g></svg>`;

/** The permission modes as the chat's picker shows them. */
export const MODE_LABELS: Record<PermissionMode, { label: string; title: string }> = {
  default: { label: 'Ask first', title: 'Edits and commands need approval. Approving from this chat is not available yet, so they are declined.' },
  acceptEdits: { label: 'Accept edits', title: 'File edits and file-system commands in the session folder run without asking; anything else is declined.' },
  plan: { label: 'Plan', title: 'Claude only plans. Approving the plan from this chat is not available yet, so it is declined.' },
  auto: { label: 'Auto', title: "Claude Code's own classifier decides what runs; nothing is asked." },
};

export const chatModes = () => PERMISSION_MODES.map((id) => ({ id, ...MODE_LABELS[id] }));

const TOOL_STATUS: Record<'running' | 'ok' | 'failed' | 'denied', { icon: string; title: string; cls: string }> = {
  running: { icon: 'loading codicon-modifier-spin', title: 'Running', cls: 'pending' },
  ok: { icon: 'check', title: 'Succeeded', cls: 'ok' },
  failed: { icon: 'error', title: 'Failed', cls: 'error' },
  denied: { icon: 'circle-slash', title: 'Declined: needs approval', cls: 'error' },
};

function renderPiece(p: LivePiece): string {
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
      reply.push(renderPiece(p));
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
    mode: status?.mode ?? mode,
    last,
  };
}
