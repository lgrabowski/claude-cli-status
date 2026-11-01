# cli-status

A Claude Code plugin that adds a live status row under the prompt. It sits below the engine's own hint line (`accept edits on`, shortcuts), which stays intact.

```
•∙·• ▐ Reviewing sparkles 1/2 ▌ ▰▰▰▰▰▱▱▱▱▱ ·•∙•  │  Opus 5.5 ⠹  │  ctx ▰▰▰▱▱▱▱▱▱▱ 31%  │  5h ▰▰▱▱▱▱▱▱▱▱ 18% ↻2h14  │  7d 42%  │  $1.27
```

## What it shows

- **Task pill** (always on):
  - `no tasks` (dim, static) when idle with no task list.
  - `working` with an indeterminate sweep on the bar while a single prompt runs.
  - With a task list: the running task's label plus `done/total` (`✓` when all are done).
- **Progress bar**: 10 cells (10% steps) between the pill and the right-hand dots. Done tasks count fully, the one in progress counts half.
- **Sparkles**: twinkling dots on both sides of the pill. They animate only while a turn runs.
- **Model**: current model name, with a braille snake loader while working.
- **Context**: usage % with a 10-cell bar.
- **Rate limits**: 5h usage with a bar and reset countdown (`↻2h14`), plus 7d usage (Claude subscriptions only; appears after the first reply).
- **Cost**: this session's cost so far.

Bars turn amber from 65% and red from 85%. Colors follow Solarized Dark with accent `#afb9fe`; edit the `PALETTE` block at the top of `hooks/register.tsx`.

The row always fits one line. On narrow terminals it drops detail in steps: task label, reset countdowns, sparkles, bars and the 7d window, and finally the model loader.

`/cli-status` shows or hides the row.

Text size is set by your terminal font; plugins cannot change it.

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

## Develop locally

For one session, load the plugin straight from this folder (it hot-reloads on save):

```
claude --plugin-dir /path/to/claude-cli-status
```

For every session, add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/claude-cli-status" } }
```

Or install it from the local folder as a marketplace (it is read straight from the folder; run `/reload-plugins` after edits):

```
/plugin marketplace add /path/to/claude-cli-status
/plugin install cli-status@claude-cli-status
```

## License

MIT
