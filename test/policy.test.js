import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parsePolicyFile, patternFromDisclosure, resolvePolicy } from '../src/policy.js';
import { evaluate } from '../src/check.js';
import { tempRepo, envFor } from './helpers.js';

test('parser: key/value, comments, quotes, case', () => {
  const { values, warnings } = parsePolicyFile(
    '# header\n\nMode: strip   # inline\ndisclosure: "Assisted-by: <tool>"\npattern: ^AI: .+ #x\nextra: 1\n',
  );
  assert.deepEqual(values, { mode: 'strip', disclosure: 'Assisted-by: <tool>', pattern: '^AI: .+' });
  assert.equal(warnings.length, 1);
});

test('parser: a value may contain colons', () => {
  assert.equal(parsePolicyFile('disclosure: AI-used: yes, tool: <tool>\n').values.disclosure, 'AI-used: yes, tool: <tool>');
});

test('parser: rejects lines that are not key: value', () => {
  assert.throws(() => parsePolicyFile('mode strip\n'), /expected "key: value"/);
});

test('disclosure template becomes a pattern', () => {
  const re = new RegExp(patternFromDisclosure('Assisted-by: <tool>'), 'i');
  assert.ok(re.test('Assisted-by: Claude Code'));
  assert.ok(re.test('assisted-by:Claude'));
  assert.ok(!re.test('Assisted-by:'));
  assert.ok(!re.test('Assisted-by:   '));
  const exact = new RegExp(patternFromDisclosure('AI-assisted: yes'), 'i');
  assert.ok(exact.test('AI-assisted: yes'));
  assert.ok(!exact.test('AI-assisted: no'));
});

test('no policy anywhere means mode off', () => {
  const r = tempRepo();
  assert.equal(resolvePolicy(r.dir).mode, 'off');
});

test('precedence: global < file < local < flag', (t) => {
  const r = tempRepo();
  const saved = { ...process.env };
  const env = envFor(r.home);
  Object.assign(process.env, { HOME: env.HOME, GIT_CONFIG_GLOBAL: env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: '1' });
  t.after(() => {
    process.env = saved;
  });
  fs.writeFileSync(path.join(r.dir, '.ai-policy'), 'mode: ban\ndisclosure: Assisted-by: <tool>\n');
  let p = resolvePolicy(r.dir);
  assert.equal(p.mode, 'ban');
  assert.equal(p.sources.mode, '.ai-policy');
  r.git('config', '--global', 'trailerPolicy.mode', 'strip');
  p = resolvePolicy(r.dir);
  assert.equal(p.mode, 'ban'); // global strip loses to the committed file
  assert.equal(p.sources.mode, '.ai-policy');
  r.git('config', '--local', 'trailerPolicy.mode', 'require');
  r.git('config', '--local', 'trailerPolicy.disclosure', 'AI-used: <tool>');
  p = resolvePolicy(r.dir);
  assert.equal(p.mode, 'require');
  assert.equal(p.disclosure, 'AI-used: <tool>');
  p = resolvePolicy(r.dir, { mode: 'off' });
  assert.equal(p.mode, 'off');
  assert.equal(p.sources.mode, 'flag');
});

test('invalid mode and invalid pattern are errors', () => {
  const r = tempRepo();
  fs.writeFileSync(path.join(r.dir, '.ai-policy'), 'mode: loud\n');
  assert.throws(() => resolvePolicy(r.dir), /invalid mode "loud"/);
  fs.writeFileSync(path.join(r.dir, '.ai-policy'), 'mode: require\npattern: (\n');
  assert.throws(() => resolvePolicy(r.dir), /invalid disclosure pattern/);
});

const pol = (mode, extra = {}) => ({ mode, disclosure: 'Assisted-by: <tool>', regex: /^Assisted-by:\s*\S.*$/i, patternSource: 'x', ...extra });
const withCo = 'fix\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n';

test('mode off never fails', () => {
  assert.equal(evaluate(withCo, pol('off')).ok, true);
});
test('mode strip fails when attribution exists, passes when clean', () => {
  assert.equal(evaluate(withCo, pol('strip')).ok, false);
  assert.equal(evaluate('fix\n', pol('strip')).ok, true);
});
test('mode ban fails on any trace, including Assisted-by', () => {
  assert.equal(evaluate(withCo, pol('ban')).ok, false);
  assert.equal(evaluate('fix\n\nAssisted-by: Claude Code\n', pol('ban')).ok, false);
  assert.equal(evaluate('fix\n', pol('ban')).ok, true);
});
test('mode require: traces without disclosure fail, disclosure passes, clean passes', () => {
  assert.equal(evaluate(withCo, pol('require')).ok, false);
  const ok = evaluate('fix\n\nAssisted-by: Claude Code\n', pol('require'));
  assert.equal(ok.ok, true);
  assert.equal(ok.disclosed, true);
  assert.equal(evaluate(`${withCo}Assisted-by: Claude Code\n`, pol('require')).ok, true);
  assert.equal(evaluate('fix\n', pol('require')).ok, true);
});
test('mode require honours a custom pattern', () => {
  const custom = pol('require', { regex: /^AI-used: .+$/i });
  assert.equal(evaluate('fix\n\nAssisted-by: Claude Code\n', custom).ok, false);
  assert.equal(evaluate('fix\n\nAssisted-by: Claude Code\nAI-used: claude\n', custom).ok, true);
});

test('global strip plus repo .ai-policy require gives require', (t) => {
  const r = tempRepo();
  const saved = { ...process.env };
  const env = envFor(r.home);
  Object.assign(process.env, { HOME: env.HOME, GIT_CONFIG_GLOBAL: env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: '1' });
  t.after(() => {
    process.env = saved;
  });
  r.git('config', '--global', 'trailerPolicy.mode', 'strip');
  fs.writeFileSync(path.join(r.dir, '.ai-policy'), 'mode: require\n');
  assert.equal(resolvePolicy(r.dir).mode, 'require');
});

test('local config overrides .ai-policy', (t) => {
  const r = tempRepo();
  const saved = { ...process.env };
  const env = envFor(r.home);
  Object.assign(process.env, { HOME: env.HOME, GIT_CONFIG_GLOBAL: env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: '1' });
  t.after(() => {
    process.env = saved;
  });
  fs.writeFileSync(path.join(r.dir, '.ai-policy'), 'mode: require\n');
  r.git('config', '--local', 'trailerPolicy.mode', 'off');
  const p = resolvePolicy(r.dir);
  assert.equal(p.mode, 'off');
  assert.equal(p.sources.mode, 'git config (local)');
});

test('without .ai-policy the global value applies', (t) => {
  const r = tempRepo();
  const saved = { ...process.env };
  const env = envFor(r.home);
  Object.assign(process.env, { HOME: env.HOME, GIT_CONFIG_GLOBAL: env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: '1' });
  t.after(() => {
    process.env = saved;
  });
  r.git('config', '--global', 'trailerPolicy.mode', 'strip');
  assert.equal(resolvePolicy(r.dir).mode, 'strip');
});
