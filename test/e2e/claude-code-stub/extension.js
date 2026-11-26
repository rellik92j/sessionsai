// Stands in for the Claude Code extension (anthropic.claude-code) in the end-to-end harness, so SessionsAI offers
// "Open in Claude Code Chat" there. Its one command, which SessionsAI runs to open a session in the Claude Code chat,
// only appends a `claude-code-open` line to the events file (SESSIONSAI_E2E_EVENTS). It opens nothing.

const { appendFileSync } = require('node:fs');
const vscode = require('vscode');

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('claude-vscode.editor.open', (sessionId, prompt) => {
      const file = process.env.SESSIONSAI_E2E_EVENTS;
      if (file) {
        appendFileSync(file, JSON.stringify({ t: Date.now(), event: 'claude-code-open', session: sessionId ?? null, prompt: prompt ?? null }) + '\n');
      }
    }),
  );
}

module.exports = { activate };
