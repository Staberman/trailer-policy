import { AGENTS, LINE_RULES, GENERATED_VERBS, GENERATED_PREPS, NAME_TAIL } from './patterns.js';

const CO_AUTHOR = /^\s*co-?authored-?by:\s*(.+?)\s*$/i;
const ASSISTED_BY = /^\s*assisted-by:\s*(.+?)\s*$/i;
const SCISSORS = /^# -{10,} >8 -{10,}$/;

const mentions = AGENTS.map((a) => ({
  agent: a,
  loose: new RegExp(`\\b(?:${a.mention})\\b`, 'i'),
  generated: new RegExp(
    `^\\s*(?:🤖\\s*)?(?:${GENERATED_VERBS})\\s+(?:${GENERATED_PREPS})\\s+(?:the\\s+)?\\W{0,3}(?:${a.mention})\\b` +
      `(?:\\s+(?:${NAME_TAIL}))*[\\]*_]*(?:\\([^)]*\\))?[\\s.!]*(?:via\\s+.*)?$`,
    'i',
  ),
}));

export const splitLines = (text) => text.split(/\r?\n/);

/** Indexes of lines git would keep. In commit-msg mode, '#' lines and everything after the scissors line are ignored. */
export function activeLines(lines, commitMsg) {
  const keep = new Array(lines.length).fill(true);
  if (!commitMsg) return keep;
  let cut = false;
  lines.forEach((l, i) => {
    if (SCISSORS.test(l)) cut = true;
    if (cut || l.startsWith('#')) keep[i] = false;
  });
  return keep;
}

function coAuthorAgent(value) {
  const m = /^(.*?)\s*<([^>]*)>$/.exec(value);
  const name = (m ? m[1] : value).trim().replace(/^["']|["']$/g, '');
  const email = m ? m[2].trim() : '';
  for (const a of AGENTS) {
    if (a.coName.test(name) || (email && a.coEmail.test(email))) return a;
  }
  return null;
}

function classify(line) {
  let m = CO_AUTHOR.exec(line);
  if (m) {
    const a = coAuthorAgent(m[1]);
    return a && { agent: a.id, label: a.label, rule: 'co-authored-by' };
  }
  m = ASSISTED_BY.exec(line);
  if (m) {
    const hit = mentions.find((x) => x.loose.test(m[1]));
    return hit && { agent: hit.agent.id, label: hit.agent.label, rule: 'assisted-by' };
  }
  for (const r of LINE_RULES) {
    if (r.re.test(line)) {
      const a = AGENTS.find((x) => x.id === r.agent);
      return { agent: a.id, label: a.label, rule: r.id };
    }
  }
  for (const x of mentions) {
    if (x.generated.test(line)) return { agent: x.agent.id, label: x.agent.label, rule: 'generated-with' };
  }
  return null;
}

/** @returns {{line:number,text:string,agent:string,label:string,rule:string}[]} line is 1-based */
export function detect(text, { commitMsg = false } = {}) {
  const lines = splitLines(text);
  const keep = activeLines(lines, commitMsg);
  const out = [];
  lines.forEach((text, i) => {
    if (!keep[i]) return;
    const hit = classify(text);
    if (hit) out.push({ line: i + 1, text: text.trim(), ...hit });
  });
  return out;
}
