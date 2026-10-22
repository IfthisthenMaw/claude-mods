import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const PROGRESS = 'mcp__agent-progress__progress'
const BAND = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100 } as never } as const

async function session($: Engine, on: On) {
  mock.clock(on, { now: Date.parse('2026-10-22T09:00:00Z') })
  // Stand-ins for the engine beneath the plugin.
  on('session.start', async () => ({ cwd: '/repo' }) as never)
  on('tool.register', async () => ({ value: {} }) as never)
  on('command.register', async () => ({ value: { command: 'agents-info' } }) as never)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start({ source: 'startup', cwd: '/repo', surface: 'terminal', isInteractive: true } as never)
}

async function bandHas($: Engine, surface: 'terminal' | 'desktop', text: RegExp): Promise<boolean> {
  const ui = await $.ui.mount({ plugin: 'agent-progress', surface, ...BAND })
  const found = await ui.findAll({ type: 'Text', text })
  await ui.unmount()
  return found.length > 0
}

test('the main session reports a plan and the band draws it on each surface', async ($, on) => {
  await session($, on)
  const r = await $.tool.call({ tool: PROGRESS, title: 'Ship it', total: 4, done: 1, phase: 'delegate' } as never)
  expect(r).toMatchObject({ result: 'ok: Tasks 1/4' })
  for (const surface of ['terminal', 'desktop'] as const) {
    expect(await bandHas($, surface, /^Ship it$/)).toBe(true)
    expect(await bandHas($, surface, /^Tasks 1\/4$/)).toBe(true)
  }
})

test('a subagent cannot rename, finish or start the plan', async ($, on) => {
  await session($, on)
  const started = await $.tool.call({ tool: PROGRESS, agentId: 'a1', title: 'Hijacked', total: 2 } as never)
  expect(started).toMatchObject({ result: 'ignored: only the main session reports the plan' })

  await $.tool.call({ tool: PROGRESS, title: 'Real plan', total: 3, done: 1, phase: 'delegate' } as never)
  const hijack = await $.tool.call({ tool: PROGRESS, agentId: 'a1', title: 'Hijacked', finished: true } as never)
  expect(hijack).toMatchObject({ result: 'ignored: only the main session reports the plan' })
  expect(await bandHas($, 'terminal', /^Real plan$/)).toBe(true)
  expect(await bandHas($, 'terminal', /Hijacked/)).toBe(false)
})

test('the step tool is for subagents only', async ($, on) => {
  await session($, on)
  const r = await $.tool.call({ tool: 'mcp__agent-progress__step', done: 1, total: 3 } as never)
  expect(r).toMatchObject({ result: 'ignored: only subagents report steps' })
})

test('no plan, no band', async ($, on) => {
  await session($, on)
  expect(await bandHas($, 'terminal', /Tasks|Planning/)).toBe(false)
  expect(await bandHas($, 'terminal', /^engine$/)).toBe(true)
})
