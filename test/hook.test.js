import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo, commit, run, sh } from './helpers.js';

const CO = 'Co-Authored-By: Claude <noreply@anthropic.com>';
const policy = (r, text) => fs.writeFileSync(path.join(r.dir, '.ai-policy'), text);
const hookFile = (r) => path.join(r.dir, '.git/hooks/commit-msg');
const lastMessage = (r) => r.git('log', '-1', '--format=%B').stdout.trimEnd();
const exec = (f) => fs.statSync(f).mode & 0o111;

test('install-hook creates an executable commit-msg hook; reinstall is idempotent', () => {
  const r = tempRepo();
  const a = r.tp(['install-hook']);
  assert.equal(a.code, 0, a.stderr);
  assert.ok(exec(hookFile(r)));
  const first = fs.readFileSync(hookFile(r), 'utf8');
  assert.match(first, /trailer-policy: managed hook/);
  const b = r.tp(['install-hook']);
  assert.match(b.stdout, /updated/);
  assert.equal(fs.readFileSync(hookFile(r), 'utf8'), first);
  assert.equal(fs.existsSync(`${hookFile(r)}.pre-trailer-policy`), false);
});

test('strip mode: the hook removes attribution on commit', () => {
  const r = tempRepo();
  policy(r, 'mode: strip\n');
  r.tp(['install-hook']);
  const res = commit(r, `feat: thing\n\nBody.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\n${CO}\nCo-authored-by: Ada <ada@example.com>\n`);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(lastMessage(r), 'feat: thing\n\nBody.\n\nCo-authored-by: Ada <ada@example.com>');
});

test('ban mode: the hook rejects the commit with a clear message', () => {
  const r = tempRepo();
  policy(r, 'mode: ban\n');
  r.tp(['install-hook']);
  const res = commit(r, `feat: thing\n\n${CO}\n`);
  assert.notEqual(res.code, 0);
  assert.match(res.stderr, /commit rejected \(mode: ban\)/);
  assert.match(res.stderr, /line 3/);
  assert.equal(r.git('rev-list', '--count', '--all').stdout.trim(), '0');
  assert.equal(commit(r, 'feat: clean\n\nMentions Claude in prose.\n').code, 0);
});

test('require mode: rejects traces without disclosure, accepts with it', () => {
  const r = tempRepo();
  policy(r, 'mode: require\n');
  r.tp(['install-hook']);
  const bad = commit(r, `feat: thing\n\n${CO}\n`);
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /requires a disclosure line/);
  assert.match(bad.stderr, /Assisted-by: Claude/);
  assert.equal(commit(r, `feat: thing\n\nAssisted-by: Claude Code\n`).code, 0);
  assert.equal(commit(r, 'feat: human only\n').code, 0);
});

test('off mode and missing policy let everything through', () => {
  const r = tempRepo();
  r.tp(['install-hook']);
  assert.equal(commit(r, `feat: thing\n\n${CO}\n`).code, 0);
  assert.match(lastMessage(r), /Co-Authored-By/);
});

test('hook ignores git comment lines', () => {
  const r = tempRepo();
  policy(r, 'mode: ban\n');
  r.tp(['install-hook']);
  assert.equal(commit(r, 'feat: x\n\n# Co-Authored-By: Claude <noreply@anthropic.com>\n').code, 0);
});

test('chaining: an existing hook is kept, runs after the policy, and can still fail the commit', () => {
  const r = tempRepo();
  policy(r, 'mode: strip\n');
  const log = path.join(r.home, 'chain.log');
  fs.mkdirSync(path.join(r.dir, '.git/hooks'), { recursive: true });
  fs.writeFileSync(hookFile(r), `#!/bin/sh\necho "chained saw: $(tail -n 1 "$1")" >> ${log}\ngrep -q WIP "$1" && exit 7\nexit 0\n`, { mode: 0o755 });
  const res = r.tp(['install-hook']);
  assert.match(res.stdout, /chained the existing hook/);
  assert.ok(exec(`${hookFile(r)}.pre-trailer-policy`));
  assert.match(fs.readFileSync(`${hookFile(r)}.pre-trailer-policy`, 'utf8'), /chained saw/);

  assert.equal(commit(r, `feat: one\n\nBody.\n\n${CO}\n`).code, 0);
  assert.match(fs.readFileSync(log, 'utf8'), /chained saw: Body\./); // already stripped when the old hook ran
  assert.doesNotMatch(lastMessage(r), /Claude/);

  const bad = commit(r, 'WIP: nope\n');
  assert.notEqual(bad.code, 0);

  // installing again must not clobber the chained hook
  r.tp(['install-hook']);
  assert.match(fs.readFileSync(`${hookFile(r)}.pre-trailer-policy`, 'utf8'), /chained saw/);
});

test('uninstall removes our hook and restores the original', () => {
  const r = tempRepo();
  fs.mkdirSync(path.join(r.dir, '.git/hooks'), { recursive: true });
  const original = '#!/bin/sh\nexit 0\n';
  fs.writeFileSync(hookFile(r), original, { mode: 0o755 });
  r.tp(['install-hook']);
  const res = r.tp(['uninstall-hook']);
  assert.match(res.stdout, /restored the original hook/);
  assert.equal(fs.readFileSync(hookFile(r), 'utf8'), original);
  assert.ok(exec(hookFile(r)));
  assert.equal(fs.existsSync(`${hookFile(r)}.pre-trailer-policy`), false);

  fs.unlinkSync(hookFile(r));
  r.tp(['install-hook']);
  r.tp(['uninstall-hook']);
  assert.equal(fs.existsSync(hookFile(r)), false);
  assert.match(r.tp(['uninstall-hook']).stdout, /not installed/);
});

test('uninstall never touches a hook that is not ours', () => {
  const r = tempRepo();
  fs.mkdirSync(path.join(r.dir, '.git/hooks'), { recursive: true });
  fs.writeFileSync(hookFile(r), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.match(r.tp(['uninstall-hook']).stdout, /not installed/);
  assert.ok(fs.existsSync(hookFile(r)));
});

test('per-repo install refuses when a global core.hooksPath would ignore it', () => {
  const r = tempRepo();
  r.git('config', '--global', 'core.hooksPath', path.join(r.home, 'shared-hooks'));
  const res = r.tp(['install-hook']);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /core\.hooksPath is set globally/);
  assert.equal(fs.existsSync(hookFile(r)), false);
});

test('per-repo install honours a local core.hooksPath', () => {
  const r = tempRepo();
  r.git('config', 'core.hooksPath', '.githooks');
  const res = r.tp(['install-hook']);
  assert.equal(res.code, 0, res.stderr);
  assert.ok(fs.existsSync(path.join(r.dir, '.githooks/commit-msg')));
  assert.equal(fs.existsSync(hookFile(r)), false);
});

test('--global with no hooksPath: own directory, forwarders, warning, repo hooks keep working', () => {
  const r = tempRepo();
  policy(r, 'mode: ban\n');
  const res = r.tp(['install-hook', '--global']);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /A global hooksPath makes git ignore every repo's own \.git\/hooks/);
  const dir = path.join(r.home, '.config/trailer-policy/hooks');
  assert.equal(r.git('config', '--global', '--get', 'core.hooksPath').stdout.trim(), dir);
  assert.ok(exec(path.join(dir, 'commit-msg')));
  assert.ok(exec(path.join(dir, 'pre-commit')));

  // policy applies without a per-repo hook
  assert.notEqual(commit(r, `feat: x\n\n${CO}\n`).code, 0);

  // a repo-local pre-commit hook still runs through the forwarder
  const marker = path.join(r.home, 'pre-commit-ran');
  fs.mkdirSync(path.join(r.dir, '.git/hooks'), { recursive: true });
  fs.writeFileSync(path.join(r.dir, '.git/hooks/pre-commit'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  assert.equal(commit(r, 'feat: clean\n').code, 0);
  assert.ok(fs.existsSync(marker));

  // and a repo-local commit-msg hook is chained after the policy
  const marker2 = path.join(r.home, 'commit-msg-ran');
  fs.writeFileSync(path.join(r.dir, '.git/hooks/commit-msg'), `#!/bin/sh\ntouch ${marker2}\nexit 0\n`, { mode: 0o755 });
  assert.equal(commit(r, 'feat: clean 2\n').code, 0);
  assert.ok(fs.existsSync(marker2));
  assert.notEqual(commit(r, `feat: dirty\n\n${CO}\n`).code, 0);
});

test('--global with an existing core.hooksPath installs into it and chains its commit-msg', () => {
  const r = tempRepo();
  const shared = path.join(r.home, 'shared-hooks');
  fs.mkdirSync(shared);
  const old = '#!/bin/sh\ngrep -q BLOCKME "$1" && exit 9\nexit 0\n';
  fs.writeFileSync(path.join(shared, 'commit-msg'), old, { mode: 0o755 });
  fs.writeFileSync(path.join(shared, 'pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  r.git('config', '--global', 'core.hooksPath', shared);
  policy(r, 'mode: strip\n');

  const res = r.tp(['install-hook', '--global']);
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /already set globally/);
  assert.equal(r.git('config', '--global', '--get', 'core.hooksPath').stdout.trim(), shared);
  assert.equal(fs.readFileSync(path.join(shared, 'commit-msg.pre-trailer-policy'), 'utf8'), old);
  assert.equal(fs.readFileSync(path.join(shared, 'pre-commit'), 'utf8'), '#!/bin/sh\nexit 0\n');

  assert.equal(commit(r, `feat: a\n\n${CO}\n`).code, 0);
  assert.doesNotMatch(lastMessage(r), /Claude/);
  assert.notEqual(commit(r, 'BLOCKME\n').code, 0);

  r.tp(['uninstall-hook', '--global']);
  assert.equal(fs.readFileSync(path.join(shared, 'commit-msg'), 'utf8'), old);
  assert.equal(r.git('config', '--global', '--get', 'core.hooksPath').stdout.trim(), shared);
});

test('--global uninstall removes our directory and unsets core.hooksPath', () => {
  const r = tempRepo();
  r.tp(['install-hook', '--global']);
  const res = r.tp(['uninstall-hook', '--global']);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(r.git('config', '--global', '--get', 'core.hooksPath').stdout.trim(), '');
  assert.equal(fs.existsSync(path.join(r.home, '.config/trailer-policy/hooks')), false);
});

test('a hook with no trailer-policy on PATH and a missing CLI warns and lets the commit through', () => {
  const r = tempRepo();
  r.tp(['install-hook']);
  const f = hookFile(r);
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replaceAll(/'[^']*trailer-policy\.js'/g, "'/nonexistent/x.js'"));
  const res = commit(r, `feat: x\n\n${CO}\n`);
  assert.equal(res.code, 0);
  assert.match(res.stderr, /policy NOT enforced/);
});
