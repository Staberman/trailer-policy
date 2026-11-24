import test from 'node:test';
import assert from 'node:assert/strict';
import { detect } from '../src/detect.js';
import { strip } from '../src/strip.js';
import { AGENT_FIXTURES, HUMAN_FIXTURES } from './fixtures.js';

for (const [agent, fixtures] of Object.entries(AGENT_FIXTURES)) {
  test(`detects ${agent} signatures`, () => {
    fixtures.forEach((text) => {
      const found = detect(text);
      assert.ok(found.length > 0, `no match in:\n${text}`);
      assert.deepEqual([...new Set(found.map((f) => f.agent))], [agent], `wrong agent in:\n${text}`);
    });
  });

  test(`strips ${agent} signatures and keeps the message`, () => {
    fixtures.forEach((text) => {
      const out = strip(text, detect(text));
      assert.equal(detect(out).length, 0, out);
      assert.equal(out, 'feat: add parser\n\nExplain the change.\n');
    });
  });
}

for (const [name, text] of Object.entries(HUMAN_FIXTURES)) {
  test(`no false positive: ${name}`, () => {
    assert.deepEqual(detect(text), []);
  });
}

test('rule names are reported', () => {
  const text = 'x\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\nClaude-Session: https://claude.ai/code/session_1\n';
  assert.deepEqual(detect(text).map((f) => f.rule), ['co-authored-by', 'generated-with', 'session-trailer']);
  assert.deepEqual(detect(text).map((f) => f.line), [3, 4, 5]);
});

test('commit-msg mode ignores comment lines and the scissors section', () => {
  const text = 'fix\n\n# Please enter the message\n# ------------------------ >8 ------------------------\nGenerated with Claude\n';
  assert.equal(detect(text, { commitMsg: true }).length, 0);
  assert.equal(detect(text).length, 1);
});

test('strip keeps human trailers and the blank line before them', () => {
  const text = 'fix: x\n\nBody.\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nCo-authored-by: Ada <ada@example.com>\nSigned-off-by: Bob <bob@example.com>\n';
  assert.equal(strip(text, detect(text)), 'fix: x\n\nBody.\n\nCo-authored-by: Ada <ada@example.com>\nSigned-off-by: Bob <bob@example.com>\n');
});

test('strip drops the whole trailer block when only AI lines were in it', () => {
  const text = 'fix: x\n\nBody.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n';
  assert.equal(strip(text, detect(text)), 'fix: x\n\nBody.\n');
});

test('strip collapses the gap left in the middle of a body', () => {
  const text = 'Title\n\nPara one.\n\nGenerated with Claude Code\n\nPara two.\n';
  assert.equal(strip(text, detect(text)), 'Title\n\nPara one.\n\nPara two.\n');
});

test('strip keeps the signed-off-by that sits right above an AI line', () => {
  const text = 'fix\n\nSigned-off-by: Bob <bob@example.com>\nCo-Authored-By: Claude <noreply@anthropic.com>\n';
  assert.equal(strip(text, detect(text)), 'fix\n\nSigned-off-by: Bob <bob@example.com>\n');
});

test('strip preserves CRLF and a missing final newline', () => {
  const crlf = 'a\r\n\r\nCo-Authored-By: Claude <noreply@anthropic.com>\r\n';
  assert.equal(strip(crlf, detect(crlf)), 'a\r\n');
  const noNl = 'a\n\nGenerated with Claude Code';
  assert.equal(strip(noNl, detect(noNl)), 'a');
});

test('strip leaves untouched text identical', () => {
  const text = 'a\n\n\nb\n';
  assert.equal(strip(text, detect(text)), text);
});

test('strip keeps git comment lines in commit-msg mode', () => {
  const text = 'fix\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n# Please enter the commit message\n';
  assert.equal(strip(text, detect(text, { commitMsg: true })), 'fix\n\n# Please enter the commit message\n');
});
