import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CodexAccount, CodexUsage, CodexWindow } from '../types'
import { CLAUDE_PNG, CODEX_PNG } from './logos'

const usage = atom({ plugin: 'usage-band', key: 'usage' } as const, null)
const codex = atom({ plugin: 'usage-band', key: 'codex' } as const, null)

const LABELS: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }
const LOW_REMAIN = 20
const SLOTS = ['five_hour', 'seven_day']

// Codex 사용량: 기존 statusline-codex.cjs와 같은 방식 (CLIProxyAPI 자격증명 → wham/usage)
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const CODEX_POLL_MS = 60_000
const CODEX_MIN_GAP_MS = 10_000
const FIVE_HOURS_S = 5 * 3600
const WEEK_S = 7 * 86400

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

// left: "HH:MM"(1일 이상이면 "Dd HH:MM"), at: "MM/DD(요일) HH:MM", atShort: "요일 HH:MM"
function fmtReset(targetMs: number, now: number): Reset | null {
  if (!Number.isFinite(targetMs)) return null
  const diff = Math.max(0, Math.floor((targetMs - now) / 1000))
  const days = Math.floor(diff / 86400)
  const hm = `${pad(Math.floor((diff % 86400) / 3600))}:${pad(Math.floor((diff % 3600) / 60))}`
  const d = new Date(targetMs)
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

// 칸 폭 고정(셀 단위): 두 줄의 같은 항목이 같은 x에서 시작하도록, 각 단계에서 내용이 가장 길 때 기준
// 리셋: "6d 23:59 · 10/14(화) 16:57" / "6d 23:59 · 화 16:57" / "6d 23:59"
const COL = { label: 3, value: 4, tokens: 11 }
const BAR_CELLS: Record<Tier, number> = { 3: 10, 2: 6, 1: 4, 0: 0 }
const RESET_CELLS: Record<Tier, number> = { 3: 26, 2: 19, 1: 8, 0: 8 }

// PNG 아이콘을 SVG <image>로 감싸 데스크톱 Svg 요소로 그린다 (데스크톱 표면엔 Image 요소가 없음)
function logo(png: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="16" height="16" viewBox="0 0 48 48">` +
    `<image width="48" height="48" href="data:image/png;base64,${png}" xlink:href="data:image/png;base64,${png}"/></svg>`
}

// 줄 배경: 각 서비스 테마색을 아주 옅게(알파 ~18%) 깔아 라이트/다크 어디서나 파스텔 틴트로 보이게
type RowTheme = { bg: string; label: string; logo: string; name: string }
const CLAUDE_THEME: RowTheme = { bg: '#D977572E', label: '#D97757', logo: CLAUDE_PNG, name: 'Claude' } // Claude 테라코타
const CODEX_THEME: RowTheme = { bg: '#7B8CF52E', label: '#7B8CF5', logo: CODEX_PNG, name: 'Codex' }  // Codex 블루바이올렛

const HEX: Record<string, string> = { green: '#3fb950', yellow: '#d29922', red: '#f85149', gray: '#8b949e' }

// 둥근 게이지 바 (트랙은 반투명 회색이라 라이트/다크 둘 다 보임), 폭 가변
function bar(pct: number, color: string, width: number): string {
  const w = (Math.max(0, Math.min(100, pct)) / 100) * width
  const fill = HEX[color] ?? color
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="6" viewBox="0 0 ${width} 6">` +
    `<rect width="${width}" height="6" rx="3" fill="#8b949e" fill-opacity="0.25"/>` +
    (w > 0 ? `<rect width="${Math.max(w, 6).toFixed(1)}" height="6" rx="3" fill="${fill}"/>` : '') + `</svg>`
}

// ---- Codex ----

function num(v: unknown): number | null {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// JWT payload의 base64url 디코드 (Node/DOM 없이)
function b64urlDecode(s: string): string {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  let bits = 0
  let acc = 0
  const bytes: number[] = []
  for (const ch of s.replace(/=+$/, '')) {
    const i = abc.indexOf(ch === '+' ? '-' : ch === '/' ? '_' : ch)
    if (i < 0) continue
    acc = ((acc << 6) | i) & 0xffffff
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes.push((acc >> bits) & 0xff)
    }
  }
  return decodeURIComponent(bytes.map(b => '%' + b.toString(16).padStart(2, '0')).join(''))
}

function accountIdFromToken(token: string): string | null {
  try {
    const claims = JSON.parse(b64urlDecode(token.split('.')[1] ?? ''))
    return claims['https://api.openai.com/auth.chatgpt_account_id'] ?? null
  } catch {
    return null
  }
}

function expiryMs(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = num(v)
  if (n !== null && n > 0) return n > 1e12 ? n : n * 1000
  const p = Date.parse(String(v))
  return Number.isFinite(p) ? p : null
}

function normWindow(w: Record<string, unknown> | undefined, nowMs: number): CodexWindow | null {
  if (!w || typeof w !== 'object') return null
  const used = num(w.used_percent ?? w.usedPercent)
  if (used === null) return null
  const out: CodexWindow = { usedPercent: Math.max(0, Math.min(100, used)) }
  const at = num(w.reset_at ?? w.resetAt)
  const after = num(w.reset_after_seconds ?? w.resetAfterSeconds)
  if (at && at > 0) out.resetsAt = Math.floor(at > 1e12 ? at / 1000 : at)
  else if (after && after > 0) out.resetsAt = Math.floor(nowMs / 1000) + Math.floor(after)
  return out
}

function classify(w: Record<string, unknown> | undefined, fallback: 'fiveHour' | 'weekly'): 'fiveHour' | 'weekly' | null {
  const dur = num(w?.limit_window_seconds ?? w?.limitWindowSeconds)
  if (dur === null || dur <= 0) return fallback
  if (Math.abs(dur - FIVE_HOURS_S) / FIVE_HOURS_S <= 0.25) return 'fiveHour'
  if (Math.abs(dur - WEEK_S) / WEEK_S <= 0.25) return 'weekly'
  return null
}

function parseCodexUsage(data: Record<string, unknown>, nowMs: number): CodexAccount | null {
  const rl = (data.rate_limit ?? data.rateLimit) as Record<string, Record<string, unknown>> | undefined
  const acct: CodexAccount = { plan: String(data.plan_type ?? data.planType ?? 'codex').toLowerCase().slice(0, 32) }
  const pairs: [Record<string, unknown> | undefined, 'fiveHour' | 'weekly'][] = [
    [rl?.primary_window ?? rl?.primaryWindow, 'fiveHour'],
    [rl?.secondary_window ?? rl?.secondaryWindow, 'weekly'],
  ]
  for (const [raw, fb] of pairs) {
    const w = normWindow(raw, nowMs)
    const kind = classify(raw, fb)
    if (!w || !kind) continue
    const prev = acct[kind]
    if (!prev || w.usedPercent > prev.usedPercent) acct[kind] = w
  }
  return acct.fiveHour || acct.weekly ? acct : null
}

type Credential = { token: string; accountId: string | null }

async function readJson($: EngineInterface, path: string): Promise<Record<string, unknown> | null> {
  try {
    if (!(await $.fs.exists(path))) return null
    return JSON.parse(String(await $.fs.read(path)))
  } catch {
    return null // 깨진 자격증명 파일은 건너뛴다
  }
}

// 자격증명 출처: Codex(CLI·데스크톱)가 갱신하는 ~/.codex/auth.json, 그리고 CLIProxyAPI의 codex-*.json
async function readCredentials($: EngineInterface, nowMs: number): Promise<Credential[]> {
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))
  if (!home) return []
  const creds: Credential[] = []

  const auth = await readJson($, `${home}/.codex/auth.json`)
  const tokens = auth?.tokens as Record<string, unknown> | undefined
  if (typeof tokens?.access_token === 'string' && tokens.access_token) {
    const token = tokens.access_token.trim()
    creds.push({ token, accountId: (tokens.account_id as string) || accountIdFromToken(token) })
  }

  const dir = `${home}/.cli-proxy-api`
  if (await $.fs.exists(dir)) {
    const files = (await $.fs.list(dir)).filter(f => f.kind === 'file' && /^codex-.*\.json$/i.test(f.name))
    files.sort((a, b) => a.name.localeCompare(b.name))
    for (const f of files) {
      const cred = await readJson($, `${dir}/${f.name}`)
      const token = typeof cred?.access_token === 'string' ? cred.access_token.trim() : ''
      const exp = expiryMs(cred?.expired ?? cred?.expires_at)
      if (!cred || cred.disabled === true || !token || (exp && exp <= nowMs + 60_000)) continue
      creds.push({ token, accountId: (cred.account_id as string) || accountIdFromToken(token) })
    }
  }

  // 같은 계정이 두 곳에 있으면 먼저 읽은 것(Codex 본체)만 남긴다
  const seen = new Set<string>()
  return creds.filter(c => {
    const id = c.accountId ?? c.token
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

async function fetchCodex($: EngineInterface): Promise<CodexUsage | null> {
  const nowMs = await $.clock.now()
  const accounts: CodexAccount[] = []
  for (const c of await readCredentials($, nowMs)) {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${c.token}`,
      Accept: 'application/json',
      'User-Agent': 'codex-tui/0.149.1 (Windows 11; x86_64)',
    }
    if (c.accountId) headers['ChatGPT-Account-Id'] = c.accountId
    try {
      const res = await $.http.fetch(CODEX_USAGE_URL, { method: 'GET', headers })
      if (!res.ok) continue // 만료·폐기된 토큰(401)은 건너뛴다
      const acct = parseCodexUsage(JSON.parse(res.text), nowMs)
      if (acct) accounts.push(acct)
    } catch {
      continue // 네트워크 오류: 다음 자격증명, 다음 주기에 재시도
    }
  }
  return accounts.length > 0 ? { fetchedAt: nowMs, accounts } : null
}

async function refreshCodex($: EngineInterface): Promise<void> {
  const prev = await read($, codex)
  const now = await $.clock.now()
  if (prev && now - prev.fetchedAt < CODEX_MIN_GAP_MS) return
  const next = await fetchCodex($)
  if (next) await update($, codex, () => next)
}

// ---- 표시용 슬롯 ----

type Slot = { key: string; label: string; pending: boolean; rem: number; reset: Reset | null }

function pendingSlot(key: string, label: string): Slot {
  return { key, label, pending: true, rem: 0, reset: null }
}

function codexSlots(c: CodexUsage | null, now: number): Slot[] {
  const accts = c?.accounts ?? []
  if (accts.length === 0) return [pendingSlot('cx-5h', '5h'), pendingSlot('cx-7d', '7d')]
  return accts.flatMap((a, i) => {
    const tag = accts.length > 1 ? `${a.plan} ` : ''
    const mk = (w: CodexWindow | undefined, id: string, label: string): Slot => {
      if (!w) return pendingSlot(`cx${i}-${id}`, `${tag}${label}`)
      const rem = Math.max(0, Math.round(100 - w.usedPercent))
      return { key: `cx${i}-${id}`, label: `${tag}${label}`, pending: false, rem,
        reset: w.resetsAt ? fmtReset(w.resetsAt * 1000, now) : null }
    }
    return [mk(a.fiveHour, '5h', '5h'), mk(a.weekly, '7d', '7d')]
  })
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
    await refreshCodex($)
    $.clock.every(CODEX_POLL_MS, () => refreshCodex($))
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
    await refreshCodex($)
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const u = await read($, usage)
    const cx = await read($, codex)

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
    const claude: Slot[] = kinds.map(kind => {
      const label = LABELS[kind] ?? kind
      const l = known.find(x => x.kind === kind)
      if (!l) return pendingSlot(kind, label)
      const rem = Math.max(0, Math.round(100 - l.percentUsed))
      return { key: kind, label, pending: false, rem, reset: l.resetsAt ? fmtReset(Date.parse(l.resetsAt), now) : null }
    })
    const cxSlots = codexSlots(cx, now)

    if (e.surface === 'desktop' && 'Svg' in ui) {
      const { Svg } = ui as typeof ui & { Svg: (p: { source: string; alt: string; width?: number; height?: number }) => unknown }
      const tier = tierOf(e.viewport?.columns)
      const barW = BAR_W[tier]

      // 항목 안의 라벨·게이지·퍼센트·시간은 간격 없이 붙이고, 정렬은 항목 바깥 폭(가장 긴 경우 기준)으로 맞춘다
      const chip = (key: string, label: string, pct: number, color: string, value: string, pending: boolean, tail: unknown, tailCells: number) => (
        <Box key={key} flexDirection="row" alignItems="center" gap={0} flexShrink={0}
          width={COL.label + BAR_CELLS[tier] + COL.value + tailCells}>
          <Text bold={!pending} dimColor={pending}>{label}</Text>
          {barW > 0 ? <Svg source={bar(pending ? 0 : pct, color, barW)} alt={`${label} ${value}`} width={barW} height={6} /> : null}
          <Text color={pending ? undefined : color} bold={!pending} dimColor={pending}>{value}</Text>
          {tail}
        </Box>
      )

      const resetTail = (r: Reset | null) => {
        if (!r) return null
        const at = tier === 3 ? r.at : tier === 2 ? r.atShort : ''
        return <Text dimColor wrap="truncate">{at ? `${r.left} · ${at}` : r.left}</Text>
      }

      const slotChip = (s: Slot) => s.pending
        ? chip(s.key, s.label, 0, 'gray', '–', true, null, RESET_CELLS[tier])
        : chip(s.key, s.label, s.rem, remainColor(s.rem), `${s.rem}%`, false, resetTail(s.reset), RESET_CELLS[tier])

      const row = (key: string, name: string, theme: RowTheme, items: unknown[]) => (
        <Box key={key} flexDirection="row" flexWrap="nowrap" alignItems="center" gap={1} overflow="hidden"
          backgroundColor={theme.bg} borderStyle="round" borderColor={theme.bg} paddingX={1}>
          <Box width={2} flexShrink={0}><Svg source={logo(theme.logo)} alt={theme.name} width={16} height={16} /></Box>
          {items.flatMap((item, i) => (i === 0 ? [item] : [<Text key={`${key}-sep${i}`} dimColor>│</Text>, item]))}
        </Box>
      )

      const claudeItems = claude.map(slotChip)
      claudeItems.push(chip('ctx', 'ctx', used, hasCtx ? ctxColor(used) : 'gray', hasCtx ? `${used}%` : '–', !hasCtx,
        tier >= 2 ? <Text dimColor>{tokens}</Text> : null, tier >= 2 ? COL.tokens : 0))

      return (
        <Box flexDirection="column">
          {row('claude', 'Claude', CLAUDE_THEME, claudeItems)}
          {row('codex', 'Codex', CODEX_THEME, cxSlots.map(slotChip))}
        </Box>
      )
    }

    const textRow = (key: string, name: string, theme: RowTheme, slots: Slot[], extra: unknown) => (
      <Box key={key} flexDirection="row">
        <Text color={theme.label} bold>{name.padEnd(7)}</Text>
        {slots.map((s, i) => (
          <Box key={s.key} flexDirection="row">
            <Text dimColor>{i > 0 ? ' | ' : ''}{s.label}:</Text>
            {s.pending ? <Text dimColor>–</Text> : <Text color={remainColor(s.rem)}>{s.rem}%</Text>}
            <Text dimColor>{s.reset ? ` (${s.reset.left} · ${s.reset.atShort})` : ''}</Text>
          </Box>
        ))}
        {extra}
      </Box>
    )

    return (
      <Box flexDirection="column">
        {textRow('claude', 'Claude', CLAUDE_THEME, claude, (
          <Box flexDirection="row">
            <Text dimColor> | ctx </Text>
            {hasCtx ? <Text color={ctxColor(used)}>{used}%</Text> : <Text dimColor>–</Text>}
            <Text dimColor> ({tokens})</Text>
          </Box>
        ))}
        {textRow('codex', 'Codex', CODEX_THEME, cxSlots, null)}
      </Box>
    )
  })
}
