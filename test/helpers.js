import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BIN = path.join(ROOT, 'bin/trailer-policy.js');

export const tempDir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tp-')));

/** Isolated environment: own HOME so global git config never touches the real one. */
export function envFor(home) {
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), GIT_CONFIG_NOSYSTEM: '1' };
  delete env.GIT_DIR;
  delete env.GIT_CONFIG_GLOBAL;
  env.GIT_CONFIG_GLOBAL = path.join(home, '.gitconfig');
  env.PATH = process.env.PATH;
  return env;
}

export function run(args, { cwd, home, input } = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', input, env: envFor(home || cwd) });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

export function sh(cmd, args, { cwd, home, input } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', input, env: envFor(home || cwd) });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** A fresh repo plus a separate fake HOME. */
export function tempRepo() {
  const home = tempDir();
  const dir = path.join(home, 'repo');
  fs.mkdirSync(dir);
  sh('git', ['init', '-q', '-b', 'main'], { cwd: dir, home });
  sh('git', ['config', 'user.name', 'Test'], { cwd: dir, home });
  sh('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, home });
  return { dir, home, git: (...a) => sh('git', a, { cwd: dir, home }), tp: (a, o = {}) => run(a, { cwd: dir, home, ...o }) };
}

export function commit(repo, message, file = 'f.txt') {
  fs.appendFileSync(path.join(repo.dir, file), `${Math.random()}\n`);
  repo.git('add', file);
  const mf = path.join(repo.home, 'msg.txt');
  fs.writeFileSync(mf, message);
  return repo.git('commit', '-q', '-F', mf);
}
