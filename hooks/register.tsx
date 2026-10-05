import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Usage } from '../types'

const usage = atom({ plugin: 'usage-band', key: 'usage' } as const, null)

const LABELS: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }
const LOW_REMAIN = 20

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return Math.round(n / 1_000) + 'K'
  return String(n)
}

// 기존 statusline과 동일: 남은 % 기준 색
function remainColor(rem: number): string {
  if (rem > 50) return 'green'
  if (rem > LOW_REMAIN) return 'yellow'
  return 'red'
}

// 컨텍스트는 사용 % 기준 색
function ctxColor(used: number): string {
  if (used < 50) return 'green'
  if (used < 80) return 'yellow'
  return 'red'
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

// "HH:MM", 1일 이상이면 "D HH:MM"; 잔여 20% 이하면 "MM/DD HH:MM" 리셋 시각 추가
function fmtReset(resetsAt: string, now: number, rem: number): string {
  const target = Date.parse(resetsAt)
  if (Number.isNaN(target)) return ''
  const diff = Math.max(0, Math.floor((target - now) / 1000))
  const days = Math.floor(diff / 86400)
  const hm = `${pad(Math.floor((diff % 86400) / 3600))}:${pad(Math.floor((diff % 3600) / 60))}`
  let s = days > 0 ? `${days} ${hm}` : hm
  if (rem <= LOW_REMAIN) {
    const d = new Date(target)
    s += `, ${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
  return s
}

const HEX: Record<string, string> = { green: '#3fb950', yellow: '#d29922', red: '#f85149' }

// 둥근 게이지 바 (트랙은 반투명 회색이라 라이트/다크 둘 다 보임)
function bar(pct: number, color: string): string {
  const w = Math.max(0, Math.min(100, pct)) * 0.72
  const fill = HEX[color] ?? color
  return `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="8" viewBox="0 0 72 8">` +
    `<rect width="72" height="8" rx="4" fill="#8b949e" fill-opacity="0.25"/>` +
    `<rect width="${w.toFixed(1)}" height="8" rx="4" fill="${fill}"/></svg>`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    const u = await $.session.usage()
    await update($, usage, () => ({
      ctxPercent: u.context.percent,
      ctxTokens: u.context.tokens,
      ctxWindow: u.context.window,
      limits: u.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
    }))
    return r
  })

  on('session.measure', async ($, e, next) => {
    const r = await next(e)
    await update($, usage, () => ({
      ctxPercent: e.context.percent,
      ctxTokens: e.context.tokens,
      ctxWindow: e.context.window,
      limits: e.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
    }))
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const u = await read($, usage)
    if (e.props.hasSurvey || u === null) return next(e)

    const now = await $.clock.now()
    const ui = $.ui.resolve(e)
    const { Box, Text } = ui
    const used = u.ctxPercent ?? 0
    const tokens = u.ctxTokens !== undefined ? `${fmtTokens(u.ctxTokens)} / ${fmtTokens(u.ctxWindow)}` : `– / ${fmtTokens(u.ctxWindow)}`

    if (e.surface === 'desktop' && 'Svg' in ui) {
      const { Svg } = ui as typeof ui & { Svg: (p: { source: string; alt: string; width?: number; height?: number }) => unknown }
      const chip = (key: string, label: string, pct: number, color: string, value: string, sub: string) => (
        <Box key={key} flexDirection="row" alignItems="center" gap={1}>
          <Text bold>{label}</Text>
          <Svg source={bar(pct, color)} alt={`${label} ${value}`} width={72} height={8} />
          <Text color={color} bold>{value}</Text>
          {sub ? <Text dimColor>{sub}</Text> : null}
        </Box>
      )
      const items = u.limits.map(l => {
        const rem = Math.max(0, Math.round(100 - l.percentUsed))
        const reset = l.resetsAt ? fmtReset(l.resetsAt, now, rem) : ''
        const icon = l.kind === 'five_hour' ? '⏱' : l.kind === 'seven_day' ? '📅' : '💳'
        return chip(l.kind, `${icon} ${LABELS[l.kind] ?? l.kind}`, rem, remainColor(rem), `${rem}% 남음`, reset ? `⟳ ${reset}` : '')
      })
      items.push(chip('ctx', '🧠 ctx', used, ctxColor(used), u.ctxPercent === undefined ? '–' : `${used}%`, tokens))
      return (
        <Box flexDirection="row" flexWrap="nowrap" alignItems="center" gap={1}>
          {items.flatMap((item, i) => (i === 0 ? [item] : [<Text key={`sep${i}`} dimColor>│</Text>, item]))}
        </Box>
      )
    }

    return (
      <Box flexDirection="row">
        {u.limits.map(l => {
          const rem = Math.max(0, Math.round(100 - l.percentUsed))
          const reset = l.resetsAt ? fmtReset(l.resetsAt, now, rem) : ''
          return (
            <Box key={l.kind} flexDirection="row">
              <Text dimColor>{LABELS[l.kind] ?? l.kind}:</Text>
              <Text color={remainColor(rem)}>{rem}%</Text>
              <Text dimColor>{reset ? ` (${reset})` : ''} | </Text>
            </Box>
          )
        })}
        <Text dimColor>ctx </Text>
        <Text color={ctxColor(used)}>{u.ctxPercent === undefined ? '–' : `${used}%`}</Text>
        <Text dimColor> ({tokens})</Text>
      </Box>
    )
  })
}
