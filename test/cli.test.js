import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempRepo, commit } from './helpers.js';

const CO = 'Co-Authored-By: Claude <noreply@anthropic.com>';
const policy = (r, text) => fs.writeFileSync(path.join(r.dir, '.ai-policy'), text);
const write = (r, name, text) => {
  const f = path.join(r.dir, name);
  fs.writeFileSync(f, text);
  return f;
};

test('check: off mode passes everything', () => {
  const r = tempRepo();
  const f = write(r, 'body.md', `Summary\n\n${CO}\n`);
  assert.equal(r.tp(['check', f]).code, 0);
});

test('check: strip and ban fail with readable output, clean passes', () => {
  const r = tempRepo();
  const bad = write(r, 'bad.md', `Summary\n\n${CO}\n`);
  const good = write(r, 'good.md', 'Summary\n\nJust text about Claude.\n');
  for (const mode of ['strip', 'ban']) {
    policy(r, `mode: ${mode}\n`);
    const res = r.tp(['check', bad]);
    assert.equal(res.code, 1);
    assert.match(res.stdout, new RegExp(`FAIL \\(mode: ${mode}\\)`));
    assert.match(res.stdout, /line 3: Claude \(co-authored-by\)/);
    assert.equal(r.tp(['check', good]).code, 0);
  }
});

test('check: require explains the disclosure format', () => {
  const r = tempRepo();
  policy(r, 'mode: require\n');
  const f = write(r, 'b.md', `Summary\n\n${CO}\n`);
  const res = r.tp(['check', f]);
  assert.equal(res.code, 1);
  assert.match(res.stdout, /Assisted-by: Claude/);
  write(r, 'b.md', 'Summary\n\nAssisted-by: Claude Code\n');
  assert.equal(r.tp(['check', f]).code, 0);
});

test('check: reads stdin with "-" and with no argument', () => {
  const r = tempRepo();
  policy(r, 'mode: ban\n');
  assert.equal(r.tp(['check', '-'], { input: `x\n\n${CO}\n` }).code, 1);
  assert.equal(r.tp(['check'], { input: 'x\n' }).code, 0);
});

test('check --json', () => {
  const r = tempRepo();
  policy(r, 'mode: ban\n');
  const res = r.tp(['check', '-', '--json'], { input: `x\n\nGenerated with Claude Code\n` });
  const j = JSON.parse(res.stdout);
  assert.equal(res.code, 1);
  assert.equal(j.ok, false);
  assert.equal(j.mode, 'ban');
  assert.equal(j.findings[0].agent, 'claude');
  assert.equal(j.findings[0].rule, 'generated-with');
});

test('check: --mode overrides the policy file, bad mode exits 2', () => {
  const r = tempRepo();
  policy(r, 'mode: ban\n');
  assert.equal(r.tp(['check', '-', '--mode', 'off'], { input: `x\n\n${CO}\n` }).code, 0);
  assert.equal(r.tp(['check', '-', '--mode', 'loud'], { input: 'x\n' }).code, 2);
});

test('fix rewrites a file in strip mode', () => {
  const r = tempRepo();
  policy(r, 'mode: strip\n');
  const f = write(r, 'body.md', `Summary\n\nDetails.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\n${CO}\n`);
  const res = r.tp(['fix', f]);
  assert.equal(res.code, 0);
  assert.equal(fs.readFileSync(f, 'utf8'), 'Summary\n\nDetails.\n');
  assert.equal(r.tp(['check', f]).code, 0);
});

test('fix: "-" filters stdin to stdout', () => {
  const r = tempRepo();
  policy(r, 'mode: strip\n');
  assert.equal(r.tp(['fix', '-'], { input: `a\n\n${CO}\n` }).stdout, 'a\n');
});

test('fix refuses outside strip mode', () => {
  const r = tempRepo();
  policy(r, 'mode: ban\n');
  const f = write(r, 'b.md', `a\n\n${CO}\n`);
  assert.equal(r.tp(['fix', f]).code, 2);
  assert.match(fs.readFileSync(f, 'utf8'), /Co-Authored-By/);
});

test('check --range reports only the bad commits', () => {
  const r = tempRepo();
  policy(r, 'mode: ban\n');
  commit(r, 'chore: base\n');
  const base = r.git('rev-parse', 'HEAD').stdout.trim();
  commit(r, 'feat: clean\n');
  commit(r, `feat: dirty\n\n${CO}\n`);
  commit(r, 'feat: also clean\n\nMentions Claude in prose.\n');
  const res = r.tp(['check', '--range', `${base}..HEAD`]);
  assert.equal(res.code, 1);
  assert.match(res.stdout, /FAIL \w+ feat: dirty/);
  assert.doesNotMatch(res.stdout, /feat: clean/);
  assert.match(res.stdout, /3 commit\(s\) checked \(mode: ban\): 1 failing/);
  const j = JSON.parse(r.tp(['check', '--range', `${base}..HEAD`, '--json']).stdout);
  assert.equal(j.commits.length, 3);
  assert.equal(j.commits.filter((c) => !c.ok).length, 1);
  assert.equal(r.tp(['check', '--range', `${base}..HEAD~2`]).code, 0);
});

test('check --range: bad range exits 2; empty range passes', () => {
  const r = tempRepo();
  commit(r, 'a\n');
  assert.equal(r.tp(['check', '--range', 'nope..HEAD']).code, 2);
  assert.equal(r.tp(['check', '--range', 'HEAD..HEAD']).code, 0);
});

test('init writes a commented .ai-policy that parses, and will not overwrite', () => {
  const r = tempRepo();
  assert.equal(r.tp(['init', '--mode', 'require']).code, 0);
  const text = fs.readFileSync(path.join(r.dir, '.ai-policy'), 'utf8');
  assert.match(text, /^# AI attribution policy/);
  assert.match(text, /^mode: require$/m);
  assert.equal(r.tp(['check', '-'], { input: `x\n\n${CO}\n` }).code, 1);
  assert.equal(r.tp(['init']).code, 2);
  assert.equal(r.tp(['init', '--force', '--mode', 'ban']).code, 0);
  assert.equal(r.tp(['init', '--force', '--mode', 'loud']).code, 2);
});

test('unknown command and unknown option exit 2', () => {
  const r = tempRepo();
  assert.equal(r.tp(['frobnicate']).code, 2);
  assert.equal(r.tp(['check', '--wat']).code, 2);
});

test('git config overrides the committed file', () => {
  const r = tempRepo();
  policy(r, 'mode: ban\n');
  r.git('config', 'trailerPolicy.mode', 'off');
  assert.equal(r.tp(['check', '-'], { input: `x\n\n${CO}\n` }).code, 0);
});
