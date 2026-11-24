import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePolicy, repoRoot, git, MODES, POLICY_FILE } from './policy.js';
import { evaluate, applyStrip, describeFailure } from './check.js';
import { installHook, uninstallHook } from './hook.js';

const CLI_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/trailer-policy.js');

const HELP = `trailer-policy - per-repo policy for AI attribution in commit messages and PR bodies

Usage:
  trailer-policy check [file|-] [--json] [--mode <mode>] [--commit-msg]
  trailer-policy check --range <rev-range> [--json] [--mode <mode>]
  trailer-policy fix <file|-> [--mode strip] [--commit-msg]
  trailer-policy install-hook [--global]
  trailer-policy uninstall-hook [--global]
  trailer-policy init [--mode <mode>] [--force]

Modes: off | strip | require | ban
Policy comes from .ai-policy at the repo root, overridden by
git config trailerPolicy.mode / trailerPolicy.disclosure / trailerPolicy.pattern
(local over global), overridden by --mode.

Exit codes: 0 ok, 1 policy violation, 2 error or bad usage.
`;

const out = (s) => process.stdout.write(s + '\n');
const err = (s) => process.stderr.write(s + '\n');

class UsageError extends Error {}

const VALUE_FLAGS = ['--range', '--mode'];
const BOOL_FLAGS = ['--json', '--commit-msg', '--global', '--force'];

function parseArgs(argv, allowed) {
  const flags = {};
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-' || !a.startsWith('--')) args.push(a);
    else if (!allowed.includes(a)) throw new UsageError(`unknown option ${a}`);
    else if (VALUE_FLAGS.includes(a)) {
      if (i + 1 >= argv.length) throw new UsageError(`${a} needs a value`);
      flags[a] = argv[++i];
    } else flags[a] = true;
  }
  return { flags, args };
}

const readInput = (arg) => (arg === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(arg, 'utf8'));

function loadPolicy(flags) {
  const overrides = flags['--mode'] ? { mode: flags['--mode'] } : {};
  const policy = resolvePolicy(process.cwd(), overrides);
  for (const w of policy.warnings) err(`warning: ${w}`);
  return policy;
}

function cmdCheck(argv) {
  const { flags, args } = parseArgs(argv, ['--json', '--mode', '--commit-msg', '--range']);
  const policy = loadPolicy(flags);
  const json = flags['--json'];
  const base = { mode: policy.mode, policy: policy.file ? path.basename(policy.file) : null };

  if (flags['--range']) {
    const raw = git(['log', '--format=%H%x1f%B%x1e', flags['--range']], process.cwd());
    if (raw === null) throw new UsageError(`could not read range "${flags['--range']}" (is it a valid rev range in a git repo?)`);
    const commits = raw
      .split('\x1e')
      .map((c) => c.replace(/^\n/, ''))
      .filter(Boolean)
      .map((c) => {
        const [sha, body = ''] = c.split('\x1f');
        return { sha, subject: body.split('\n')[0], ...evaluate(body, policy) };
      });
    const bad = commits.filter((c) => !c.ok);
    if (json) out(JSON.stringify({ ...base, ok: bad.length === 0, commits }, null, 2));
    else {
      for (const c of bad) {
        out(`FAIL ${c.sha.slice(0, 10)} ${c.subject}`);
        out(describeFailure(c, policy));
      }
      out(`${commits.length} commit(s) checked (mode: ${policy.mode}): ${bad.length} failing.`);
    }
    return bad.length ? 1 : 0;
  }

  let input = args[0];
  if (!input) {
    if (process.stdin.isTTY) throw new UsageError('give a file, "-" for stdin, or --range');
    input = '-';
  }
  const result = evaluate(readInput(input), policy, { commitMsg: !!flags['--commit-msg'] });
  if (json) out(JSON.stringify({ ...base, ok: result.ok, disclosed: result.disclosed, findings: result.findings }, null, 2));
  else if (result.ok) {
    out(`ok (mode: ${policy.mode})${result.findings.length ? `, disclosed` : ''}`);
  } else {
    out(`FAIL (mode: ${policy.mode}): ${result.findings.length} AI attribution line(s)`);
    out(describeFailure(result, policy));
  }
  return result.ok ? 0 : 1;
}

function cmdFix(argv) {
  const { flags, args } = parseArgs(argv, ['--mode', '--commit-msg']);
  if (!args[0]) throw new UsageError('fix needs a file, or "-" to filter stdin to stdout');
  const policy = loadPolicy(flags);
  if (policy.mode === 'off') {
    err('mode is off; nothing to do');
    return 0;
  }
  if (policy.mode !== 'strip') {
    err(`fix only applies in strip mode (current mode: ${policy.mode}); edit the message by hand`);
    return 2;
  }
  const text = readInput(args[0]);
  const r = applyStrip(text, { commitMsg: !!flags['--commit-msg'] });
  if (args[0] === '-') process.stdout.write(r.text);
  else if (r.removed) fs.writeFileSync(args[0], r.text);
  err(`removed ${r.removed} AI attribution line(s)`);
  return 0;
}

/** Entry point for the commit-msg hook. */
function cmdHook(argv) {
  const file = argv[0];
  if (!file) throw new UsageError('hook needs the commit message file');
  const policy = resolvePolicy(process.cwd());
  if (policy.mode === 'off') return 0;
  const text = fs.readFileSync(file, 'utf8');
  if (policy.mode === 'strip') {
    const r = applyStrip(text, { commitMsg: true });
    if (r.removed) {
      fs.writeFileSync(file, r.text);
      err(`trailer-policy: removed ${r.removed} AI attribution line(s) from the commit message`);
    }
    return 0;
  }
  const result = evaluate(text, policy, { commitMsg: true });
  if (result.ok) return 0;
  err(`trailer-policy: commit rejected (mode: ${policy.mode})`);
  err(describeFailure(result, policy));
  return 1;
}

function printHookResult(r, what) {
  const verb = { created: 'installed', updated: 'updated', chained: 'installed, chained the existing hook', removed: 'removed', restored: 'removed, restored the original hook', 'not-installed': 'not installed' }[r.status];
  out(`${what}: ${verb}${r.path ? ` (${r.path})` : ''}`);
  if (r.chained) out(`  existing hook kept as ${r.chained} and runs after the policy check`);
  for (const n of r.notes || []) out(`  note: ${n}`);
}

function cmdInstall(argv) {
  const { flags } = parseArgs(argv, ['--global']);
  const r = installHook({ cwd: process.cwd(), global: !!flags['--global'], cliPath: CLI_PATH });
  printHookResult(r, 'commit-msg hook');
  if (CLI_PATH.includes('_npx')) {
    out('  warning: running from the npx cache, which can be cleaned. Install trailer-policy somewhere stable so the hook keeps finding it.');
  }
  return 0;
}

function cmdUninstall(argv) {
  const { flags } = parseArgs(argv, ['--global']);
  printHookResult(uninstallHook({ cwd: process.cwd(), global: !!flags['--global'] }), 'commit-msg hook');
  return 0;
}

export const TEMPLATE = (mode) => `# AI attribution policy, read by trailer-policy.
# Keep this file in the repo so everyone (and every agent) gets the same rules.

# off      do nothing
# strip    remove AI attribution from commit messages and PR bodies
# require  AI-assisted changes must carry a disclosure line
# ban      fail if any AI attribution is present
mode: ${mode}

# Used by require mode. <tool> stands for the agent or tool name.
# disclosure: Assisted-by: <tool>

# Optional regex (case-insensitive, matched per line) that a disclosure line
# must match. Defaults to the disclosure above with <tool> as "anything".
# pattern: ^Assisted-by: \\S.*$
`;

function cmdInit(argv) {
  const { flags } = parseArgs(argv, ['--mode', '--force']);
  const mode = flags['--mode'] || 'strip';
  if (!MODES.includes(mode)) throw new UsageError(`invalid mode "${mode}"; use one of: ${MODES.join(', ')}`);
  const file = path.join(repoRoot(process.cwd()), POLICY_FILE);
  if (fs.existsSync(file) && !flags['--force']) {
    err(`${file} already exists (use --force to overwrite)`);
    return 2;
  }
  fs.writeFileSync(file, TEMPLATE(mode));
  out(`wrote ${file} (mode: ${mode})`);
  return 0;
}

const COMMANDS = {
  check: cmdCheck,
  fix: cmdFix,
  hook: cmdHook,
  'install-hook': cmdInstall,
  'uninstall-hook': cmdUninstall,
  init: cmdInit,
};

export function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
    out(HELP);
    return cmd ? 0 : 2;
  }
  if (!COMMANDS[cmd]) {
    err(`unknown command "${cmd}"\n\n${HELP}`);
    return 2;
  }
  try {
    return COMMANDS[cmd](rest);
  } catch (e) {
    err(`error: ${e.message}`);
    return 2;
  }
}
