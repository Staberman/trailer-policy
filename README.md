# trailer-policy

Set a per-repo rule for AI attribution in commit messages and PR bodies: strip it, require a disclosure line, or ban it.

## The problem

AI coding agents add attribution to commits and pull requests: `Co-Authored-By: Claude <noreply@anthropic.com>`, a `🤖 Generated with [Claude Code]` line, a `Claude-Session:` URL. Repos disagree about whether that is wanted. Some want it gone. Some require disclosure (the Linux kernel and others ask for an `Assisted-by:` trailer). Some ban AI traces outright.

The agents do not reliably follow their own settings, so a rule in the agent is not enough:

- [anthropics/claude-code#4287](https://github.com/anthropics/claude-code/issues/4287): `Co-Authored-By` is added even with `includeCoAuthoredBy: false`.
- [#36105](https://github.com/anthropics/claude-code/issues/36105): people ask for `Assisted-by` instead of `Co-authored-by`.
- [#66504](https://github.com/anthropics/claude-code/issues/66504): a session URL is added by default.

trailer-policy enforces the rule at the git layer, so it works the same for Claude Code, Codex, Gemini CLI, Copilot, Cursor, Aider, opencode and Devin. It has no dependencies and never uses the network.

## Use it

Not on npm yet. Until it is, run it from a checkout (`node bin/trailer-policy.js`) or `npm link` it. Once published the commands below are the intended form:

```sh
npx trailer-policy init           # write a commented .ai-policy
npx trailer-policy install-hook   # commit-msg hook for this repo
```

Requires Node 18 or newer and git.

## The policy file

`.ai-policy` at the repo root, committed so everyone gets the same rules:

```yaml
# off | strip | require | ban
mode: require

# What a disclosure line looks like. <tool> matches any text.
disclosure: Assisted-by: <tool>

# Optional: a regex (case-insensitive, per line) a disclosure line must match.
# Defaults to the disclosure above.
# pattern: ^Assisted-by: \S.*$
```

Only `key: value` lines and `#` comments are read. Comments must be on their own line (or quote the value).

Precedence, lowest to highest:

1. your global git config (a personal default)
2. the committed `.ai-policy` (the repo's rule)
3. the repo's local git config (an explicit choice for this clone)
4. `--mode <mode>` on the command line

So a personal default never overrides what a repo asks for, but you can still override a repo in your own clone:

```sh
git config --global trailerPolicy.mode strip                     # default for repos without .ai-policy
git config --local trailerPolicy.disclosure "AI-used: <tool>"    # this clone only
```

With no policy anywhere the mode is `off`.

## Modes

- `strip`: remove AI attribution lines. `fix` rewrites the message and tidies the blank lines and the trailer block. The commit-msg hook does it on every commit.
- `require`: if the message carries AI attribution, it must also contain a disclosure line matching the pattern. Otherwise the check fails and says what to add. A message with no AI traces passes, so human-only commits are not touched. The tool cannot know that an agent used no attribution at all; it only sees what is written.
- `ban`: fail if any AI attribution is present, including `Assisted-by:` lines that name an agent.

What counts as attribution: `Co-Authored-By` lines naming Claude, Anthropic, Codex/OpenAI, Gemini/Google AI, Copilot, Cursor, Aider, opencode or Devin; `Generated with/by <agent>` lines (with or without the 🤖); `Claude-Session:` trailers and claude.ai/code session URLs; Devin session links; `Assisted-by:` lines that name an agent. The list is in [`src/patterns.js`](src/patterns.js).

It matches whole lines and checks the name and email of co-authors, so a human co-author, a person named Claude or Devin, or prose like "I used Claude to review this" are left alone.

## Commands

```sh
trailer-policy check [file|-] [--json] [--mode m]   # exit 0 ok, 1 violation, 2 error
trailer-policy check --range origin/main..HEAD      # every commit in a range
trailer-policy fix <file|->                         # strip mode only; rewrites in place
trailer-policy install-hook [--global]
trailer-policy uninstall-hook [--global]
trailer-policy init [--mode m] [--force]
```

### Hook

`install-hook` writes `.git/hooks/commit-msg`. In `strip` mode it cleans the message. In `require` and `ban` it rejects the commit and prints the offending lines and what to do. In `off` it does nothing.

If a commit-msg hook already exists it is renamed to `commit-msg.pre-trailer-policy` and called after the policy check, so your old hook still runs and still sees the stripped message. `uninstall-hook` puts it back. Installing twice is safe. A repo with its own `core.hooksPath` gets the hook there.

Git skips `commit-msg` on `git commit --no-verify`; use the CI check below as a backstop.

### Global install

`install-hook --global` covers every repo that has no hooksPath of its own.

- If `core.hooksPath` is not set globally, it creates `~/.config/trailer-policy/hooks` and sets `core.hooksPath` to it. A global `core.hooksPath` makes git ignore every repo's own `.git/hooks`, so it also installs small forwarders for the other client hooks that run the repo's hook of the same name, and the repo's own `commit-msg` is chained after the policy check.
- If a global `core.hooksPath` is already set, it installs into that directory and chains the `commit-msg` hook already there. Other hooks in the directory are untouched.
- A repo that sets its own `core.hooksPath` (husky, for example) bypasses the global hooks. Run `install-hook` inside it.

`uninstall-hook --global` undoes it. A per-repo `install-hook` refuses to run when a global `core.hooksPath` is set, because git would never call that hook.

The hook looks for `trailer-policy` on `PATH`, then for the copy that installed it. If neither is found it prints a warning and lets the commit through, so install it somewhere permanent rather than running it once from an npx cache.

## CI

Check every commit in a pull request:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
- run: npx trailer-policy check --range origin/${{ github.base_ref }}..HEAD
```

In `strip` mode this fails on any commit that already has attribution, since history cannot be rewritten by a check. Use `ban` or `require` for CI.

## PR bodies

Agents also write the PR description. Check it before you publish:

```sh
trailer-policy check body.md && gh pr create --body-file body.md
```

In `strip` mode, clean it first:

```sh
trailer-policy fix body.md && gh pr create --body-file body.md
```

## Why not the others

[dlhck/strip-clanker-attribution](https://github.com/dlhck/strip-clanker-attribution), [newbdez33/no-claude-coauthor](https://github.com/newbdez33/no-claude-coauthor) and [ca1ebd/agent-attribution-blocker](https://github.com/ca1ebd/agent-attribution-blocker) each do one thing: remove the lines, or block the commit. That is fine if every repo you touch wants the same thing. They have no way to say "this repo requires `Assisted-by:`", and the choice is not stored in the repo. Here the policy is a committed file, one tool covers all three cases, and the same patterns check commit ranges and PR bodies.

## Tests

```sh
npm test
```

## License

MIT
