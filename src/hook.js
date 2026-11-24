import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git, repoRoot } from './policy.js';

export const MARK = '# trailer-policy: managed hook';
const FORWARD_MARK = '# trailer-policy: forwarder';
export const CHAINED = '.pre-trailer-policy';
const HOOK = 'commit-msg';
// Client-side hooks a global core.hooksPath would otherwise shadow.
const FORWARDED = [
  'applypatch-msg', 'pre-applypatch', 'post-applypatch', 'pre-commit', 'pre-merge-commit',
  'prepare-commit-msg', 'post-commit', 'pre-rebase', 'post-checkout', 'post-merge',
  'pre-push', 'post-rewrite', 'pre-auto-gc',
];

const shq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

export function hookScript({ cliPath, forwardToRepo = false }) {
  const next = forwardToRepo
    ? `"$0${CHAINED}" "$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)/hooks/${HOOK}"`
    : `"$0${CHAINED}"`;
  return `#!/bin/sh
${MARK} (remove with: trailer-policy uninstall-hook)
if command -v trailer-policy >/dev/null 2>&1; then
  trailer-policy hook "$1" || exit 1
elif [ -f ${shq(cliPath)} ] && command -v node >/dev/null 2>&1; then
  node ${shq(cliPath)} hook "$1" || exit 1
else
  echo "trailer-policy not found: commit message policy NOT enforced" >&2
fi
# Run the hook that was here before we were installed${forwardToRepo ? ', then the repo-local one' : ''}.
for next in ${next}; do
  if [ -x "$next" ] && ! [ "$next" -ef "$0" ]; then
    "$next" "$@" || exit $?
  fi
done
exit 0
`;
}

const forwarderScript = () => `#!/bin/sh
${FORWARD_MARK}: runs the repo-local hook of the same name
dir="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)/hooks"
next="$dir/$(basename "$0")"
if [ -x "$next" ] && ! [ "$next" -ef "$0" ]; then
  exec "$next" "$@"
fi
exit 0
`;

const has = (file, mark) => fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes(mark);
const write = (file, body) => {
  fs.writeFileSync(file, body, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
};
const expand = (p) => (p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p);

export function globalHooksDir() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'trailer-policy', 'hooks');
}

function installInto(dir, opts) {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, HOOK);
  let status = 'created';
  if (fs.existsSync(target)) {
    if (has(target, MARK)) status = 'updated';
    else {
      const chained = target + CHAINED;
      if (fs.existsSync(chained)) throw new Error(`${chained} already exists; refusing to overwrite it`);
      fs.renameSync(target, chained);
      status = 'chained';
    }
  }
  write(target, hookScript(opts));
  return { status, path: target, chained: status === 'chained' ? target + CHAINED : null };
}

function uninstallFrom(dir) {
  const target = path.join(dir, HOOK);
  if (!has(target, MARK)) return { status: 'not-installed', path: target };
  fs.unlinkSync(target);
  const chained = target + CHAINED;
  let restored = false;
  if (fs.existsSync(chained)) {
    fs.renameSync(chained, target);
    restored = true;
  }
  return { status: restored ? 'restored' : 'removed', path: target };
}

/** Where a per-repo hook has to live. Refuses when a global core.hooksPath would ignore it. */
function repoHooksDir(cwd) {
  const top = repoRoot(cwd);
  const local = git(['config', '--local', '--get', 'core.hooksPath'], cwd);
  if (local) return { dir: path.resolve(top, expand(local)), notes: [`core.hooksPath is set in this repo (${local}); installed there. If that directory is committed, the hook is now part of the repo.`] };
  const global = git(['config', '--global', '--get', 'core.hooksPath'], cwd);
  if (global) {
    throw new Error(
      `core.hooksPath is set globally (${global}), so git ignores .git/hooks in this repo. ` +
        'Run "trailer-policy install-hook --global" to chain into it, or set core.hooksPath locally first.',
    );
  }
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  if (!common) throw new Error('not inside a git repository');
  return { dir: path.join(common, 'hooks'), notes: [] };
}

export function installHook({ cwd, global = false, cliPath }) {
  if (!global) {
    const { dir, notes } = repoHooksDir(cwd);
    return { ...installInto(dir, { cliPath }), notes };
  }
  const existing = git(['config', '--global', '--get', 'core.hooksPath'], cwd);
  const own = globalHooksDir();
  if (existing) {
    const dir = expand(existing);
    if (!path.isAbsolute(dir)) throw new Error(`global core.hooksPath "${existing}" is relative; make it absolute first`);
    const managed = path.resolve(dir) === own;
    const r = installInto(dir, { cliPath, forwardToRepo: managed });
    return {
      ...r,
      notes: [
        managed
          ? 'Updated the trailer-policy global hooks directory.'
          : `core.hooksPath is already set globally (${existing}). Installed into it; any existing commit-msg hook there is chained. Other hooks in that directory are untouched.`,
        'Repos that set their own core.hooksPath (husky, for example) bypass global hooks: run "install-hook" inside them.',
      ],
    };
  }
  fs.mkdirSync(own, { recursive: true });
  const stubs = [];
  for (const name of FORWARDED) {
    const f = path.join(own, name);
    if (!fs.existsSync(f) || has(f, FORWARD_MARK)) {
      write(f, forwarderScript());
      stubs.push(name);
    }
  }
  const r = installInto(own, { cliPath, forwardToRepo: true });
  fs.writeFileSync(path.join(own, '.managed'), 'created by trailer-policy install-hook --global\n');
  const set = git(['config', '--global', 'core.hooksPath', own], cwd);
  if (set === null) throw new Error('could not set core.hooksPath in global git config');
  return {
    ...r,
    notes: [
      `Set global core.hooksPath to ${own}. A global hooksPath makes git ignore every repo's own .git/hooks, so ${stubs.length} forwarders were installed that run the repo-local hook of the same name.`,
      'Repos that set their own core.hooksPath (husky, for example) bypass global hooks: run "install-hook" inside them.',
      'Undo with: trailer-policy uninstall-hook --global',
    ],
  };
}

export function uninstallHook({ cwd, global = false }) {
  if (!global) return { ...uninstallFrom(repoHooksDirSafe(cwd)), notes: [] };
  const existing = git(['config', '--global', '--get', 'core.hooksPath'], cwd);
  if (!existing) return { status: 'not-installed', path: null, notes: ['No global core.hooksPath is set.'] };
  const dir = expand(existing);
  const r = uninstallFrom(dir);
  const notes = [];
  if (path.resolve(dir) === globalHooksDir() && fs.existsSync(path.join(dir, '.managed'))) {
    for (const name of FORWARDED) {
      const f = path.join(dir, name);
      if (has(f, FORWARD_MARK)) fs.unlinkSync(f);
    }
    fs.unlinkSync(path.join(dir, '.managed'));
    const left = fs.readdirSync(dir);
    if (left.length === 0) fs.rmdirSync(dir);
    git(['config', '--global', '--unset', 'core.hooksPath'], cwd);
    notes.push('Removed the forwarders and unset the global core.hooksPath.');
    if (left.length) notes.push(`Left ${left.join(', ')} in ${dir}.`);
  }
  return { ...r, notes };
}

function repoHooksDirSafe(cwd) {
  const local = git(['config', '--local', '--get', 'core.hooksPath'], cwd);
  if (local) return path.resolve(repoRoot(cwd), expand(local));
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  if (!common) throw new Error('not inside a git repository');
  return path.join(common, 'hooks');
}
