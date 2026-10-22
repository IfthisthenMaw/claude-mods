import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRun, Flow, Panel, Phase, PlannedTask } from '../types'

const flow = atom({ plugin: 'agent-progress', key: 'flow' } as const, null)
const agents = atom({ plugin: 'agent-progress', key: 'agents' } as const, [])
const panel = atom({ plugin: 'agent-progress', key: 'panel' } as const, {
  isCompact: false,
  isDoneCollapsed: false,
  autoOpenedFor: '',
})
const now = atom({ plugin: 'agent-progress', key: 'now' } as const, 0)

const TOOL = 'mcp__agent-progress__progress'
const STEP_TOOL = 'mcp__agent-progress__step'
// Appended to a subagent's brief while a plan is live: subagents follow a request
// in their brief more reliably than a tool description.
const STEP_BRIEF = `

Progress reporting: before any other work, call \`${STEP_TOOL}\` with \`total\` (your plan in 3 to 8 steps) and \`done: 0\`; call it again with \`done\` and a few-word \`note\` as each step finishes. It only draws a progress bar.`
const PANE = 'agent-progress'
const PHASES: readonly Phase[] = ['plan', 'design', 'delegate', 'review', 'close']
// Tool schemas are advice to the model, not a check: what a call may draw is bounded here.
const MAX_TASKS = 200
const MAX_AFTER = 20
const MAX_TITLE = 120
const MAX_RUNS = 200
// Avon brand red for a live plan, green once closed.
const ACCENT = '#E4003B'
const DONE = '#3B9C5F'

type ProgressInput = {
  title?: string
  total?: number
  done?: number
  phase?: Phase
  finished?: boolean
  tasks?: { title?: string; after?: number[] }[]
}

// ---------------------------------------------------------------------------
// The flow: the plan the main session reports.

const blank = (): Flow => ({ title: 'Plan', total: 0, done: 0, running: 0, phase: 'plan', isFinished: false, tasks: [] })

const clip = (s: string, max: number): string => (s.length > max ? s.slice(0, Math.max(1, max - 1)) + '…' : s)

const isNewFlow = (prev: Flow | null, input: ProgressInput): boolean =>
  !prev || prev.isFinished || (input.title !== undefined && clip(input.title.trim(), MAX_TITLE) !== prev.title)

const cleanTasks = (tasks: ProgressInput['tasks']): PlannedTask[] | undefined =>
  tasks
    ?.filter(t => t.title?.trim())
    .slice(0, MAX_TASKS)
    .map(t => ({
      title: clip((t.title ?? '').trim(), MAX_TITLE),
      after: (t.after ?? []).filter(n => Number.isInteger(n) && n > 0).slice(0, MAX_AFTER),
    }))

const merge = (prev: Flow | null, input: ProgressInput): Flow => {
  // A new title is a new flow: counters never carry over from an earlier one.
  const base = isNewFlow(prev, input) || !prev ? blank() : { ...blank(), ...prev }
  const tasks = cleanTasks(input.tasks) ?? base.tasks
  const total = Math.min(MAX_TASKS, Math.max(0, Math.round(input.total ?? (input.tasks ? tasks.length : base.total))))
  const done = Math.min(total || Infinity, Math.max(0, Math.round(input.done ?? base.done)))
  const phase = input.phase && PHASES.includes(input.phase) ? input.phase : base.phase
  return {
    ...base,
    title: clip(input.title?.trim() || base.title, MAX_TITLE),
    total,
    done,
    phase: input.finished ? 'close' : phase,
    isFinished: input.finished === true,
    tasks,
  }
}

const label = (f: Flow): string => {
  if (f.isFinished) return 'Done'
  if (f.phase === 'plan') return 'Planning'
  if (f.phase === 'design') return 'Design'
  const count = f.total ? `${f.done}/${f.total}` : `${f.running} running`
  return `${f.phase === 'review' ? 'Review' : 'Tasks'} ${count}`
}

const ratio = (f: Flow): number => (f.isFinished ? 1 : f.total ? f.done / f.total : 0)

const bar = (share: number, width: number): string => {
  const filled = Math.round(width * Math.max(0, Math.min(1, share)))
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled))
}

// ---------------------------------------------------------------------------
// Cost and context. The engine reports tokens, not money, so cost is an estimate.
// USD per million tokens: input, output, cache read, cache write. The first match wins,
// so a release sits above its family. Taken from johnnyvizz/claude-kit savvy-progress
// 1.2.1 (list prices as of 2026-10-10); not checked against Anthropic's price page.

type Price = [input: number, output: number, cacheRead: number, cacheWrite: number]

const PRICES: [RegExp, Price][] = [
  [/(fable|mythos)-5-1/, [10, 50, 0.25, 20]],
  [/fable|mythos/, [10, 50, 1, 20]],
  [/opus-5-5/, [4, 20, 0.2, 8]],
  [/opus/, [5, 25, 0.5, 10]],
  [/sonnet-5-5/, [2, 10, 0.1, 4]],
  [/sonnet-5/, [2, 10, 0.2, 4]],
  [/sonnet/, [3, 15, 0.3, 6]],
  [/haiku-5-5/, [0.1, 0.5, 0.01, 0.2]],
  [/haiku/, [1, 5, 0.1, 2]],
]
const DEFAULT_PRICE: Price = [4, 20, 0.2, 8]

type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

const tokensOf = (u: Usage): number =>
  (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)

const costOf = (model: string, u: Usage): number => {
  const [i, o, r, w] = PRICES.find(([re]) => re.test(model.toLowerCase()))?.[1] ?? DEFAULT_PRICE
  return (
    ((u.input_tokens || 0) * i +
      (u.output_tokens || 0) * o +
      (u.cache_read_input_tokens || 0) * r +
      (u.cache_creation_input_tokens || 0) * w) /
    1e6
  )
}

// Haiku 4.5 and the Claude 3 models have a 200K window; the rest 1M.
const windowOf = (model: string): number => (/haiku-4|claude-3/i.test(model) ? 200_000 : 1_000_000)

// "Opus 5.5" from "claude-opus-5-5".
const modelName = (id: string): string => {
  const m = /(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id)
  const [, family = '', major = '', minor] = m ?? []
  if (!family) return id.replace(/^claude-/, '').replace(/\[.*\]$/, '') || '-'
  return `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()} ${major}${minor ? '.' + minor : ''}`
}

const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

const fmtTokens = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${Math.round(n)}`

const fmtCost = (usd: number): string => `$${usd < 10 ? usd.toFixed(2) : usd.toFixed(1)}`

const fmtTime = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

const elapsed = (a: AgentRun, at: number): number => (a.endedAt ?? Math.max(at, a.startedAt)) - a.startedAt

const ctxOf = (a: AgentRun): number => (a.contextMax ? Math.min(100, Math.round((a.contextTokens / a.contextMax) * 100)) : 0)

// The run's own progress when it reports steps; a finished run is full; else null.
const progressOf = (a: AgentRun): number | null => {
  if (a.status === 'done') return 1
  if (a.stepTotal) return Math.min(1, (a.stepDone ?? 0) / a.stepTotal)
  return null
}

type Planned = PlannedTask & { n: number }

// Planned tasks with no run yet, matched to runs by the Agent description.
const plannedOf = (f: Flow | null, list: AgentRun[]): Planned[] => {
  if (!f || f.isFinished) return []
  const started = new Set(list.map(a => norm(a.description)))
  return f.tasks.map((t, i) => ({ ...t, n: i + 1 })).filter(t => !started.has(norm(t.title)))
}

const totals = (list: AgentRun[], at: number) => {
  if (!list.length) return { cost: 0, tokens: 0, time: 0 }
  const start = Math.min(...list.map(a => a.startedAt))
  const end = Math.max(...list.map(a => a.endedAt ?? Math.max(at, a.startedAt)))
  return {
    cost: list.reduce((s, a) => s + a.costUsd, 0),
    tokens: list.reduce((s, a) => s + a.tokens, 0),
    time: end - start,
  }
}

const GLYPH: Record<string, string> = { running: '●', done: '✓', failed: '✗', planned: '◷' }
const GLYPH_COLOR: Record<string, string> = { running: ACCENT, done: DONE, failed: 'red', planned: 'gray' }

// ---------------------------------------------------------------------------
// The pane.

async function openPane($: EngineInterface): Promise<void> {
  const at = await $.clock.now()
  await update($, now, () => at)
  await $.ui.open({ id: PANE, title: 'Agents' })
}

// Opens the pane, or closes it when it is up; true when it ends up open.
async function togglePane($: EngineInterface): Promise<boolean> {
  if ((await $.ui.panes()).some(p => p.id === PANE)) {
    await $.ui.close({ id: PANE })
    return false
  }
  await openPane($)
  return true
}

// Opens the pane once per key, so closing it is respected until a new plan arrives.
async function autoOpen($: EngineInterface, key: string): Promise<void> {
  const p = await read($, panel)
  if (p.autoOpenedFor === key) return
  await update($, panel, prev => ({ ...prev, autoOpenedFor: key }))
  void openPane($)
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.tool.register({
      name: 'progress',
      description:
        'Report the progress of planned multi-agent work to the band above the prompt and the agents pane. ' +
        'Call it after presenting the plan (title, tasks, phase "delegate"), each time a task is accepted (done), ' +
        'when switching phase or re-planning (tasks), and once at the end with finished: true. Fields left out keep their value. ' +
        'Main session only: a call from a subagent is ignored (subagents report with `step`).',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short name of the overall task, a few words.' },
          total: { type: 'integer', minimum: 0, description: 'Number of planned subagent tasks.' },
          done: { type: 'integer', minimum: 0, description: 'Number of tasks accepted after review.' },
          phase: { type: 'string', enum: [...PHASES] },
          finished: { type: 'boolean', description: 'True once the work is closed.' },
          tasks: {
            type: 'array',
            description:
              'The planned subagent tasks in order, numbered from 1. Each title must equal the Agent tool `description` the task will be delegated with, so the pane can match runs to tasks.',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'A few words; reused verbatim as the Agent description.' },
                after: { type: 'array', items: { type: 'integer' }, description: 'Numbers of the tasks this one waits for.' },
              },
              required: ['title'],
            },
          },
        },
      },
    })
    await $.tool.register({
      name: 'step',
      description:
        'For subagents: report progress on your own task to the agents pane. ' +
        'Right after reading the brief, call it with `total` (your plan in 3 to 8 steps) and `done: 0`; ' +
        'call it again as each step finishes. It only draws a bar.',
      inputSchema: {
        type: 'object',
        properties: {
          done: { type: 'integer', minimum: 0, description: 'Steps finished so far.' },
          total: { type: 'integer', minimum: 1, description: 'Steps planned; may change if the plan changes.' },
          note: { type: 'string', description: 'The step in progress, a few words.' },
        },
        required: ['done'],
      },
      // Listed up front, not behind ToolSearch: subagents do not go looking for it.
      isDeferred: false,
    })
    await $.command.register({
      name: 'agents-info',
      description: 'Show or hide the agents pane: running, finished and planned subagents with model, steps, context, cost and time',
    })

    // Ticks the running agents' clocks; quiet when nothing runs.
    $.clock.every(1000, () => {
      void (async () => {
        const list = await read($, agents)
        if (!list.some(a => a.status === 'running')) return
        const at = await $.clock.now()
        await update($, now, () => at)
      })()
    })
    return started
  })

  on('command.run', { command: 'agents-info' }, async ($, e) => {
    // `/agents-info open` opens the pane or brings it forward without toggling.
    if ((e.args ?? '').trim() === 'open') {
      await openPane($)
      return { text: 'Agents pane opened.' }
    }
    return { text: (await togglePane($)) ? 'Agents pane opened.' : 'Agents pane closed.' }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    // The flow belongs to the main session: a subagent's call carries its agentId
    // and changes nothing, or any subagent could rename, finish or reset the flow.
    if (e.agentId) return { result: 'ignored: only the main session reports the plan' }
    const input = e as unknown as ProgressInput
    const prev = await read($, flow)
    if (isNewFlow(prev, input) && input.title !== undefined) {
      // A new flow starts with a clean list; agents still running stay.
      await update($, agents, list => list.filter(a => a.status === 'running'))
    }
    const next = await update($, flow, p => merge(p, input))
    if (next && input.tasks?.length) await autoOpen($, next.title)
    return { result: `ok: ${label(next ?? blank())}` }
  })

  // A subagent's own progress: the call runs in its loop, so agentId names it.
  on('tool.call', { tool: STEP_TOOL }, async ($, e) => {
    const input = e as unknown as { done?: number; total?: number; note?: string }
    const agentId = e.agentId
    if (!agentId) return { result: 'ignored: only subagents report steps' }
    let matched = false
    await update($, agents, list =>
      list.map(a => {
        if (a.agentId !== agentId) return a
        matched = true
        const total = Math.max(0, Math.round(input.total ?? a.stepTotal ?? 0))
        const done = Math.max(0, Math.round(input.done ?? a.stepDone ?? 0))
        return {
          ...a,
          stepTotal: total,
          stepDone: total ? Math.min(total, done) : done,
          stepNote: input.note?.trim() ? clip(input.note.trim(), MAX_TITLE) : undefined,
        }
      }),
    )
    return { result: matched ? 'ok' : `ignored: no pane row for agent ${agentId}` }
  })

  // Counts launches in flight, so the band moves even if the main session forgets to report.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const f = await read($, flow)
    if (!f || f.isFinished) return next(e)
    await update($, flow, prev =>
      prev ? { ...prev, running: prev.running + 1, phase: prev.phase === 'plan' ? 'delegate' : prev.phase } : prev,
    )
    try {
      return await next(e)
    } finally {
      await update($, flow, prev => (prev ? { ...prev, running: Math.max(0, prev.running - 1) } : prev))
    }
  })

  on('agent.spawn', async ($, e, next) => {
    const f = await read($, flow)
    const isLive = f !== null && !f.isFinished
    const isUnbriefed = isLive && !e.prompt.includes(STEP_TOOL)
    const started = await next(isUnbriefed ? { ...e, prompt: e.prompt + STEP_BRIEF } : e)
    if (started.deny !== undefined) return started

    const at = await $.clock.now()
    await update($, agents, list => {
      const run: AgentRun = {
        id: started.agentId ?? e.tool_use_id,
        agentId: started.agentId,
        type: e.subagentType,
        description: e.description,
        model: started.model,
        status: 'running',
        startedAt: at,
        contextTokens: 0,
        contextMax: windowOf(started.model),
        tokens: 0,
        costUsd: 0,
        steps: 0,
      }
      return [...list.filter(a => a.id !== run.id), run].slice(-MAX_RUNS)
    })
    await update($, now, () => at)
    if (isLive && f) await autoOpen($, f.title)
    else if (options.autoOpen === 'any') await autoOpen($, 'any-agent')
    return started
  })

  // Each model request of a subagent: live context, tokens and cost.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const agentId = e.agentId
    const usage = result.usage
    if (!agentId || !usage) return result

    const model = usage.model || e.model
    await update($, agents, list =>
      list.map((a): AgentRun =>
        a.agentId !== agentId
          ? a
          : {
              ...a,
              model,
              effort: typeof e.effort === 'string' ? e.effort : a.effort,
              status: 'running',
              endedAt: undefined,
              contextTokens: tokensOf(usage),
              contextMax: windowOf(model),
              tokens: a.tokens + tokensOf(usage),
              costUsd: a.costUsd + costOf(model, usage),
              steps: a.steps + 1,
            },
      ),
    )
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId) {
      const at = await $.clock.now()
      await update($, agents, list =>
        list.map((a): AgentRun => {
          if (a.agentId !== agentId) return a
          // A run whose steps went unseen still gets the turn's own sum.
          const usage = a.steps === 0 ? e.usage : undefined
          return {
            ...a,
            status: e.reason === 'answer' ? 'done' : 'failed',
            endedAt: at,
            ...(usage
              ? { model: usage.model || a.model, tokens: tokensOf(usage), costUsd: costOf(usage.model || a.model, usage) }
              : {}),
          }
        }),
      )
      await update($, now, () => at)
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, agents)
    const f = await read($, flow)
    const p: Panel = await read($, panel)
    const at = Math.max(await read($, now), ...list.map(a => a.startedAt), 0)

    const running = list.filter(a => a.status === 'running').reverse()
    const finished = list.filter(a => a.status !== 'running').reverse()
    const planned = plannedOf(f, list)
    const t = totals(list, at)
    const title = f && !f.isFinished ? f.title : ''
    const cols = Math.max(24, e.props.bodyColumns || 40)
    const barW = Math.max(6, Math.min(20, cols - 34))

    const toggleCompact = (
      <Button
        key="compact"
        label={p.isCompact ? 'Expand' : 'Collapse'}
        plain
        onPress={() => update($, panel, prev => ({ ...prev, isCompact: !prev.isCompact }))}
      />
    )
    const toggleDone = (
      <Button
        key="done"
        label={`${p.isDoneCollapsed ? '▸' : '▾'} Finished · ${finished.length}`}
        plain
        onPress={() => update($, panel, prev => ({ ...prev, isDoneCollapsed: !prev.isDoneCollapsed }))}
      />
    )

    const row = (a: AgentRun) => {
      const ctx = ctxOf(a)
      const progress = progressOf(a)
      const model = a.effort ? `${modelName(a.model)} · ${a.effort}` : modelName(a.model)
      const steps = a.stepTotal ? `${a.stepDone ?? 0}/${a.stepTotal}${a.stepNote ? ' ' + a.stepNote : ''} · ` : ''
      return (
        <Box key={a.id} flexDirection="column" marginBottom={1}>
          <Box flexDirection="row" gap={1}>
            <Text color={GLYPH_COLOR[a.status]}>{GLYPH[a.status]}</Text>
            <Text bold wrap="truncate-end">
              {a.description || a.type}
            </Text>
          </Box>
          <Text dimColor wrap="truncate-end">
            {'  '}
            {a.type} · {model}
            {a.status === 'failed' ? ' · error' : ''}
          </Text>
          <Text wrap="truncate-end">
            {'  '}
            {/* Without reported steps the bar shows context fill, dimmed. */}
            {progress === null ? <Text dimColor>{bar(ctx / 100, barW)}</Text> : <Text color={ACCENT}>{bar(progress, barW)}</Text>}
            <Text dimColor>
              {' '}
              {steps}ctx {ctx}% · {fmtTokens(a.contextTokens)} ≈{fmtCost(a.costUsd)} {fmtTime(elapsed(a, at))}
            </Text>
          </Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold wrap="truncate-end">
            {title}
          </Text>
          {toggleCompact}
        </Box>
        <Text dimColor>
          ≈{fmtCost(t.cost)} · {fmtTokens(t.tokens)} tokens · {fmtTime(t.time)}
        </Text>
        {p.isCompact ? (
          <Text wrap="truncate-end">
            {[...running, ...finished].map(a => (
              <Text key={a.id} color={GLYPH_COLOR[a.status]}>
                {GLYPH[a.status]}{' '}
              </Text>
            ))}
            {planned.map(pl => (
              <Text key={`plan-${pl.n}`} dimColor>
                {GLYPH.planned}{' '}
              </Text>
            ))}
          </Text>
        ) : (
          <Box flexDirection="column" marginTop={1}>
            {list.length === 0 && planned.length === 0 && <Text dimColor>No subagents yet.</Text>}
            {running.length > 0 && <Text dimColor>Running · {running.length}</Text>}
            {running.map(row)}
            {finished.length > 0 && toggleDone}
            {!p.isDoneCollapsed && finished.map(row)}
            {planned.length > 0 && <Text dimColor>Planned · {planned.length}</Text>}
            {planned.map(pl => (
              <Box key={`plan-${pl.n}`} flexDirection="column" marginBottom={1}>
                <Text dimColor wrap="truncate-end">
                  {GLYPH.planned} {pl.n}. {pl.title}
                </Text>
                {pl.after.length > 0 && (
                  <Text dimColor wrap="truncate-end">
                    {'  '}after {pl.after.join(', ')}
                  </Text>
                )}
              </Box>
            ))}
          </Box>
        )}
      </Box>
    )
  })

  // ---------------------------------------------------------------------------
  // The band above the prompt.

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const f = await read($, flow)
    if (f === null || e.props.hasSurvey) return next(e)
    // Draw this row with other mods' bands beneath it. The engine's own placeholder
    // ({ type: 'engine' }) is never nested: the desktop drops a band that nests it.
    const drawn = await Promise.resolve(next(e)).catch(() => null)
    const below = drawn && typeof drawn === 'object' && (drawn as { type?: string }).type !== 'engine' ? drawn : null

    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, agents)
    const crew = list.length + plannedOf(f, list).length
    const color = f.isFinished ? DONE : ACCENT
    const cols = e.props.bodyColumns || 100
    const titleW = Math.max(8, Math.min(30, f.title.length + 2, Math.floor(cols / 3)))
    const width = Math.max(6, Math.min(40, cols - titleW - 32))

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={2} alignItems="center">
          <Box width={titleW} flexShrink={0}>
            <Text color={color}>● </Text>
            <Text wrap="truncate-end">{f.title}</Text>
          </Box>
          <Text color={color}>{bar(ratio(f), width)}</Text>
          <Text bold>{label(f)}</Text>
          <Text dimColor>{Math.round(ratio(f) * 100)}%</Text>
          <Button key="crew" label={`Agents ×${crew}`} plain onPress={() => void togglePane($)} />
          <Button key="dismiss" label="✕" plain role="dismiss" onPress={() => update($, flow, () => null)} />
        </Box>
        {below}
      </Box>
    )
  })
}
