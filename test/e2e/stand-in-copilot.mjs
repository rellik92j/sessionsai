// A stand-in for one Copilot CLI turn, `copilot --resume=<id> --output-format json --stream on [allowances]` with the
// message on stdin, for the end-to-end harness (docs/dev/e2e.md). It never calls a model: the message picks a fixed
// script, which writes the JSON lines Copilot CLI writes to stdout and appends the same records (same ids) to the
// session's events.jsonl, as Copilot CLI does. The record shapes are real (test/fixtures/copilot-stream/); every text,
// id and path is synthetic.
//
// The extension starts it only when SESSIONSAI_E2E_COPILOT names this file. It notes what happened to it in the
// JSON-lines file named by SESSIONSAI_E2E_EVENTS: `start` (with its pid and arguments), `turn-start` (with the message
// exactly as it came on stdin), `tool` (a call and whether it was allowed), `turn-end`, `exit`. Stop kills the process,
// so a stopped turn has no `turn-end` and no `exit`; its pid is gone.
//
// Scripts, picked by a word in the message:
//   "edit"         an apply_patch call: it runs when the arguments allow writes (--allow-tool=write or
//                  --allow-all-tools), and is declined otherwise, as Copilot CLI declines what it cannot ask about;
//                  then the slow reply
//   anything else  a slow reply: REPLY_LINES lines, one every LINE_MS

import { appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const REPLY_LINES = 12;
const LINE_MS = 450;
const MODEL = 'copilot-stand-in';

const args = process.argv.slice(2);
const sessionId = (args.find((a) => a.startsWith('--resume=')) ?? '').slice('--resume='.length);
const eventsFile = process.env.SESSIONSAI_E2E_EVENTS;
const logFile = path.join(process.env.COPILOT_HOME ?? '', 'session-state', sessionId, 'events.jsonl');
const writesAllowed = args.includes('--allow-all-tools') || args.includes('--allow-tool=write');

function note(event, extra = {}) {
  if (eventsFile) {
    appendFileSync(eventsFile, JSON.stringify({ t: Date.now(), pid: process.pid, session: sessionId, event, ...extra }) + '\n');
  }
}

note('start', { args });
if (!sessionId || !existsSync(logFile) || !args.includes('--output-format')) {
  process.stdout.write(`Error: No session, task, or name matched '${sessionId}'.\n`);
  note('refused', { args });
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastId = null;

/** One record: to stdout, and to the log unless it is ephemeral (deltas and the like). */
function emit(type, data, { ephemeral = false } = {}) {
  const id = randomUUID();
  const rec = { type, data, ...(ephemeral ? { ephemeral: true } : {}), id, timestamp: new Date().toISOString(), parentId: lastId };
  if (!ephemeral) {
    appendFileSync(logFile, JSON.stringify(rec) + '\n');
    lastId = id;
  }
  process.stdout.write(JSON.stringify(rec) + '\n');
  return id;
}

async function slowReply(turnId, interactionId, originatingMessageId) {
  const messageId = randomUUID();
  emit('assistant.message_start', { messageId, phase: 'final_answer' }, { ephemeral: true });
  const lines = Array.from({ length: REPLY_LINES }, (_, i) => (i === REPLY_LINES - 1 ? `Line ${i + 1} of the stand-in reply. Done.` : `Line ${i + 1} of the stand-in reply.`));
  let text = '';
  for (const line of lines) {
    const chunk = (text ? '\n\n' : '') + line;
    text += chunk;
    emit('assistant.message_delta', { messageId, deltaContent: chunk }, { ephemeral: true });
    await sleep(LINE_MS);
  }
  emit('assistant.message', { messageId, originatingMessageId, model: MODEL, providerId: 'copilot', content: text, toolRequests: [], interactionId, turnId, phase: 'final_answer' });
}

function editCall(turnId, interactionId, originatingMessageId) {
  const toolCallId = `custom_call_${randomUUID().slice(0, 8)}`;
  const patch = '*** Begin Patch\n*** Add File: stand-in.txt\n+hi\n*** End Patch\n';
  emit('assistant.message', {
    messageId: randomUUID(),
    originatingMessageId,
    model: MODEL,
    providerId: 'copilot',
    content: '',
    toolRequests: [{ toolCallId, name: 'apply_patch', arguments: patch, type: 'custom', toolTitle: 'Applying patch' }],
    interactionId,
    turnId,
  });
  emit('tool.execution_start', { toolCallId, toolName: 'apply_patch', arguments: patch, turnId, model: MODEL, toolTitle: 'Applying patch' });
  emit(
    'tool.execution_complete',
    writesAllowed
      ? { toolCallId, model: MODEL, interactionId, turnId, success: true, result: { content: 'Added 1 file(s): stand-in.txt', detailedContent: 'Added 1 file(s): stand-in.txt' } }
      : {
          toolCallId,
          model: MODEL,
          interactionId,
          turnId,
          success: false,
          error: {
            message: 'Permission denied because no interactive user response was available. Retry in an interactive session so the user can approve it, or try an alternative that does not require this permission.',
            code: 'denied',
          },
        },
  );
  note('tool', { name: 'apply_patch', allowed: writesAllowed });
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', async () => {
  note('turn-start', { text: input });
  const interactionId = randomUUID();
  emit('session.resume', { resumeTime: new Date().toISOString(), context: { cwd: process.cwd() }, alreadyInUse: false, sessionWasActive: false });
  const messageId = randomUUID();
  emit('user.message', { content: input, transformedContent: input, messageId, delivery: 'idle', interactionId, turnId: '0' });
  emit('assistant.turn_start', { turnId: '0', interactionId, agentMode: 'interactive' });
  if (/\bedit\b/i.test(input)) {
    editCall('0', interactionId, messageId);
  }
  await slowReply('0', interactionId, messageId);
  emit('assistant.turn_end', { turnId: '0' });
  emit('assistant.idle', {}, { ephemeral: true });
  process.stdout.write(JSON.stringify({ type: 'result', timestamp: new Date().toISOString(), sessionId, exitCode: 0, usage: { premiumRequests: 1 } }) + '\n');
  note('turn-end', { how: 'completed' });
  emit('session.shutdown', { shutdownType: 'routine' });
  note('exit');
  process.exit(0);
});
