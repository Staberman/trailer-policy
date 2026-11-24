import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const MODES = ['off', 'strip', 'require', 'ban'];
export const DEFAULT_DISCLOSURE = 'Assisted-by: <tool>';
export const POLICY_FILE = '.ai-policy';
const KEYS = ['mode', 'disclosure', 'pattern'];

export function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** Parse the `.ai-policy` subset of YAML: `key: value` lines and `#` comments. */
export function parsePolicyFile(text) {
  const values = {};
  const warnings = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const m = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) throw new Error(`${POLICY_FILE}:${i + 1}: expected "key: value", got "${line}"`);
    const key = m[1].toLowerCase();
    let value = m[2];
    const q = /^(["'])(.*)\1$/.exec(value);
    if (q) value = q[2];
    else value = value.replace(/\s+#.*$/, '').trim();
    if (!KEYS.includes(key)) warnings.push(`${POLICY_FILE}:${i + 1}: unknown key "${key}" ignored`);
    else values[key] = value;
  });
  return { values, warnings };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `Assisted-by: <tool>` becomes /^Assisted-by:\s*\S.*$/i. Without a <tool> placeholder the line must match exactly. */
export function patternFromDisclosure(disclosure) {
  const parts = disclosure.split('<tool>').map((p) => escapeRe(p).replace(/\s+/g, '\\s*'));
  return `^${parts.join('\\S.*')}$`;
}

export function repoRoot(cwd) {
  return git(['rev-parse', '--show-toplevel'], cwd) || cwd;
}

/**
 * Precedence, lowest to highest: defaults, global git config (personal
 * default), the committed .ai-policy (the repo's rule), local git config
 * (explicit per-clone choice), explicit overrides (CLI flags).
 * Scopes are read separately; the merged git lookup is never used.
 */
export function resolvePolicy(cwd, overrides = {}) {
  const root = repoRoot(cwd);
  const file = path.join(root, POLICY_FILE);
  const policy = { mode: 'off', disclosure: DEFAULT_DISCLOSURE, pattern: null };
  const sources = { mode: 'default', disclosure: 'default', pattern: 'default' };
  const warnings = [];
  const apply = (vals, src) => {
    for (const k of KEYS) {
      if (vals[k] != null && vals[k] !== '') {
        policy[k] = vals[k];
        sources[k] = src;
      }
    }
  };
  const gitScope = (scope) => ({
    mode: git(['config', `--${scope}`, '--get', 'trailerPolicy.mode'], cwd),
    disclosure: git(['config', `--${scope}`, '--get', 'trailerPolicy.disclosure'], cwd),
    pattern: git(['config', `--${scope}`, '--get', 'trailerPolicy.pattern'], cwd),
  });
  apply(gitScope('global'), 'git config (global)');
  let hasFile = false;
  if (fs.existsSync(file)) {
    hasFile = true;
    const parsed = parsePolicyFile(fs.readFileSync(file, 'utf8'));
    warnings.push(...parsed.warnings);
    apply(parsed.values, POLICY_FILE);
  }
  apply(gitScope('local'), 'git config (local)');
  apply(overrides, 'flag');
  policy.mode = String(policy.mode).toLowerCase();
  if (!MODES.includes(policy.mode)) {
    throw new Error(`invalid mode "${policy.mode}" (from ${sources.mode}); use one of: ${MODES.join(', ')}`);
  }
  const source = policy.pattern || patternFromDisclosure(policy.disclosure);
  try {
    policy.regex = new RegExp(source, 'i');
  } catch (e) {
    throw new Error(`invalid disclosure pattern "${source}": ${e.message}`);
  }
  return { ...policy, patternSource: source, sources, warnings, file: hasFile ? file : null, root };
}
