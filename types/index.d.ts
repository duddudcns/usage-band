export type Usage = {
  ctxPercent?: number
  ctxTokens?: number
  ctxWindow: number
  limits: { kind: string; percentUsed: number; resetsAt?: string }[]
}

export type CodexWindow = { usedPercent: number; resetsAt?: number }
export type CodexAccount = { plan: string; fiveHour?: CodexWindow; weekly?: CodexWindow }
export type CodexUsage = { fetchedAt: number; accounts: CodexAccount[] }

declare module 'claude-code' {
  interface PluginState {
    'usage-band': { usage: Usage | null; codex: CodexUsage | null }
  }
}
