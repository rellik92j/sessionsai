// A stand-in for `claude -p --resume <id> --input-format stream-json --output-format stream-json …`, for the end-to-end
// harness (docs/dev/e2e.md). It never calls a model: each user turn plays a fixed script, chosen by a word in the
// message, with the stdout events and session-log records Claude Code writes (docs/dev/claude-stream-json.md). The
// record shapes are real; every text, id and path is synthetic.
//
// The extension starts it only when SESSIONSAI_E2E_CLAUDE names this file. It writes what happened to it (start,
// each turn's end, an interrupt, an answer to a permission request, stdin closing, exit) to the JSON-lines file named
// by SESSIONSAI_E2E_EVENTS, which the harness reads to check what the process saw.
//
// Scripts, picked by the first matching word in the user's message:
//   "permission"  a Bash call that asks for permission (can_use_tool); the reply depends on Allow or Deny, and with
//                 "slowly" in the message as well, it goes on for REPLY_LINES more lines after the answer
//   anything else a slow reply: REPLY_LINES lines, one every LINE_MS
// "lingering" in a message (either script) makes the process wait LINGER_MS after its last turn ends and stdin has
// closed, before it exits: a window in which the reply is over but the process is still there.
// An interrupt control request stops either script where it is, as Claude Code does.

import { appendFileSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const REPLY_LINES = 12;
const LINE_MS = 450;
// Under the extension's 3 s grace for a process whose stdin has closed, after which it kills the process.
const LINGER_MS = 2500;
const MODEL = 'claude-stand-in';
const VERSION = '2.1.332';

const args = process.argv.slice(2);
const sessionId = args[args.indexOf('--resume') + 1];
const permissionMode = args.includes('--permission-mode') ? args[args.indexOf('--permission-mode') + 1] : 'default';
const eventsFile = process.env.SESSIONSAI_E2E_EVENTS;

function note(event, extra = {}) {
  if (eventsFile) {
    appendFileSync(eventsFile, JSON.stringify({ t: Date.now(), pid: process.pid, session: sessionId, event, ...extra }) + '\n');
  }
}

/** The session's log: <CLAUDE_CONFIG_DIR>/projects/<any folder>/<id>.jsonl. */
function findLog() {
  const projects = path.join(process.env.CLAUDE_CONFIG_DIR ?? '', 'projects');
  for (const dir of existsSync(projects) ? readdirSync(projects) : []) {
    const file = path.join(projects, dir, `${sessionId}.jsonl`);
    if (existsSync(file)) {
      return file;
    }
  }
  return undefined;
}

const logFile = findLog();
if (!sessionId || !args.includes('-p') || !logFile) {
  process.stderr.write(`stand-in claude: no session ${sessionId} under CLAUDE_CONFIG_DIR, or not started with -p\n`);
  note('refused', { args });
  process.exit(1);
}

let lastUuid = (() => {
  const lines = readFileSync(logFile, 'utf8').split('\n').filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const r = JSON.parse(lines[i]);
      if (r.uuid) return r.uuid;
    } catch {
      // A torn line: keep looking.
    }
  }
  return null;
})();
const cwd = process.cwd();

const out = (ev) => process.stdout.write(JSON.stringify(ev) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

/** Appends one record to the session log, parented on the last one, and returns its uuid. */
function logRecord(rec) {
  const uuid = randomUUID();
  const full = {
    parentUuid: lastUuid,
    isSidechain: false,
    ...rec,
    uuid,
    timestamp: now(),
    userType: 'external',
    entrypoint: 'sdk-cli',
    cwd,
    sessionId,
    version: VERSION,
  };
  appendFileSync(logFile, JSON.stringify(full) + '\n');
  lastUuid = uuid;
  return uuid;
}

function assistantMessage(id, content, stopReason) {
  return { model: MODEL, id, type: 'message', role: 'assistant', content, stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: 3, output_tokens: 20 } };
}

/** Logs a finished assistant block and emits its `assistant` event with the same uuid. */
function finishBlock(messageId, block, stopReason) {
  const message = assistantMessage(messageId, [block], stopReason);
  const uuid = logRecord({ type: 'assistant', message, requestId: `req_${messageId}` });
  out({ type: 'assistant', message, parent_tool_use_id: null, session_id: sessionId, uuid, timestamp: now() });
}

function stream(event, messageId) {
  out({ type: 'stream_event', event, session_id: sessionId, parent_tool_use_id: null, uuid: randomUUID(), api_message_id: messageId });
}

let turnSeq = 0;
/** The running turn's interrupt flag and the permission answer it waits for. */
let turn;

function result(started, ok) {
  const durationMs = Date.now() - started;
  out(
    ok
      ? {
          type: 'result',
          subtype: 'success',
          is_error: false,
          num_turns: 1,
          stop_reason: 'end_turn',
          terminal_reason: 'completed',
          result: 'done',
          session_id: sessionId,
          duration_ms: durationMs,
          total_cost_usd: 0.5,
          model_usage_since_last_result: { [MODEL]: { inputTokens: 3, outputTokens: 20, costUSD: 0.0012 } },
          permission_denials: [],
        }
      : {
          type: 'result',
          subtype: 'error_during_execution',
          is_error: true,
          num_turns: 1,
          stop_reason: null,
          terminal_reason: 'aborted_streaming',
          session_id: sessionId,
          duration_ms: durationMs,
          total_cost_usd: 0.5,
          permission_denials: [],
          errors: ['[ede_diagnostic] result_type=user last_content_type=text stop_reason=null'],
          model_usage_since_last_result: { [MODEL]: { inputTokens: 3, outputTokens: 8, costUSD: 0.0004 } },
        },
  );
}

/** Streams `lines` as one text block; returns the text sent, and whether it was cut short by an interrupt. */
async function streamText(messageId, index, lines) {
  stream({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } }, messageId);
  let text = '';
  for (const line of lines) {
    if (turn.interrupted) {
      break;
    }
    const chunk = (text ? '\n\n' : '') + line;
    text += chunk;
    stream({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: chunk } }, messageId);
    await sleep(LINE_MS);
  }
  return { text, cut: turn.interrupted };
}

function interrupted(started, messageId, partial) {
  if (partial) {
    finishBlock(messageId, { type: 'text', text: partial }, null);
  }
  const content = [{ type: 'text', text: '[Request interrupted by user]' }];
  const uuid = logRecord({ type: 'user', message: { role: 'user', content } });
  out({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: sessionId, uuid, timestamp: now() });
  result(started, false);
  note('turn-end', { how: 'interrupted' });
}

async function slowReply(started, n) {
  const messageId = `msg_e2e_${n}a`;
  stream({ type: 'message_start', message: { id: messageId, role: 'assistant', model: MODEL, content: [] } }, messageId);
  const lines = Array.from({ length: REPLY_LINES }, (_, i) => (i === REPLY_LINES - 1 ? `Line ${i + 1} of the stand-in reply. Done.` : `Line ${i + 1} of the stand-in reply.`));
  const { text, cut } = await streamText(messageId, 0, lines);
  if (cut) {
    return interrupted(started, messageId, text);
  }
  finishBlock(messageId, { type: 'text', text }, 'end_turn');
  stream({ type: 'content_block_stop', index: 0 }, messageId);
  stream({ type: 'message_stop' }, messageId);
  result(started, true);
  note('turn-end', { how: 'completed' });
}

async function permissionReply(started, n, slowly) {
  const messageId = `msg_e2e_${n}a`;
  const toolUseId = `toolu_e2e_${n}`;
  const requestId = `req-e2e-${n}`;
  const input = { command: 'echo stand-in', description: 'Print a word' };
  stream({ type: 'message_start', message: { id: messageId, role: 'assistant', model: MODEL, content: [] } }, messageId);
  stream({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: toolUseId, name: 'Bash', input: {} } }, messageId);
  finishBlock(messageId, { type: 'tool_use', id: toolUseId, name: 'Bash', input }, 'tool_use');
  stream({ type: 'content_block_stop', index: 0 }, messageId);
  stream({ type: 'message_stop' }, messageId);
  const answer = new Promise((resolve) => (turn.answer = { requestId, resolve }));
  out({
    type: 'control_request',
    request_id: requestId,
    request: { subtype: 'can_use_tool', tool_name: 'Bash', display_name: 'Bash', input, description: input.description, tool_use_id: toolUseId, permission_suggestions: [] },
  });
  note('permission-asked', { requestId });
  const response = await answer;
  turn.answer = undefined;
  if (!response) {
    return interrupted(started, messageId, '');
  }
  const allowed = response.behavior === 'allow';
  note('permission-answered', { behavior: response.behavior, message: response.message });
  const toolResult = allowed
    ? { type: 'tool_result', tool_use_id: toolUseId, content: 'stand-in\n', is_error: false }
    : { type: 'tool_result', tool_use_id: toolUseId, content: String(response.message ?? 'Denied.'), is_error: true };
  const uuid = logRecord({ type: 'user', message: { role: 'user', content: [toolResult] }, sourceToolAssistantUUID: lastUuid });
  out({ type: 'user', message: { role: 'user', content: [toolResult] }, parent_tool_use_id: null, session_id: sessionId, uuid, timestamp: now() });
  const second = `msg_e2e_${n}b`;
  stream({ type: 'message_start', message: { id: second, role: 'assistant', model: MODEL, content: [] } }, second);
  const lines = allowed ? ['The command ran', 'and printed the word stand-in.'] : ['The command was declined,', 'so I am carrying on without it.'];
  if (slowly) {
    // Long enough after the answer for a scenario to act while the reply is still going.
    lines.push(...Array.from({ length: REPLY_LINES }, (_, i) => `Afterthought ${i + 1} of the stand-in reply.`));
  }
  const { text, cut } = await streamText(second, 0, lines);
  if (cut) {
    return interrupted(started, second, text);
  }
  finishBlock(second, { type: 'text', text }, 'end_turn');
  stream({ type: 'content_block_stop', index: 0 }, second);
  stream({ type: 'message_stop' }, second);
  result(started, true);
  note('turn-end', { how: 'completed' });
}

async function runTurn(text) {
  const n = ++turnSeq;
  const started = Date.now();
  turn = { interrupted: false };
  note('turn-start', { text });
  if (/lingering/i.test(text)) {
    lingering = true;
  }
  out({ type: 'system', subtype: 'init', session_id: sessionId, model: MODEL, permissionMode, tools: ['Bash', 'Edit', 'Read', 'Write'], claude_code_version: VERSION, cwd });
  const uuid = logRecord({ type: 'user', message: { role: 'user', content: text }, promptId: randomUUID(), permissionMode, origin: { kind: 'human' } });
  await sleep(150);
  out({ type: 'user', message: { role: 'user', content: text }, session_id: sessionId, parent_tool_use_id: null, uuid, timestamp: now(), isReplay: true });
  if (/permission/i.test(text)) {
    await permissionReply(started, n, /slowly/i.test(text));
  } else {
    await slowReply(started, n);
  }
  turn = undefined;
}

/** Set by a message with "lingering" in it: once stdin has closed and the last turn has ended, exit is held back. */
let lingering = false;

// ---------- stdin ----------

const queue = [];
let busy = false;
let stdinClosed = false;

async function pump() {
  if (busy) {
    return;
  }
  busy = true;
  while (queue.length) {
    await runTurn(queue.shift());
  }
  busy = false;
  if (stdinClosed) {
    if (lingering) {
      await sleep(LINGER_MS);
    }
    note('exit', { code: 0 });
    process.exit(0);
  }
}

function onLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    process.stderr.write(`stand-in claude: not JSON on stdin: ${line.slice(0, 80)}\n`);
    return;
  }
  if (msg.type === 'user') {
    const c = msg.message?.content;
    queue.push(typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => b?.text ?? '').join('') : '');
    void pump();
  } else if (msg.type === 'control_request' && msg.request?.subtype === 'interrupt') {
    note('interrupt');
    out({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { still_queued: [] } } });
    if (turn) {
      turn.interrupted = true;
      turn.answer?.resolve(undefined);
    }
  } else if (msg.type === 'control_response') {
    const r = msg.response;
    if (turn?.answer && r?.request_id === turn.answer.requestId) {
      turn.answer.resolve(r.response ?? {});
    }
  }
}

note('start', { args });
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) onLine(line);
  }
});
process.stdin.on('end', () => {
  // Closing stdin does not interrupt: the running turn and any queued ones finish, then the process exits.
  stdinClosed = true;
  note('stdin-end');
  if (!busy) {
    void (lingering ? sleep(LINGER_MS) : Promise.resolve()).then(() => {
      note('exit', { code: 0 });
      process.exit(0);
    });
  }
});
