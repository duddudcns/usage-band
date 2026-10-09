import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CodexAccount, CodexUsage, CodexWindow } from '../types'

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

// Lucide "rotate-cw" (ISC): 원호 + 꺾쇠 화살촉, 24 그리드에 2px 선
const RESET_ICON =
  `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" ` +
  `stroke="#8b949e" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round">` +
  `<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>`

// 로고 경로: Simple Icons (CC0 데이터; 각 로고는 해당 회사의 상표)
const CLAUDE_PATH = 'm4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z'
const OPENAI_PATH = 'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z'

function logo(path: string, color: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"><path fill="${color}" d="${path}"/></svg>`
}

// 줄 배경: 각 서비스 테마색을 아주 옅게(알파 ~18%) 깔아 라이트/다크 어디서나 파스텔 틴트로 보이게
type RowTheme = { bg: string; label: string; logo: string; name: string }
const CLAUDE_THEME: RowTheme = { bg: '#D977572E', label: '#D97757', logo: CLAUDE_PATH, name: 'Claude' } // Claude 테라코타
const CODEX_THEME: RowTheme = { bg: '#7B8CF52E', label: '#7B8CF5', logo: OPENAI_PATH, name: 'Codex' }  // Codex 블루바이올렛

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

type Slot = { key: string; icon: string; label: string; pending: boolean; rem: number; reset: Reset | null }

function pendingSlot(key: string, icon: string, label: string): Slot {
  return { key, icon, label, pending: true, rem: 0, reset: null }
}

function codexSlots(c: CodexUsage | null, now: number): Slot[] {
  const accts = c?.accounts ?? []
  if (accts.length === 0) return [pendingSlot('cx-5h', '⏱', '5h'), pendingSlot('cx-7d', '📅', '7d')]
  return accts.flatMap((a, i) => {
    const tag = accts.length > 1 ? `${a.plan} ` : ''
    const mk = (w: CodexWindow | undefined, id: string, icon: string, label: string): Slot => {
      if (!w) return pendingSlot(`cx${i}-${id}`, icon, `${tag}${label}`)
      const rem = Math.max(0, Math.round(100 - w.usedPercent))
      return { key: `cx${i}-${id}`, icon, label: `${tag}${label}`, pending: false, rem,
        reset: w.resetsAt ? fmtReset(w.resetsAt * 1000, now) : null }
    }
    return [mk(a.fiveHour, '5h', '⏱', '5h'), mk(a.weekly, '7d', '📅', '7d')]
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
      const icon = kind === 'five_hour' ? '⏱' : kind === 'seven_day' ? '📅' : '💳'
      const label = LABELS[kind] ?? kind
      const l = known.find(x => x.kind === kind)
      if (!l) return pendingSlot(kind, icon, label)
      const rem = Math.max(0, Math.round(100 - l.percentUsed))
      return { key: kind, icon, label, pending: false, rem, reset: l.resetsAt ? fmtReset(Date.parse(l.resetsAt), now) : null }
    })
    const cxSlots = codexSlots(cx, now)

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

      const slotChip = (s: Slot) => s.pending
        ? chip(s.key, s.icon, s.label, 0, 'gray', '–', true, null)
        : chip(s.key, s.icon, s.label, s.rem, remainColor(s.rem), tier === 3 ? `${s.rem}% 남음` : `${s.rem}%`, false, resetTail(s.reset))

      const row = (key: string, name: string, theme: RowTheme, items: unknown[]) => (
        <Box key={key} flexDirection="row" flexWrap="nowrap" alignItems="center" gap={1} overflow="hidden"
          backgroundColor={theme.bg} paddingX={1}>
          <Box flexShrink={0}><Svg source={logo(theme.logo, theme.label)} alt={theme.name} width={14} height={14} /></Box>
          {items.flatMap((item, i) => (i === 0 ? [item] : [<Text key={`${key}-sep${i}`} dimColor>│</Text>, item]))}
        </Box>
      )

      const claudeItems = claude.map(slotChip)
      claudeItems.push(chip('ctx', '🧠', 'ctx', used, hasCtx ? ctxColor(used) : 'gray', hasCtx ? `${used}%` : '–', !hasCtx,
        tier >= 2 ? <Text dimColor>{tokens}</Text> : null))

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
