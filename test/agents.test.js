const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { parseAgentFrontmatter, listAgents, userAgentsDir, claudeOverrideArgs, claudeNewSessionArgs, claudeResumeArgs } = require('../out/agents');

const fixtures = path.join(__dirname, 'fixtures', 'claude-agents');

/** A project folder and a user agents folder in a temp dir. `.claude/` is gitignored, so the fixtures can't sit in one. */
function agentFolders() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-agents-'));
  const project = path.join(root, 'repo');
  const userAgents = path.join(root, 'config', 'agents');
  fs.cpSync(path.join(fixtures, 'project'), path.join(project, '.claude', 'agents'), { recursive: true });
  fs.cpSync(path.join(fixtures, 'user'), userAgents, { recursive: true });
  return { root, project, userAgents };
}

test('parseAgentFrontmatter: name and description from plain, quoted and folded values', () => {
  assert.deepEqual(parseAgentFrontmatter('---\nname: planner\ndescription: Plans work.\n---\nbody'), { name: 'planner', description: 'Plans work.' });
  // CRLF and a byte order mark, as Windows editors save them.
  assert.deepEqual(parseAgentFrontmatter('﻿---\r\nname: win\r\n---\r\n'), { name: 'win', description: undefined });
  assert.deepEqual(parseAgentFrontmatter('---\nname: "ship-it"\ndescription: "Line one.\\nLine two."\n---\n'), {
    name: 'ship-it',
    description: 'Line one. Line two.',
  });
  assert.deepEqual(parseAgentFrontmatter("---\nname: 'it''s'\n---\n"), { name: "it's", description: undefined });
  assert.equal(parseAgentFrontmatter('---\nname: x\ndescription: |\n  Keeps\n  lines\n---\n').description, 'Keeps lines');
  assert.equal(parseAgentFrontmatter('---\nname: x\ndescription: starts here\n  and carries on\n---\n').description, 'starts here and carries on');
  assert.equal(parseAgentFrontmatter('---\nname: x # a comment\n---\n').name, 'x');
  // Other keys, lists and comments are passed over.
  assert.deepEqual(parseAgentFrontmatter('---\n# comment\ntools:\n  - Read\n  - Grep\nname: y\n---\n'), { name: 'y', description: undefined });
});

test('parseAgentFrontmatter: malformed input gives no name, never a throw', () => {
  assert.equal(parseAgentFrontmatter(''), undefined);
  assert.equal(parseAgentFrontmatter('name: x\n'), undefined, 'no frontmatter block');
  assert.equal(parseAgentFrontmatter('---\nname: x\nno closing line'), undefined);
  assert.equal(parseAgentFrontmatter('---\n---\n').name, undefined);
  assert.equal(parseAgentFrontmatter('---\nname:\n---\n').name, undefined);
  assert.equal(parseAgentFrontmatter('---\nname: [a, b]\n---\n').name, undefined);
  assert.equal(parseAgentFrontmatter('---\nname: {a: 1}\n---\n').name, undefined);
  assert.equal(parseAgentFrontmatter('---\nname: "unterminated\n---\n').name, undefined);
  for (let i = 0; i < 200; i++) {
    const junk = Array.from({ length: 40 }, () => '-:"\'|>#\n \t[]{}ab'[Math.floor(Math.random() * 18)]).join('');
    parseAgentFrontmatter(`---\n${junk}\n---\n`);
    parseAgentFrontmatter(junk);
  }
});

test('listAgents: project agents first, then the user\'s; bad files skipped; a project agent hides a user one', async () => {
  const { root, project, userAgents } = agentFolders();
  try {
    const agents = await listAgents(project, userAgents);
    assert.deepEqual(
      agents.map((a) => [a.name, a.scope, path.basename(a.filePath)]),
      [
        ['planner', 'project', 'planner.md'],
        ['ship-it', 'project', 'release-checker.md'],
        ['reviewer', 'user', 'reviewer.md'],
      ],
    );
    assert.equal(agents[0].description, 'Breaks a goal into steps before any code is written. Use when a request spans several files.');
    assert.equal(agents[1].description, 'Checks a branch is ready to ship. Runs the tests, then reads the diff.');
    assert.equal(agents[2].description, 'Reviews a diff for correctness bugs. Use after a change is finished.');

    // Without a project folder, or with one that has no agents folder, only the user's.
    assert.deepEqual((await listAgents(undefined, userAgents)).map((a) => a.name), ['planner', 'reviewer']);
    assert.deepEqual((await listAgents(path.join(root, 'elsewhere'), userAgents)).map((a) => [a.name, a.scope]), [
      ['planner', 'user'],
      ['reviewer', 'user'],
    ]);
    // Neither folder exists: none, so the picker has no agent step.
    assert.deepEqual(await listAgents(path.join(root, 'nope'), path.join(root, 'none')), []);
    // A session in the folder that holds the user agents counts them once, as the user's.
    const config = path.dirname(userAgents);
    fs.mkdirSync(path.join(config, '.claude'));
    fs.cpSync(userAgents, path.join(config, '.claude', 'agents'), { recursive: true });
    const home = await listAgents(config, path.join(config, '.claude', 'agents'));
    assert.deepEqual(home.map((a) => [a.name, a.scope]), [
      ['planner', 'user'],
      ['reviewer', 'user'],
    ]);
    // A folder named like an agent file is skipped.
    fs.mkdirSync(path.join(userAgents, 'folder.md'));
    assert.deepEqual((await listAgents(undefined, userAgents)).map((a) => a.name), ['planner', 'reviewer']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('userAgentsDir: agents under CLAUDE_CONFIG_DIR, else ~/.claude/agents', () => {
  const home = path.join('C:', 'Users', 'me');
  assert.equal(userAgentsDir({}, home), path.join(home, '.claude', 'agents'));
  assert.equal(userAgentsDir({ CLAUDE_CONFIG_DIR: '' }, home), path.join(home, '.claude', 'agents'));
  assert.equal(userAgentsDir({ CLAUDE_CONFIG_DIR: path.join('D:', 'claude') }, home), path.join('D:', 'claude', 'agents'));
});

test('Claude Code arguments with and without an agent', () => {
  assert.deepEqual(claudeOverrideArgs({}), []);
  assert.deepEqual(claudeOverrideArgs({ model: 'opus', effort: 'high', agent: 'planner' }), ['--model', 'opus', '--effort', 'high', '--agent', 'planner']);
  assert.deepEqual(claudeNewSessionArgs({}, 'Continued: X', 'handoff'), ['--name', 'Continued: X', 'handoff']);
  assert.deepEqual(claudeNewSessionArgs({ agent: 'ship-it' }, 'Continued: X', 'handoff'), ['--agent', 'ship-it', '--name', 'Continued: X', 'handoff']);
  assert.deepEqual(claudeNewSessionArgs({ model: 'sonnet', agent: 'a b' }, 'N', 'p'), ['--model', 'sonnet', '--agent', 'a b', '--name', 'N', 'p']);
  // Resuming drops the agent: Claude Code ignores --agent with --resume.
  assert.deepEqual(claudeResumeArgs('id-1', {}, 'next'), ['--resume', 'id-1', 'next']);
  assert.deepEqual(claudeResumeArgs('id-1', { model: 'haiku', effort: 'low', agent: 'planner' }, 'next'), ['--resume', 'id-1', '--model', 'haiku', '--effort', 'low', 'next']);
});
