import { splitLines } from './detect.js';

/**
 * Remove the given findings and tidy what is left: a run of blank lines that
 * had a removed line in it shrinks to one blank line (or none at the edges),
 * so the trailer block and the paragraph spacing stay clean.
 */
export function strip(text, findings) {
  if (!findings.length) return text;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const endsWithEol = /\n$/.test(text);
  const lines = splitLines(text);
  if (endsWithEol) lines.pop();
  const drop = new Set(findings.map((f) => f.line - 1));
  const out = [];
  let run = null; // pending blank/removed run
  const flush = (atEdge) => {
    if (!run) return;
    if (!run.removed) out.push(...run.blanks);
    else if (!atEdge && run.blanks.length && out.length) out.push('');
    run = null;
  };
  lines.forEach((l, i) => {
    const removed = drop.has(i);
    if (removed || l.trim() === '') {
      run ||= { blanks: [], removed: false };
      if (removed) run.removed = true;
      else run.blanks.push(l);
    } else {
      flush(false);
      out.push(l);
    }
  });
  flush(true);
  if (!out.length) return '';
  return out.join(eol) + (endsWithEol ? eol : '');
}
