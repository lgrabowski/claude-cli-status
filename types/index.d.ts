export type TaskStatus = 'pending' | 'in_progress' | 'completed'

export type TaskItem = { id: string; subject: string; status: TaskStatus; activeForm?: string }

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Usage = {
  ctxTokens: number | null
  ctxWindow: number
  ctxPercent: number | null
  limits: Limit[]
  costUsd: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'cli-status': { usage: Usage; tasks: TaskItem[]; model: string; isHidden: boolean; frame: number; tick: number }
  }
}
