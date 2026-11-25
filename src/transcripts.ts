// Reads any session's log as transcript entries, with the parser for its source.
// No VS Code imports here so it can be unit-tested with plain Node.

import { parseCopilotTranscript } from './copilotCliParser';
import { parseTranscript, SessionInfo, SubagentRun, TranscriptEntry } from './sessionParser';
import { sourceOf } from './sources';
import { parseChatTranscript } from './vscodeChatParser';

/** `subagents`: a Claude Code session's subagent runs (readSubagentRuns), shown where each was started. */
export function parseTranscriptFor(session: SessionInfo, text: string, subagents: SubagentRun[] = []): TranscriptEntry[] {
  switch (sourceOf(session)) {
    case 'copilot-cli':
      return parseCopilotTranscript(text);
    case 'vscode-chat':
      return parseChatTranscript(text);
    default:
      return parseTranscript(text, { sessionId: session.id, subagents });
  }
}
