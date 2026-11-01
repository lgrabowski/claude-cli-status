# cli-status

A Claude Code plugin that shows a one-line status bar above the prompt:

```
██████░░░░ 3/5 Running tests │ Opus 5.5 │ ctx ███░░░ 42% 84k/200k │ 5h 23% ↻2h10 │ 7d 61% │ $1.23
```

- **Task progress (estimated)**: from Claude's own task list. Done tasks count fully, the one in progress counts half. Shown only while there is a task list.
- **Model**: the session's current model.
- **Context window**: how full it is, with tokens used and the window size.
- **Usage limits**: the 5-hour and 7-day windows with time until reset (Claude subscriptions only; appears after the first reply).
- **Cost**: what this session has cost so far.

Levels turn amber from 65% and red from 85%. On narrow terminals (under 90 columns) the bar drops the details so it stays on one line.

`/cli-status` hides or shows the bar.

All colours are in the `PALETTE` block at the top of `hooks/register.tsx`.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install cli-status --marketplace lgrabowski/claude-cli-status
```

Answer `y` to add the marketplace, then pick a scope.

From a shell:

```
claude plugin install cli-status --marketplace lgrabowski/claude-cli-status
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `lgrabowski/claude-cli-status`, then Add plugin.

## Develop

Run a session with the plugin loaded straight from this folder:

```
claude --plugin-dir /path/to/claude-cli-status
```
