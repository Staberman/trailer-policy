import { detect, splitLines, activeLines } from './detect.js';
import { strip } from './strip.js';

/**
 * Apply a policy to one message.
 * off: always ok. strip/ban: ok when no attribution is found.
 * require: ok when there is no attribution, or when a disclosure line matching
 * the policy pattern is present. Disclosure lines are never reported as traces.
 */
export function evaluate(text, policy, { commitMsg = false } = {}) {
  let findings = detect(text, { commitMsg });
  const result = { mode: policy.mode, ok: true, findings, disclosed: false };
  if (policy.mode === 'off') return { ...result, findings: [] };
  if (policy.mode === 'require') {
    const lines = splitLines(text);
    const keep = activeLines(lines, commitMsg);
    result.disclosed = lines.some((l, i) => keep[i] && policy.regex.test(l));
    findings = findings.filter((f) => !policy.regex.test(f.text));
    result.findings = findings;
    result.ok = findings.length === 0 || result.disclosed;
  } else {
    result.ok = findings.length === 0;
  }
  return result;
}

/** Rewrite a message for strip mode. */
export function applyStrip(text, { commitMsg = false } = {}) {
  const findings = detect(text, { commitMsg });
  return { text: strip(text, findings), removed: findings.length, findings };
}

export function describeFailure(result, policy) {
  const lines = result.findings.map((f) => `  line ${f.line}: ${f.label} (${f.rule})  ${f.text}`);
  let hint;
  if (result.mode === 'strip') hint = 'Run "trailer-policy fix <file>" to remove them, or install the hook so this happens on commit.';
  else if (result.mode === 'ban') hint = 'This repo bans AI attribution. Remove those lines.';
  else {
    const example = policy.disclosure.replace('<tool>', result.findings[0]?.label || 'Claude Code');
    hint = `This repo requires a disclosure line matching ${policy.patternSource}\nAdd one, for example: ${example}`;
  }
  return [...lines, hint].join('\n');
}
