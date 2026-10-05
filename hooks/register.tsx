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

type Reset = { left: string; at: string; atShort: string }

// left: "HH:MM"(1일 이상이면 "D HH:MM"), at: "MM/DD(요일) HH:MM", atShort: "요일 HH:MM"
function fmtReset(resetsAt: string, now: number): Reset | null {
  const target = Date.parse(resetsAt)
  if (Number.isNaN(target)) return null
  const diff = Math.max(0, Math.floor((target - now) / 1000))
  const days = Math.floor(diff / 86400)
  const hm = `${pad(Math.floor((diff % 86400) / 3600))}:${pad(Math.floor((diff % 3600) / 60))}`
  const d = new Date(target)
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const wd = WEEKDAYS[d.getDay()]
  return {
    left: days > 0 ? `${days}d ${hm}` : hm,
    at: `${pad(d.getMonth() + 1)}/${pad(d.getDate())}(${wd}) ${clock}`,
    atShort: `${wd} ${clock}`,
  }
}

// 폭에 따른 표시 단계: 3 넓음 → 0 아주 좁음 (viewport를 모르면 3)
type Tier = 0 | 1 | 2 | 3
function tierOf(columns: number | undefined): Tier {
  if (columns === undefined) return 3
  if (columns >= 150) return 3
  if (columns >= 115) return 2
  if (columns >= 85) return 1
  return 0
}
const BAR_W: Record<Tier, number> = { 3: 64, 2: 40, 1: 24, 0: 0 }

// Lucide "rotate-cw" (ISC): 원호 + 꺾쇠 화살촉, 24 그리드에 2px 선
const RESET_ICON =
  `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" ` +
  `stroke="#8b949e" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round">` +
  `<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>`

const HEX: Record<string, string> = { green: '#3fb950', yellow: '#d29922', red: '#f85149', gray: '#8b949e' }

// 둥근 게이지 바 (트랙은 반투명 회색이라 라이트/다크 둘 다 보임), 폭 가변
function bar(pct: number, color: string, width: number): string {
  const w = (Math.max(0, Math.min(100, pct)) / 100) * width
  const fill = HEX[color] ?? color
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="6" viewBox="0 0 ${width} 6">` +
    `<rect width="${width}" height="6" rx="3" fill="#8b949e" fill-opacity="0.25"/>` +
    (w > 0 ? `<rect width="${Math.max(w, 6).toFixed(1)}" height="6" rx="3" fill="${fill}"/>` : '') + `</svg>`
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
      if (!l) return { kind, label: LABELS[kind] ?? kind, pending: true, rem: 0, reset: null as Reset | null }
      const rem = Math.max(0, Math.round(100 - l.percentUsed))
      return { kind, label: LABELS[kind] ?? kind, pending: false, rem, reset: l.resetsAt ? fmtReset(l.resetsAt, now) : null }
    })

    if (e.surface === 'desktop' && 'Svg' in ui) {
      const { Svg } = ui as typeof ui & { Svg: (p: { source: string; alt: string; width?: number; height?: number }) => unknown }
      const tier = tierOf(e.viewport?.columns)
      const barW = BAR_W[tier]

      const chip = (key: string, icon: string, label: string, pct: number, color: string, value: string, pending: boolean, tail: unknown) => (
        <Box key={key} flexDirection="row" alignItems="center" gap={1} flexShrink={0}>
          <Text bold={!pending} dimColor={pending}>{tier >= 2 ? `${icon} ${label}` : label}</Text>
          {barW > 0 ? <Svg source={bar(pending ? 0 : pct, color, barW)} alt={`${label} ${value}`} width={barW} height={6} /> : null}
          <Text color={pending ? undefined : color} bold={!pending} dimColor={pending}>{value}</Text>
          {tail}
        </Box>
      )

      const resetTail = (r: Reset | null) => {
        if (!r) return null
        const at = tier === 3 ? r.at : tier === 2 ? r.atShort : ''
        return (
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Svg source={RESET_ICON} alt="리셋까지" width={12} height={12} />
            <Text dimColor wrap="truncate">{at ? `${r.left} · ${at}` : r.left}</Text>
          </Box>
        )
      }

      const items = slots.map(s => {
        const icon = s.kind === 'five_hour' ? '⏱' : s.kind === 'seven_day' ? '📅' : '💳'
        if (s.pending) return chip(s.kind, icon, s.label, 0, 'gray', '–', true, null)
        const value = tier === 3 ? `${s.rem}% 남음` : `${s.rem}%`
        return chip(s.kind, icon, s.label, s.rem, remainColor(s.rem), value, false, resetTail(s.reset))
      })
      items.push(chip('ctx', '🧠', 'ctx', used, hasCtx ? ctxColor(used) : 'gray', hasCtx ? `${used}%` : '–', !hasCtx,
        tier >= 2 ? <Text dimColor>{tokens}</Text> : null))

      return (
        <Box flexDirection="row" flexWrap="nowrap" alignItems="center" gap={1} overflow="hidden">
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
            <Text dimColor>{s.reset ? ` (${s.reset.left} · ${s.reset.atShort})` : ''} | </Text>
          </Box>
        ))}
        <Text dimColor>ctx </Text>
        {hasCtx ? <Text color={ctxColor(used)}>{used}%</Text> : <Text dimColor>–</Text>}
        <Text dimColor> ({tokens})</Text>
      </Box>
    )
  })
}
