import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, Timer } from 'claude-code'

import type { Limit, TaskItem, Usage } from '../types'

// All colours in one place: swap these for your own palette.
const PALETTE = {
  accent: '#afb9fe', // task bar fill, model name, spinner, pill
  sparkle: '#e4e8ff', // brightest twinkle step
  ink: '#002b36', // dark text on the accent pill
  text: '#f8f8f2', // main figures
  muted: '#839496', // labels
  dim: '#586e75', // separators, the engine's hint
  track: '#073642', // empty part of bars
  ok: '#859900', // healthy levels
  warn: '#b58900', // 65% and up
  danger: '#dc322f', // 85% and up
  money: '#2aa198', // cost
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
const frame = atom({ plugin: 'cli-status', key: 'frame' } as const, 0)
const tick = atom({ plugin: 'cli-status', key: 'tick' } as const, 0)
const isHidden = atom({ plugin: 'cli-status', key: 'isHidden' } as const, false)

// Strip control, zero-width and bidi characters so model-written text can't move the cursor or reorder the row.
const clean = (s: string, max = 200) =>
  [...s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, max).join('')

// Display columns: 2 for wide (CJK, emoji) code points, else 1.
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60]/
const wide = (ch: string) => WIDE.test(ch) || (ch.codePointAt(0)! >= 0x1f300 && ch.codePointAt(0)! <= 0x1faff)
const cells = (s: string) => {
  let n = 0
  for (const ch of s) n += wide(ch) ? 2 : 1
  return n
}
// Truncate by code points to at most `max` columns, appending an ellipsis when cut.
const fit = (s: string, max: number) => {
  if (cells(s) <= max) return s
  let out = ''
  let w = 0
  for (const ch of s) {
    const cw = wide(ch) ? 2 : 1
    if (w + cw > max - 1) break
    out += ch
    w += cw
  }
  return out + '…'
}

const level = (p: number) => (p >= 85 ? PALETTE.danger : p >= 65 ? PALETTE.warn : PALETTE.ok)

const bar = (fraction: number, cells: number) => {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * cells)
  return ['▰'.repeat(filled), '▱'.repeat(cells - filled)] as const
}

// Twinkle ramp: very dim -> accent -> near-white; brighter steps use a bigger dot.
const RAMP = [
  { c: PALETTE.track, g: '·' },
  { c: PALETTE.dim, g: '·' },
  { c: PALETTE.accent, g: '∙' },
  { c: PALETTE.accent, g: '•' },
  { c: PALETTE.sparkle, g: '•' },
]
const WAVE = 8 // frame counter wraps at 120 (a multiple of the twinkle wave 8, bar sweep 12 and snake 10), so no jumps

// Timers live in module scope: the fast one only while a turn runs.
let spinTimer: Timer | undefined
let slowTimer: Timer | undefined

const SNAKE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const tokens = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))

// claude-opus-5-5[1m] -> Opus 5.5
const modelName = (rawId: string) => {
  const id = clean(rawId, 80)
  const m = /(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id)
  if (!m) return clean(id.replace(/\[.*\]$/, ''), 24) || '—'
  const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1).toLowerCase()
  return clean(`${family} ${m[2]}${m[3] ? '.' + m[3] : ''}`, 24)
}

const limitLabel = (kind: string) => (kind === 'five_hour' ? '5h' : kind === 'seven_day' ? '7d' : kind === 'spend_limit' ? 'spend' : clean(kind, 8))

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

const startSpinner = ($: EngineInterface) => {
  if (spinTimer) return
  spinTimer = $.clock.every(120, () => {
    update($, frame, n => (n + 1) % 120).catch(() => {})
  })
}

const stopSpinner = () => {
  spinTimer?.cancel()
  spinTimer = undefined
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
    await $.command.register({ name: 'cli-status', description: 'Show or hide the status line under the prompt' })
    // Slow tick keeps the reset countdown fresh.
    slowTimer?.cancel()
    slowTimer = $.clock.every(30_000, () => {
      update($, tick, n => n + 1).catch(() => {})
    })
    try {
      await refresh($)
    } catch {}
    return result
  })

  // The engine raises this whenever context, limits or cost move.
  on('session.measure', async ($, e, next) => {
    await update($, usage, () => fromUsage(e))
    return next(e)
  })

  // The model can change with /model between turns.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) stopSpinner()
    const result = await next(e)
    if (e.agentId === undefined) {
      try {
        const id = await $.session.model()
        await update($, model, () => id)
      } catch {}
    }
    return result
  })

  // Spin only while a main-session turn runs. turn.complete also fires on
  // interrupt (reason 'aborted'), so the spinner stops then too.
  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    startSpinner($)
    try {
      const id = await $.session.model()
      await update($, model, () => id)
    } catch {}
    return next(e)
  })

  // Task progress, from the main session's own task list (subagents are ignored).
  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const result = await next(e)
    if (e.agentId || result.deny !== undefined || result.isError) return result
    try {
      await update($, tasks, () =>
        (e.todos ?? []).map((t, i) => ({
          id: String(i),
          subject: clean(t.content ?? ''),
          status: t.status,
          activeForm: t.activeForm === undefined ? undefined : clean(t.activeForm),
        })),
      )
    } catch {}
    return result
  })

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const result = await next(e)
    if (e.agentId || result.deny !== undefined || result.isError) return result
    try {
      const id = result.result.task.id
      const subject = clean(e.subject ?? '')
      const activeForm = e.activeForm === undefined ? undefined : clean(e.activeForm)
      await update($, tasks, (list): TaskItem[] => {
        // A fresh plan: once every earlier task is done, start the list over.
        const keep = list.every(t => t.status === 'completed') ? [] : list
        const added: TaskItem = { id, subject, status: 'pending', activeForm }
        return [...keep.filter(t => t.id !== id), added]
      })
    } catch {}
    return result
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const result = await next(e)
    if (e.agentId || result.deny !== undefined || result.isError) return result
    try {
      const status = e.status
      const subject = e.subject === undefined ? undefined : clean(e.subject)
      const activeForm = e.activeForm === undefined ? undefined : clean(e.activeForm)
      await update($, tasks, (list): TaskItem[] =>
        status === 'deleted'
          ? list.filter(t => t.id !== e.taskId)
          : list.map(t =>
              t.id !== e.taskId
                ? t
                : {
                    ...t,
                    subject: subject ?? t.subject,
                    activeForm: activeForm ?? t.activeForm,
                    status: status ?? t.status,
                  },
            ),
      )
    } catch {}
    return result
  })

  on('command.run', { command: 'cli-status' }, async ($, e) => {
    const hidden = !(await read($, isHidden))
    await update($, isHidden, () => hidden)
    return { text: hidden ? 'Status line hidden.' : 'Status line shown.' }
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (await read($, isHidden)) return next(e)

    let started = false
    let engineLine: Awaited<ReturnType<typeof next>> | undefined
    try {
      const { Box, Text } = $.ui.resolve(e)
      const u = await read($, usage)
      const id = await read($, model)
      const p = progressOf(await read($, tasks))
      await read($, tick)
      const working = !!e.props.isWorking
      // Render is authoritative: covers interrupted turns and hot reload mid-turn.
      if (!working && spinTimer) stopSpinner()
      else if (working && !spinTimer) startSpinner($)
      const fr = await read($, frame)
      const now = await $.clock.now()
      const cols = e.viewport?.columns ?? 80

      // A segment is its drawn tree plus its plain width, so rows can be fitted.
      type Seg = { w: number; node: RenderElement }
      const seg = (key: string, w: number, node: RenderElement): Seg => ({ w, node: <Box key={key}>{node}</Box> })

      // A field of independently twinkling dots; static and dim when idle.
      const sparkles = (key: string, from: number) => (
        <Text key={key}>
          {Array.from({ length: 4 }, (_, i) => {
            const phase = ((from + i) * 7 + 3) % WAVE
            const t = (fr + phase) % WAVE
            const step = working ? (t <= WAVE / 2 ? t : WAVE - t) : 1
            const r = RAMP[Math.min(step, RAMP.length - 1)]!
            return (
              <Text key={String(i)} color={r.c}>
                {r.g}
              </Text>
            )
          })}
        </Text>
      )
      // Each level drops more detail than the one before it.
      const build = (lv: number): Seg[] => {
        const bars = lv < 5
        const segs: Seg[] = []

        {
          // The pill is always first: tasks, "working" (no tasks), or a muted placeholder.
          const idle = !p && !working
          const frac = p ? `${p.done}/${p.total}` : ''
          let text: string
          if (lv >= 5) text = p ? frac : working ? '…' : '—'
          else if (!p) text = working ? 'working' : 'no tasks'
          else {
            const raw = p.running ? (p.running.activeForm ?? p.running.subject) : ''
            const max = lv < 1 ? 24 : 16
            const label = lv < 2 && raw ? fit(raw, max) : ''
            text = (label ? `${label} ` : '') + frac + (p.done === p.total ? ' ✓' : '')
          }
          text = ` ${text} `
          const fields = lv < 3
          const withBar = lv < 4
          const capColor = idle ? PALETTE.track : PALETTE.accent

          // Bar: real progress, an indeterminate sweep while working, or an empty track.
          let barNode: RenderElement | null = null
          if (withBar) {
            if (p) {
              const [fill, rest] = bar(p.fraction, 10)
              barNode = (
                <Text>
                  <Text color={PALETTE.accent}>{fill}</Text>
                  <Text color={PALETTE.track}>{rest}</Text>
                </Text>
              )
            } else if (working) {
              const pos = (fr % 12) - 1
              const a = Math.max(0, pos)
              const b = Math.min(10, pos + 2)
              const n = Math.max(0, b - a)
              barNode = (
                <Text>
                  <Text color={PALETTE.track}>{'▱'.repeat(a)}</Text>
                  <Text color={PALETTE.accent}>{'▰'.repeat(n)}</Text>
                  <Text color={PALETTE.track}>{'▱'.repeat(10 - a - n)}</Text>
                </Text>
              )
            } else {
              barNode = <Text color={PALETTE.track}>{'▱'.repeat(10)}</Text>
            }
          }

          const w = (fields ? 5 : 0) + 2 + cells(text) + (withBar ? 11 : 0) + (fields ? 5 : 0)
          segs.push(
            seg('task', w, (
              <Text wrap="truncate-end">
                {fields ? sparkles('sl', 0) : null}
                {fields ? ' ' : null}
                <Text color={capColor}>▐</Text>
                <Text bold={!idle} backgroundColor={idle ? PALETTE.track : PALETTE.accent} color={idle ? PALETTE.muted : PALETTE.ink}>
                  {text}
                </Text>
                <Text color={capColor}>▌</Text>
                {withBar ? ' ' : null}
                {barNode}
                {fields ? ' ' : null}
                {fields ? sparkles('sr', 4) : null}
              </Text>
            )),
          )
        }

        const name = modelName(id)
        segs.push(
          seg('model', cells(name) + (lv < 5 ? 2 : 0), (
            <Text>
              <Text bold color={PALETTE.accent}>
                {name}
              </Text>
              {lv < 5 ? <Text color={PALETTE.accent}>{working ? ` ${SNAKE[fr % SNAKE.length]}` : '  '}</Text> : null}
            </Text>
          )),
        )

        if (u.ctxWindow) {
          const pct = u.ctxPercent ?? 0
          const label = u.ctxPercent === null ? '—' : `${pct}%`
          const [fill, rest] = bar(pct / 100, 10)
          segs.push(
            seg('ctx', 4 + (bars ? 11 : 0) + label.length, (
              <Text>
                <Text color={PALETTE.muted}>ctx </Text>
                {bars ? <Text color={level(pct)}>{fill}</Text> : null}
                {bars ? <Text color={PALETTE.track}>{rest}</Text> : null}
                {bars ? ' ' : null}
                <Text color={PALETTE.text}>{label}</Text>
              </Text>
            )),
          )
        }

        for (const l of u.limits) {
          const isFive = l.kind === 'five_hour'
          if (lv >= 4 && !isFive) continue
          const name = limitLabel(l.kind)
          const reset = lv < 3 ? untilReset(l.resetsAt, now) : ''
          const label = `${l.percentUsed}%`
          const [fill, rest] = bar(l.percentUsed / 100, 10)
          const miniBar = bars && isFive
          segs.push(
            seg(`limit-${l.kind}`, cells(name) + 1 + (miniBar ? 11 : 0) + label.length + (reset ? reset.length + 2 : 0), (
              <Text>
                <Text color={PALETTE.muted}>{name} </Text>
                {miniBar ? <Text color={level(l.percentUsed)}>{fill}</Text> : null}
                {miniBar ? <Text color={PALETTE.track}>{rest}</Text> : null}
                {miniBar ? ' ' : null}
                <Text color={level(l.percentUsed)}>{label}</Text>
                {reset ? <Text color={PALETTE.muted}> ↻{reset}</Text> : null}
              </Text>
            )),
          )
        }

        if (u.costUsd !== null) {
          const cost = `$${u.costUsd.toFixed(2)}`
          segs.push(seg('cost', cost.length, <Text color={PALETTE.money}>{cost}</Text>))
        }
        return segs
      }

      const widthOf = (segs: Seg[]) => 2 + segs.reduce((n, s) => n + s.w, 0) + Math.max(0, segs.length - 1) * 3

      let lv = 0
      let segs = build(0)
      while (lv < 5 && widthOf(segs) > cols) segs = build(++lv)

      // Row 1: the engine's own line (mode pill such as "accept edits on", hints),
      // kept live. Row 2: the status.
      started = true
      engineLine = await next(e)
      return (
        <Box flexDirection="column">
          {engineLine}
          <Box flexDirection="row" flexWrap="nowrap" overflow="hidden" paddingX={1}>
            {segs.flatMap((s, i) => (i === 0 ? [s.node] : [<Text key={`sep-${i}`} color={PALETTE.dim}> │ </Text>, s.node]))}
          </Box>
        </Box>
      )
    } catch (err) {
      // Never leave the prompt hint blank: fall back to the engine's own line.
      if (engineLine !== undefined) return engineLine
      if (started) throw err
      return next(e)
    }
  })
}
