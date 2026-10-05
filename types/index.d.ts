export type Usage = {
  ctxPercent?: number
  ctxTokens?: number
  ctxWindow: number
  limits: { kind: string; percentUsed: number; resetsAt?: string }[]
}

declare module 'claude-code' {
  interface PluginState {
    'usage-band': { usage: Usage | null }
  }
}
