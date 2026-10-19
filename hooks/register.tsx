import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ClaudeLimits, CodexAccount, CodexUsage, CodexWindow, Usage } from '../types'
import { CLAUDE_PNG, CODEX_PNG } from './logos'

const usage = atom({ plugin: 'usage-band', key: 'usage' } as const, null)
const claudeApi = atom({ plugin: 'usage-band', key: 'claude' } as const, null)
const codex = atom({ plugin: 'usage-band', key: 'codex' } as const, null)

// Claude 사용량: 앱 사용량 화면과 같은 출처(/api/oauth/usage)를 직접 조회.
// 엔진이 넘기는 값(응답 헤더)은 정수로 잘린 값이라 앱보다 1%p 낮게 나오고, 응답이 있을 때만 갱신된다.
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const CLAUDE_STALE_MS = 5 * 60_000 // 이보다 오래된 조회 결과는 버리고 엔진 값으로 돌아간다

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

// 페이스 기준 색: 창을 같은 단위로 나눠(5h=1시간×5, 7d=1일×7) 지금 지나고 있는 단위가 끝날 때
// 남아 있어야 할 몫 이상이면 초록, 모자라면 노랑. 시간과 무관하게 20% 미만이면 빨강.
// 예) 5h 창에서 1~2시간째 → 100 - 2×20 = 60% 이상이면 초록.
const PACE: Record<string, { units: number; unitMs: number }> = {
  '5h': { units: 5, unitMs: 3_600_000 },
  '7d': { units: 7, unitMs: 86_400_000 },
}

function paceColor(rem: number, windowId: string, resetMs: number | null, now: number): string {
  if (rem < LOW_REMAIN) return 'red'
  const pace = PACE[windowId]
  if (!pace || resetMs === null || !Number.isFinite(resetMs)) return remainColor(rem)
  const elapsed = pace.units * pace.unitMs - Math.max(0, resetMs - now)
  const unit = Math.min(pace.units - 1, Math.max(0, Math.floor(elapsed / pace.unitMs)))
  const shouldRemain = 100 - ((unit + 1) * 100) / pace.units
  return rem >= shouldRemain ? 'green' : 'yellow'
}
// 컨텍스트는 사용 % 기준 색(압축 창이 있으면 그 창 대비 %)
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
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="13" height="13" viewBox="0 0 48 48">` +
    `<image width="48" height="48" href="data:image/png;base64,${png}" xlink:href="data:image/png;base64,${png}"/></svg>`
}

// 두 줄 사이 2px 간격 (Box 간격은 셀 단위라 1셀이면 너무 넓음)
const ROW_GAP = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="3" viewBox="0 0 8 3"><rect width="8" height="3" fill="#000" fill-opacity="0"/></svg>'

// 줄 배경: 각 서비스 테마색을 아주 옅게(알파 ~18%) 깔아 라이트/다크 어디서나 파스텔 틴트로 보이게
type RowTheme = { bg: string; label: string; logo: string; name: string }
const CLAUDE_THEME: RowTheme = { bg: '#D977572E', label: '#D97757', logo: CLAUDE_PNG, name: 'Claude' } // Claude 테라코타
const CODEX_THEME: RowTheme = { bg: '#7B8CF52E', label: '#7B8CF5', logo: CODEX_PNG, name: 'Codex' }  // Codex 블루바이올렛

const HEX: Record<string, string> = { green: '#3fb950', yellow: '#d29922', red: '#f85149', gray: '#8b949e' }

// 둥근 게이지 바 (트랙은 반투명 회색이라 라이트/다크 둘 다 보임), 폭 가변.
// markPct가 있으면 그 자리에 세로 눈금(자동 압축 지점)을 채움 위에 겹쳐 그린다.
export function bar(pct: number, color: string, width: number, markPct?: number): string {
  const w = (Math.max(0, Math.min(100, pct)) / 100) * width
  const fill = HEX[color] ?? color
  const markX = markPct !== undefined ? Math.max(1, Math.min(width - 1, (markPct / 100) * width)) : null
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="6" viewBox="0 0 ${width} 6">` +
    `<rect width="${width}" height="6" rx="3" fill="#8b949e" fill-opacity="0.25"/>` +
    (w > 0 ? `<rect width="${Math.max(w, 6).toFixed(1)}" height="6" rx="3" fill="${fill}"/>` : '') +
    (markX !== null ? `<rect data-mark="${markPct}" x="${(markX - 1).toFixed(1)}" width="2" height="6" fill="#8b949e"/>` : '') + `</svg>`
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

// ---- Claude ----

// "2026-10-13T17:00:00.259394+00:00"처럼 소수 6자리 ISO는 런타임에 따라 Date.parse가 NaN을 낼 수 있어 3자리로 자른다
function parseIso(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const ms = Date.parse(v.replace(/(\.\d{3})\d+/, '$1'))
  return Number.isFinite(ms) ? ms : null
}

// /api/oauth/usage 응답 → limits. utilization은 이미 0~100 단위
export function parseClaudeUsage(data: Record<string, unknown>): Usage['limits'] {
  const out: Usage['limits'] = []
  for (const kind of SLOTS) {
    const w = data[kind] as Record<string, unknown> | null | undefined
    const used = num(w?.utilization)
    if (!w || used === null) continue
    const resetMs = parseIso(w.resets_at)
    out.push({ kind, percentUsed: Math.max(0, Math.min(100, used)), ...(resetMs !== null && { resetsAt: new Date(resetMs).toISOString() }) })
  }
  return out
}

// 이 엔드포인트는 요청 제한이 빡빡하다: 세션마다 1분 조회하면 세션 수만큼 늘어 429가 났다(실측).
// 그래서 같은 설정 폴더의 모든 세션(프로세스)이 파일 하나를 함께 쓴다. 전체에서 1분에 한 번만 서버에 묻고, 나머지는 파일을 읽는다.
// 파일엔 토큰이 없다(사용률·리셋 시각·다음 조회 가능 시각뿐).
const CLAUDE_POLL_MS = 60_000
const CLAUDE_BACKOFF_MIN_MS = 2 * 60_000
const CLAUDE_BACKOFF_MAX_MS = 30 * 60_000
const CLAUDE_RETRY_AFTER_MAX_MS = 60 * 60_000 // 서버가 준 대기 시간은 존중하되 1시간을 넘기지 않는다
const CLAUDE_INFLIGHT_MAX_MS = 2 * 60_000 // fetch엔 타임아웃이 없어, 끝내 안 오는 요청은 2분 뒤 포기한 것으로 본다

export type ClaudeCache = { fetchedAt?: number; limits?: Usage['limits']; nextAt?: number; backoffMs?: number; claim?: string }

// 실패 뒤 대기: 2분부터 두 배씩 최대 30분. Retry-After(초)가 더 길면 그만큼(최대 1시간)
export function nextBackoff(prevMs: number | undefined, retryAfterSec: number | null): number {
  const doubled = Math.min(CLAUDE_BACKOFF_MAX_MS, Math.max(CLAUDE_BACKOFF_MIN_MS, (prevMs ?? 0) * 2))
  if (retryAfterSec === null || retryAfterSec <= 0) return doubled
  return Math.max(doubled, Math.min(CLAUDE_RETRY_AFTER_MAX_MS, retryAfterSec * 1000))
}

// 파일은 다른 프로세스가 쓰다 만 것일 수도, 손으로 고친 것일 수도 있어 모양을 검사하고 시각을 자른다
export function sanitizeCache(raw: unknown, now: number): ClaudeCache {
  if (!raw || typeof raw !== 'object') return {}
  const r = raw as Record<string, unknown>
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
  const limits = Array.isArray(r.limits)
    ? (r.limits as Record<string, unknown>[]).filter(l => l && typeof l.kind === 'string' && n(l.percentUsed) !== undefined)
      .map(l => ({ kind: l.kind as string, percentUsed: l.percentUsed as number, ...(typeof l.resetsAt === 'string' && { resetsAt: l.resetsAt }) }))
    : undefined
  const nextAt = n(r.nextAt)
  const fetchedAt = n(r.fetchedAt)
  return {
    // 미래 시각(시계가 뒤로 감·손으로 고친 파일)은 버린다: 남겨 두면 그 시각까지 "방금 받음"으로 보여 조회가 멈춘다
    fetchedAt: fetchedAt !== undefined && fetchedAt <= now ? fetchedAt : undefined,
    limits,
    nextAt: nextAt !== undefined ? Math.min(nextAt, now + CLAUDE_RETRY_AFTER_MAX_MS) : undefined,
    backoffMs: n(r.backoffMs),
    claim: typeof r.claim === 'string' ? r.claim : undefined,
  }
}

// 설정 폴더(CLAUDE_CONFIG_DIR, 없으면 ~/.claude)마다 따로: 다른 계정으로 로그인한 설정 폴더와 값이 섞이지 않게.
// 한계: 같은 설정 폴더에서 /login으로 계정을 바꾸면 다음 성공 조회(최대 백오프 시간) 전까지 이전 계정 값이 보일 수 있다.
async function claudeCachePath($: EngineInterface): Promise<string | null> {
  const dir = await $.env.get('CLAUDE_CONFIG_DIR')
  if (dir) return `${dir}/usage-band-claude.json`
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))
  return home ? `${home}/.claude/usage-band-claude.json` : null
}

async function readCache($: EngineInterface, path: string, now: number): Promise<ClaudeCache> {
  return sanitizeCache(await readJson($, path), now)
}

async function writeCache($: EngineInterface, path: string, c: ClaudeCache): Promise<boolean> {
  return $.fs.write(path, JSON.stringify(c)).then(() => true, () => false)
}

// 파일 쓰기가 막혀도(권한·다른 플러그인의 fs 훅) 이 프로세스만큼은 쉬도록 메모리에도 하한을 둔다
let memNextAt = 0
let memBackoffMs = 0
let inFlightSince = 0

// 자격증명은 엔진이 쥐고 핸들만 준다(비밀값은 플러그인에 오지 않고, 퍼스트파티 호스트에만 쓰이며, 트래픽 차단 정책도 엔진이 지킨다).
async function refreshClaude($: EngineInterface): Promise<void> {
  const auth = await $.session.authorize()
  // 로그인 없음·3P 제공자·게이트웨이·API 키(이 엔드포인트는 구독 OAuth 전용): 엔진 값으로 표시.
  // 이전 계정의 조회 값이 남아 계속 보이지 않게 비운다.
  if (auth?.kind !== 'bearer') {
    await update($, claudeApi, () => null)
    return
  }
  const path = await claudeCachePath($)
  if (!path) return // 홈 경로를 모르면 공유 파일 없이 조회하지 않는다(세션마다 따로 물으면 429가 난다)
  const now = await $.clock.now()
  const raw = await readJson($, path)
  // 파일은 있는데 못 읽었다 = 다른 세션이 쓰는 중(쓰기가 원자적이지 않음). 이번 주기는 건너뛴다: 빈 값으로 보고 조회하면 백오프가 풀린다
  if (raw === null && (await $.fs.exists(path).catch(() => false))) return
  const cache = sanitizeCache(raw, now)
  const showCache = async (c: ClaudeCache) => {
    const at = c.fetchedAt
    const limits = c.limits
    if (at && limits && limits.length > 0) await update($, claudeApi, cur => (cur && cur.fetchedAt >= at ? cur : { fetchedAt: at, limits }))
  }
  const fresh = cache.fetchedAt !== undefined && now - cache.fetchedAt < CLAUDE_POLL_MS
  const waiting = now < Math.max(cache.nextAt ?? 0, memNextAt) || now - inFlightSince < CLAUDE_INFLIGHT_MAX_MS
  if (fresh || waiting) {
    await showCache(cache)
    return
  }
  // 차례 잡기: 표시를 쓰고 다시 읽어 내 표시가 남아 있을 때만 묻는다(동시에 뜬 세션끼리 겹치는 창을 줄인다)
  const claim = `${now}-${Math.random().toString(36).slice(2, 10)}`
  memNextAt = now + CLAUDE_POLL_MS
  if (await writeCache($, path, { ...cache, nextAt: now + CLAUDE_POLL_MS, claim })) {
    if ((await readCache($, path, now)).claim !== claim) {
      await showCache(cache)
      return
    }
  }
  inFlightSince = now
  let ok = false
  let retryAfter: number | null = null
  try {
    const res = await $.http.fetch(CLAUDE_USAGE_URL, {
      method: 'GET',
      headers: { 'anthropic-beta': 'oauth-2025-04-20', Accept: 'application/json' },
      auth: auth.handle,
    })
    const limits = res.ok ? parseClaudeUsage(JSON.parse(res.text)) : []
    if (limits.length > 0) {
      ok = true
      memBackoffMs = 0
      await writeCache($, path, { fetchedAt: now, limits, nextAt: now + CLAUDE_POLL_MS, backoffMs: 0 })
      await update($, claudeApi, () => ({ fetchedAt: now, limits }))
    } else {
      retryAfter = num(res.headers['retry-after'])
    }
  } catch {
    // 네트워크 오류·형식 변경: 아래에서 실패로 처리
  } finally {
    inFlightSince = 0
  }
  if (ok) return
  // 실패 기록 직전에 다시 읽는다: 그 사이 다른 세션이 성공했으면 그 값을 덮거나 쉬게 하지 않는다
  const latest = await readCache($, path, now)
  if (latest.fetchedAt !== undefined && latest.fetchedAt > (cache.fetchedAt ?? 0)) {
    await showCache(latest)
    return
  }
  const backoffMs = nextBackoff(Math.max(latest.backoffMs ?? 0, memBackoffMs), retryAfter)
  memBackoffMs = backoffMs
  memNextAt = now + backoffMs
  await writeCache($, path, { ...latest, nextAt: now + backoffMs, backoffMs, claim: undefined })
  await showCache(latest) // 실패해도 다른 세션이 받아 둔 마지막 값이 있으면 그것을 쓴다
}

// ctx는 서버 출처가 없다. 분모는 모델 창(context.window)이다. autoCompactWindow 같은 설정으로 자동 압축 창
// (rawMaxTokens)이 그보다 작으면 그 지점을 막대 눈금으로 남기는데, 그 창은 'summary' 분석(대화 전체 추정)으로만
// 알 수 있어 1분마다 잰다. 분자는 마지막 응답의 입력 토큰(엔진 값, 실측상 분석 추정과 0.1% 이내).
// 엔진의 session.measure는 턴마다 한 번 정도만 오지만 토큰 값은 응답 단계마다 바뀐다(실측) → 짧게 읽는다.
// 분석 없는 $.session.usage()는 계산 없는 호출이고, 값이 같으면 쓰지 않아 다시 그리지도 않는다.
const CTX_POLL_MS = 5_000
// 마지막 분석이 본 압축 창: 숫자 = 모델 창보다 작음, null = 제한 없음, undefined = 모듈이 다시 올라온 뒤 아직 안 잼
let ctxLimitBasis: number | null | undefined

// 분석이 있으면 압축 창을 새로 정하고, 없으면 지난 값(모듈이 막 올라왔으면 저장된 값)을 쓴다.
// 쓸 때마다 지금 모델 창과 다시 견준다: 분석 사이에 모델이 바뀌어 창이 작아질 수 있어서.
export function nextCtxLimit(
  basis: number | null | undefined,
  stored: number | undefined,
  context: { window: number; breakdown?: { isAutoCompactEnabled: boolean; rawMaxTokens: number } },
): { basis: number | null | undefined; limit?: number } {
  const b = context.breakdown
  const next = b ? (b.isAutoCompactEnabled && b.rawMaxTokens > 0 && b.rawMaxTokens < context.window ? b.rawMaxTokens : null) : basis
  const known = next === undefined ? stored : next ?? undefined
  return known !== undefined && known < context.window ? { basis: next, limit: known } : { basis: next }
}

type EngineUsage = Awaited<ReturnType<EngineInterface['session']['usage']>>

function sameUsage(a: Usage, b: Usage): boolean {
  return a.ctxPercent === b.ctxPercent && a.ctxTokens === b.ctxTokens && a.ctxWindow === b.ctxWindow
    && a.ctxLimit === b.ctxLimit
    && JSON.stringify(a.limits) === JSON.stringify(b.limits)
}

type EngineReading = {
  tokens?: number
  window: number // 분모(모델 창)
  limit?: number // 모델 창보다 작은 자동 압축 창(제한이 없으면 없음)
  percent?: number // 엔진이 계산한 %(tokens가 없을 때만 씀)
  limits: Usage['limits'] // 비어 있으면 이전 값을 유지
}

// prev + 엔진 값 → 다음 상태. fromResponse(새 응답 헤더, session.measure)일 때만 limitsAt을 찍고, 뒤로 가지 않게 한다.
export function buildUsage(prev: Usage | null | undefined, r: EngineReading, fromResponse: boolean, now: number): Usage {
  const hasLimits = r.limits.length > 0
  return {
    ctxPercent: r.tokens !== undefined && r.window > 0 ? Math.round((r.tokens / r.window) * 100) : r.percent,
    ctxTokens: r.tokens,
    ctxWindow: r.window,
    ...(r.limit !== undefined && { ctxLimit: r.limit }),
    limits: hasLimits ? r.limits : prev?.limits ?? [],
    limitsAt: hasLimits && fromResponse ? Math.max(prev?.limitsAt ?? 0, now) : prev?.limitsAt ?? 0,
  }
}

async function applyEngineUsage($: EngineInterface, u: Pick<EngineUsage, 'context' | 'rateLimits'>, fromResponse: boolean): Promise<void> {
  const cur = await read($, usage)
  const ctx = nextCtxLimit(ctxLimitBasis, cur?.ctxLimit, u.context)
  ctxLimitBasis = ctx.basis
  const reading: EngineReading = {
    tokens: u.context.tokens,
    window: u.context.window,
    ...(ctx.limit !== undefined && { limit: ctx.limit }),
    percent: u.context.percent,
    limits: u.rateLimits.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt })),
  }
  const now = await $.clock.now()
  // 같은 값을 다시 쓰면 읽는 쪽이 다시 그려지므로 아예 쓰지 않는다
  const probe = buildUsage(cur, reading, fromResponse, now)
  if (cur && sameUsage(cur, probe) && cur.limitsAt === probe.limitsAt) return
  // 계산은 update 안에서 최신 값(prev) 기준으로 다시 한다: 그 사이 다른 쓰기가 끼어도 덮어쓰지 않도록
  await update($, usage, prev => buildUsage(prev, reading, fromResponse, now))
}

async function measureCtx($: EngineInterface, withBreakdown: boolean): Promise<void> {
  await applyEngineUsage($, await $.session.usage(withBreakdown ? { breakdown: 'summary' } : undefined), false)
}

// 표시할 5h·7d: 직접 조회 값이 5분 안이면 그것, 그보다 오래됐으면 엔진 값과 비교해 더 새 쪽.
// 직접 조회가 채운 창은 그것으로, 나머지(spend 등)는 엔진 값으로 채운다.
export function pickLimits(engine: Usage | null, api: ClaudeLimits | null, now: number): Usage['limits'] {
  const engineLimits = engine?.limits ?? []
  const useApi = api && (now - api.fetchedAt < CLAUDE_STALE_MS || api.fetchedAt >= (engine?.limitsAt ?? 0))
  if (!useApi) return engineLimits
  return [...api.limits, ...engineLimits.filter(l => !api.limits.some(a => a.kind === l.kind))]
}

// 1분 주기 작업. 하나가 실패해도 나머지는 돈다.
async function refreshAll($: EngineInterface): Promise<void> {
  await Promise.allSettled([measureCtx($, true), refreshClaude($), refreshCodex($)])
}

// 막대에 쓸 값: used = 모델 창 대비 %, colorPct = 색 기준(압축 창이 있으면 그 창 대비), markPct = 압축 지점 눈금
export function ctxView(u: Usage): { used: number; colorPct: number; markPct?: number } {
  const used = u.ctxPercent ?? 0
  if (u.ctxLimit === undefined || u.ctxWindow <= 0) return { used, colorPct: used, markPct: undefined }
  const colorPct = u.ctxTokens !== undefined ? Math.round((u.ctxTokens / u.ctxLimit) * 100) : Math.round((used * u.ctxWindow) / u.ctxLimit)
  return { used, colorPct, markPct: Math.round((u.ctxLimit / u.ctxWindow) * 100) }
}

// ---- 표시용 슬롯 ----

type Slot = { key: string; label: string; pending: boolean; rem: number; color: string; reset: Reset | null }

function pendingSlot(key: string, label: string): Slot {
  return { key, label, pending: true, rem: 0, color: 'gray', reset: null }
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
        color: paceColor(rem, id, w.resetsAt ? w.resetsAt * 1000 : null, now),
        reset: w.resetsAt ? fmtReset(w.resetsAt * 1000, now) : null }
    }
    return [mk(a.fiveHour, '5h', '5h'), mk(a.weekly, '7d', '7d')]
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    // isInteractive로 거르지 않는다: 데스크톱 Code 탭은 SDK로 뜬 세션이라 false일 수 있다
    // 타이머 먼저 등록하고, 첫 조회는 기다리지 않는다(첫 프롬프트를 늦추지 않도록)
    $.clock.every(CODEX_POLL_MS, () => { void refreshAll($) })
    $.clock.every(CTX_POLL_MS, () => { void measureCtx($, false).catch(() => undefined) })
    void refreshAll($)
    return r
  })

  // 엔진 알림 값은 그대로 반영만 한다(턴마다 한 번 정도 옴, 분석·서버 조회는 타이머 몫)
  on('session.measure', async ($, e, next) => {
    const r = await next(e)
    await applyEngineUsage($, e, true).catch(() => undefined)
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const u = await read($, usage)
    const api = await read($, claudeApi)
    const cx = await read($, codex)

    const now = await $.clock.now()
    const ui = $.ui.resolve(e)
    const { Box, Text } = ui
    const hasCtx = u?.ctxPercent !== undefined
    const view = u ? ctxView(u) : { used: 0, colorPct: 0, markPct: undefined }
    const used = view.used
    const win = u ? fmtTokens(u.ctxWindow) : '–'
    const tokens = u?.ctxTokens !== undefined ? `${fmtTokens(u.ctxTokens)} / ${win}` : `– / ${win}`

    // 5h·7d는 값이 아직 없어도 자리를 잡아 두고 회색 '–'로 표시
    const known = pickLimits(u, api, now)
    const kinds = [...SLOTS, ...known.map(l => l.kind).filter(k => !SLOTS.includes(k))]
    const claude: Slot[] = kinds.map(kind => {
      const label = LABELS[kind] ?? kind
      const l = known.find(x => x.kind === kind)
      if (!l) return pendingSlot(kind, label)
      const rem = Math.max(0, Math.round(100 - l.percentUsed))
      const resetMs = l.resetsAt ? Date.parse(l.resetsAt) : null
      return { key: kind, label, pending: false, rem, color: paceColor(rem, label, resetMs, now), reset: resetMs !== null ? fmtReset(resetMs, now) : null }
    })
    const cxSlots = codexSlots(cx, now)

    if (e.surface === 'desktop' && 'Svg' in ui) {
      const { Svg } = ui as typeof ui & { Svg: (p: { source: string; alt: string; width?: number; height?: number }) => unknown }
      const tier = tierOf(e.viewport?.columns)
      const barW = BAR_W[tier]

      // 항목 안 요소는 기본 간격으로 붙여 두고(요소별 고정 폭 없음), 정렬은 항목 바깥 폭(가장 긴 경우 기준)으로 맞춘다
      const chip = (key: string, label: string, pct: number, color: string, value: string, pending: boolean, tail: unknown, tailCells: number, markPct?: number) => (
        <Box key={key} flexDirection="row" alignItems="center" gap={1} flexShrink={0}
          width={COL.label + BAR_CELLS[tier] + COL.value + tailCells + 3}>
          <Text bold={!pending} dimColor={pending}>{label}</Text>
          {barW > 0 ? <Svg source={bar(pending ? 0 : pct, color, barW, markPct)} alt={`${label} ${value}`} width={barW} height={6} /> : null}
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
        : chip(s.key, s.label, s.rem, s.color, `${s.rem}%`, false, resetTail(s.reset), RESET_CELLS[tier])

      const row = (key: string, name: string, theme: RowTheme, items: unknown[]) => (
        <Box key={key} flexDirection="row" flexWrap="nowrap" alignItems="center" gap={1} overflow="hidden"
          backgroundColor={theme.bg} paddingX={1} paddingY={0}>
          <Box width={2} flexShrink={0}><Svg source={logo(theme.logo)} alt={theme.name} width={13} height={13} /></Box>
          {items.flatMap((item, i) => (i === 0 ? [item] : [<Text key={`${key}-sep${i}`} dimColor>│</Text>, item]))}
        </Box>
      )

      const claudeItems = claude.map(slotChip)
      claudeItems.push(chip('ctx', 'ctx', used, hasCtx ? ctxColor(view.colorPct) : 'gray', hasCtx ? `${used}%` : '–', !hasCtx,
        tier >= 2 ? <Text dimColor>{tokens}</Text> : null, tier >= 2 ? COL.tokens : 0, hasCtx ? view.markPct : undefined))

      return (
        <Box flexDirection="column">
          {row('claude', 'Claude', CLAUDE_THEME, claudeItems)}
          <Svg source={ROW_GAP} alt="줄 간격" width={8} height={3} />
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
            {s.pending ? <Text dimColor>–</Text> : <Text color={s.color}>{s.rem}%</Text>}
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
            {hasCtx ? <Text color={ctxColor(view.colorPct)}>{used}%</Text> : <Text dimColor>–</Text>}
            <Text dimColor> ({tokens}{view.markPct !== undefined && u?.ctxLimit !== undefined ? ` · 압축 ${fmtTokens(u.ctxLimit)}` : ''})</Text>
          </Box>
        ))}
        {textRow('codex', 'Codex', CODEX_THEME, cxSlots, null)}
      </Box>
    )
  })
}
