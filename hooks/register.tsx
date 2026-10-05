import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Usage } from '../types'

const usage = atom({ plugin: 'usage-band', key: 'usage' } as const, null)

const LABELS: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }
const LOW_REMAIN = 20
const SLOTS = ['five_hour', 'seven_day']

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

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토']

// 남은 시간 "HH:MM"(1일 이상이면 "D HH:MM") + 리셋 절대시각 "MM/DD(요일) HH:MM"
function fmtReset(resetsAt: string, now: number): string {
  const target = Date.parse(resetsAt)
  if (Number.isNaN(target)) return ''
  const diff = Math.max(0, Math.floor((target - now) / 1000))
  const days = Math.floor(diff / 86400)
  const hm = `${pad(Math.floor((diff % 86400) / 3600))}:${pad(Math.floor((diff % 3600) / 60))}`
  const left = days > 0 ? `${days} ${hm}` : hm
  const d = new Date(target)
  const at = `${pad(d.getMonth() + 1)}/${pad(d.getDate())}(${WEEKDAYS[d.getDay()]}) ${pad(d.getHours())}:${pad(d.getMinutes())}`
  return `${left} · ${at}`
}

const HEX: Record<string, string> = { green: '#3fb950', yellow: '#d29922', red: '#f85149', gray: '#8b949e' }

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
    if (e.props.hasSurvey) return next(e)
    const u = await read($, usage)

    const now = await $.clock.now()
    const ui = $.ui.resolve(e)
    const { Box, Text } = ui
    const hasCtx = u?.ctxPercent !== undefined
    const used = u?.ctxPercent ?? 0
    const win = u ? fmtTokens(u.ctxWindow) : '–'
    const tokens = u?.ctxTokens !== undefined ? `${fmtTokens(u.ctxTokens)} / ${win}` : `– / ${win}`

    // 5h·7d는 값이 아직 없어도 자리를 잡아 두고 회색 '–'로 표시
    const known = u?.limits ?? []
    const kinds = [...SLOTS, ...known.map(l => l.kind).filter(k => !SLOTS.includes(k))]
    const slots = kinds.map(kind => {
      const l = known.find(x => x.kind === kind)
      if (!l) return { kind, label: LABELS[kind] ?? kind, pending: true, rem: 0, reset: '' }
      const rem = Math.max(0, Math.round(100 - l.percentUsed))
      return { kind, label: LABELS[kind] ?? kind, pending: false, rem, reset: l.resetsAt ? fmtReset(l.resetsAt, now) : '' }
    })

    if (e.surface === 'desktop' && 'Svg' in ui) {
      const { Svg } = ui as typeof ui & { Svg: (p: { source: string; alt: string; width?: number; height?: number }) => unknown }
      const chip = (key: string, label: string, pct: number, color: string, value: string, sub: string, pending: boolean) => (
        <Box key={key} flexDirection="row" alignItems="center" gap={1}>
          <Text bold={!pending} dimColor={pending}>{label}</Text>
          <Svg source={bar(pending ? 0 : pct, color)} alt={`${label} ${value}`} width={72} height={8} />
          <Text color={pending ? undefined : color} bold={!pending} dimColor={pending}>{value}</Text>
          {sub ? <Text dimColor>{sub}</Text> : null}
        </Box>
      )
      const items = slots.map(s => {
        const icon = s.kind === 'five_hour' ? '⏱' : s.kind === 'seven_day' ? '📅' : '💳'
        return s.pending
          ? chip(s.kind, `${icon} ${s.label}`, 0, 'gray', '–', '', true)
          : chip(s.kind, `${icon} ${s.label}`, s.rem, remainColor(s.rem), `${s.rem}% 남음`, s.reset ? `⟳ ${s.reset}` : '', false)
      })
      items.push(chip('ctx', '🧠 ctx', used, hasCtx ? ctxColor(used) : 'gray', hasCtx ? `${used}%` : '–', tokens, !hasCtx))
      return (
        <Box flexDirection="row" flexWrap="nowrap" alignItems="center" gap={1}>
          {items.flatMap((item, i) => (i === 0 ? [item] : [<Text key={`sep${i}`} dimColor>│</Text>, item]))}
        </Box>
      )
    }

    return (
      <Box flexDirection="row">
        {slots.map(s => (
          <Box key={s.kind} flexDirection="row">
            <Text dimColor>{s.label}:</Text>
            {s.pending ? <Text dimColor>–</Text> : <Text color={remainColor(s.rem)}>{s.rem}%</Text>}
            <Text dimColor>{s.reset ? ` (${s.reset})` : ''} | </Text>
          </Box>
        ))}
        <Text dimColor>ctx </Text>
        {hasCtx ? <Text color={ctxColor(used)}>{used}%</Text> : <Text dimColor>–</Text>}
        <Text dimColor> ({tokens})</Text>
      </Box>
    )
  })
}
