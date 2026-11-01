import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { Limit, TaskItem, Usage } from '../types'

// All colours in one place: swap these for your own palette.
const PALETTE = {
  accent: '#7aa2f7', // task bar fill, model name
  text: '#c0caf5', // main figures
  muted: '#565f89', // labels, separators
  track: '#3b4261', // empty part of bars
  ok: '#9ece6a', // healthy levels
  warn: '#e0af68', // 65% and up
  danger: '#f7768e', // 85% and up
  money: '#73daca', // cost
}

const usage = atom({ plugin: 'cli-status', key: 'usage' } as const, {
  ctxTokens: null,
  ctxWindow: 0,
  ctxPercent: null,
  limits: [],
  costUsd: null,
} as Usage)
const tasks = atom({ plugin: 'cli-status', key: 'tasks' } as const, [] as TaskItem[])
const model = atom({ plugin: 'cli-status', key: 'model' } as const, '')
const isHidden = atom({ plugin: 'cli-status', key: 'isHidden' } as const, false)

const level = (p: number) => (p >= 85 ? PALETTE.danger : p >= 65 ? PALETTE.warn : PALETTE.ok)

const bar = (fraction: number, cells: number) => {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * cells)
  return ['█'.repeat(filled), '░'.repeat(cells - filled)] as const
}

const tokens = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

// claude-opus-5-5[1m] -> Opus 5.5
const modelName = (id: string) => {
  const m = /(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id)
  if (!m) return id.replace(/\[.*\]$/, '') || '—'
  const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1).toLowerCase()
  return `${family} ${m[2]}${m[3] ? '.' + m[3] : ''}`
}

const limitLabel = (kind: string) => (kind === 'five_hour' ? '5h' : kind === 'seven_day' ? '7d' : kind === 'spend_limit' ? 'spend' : kind)

const untilReset = (resetsAt: string | undefined, now: number) => {
  const at = resetsAt ? Date.parse(resetsAt) : NaN
  if (Number.isNaN(at)) return ''
  const min = Math.max(0, Math.round((at - now) / 60_000))
  if (min >= 60 * 24) return `${Math.round(min / 60 / 24)}d`
  if (min >= 60) return `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}`
  return `${min}m`
}

// Estimated progress: done tasks count fully, the running one counts half.
const progressOf = (list: TaskItem[]) => {
  if (!list.length) return null
  const done = list.filter(t => t.status === 'completed').length
  const running = list.find(t => t.status === 'in_progress')
  return { done, total: list.length, fraction: (done + (running ? 0.5 : 0)) / list.length, running }
}

const refresh = async ($: EngineInterface) => {
  const u = await $.session.usage()
  await update($, usage, () => fromUsage(u))
  const id = await $.session.model()
  await update($, model, () => id)
}

const fromUsage = (u: { context: { tokens?: number; window: number; percent?: number }; rateLimits: Limit[]; cost?: { usd: number } }): Usage => ({
  ctxTokens: u.context.tokens ?? null,
  ctxWindow: u.context.window,
  ctxPercent: u.context.percent ?? null,
  limits: u.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
  costUsd: u.cost?.usd ?? null,
})

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: 'cli-status', description: 'Show or hide the status bar above the prompt' })
    await refresh($)
    return result
  })

  // The engine raises this whenever context, limits or cost move.
  on('session.measure', async ($, e, next) => {
    await update($, usage, () => fromUsage(e))
    return next(e)
  })

  // The model can change with /model between turns.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      const id = await $.session.model()
      await update($, model, () => id)
    }
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    const id = await $.session.model()
    await update($, model, () => id)
    return next(e)
  })

  // Task progress, from the main session's own task list (subagents are ignored).
  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const result = await next(e)
    if (e.agentId || result.deny !== undefined || result.isError) return result
    await update($, tasks, () =>
      e.todos.map((t, i) => ({ id: String(i), subject: t.content, status: t.status, activeForm: t.activeForm })),
    )
    return result
  })

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const result = await next(e)
    if (e.agentId || result.deny !== undefined || result.isError) return result
    const id = result.result.task.id
    await update($, tasks, (list): TaskItem[] => {
      // A fresh plan: once every earlier task is done, start the list over.
      const keep = list.every(t => t.status === 'completed') ? [] : list
      const added: TaskItem = { id, subject: e.subject, status: 'pending', activeForm: e.activeForm }
      return [...keep.filter(t => t.id !== id), added]
    })
    return result
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const result = await next(e)
    if (e.agentId || result.deny !== undefined || result.isError) return result
    const status = e.status
    await update($, tasks, (list): TaskItem[] =>
      status === 'deleted'
        ? list.filter(t => t.id !== e.taskId)
        : list.map(t =>
            t.id !== e.taskId
              ? t
              : {
                  ...t,
                  subject: e.subject ?? t.subject,
                  activeForm: e.activeForm ?? t.activeForm,
                  status: status ?? t.status,
                },
          ),
    )
    return result
  })

  on('command.run', { command: 'cli-status' }, async ($, e) => {
    const hidden = !(await read($, isHidden))
    await update($, isHidden, () => hidden)
    return { text: hidden ? 'Status bar hidden.' : 'Status bar shown.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isHidden))) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const u = await read($, usage)
    const id = await read($, model)
    const p = progressOf(await read($, tasks))
    const now = await $.clock.now()
    const cols = e.props.bodyColumns
    const narrow = cols < 90

    const parts: RenderElement[] = []

    if (p) {
      const [fill, rest] = bar(p.fraction, narrow ? 6 : 10)
      const doing = p.running?.activeForm ?? p.running?.subject
      parts.push(
        <Text key="task" wrap="truncate-end">
          <Text color={PALETTE.accent}>{fill}</Text>
          <Text color={PALETTE.track}>{rest}</Text>
          <Text color={PALETTE.text}> {p.done}/{p.total}</Text>
          {p.done === p.total ? <Text color={PALETTE.ok}> ✓</Text> : null}
          {doing && !narrow ? <Text color={PALETTE.muted}> {doing.slice(0, 28)}</Text> : null}
        </Text>,
      )
    }

    parts.push(
      <Text key="model" bold color={PALETTE.accent}>
        {modelName(id)}
      </Text>,
    )

    if (u.ctxWindow) {
      const pct = u.ctxPercent ?? 0
      const [fill, rest] = bar(pct / 100, 6)
      parts.push(
        <Text key="ctx">
          <Text color={PALETTE.muted}>ctx </Text>
          <Text color={level(pct)}>{fill}</Text>
          <Text color={PALETTE.track}>{rest}</Text>
          <Text color={PALETTE.text}> {u.ctxPercent === null ? '—' : `${pct}%`}</Text>
          {narrow ? null : <Text color={PALETTE.muted}> {u.ctxTokens === null ? '' : `${tokens(u.ctxTokens)}/`}{tokens(u.ctxWindow)}</Text>}
        </Text>,
      )
    }

    for (const l of u.limits) {
      const reset = untilReset(l.resetsAt, now)
      parts.push(
        <Text key={`limit-${l.kind}`}>
          <Text color={PALETTE.muted}>{limitLabel(l.kind)} </Text>
          <Text color={level(l.percentUsed)}>{l.percentUsed}%</Text>
          {reset && !narrow ? <Text color={PALETTE.muted}> ↻{reset}</Text> : null}
        </Text>,
      )
    }

    if (u.costUsd !== null) {
      parts.push(
        <Text key="cost" color={PALETTE.money}>
          ${u.costUsd.toFixed(2)}
        </Text>,
      )
    }

    return (
      <Box flexDirection="row" flexWrap="nowrap" overflow="hidden" paddingX={1}>
        {parts.flatMap((part, i) => (i === 0 ? [part] : [<Text key={`sep-${i}`} color={PALETTE.muted}> │ </Text>, part]))}
      </Box>
    )
  })
}
