import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Claude Code subagents a session can be started as (`claude --agent <name>`). They are Markdown files with YAML
 * frontmatter, in `<project>/.claude/agents/` (often gitignored, so the folder is read, not git) and in the user's
 * `~/.claude/agents/`. Plugin agents are not listed.
 */
export interface AgentInfo {
  /** The frontmatter `name:`, which is what `--agent` takes; not the file name. */
  name: string;
  description?: string;
  scope: 'project' | 'user';
  filePath: string;
}

/** What a new Claude Code or Copilot CLI session is launched with; undefined fields keep the tool's own settings. */
export interface Overrides {
  model?: string;
  effort?: string;
  /** Claude Code only. */
  agent?: string;
}

/**
 * The `name` and `description` from an agent file's frontmatter, or undefined when the file has no frontmatter block.
 * This reads the flat `key: value` subset of YAML agent files use: plain, quoted and block (`|`, `>`) scalars, with
 * indented continuation lines. Anything else (lists, nested maps, comments) is skipped, never thrown on.
 */
export function parseAgentFrontmatter(text: string): { name?: string; description?: string } | undefined {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') {
    return undefined;
  }
  const end = lines.findIndex((l, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(l));
  if (end < 0) {
    return undefined;
  }
  const fields: Record<string, string> = {};
  const body = lines.slice(1, end);
  for (let i = 0; i < body.length; i++) {
    const m = /^([A-Za-z_][\w-]*)[ \t]*:(?:[ \t]+(.*)|[ \t]*)$/.exec(body[i]);
    if (!m) {
      continue;
    }
    // Indented (or blank) lines after a key belong to its value.
    const more: string[] = [];
    while (i + 1 < body.length && (/^[ \t]/.test(body[i + 1]) || !body[i + 1].trim())) {
      more.push(body[++i].trim());
    }
    const value = scalar((m[2] ?? '').trim(), more);
    if (value !== undefined) {
      fields[m[1]] = value;
    }
  }
  const name = fields.name?.trim();
  const description = fields.description?.replace(/\s+/g, ' ').trim();
  return { name: name || undefined, description: description || undefined };
}

function scalar(first: string, more: string[]): string | undefined {
  if (/^[|>][+-]?\d*$/.test(first)) {
    return more.join(first.startsWith('|') ? '\n' : ' ').trim();
  }
  const whole = [first, ...more].filter(Boolean).join(' ');
  if (first.startsWith('"')) {
    const closed = /^"((?:[^"\\]|\\.)*)"/.exec(whole);
    if (!closed) {
      return undefined;
    }
    try {
      return JSON.parse(`"${closed[1]}"`) as string;
    } catch {
      return closed[1];
    }
  }
  if (first.startsWith("'")) {
    const closed = /^'((?:[^']|'')*)'/.exec(whole);
    return closed ? closed[1].replace(/''/g, "'") : undefined;
  }
  if (/^[[{&*!]/.test(first)) {
    // A flow collection, anchor or tag: not a name or description this reader understands.
    return undefined;
  }
  return whole.replace(/\s+#.*$/, '');
}

async function readAgentsIn(dir: string, scope: AgentInfo['scope']): Promise<AgentInfo[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const agents: AgentInfo[] = [];
  for (const entry of entries.filter((e) => e.toLowerCase().endsWith('.md')).sort()) {
    const filePath = path.join(dir, entry);
    try {
      const meta = parseAgentFrontmatter(await fs.readFile(filePath, 'utf8'));
      if (meta?.name) {
        agents.push({ name: meta.name, description: meta.description, scope, filePath });
      }
    } catch {
      // Unreadable (a folder named *.md, a permissions error): skipped like a file without a name.
    }
  }
  return agents.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The agents a Claude Code session in `projectDir` can use: the project's first, then the user's in `userAgentsDir`,
 * each sorted by name. A project agent hides a user agent of the same name, as it does in Claude Code.
 */
export async function listAgents(projectDir: string | undefined, userAgentsDir: string): Promise<AgentInfo[]> {
  const projectAgentsDir = projectDir ? path.join(projectDir, '.claude', 'agents') : undefined;
  const project = projectAgentsDir ? await readAgentsIn(projectAgentsDir, 'project') : [];
  // A session started in the home folder has the same folder for both scopes; it counts once, as the user's.
  const same = projectAgentsDir && path.resolve(projectAgentsDir).toLowerCase() === path.resolve(userAgentsDir).toLowerCase();
  const user = await readAgentsIn(userAgentsDir, 'user');
  const names = new Set((same ? [] : project).map((a) => a.name));
  return [...(same ? [] : project), ...user.filter((a) => !names.has(a.name))];
}

/** `--model`, `--effort` and `--agent` for a new Claude Code session, in that order, for whichever are set. */
export function claudeOverrideArgs(overrides: Overrides): string[] {
  return [
    ...(overrides.model ? ['--model', overrides.model] : []),
    ...(overrides.effort ? ['--effort', overrides.effort] : []),
    ...(overrides.agent ? ['--agent', overrides.agent] : []),
  ];
}

/** Arguments that start a new Claude Code session named `name` with `prompt` as its first message. */
export function claudeNewSessionArgs(overrides: Overrides, name: string, prompt: string): string[] {
  return [...claudeOverrideArgs(overrides), '--name', name, prompt];
}

/**
 * Arguments that resume Claude Code session `id` with `message` as its next prompt. No `--agent`: Claude Code 2.1.332
 * accepts it alongside `--resume` but ignores it (an unknown agent name isn't even rejected), so offering it would
 * promise something that doesn't happen.
 */
export function claudeResumeArgs(id: string, overrides: Overrides, message: string): string[] {
  return ['--resume', id, ...claudeOverrideArgs({ ...overrides, agent: undefined }), message];
}
