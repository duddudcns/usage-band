export type Usage = {
  ctxPercent?: number
  ctxTokens?: number
  ctxWindow: number
  limits: { kind: string; percentUsed: number; resetsAt?: string }[]
  limitsAt?: number // 엔진 limits가 마지막으로 들어온 시각(ms)
}

export type ClaudeLimits = { fetchedAt: number; limits: Usage['limits'] }

export type CodexWindow = { usedPercent: number; resetsAt?: number }
export type CodexAccount = { plan: string; fiveHour?: CodexWindow; weekly?: CodexWindow }
export type CodexUsage = { fetchedAt: number; accounts: CodexAccount[] }

declare module 'claude-code' {
  interface PluginState {
    'usage-band': { usage: Usage | null; claude: ClaudeLimits | null; codex: CodexUsage | null }
  }
}
