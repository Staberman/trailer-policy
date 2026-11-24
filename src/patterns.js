// AI attribution signatures. Data only: detect.js turns these into line matchers.
//
// coName / coEmail  strict matchers for the value of a Co-Authored-By line
//                   (name part and email part). Strict on purpose, so a human
//                   called Claude Dupont or Devin Smith is not flagged.
// mention           loose regex source for "Generated with X" and "Assisted-by: X".

export const AGENTS = [
  {
    id: 'claude',
    label: 'Claude',
    coName: /^claude(?:\s+(?:code|ai|opus|sonnet|haiku|\d+(?:\.\d+)*|\(.*?\)|\[.*?\]))*$/i,
    coEmail: /^(?:noreply|claude[\w.+-]*)@anthropic\.com$/i,
    mention: 'claude|anthropic',
  },
  {
    id: 'codex',
    label: 'Codex',
    coName: /^(?:openai\s+)?(?:codex|chatgpt)(?:\s+(?:cli|agent|ai|\d[\w.]*|\(.*?\)))*$|^openai$/i,
    coEmail: /^(?:noreply|codex[\w.+-]*)@openai\.com$/i,
    mention: '(?:openai\\s+)?codex|openai|chatgpt',
  },
  {
    id: 'gemini',
    label: 'Gemini',
    coName: /^(?:google\s+)?gemini(?:\s+(?:cli|code\s+assist|ai|pro|flash|\d[\w.]*|\(.*?\)))*$|^google\s+ai$/i,
    coEmail: /^gemini[\w.+-]*@/i,
    mention: 'gemini|google\\s+ai',
  },
  {
    id: 'copilot',
    label: 'Copilot',
    coName: /^(?:github\s+)?copilot(?:\s+(?:agent|chat|ai|\(.*?\)))*$|^copilot-swe-agent(?:\[bot\])?$/i,
    coEmail: /(?:^|\+)copilot(?:-[\w-]+)?@/i,
    mention: '(?:github\\s+)?copilot',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    coName: /^cursor(?:\s+(?:agent|ai))?$/i,
    coEmail: /^cursoragent@/i,
    mention: 'cursor(?:\\s+agent)?',
  },
  {
    id: 'aider',
    label: 'Aider',
    coName: /^aider(?:\s*\(.*?\))?$/i,
    coEmail: /@aider\.chat$/i,
    mention: 'aider',
  },
  {
    id: 'opencode',
    label: 'opencode',
    coName: /^opencode(?:[-\s](?:agent|ai))?(?:\[bot\])?$/i,
    coEmail: /@opencode\.ai$/i,
    mention: 'opencode',
  },
  {
    id: 'devin',
    label: 'Devin',
    coName: /^devin[-\s]ai(?:-integration)?(?:\[bot\])?$/i,
    coEmail: /devin-ai-integration/i,
    mention: 'devin(?:\\s+ai)?',
  },
];

// Whole-line rules that are not tied to a Co-Authored-By value.
export const LINE_RULES = [
  {
    id: 'session-trailer',
    agent: 'claude',
    re: /^\s*claude-session:\s*\S+\s*$/i,
  },
  {
    id: 'session-url',
    agent: 'claude',
    re: /^\s*(?:[-*]\s*)?(?:(?:claude(?:\s+code)?\s+)?session(?:\s+url)?:\s*)?<?https?:\/\/(?:www\.)?claude\.ai\/code\/\S+>?\s*$/i,
  },
  {
    id: 'session-url',
    agent: 'devin',
    re: /^\s*(?:[-*]\s*)?(?:[\w ]{1,30}:\s*)?<?https?:\/\/app\.devin\.ai\/sessions\/\S+>?\s*$/i,
  },
];

// Verbs and prepositions for "Generated with/by <agent>" lines.
export const GENERATED_VERBS = 'generated|created|written|authored|made|built';
export const GENERATED_PREPS = 'with|by|using|via';
// Words that may follow the agent name ("Claude Code", "Claude Opus 4.5").
export const NAME_TAIL = 'code|cli|agent|ai|opus|sonnet|haiku|\\d[\\d.]*';
