export type Phase = 'plan' | 'design' | 'delegate' | 'review' | 'close'

export type PlannedTask = { title: string; after: number[] }

export type Flow = {
  title: string
  total: number
  done: number
  running: number
  phase: Phase
  isFinished: boolean
  tasks: PlannedTask[]
}

export type AgentStatus = 'running' | 'done' | 'failed'

export type AgentRun = {
  id: string
  agentId?: string
  type: string
  description: string
  model: string
  effort?: string
  status: AgentStatus
  startedAt: number
  endedAt?: number
  contextTokens: number
  contextMax: number
  tokens: number
  costUsd: number
  steps: number
  /** Self-reported by the subagent through the `step` tool. */
  stepDone?: number
  stepTotal?: number
  stepNote?: string
}

export type Panel = { isCompact: boolean; isDoneCollapsed: boolean; autoOpenedFor: string }

declare module 'claude-code' {
  interface PluginState {
    'agent-progress': {
      flow: Flow | null
      agents: AgentRun[]
      panel: Panel
      now: number
    }
  }
}
