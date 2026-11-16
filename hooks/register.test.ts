import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { bar, buildUsage, cellWidth, ctxView, fitLevel, nextBackoff, nextCtxLimit, parseClaudeUsage, pickLimits, rowText, sanitizeCache } from './register'
import type { RowSpec } from './register'

test('실패 대기는 2분부터 두 배씩, 최대 30분', async () => {
  expect(nextBackoff(undefined, null)).toBe(120_000)
  expect(nextBackoff(120_000, null)).toBe(240_000)
  expect(nextBackoff(1_200_000, null)).toBe(1_800_000)
  expect(nextBackoff(1_800_000, null)).toBe(1_800_000)
})

test('Retry-After가 더 길면 그만큼 기다리되 1시간을 넘기지 않는다', async () => {
  expect(nextBackoff(undefined, 600)).toBe(600_000)
  expect(nextBackoff(undefined, 30)).toBe(120_000)
  expect(nextBackoff(undefined, 999_999)).toBe(3_600_000)
})

test('깨진 공유 파일은 빈 값으로, 이상한 항목은 버리고, 먼 미래 nextAt은 1시간으로 자른다', async () => {
  expect(sanitizeCache(null, 0)).toEqual({})
  expect(sanitizeCache('x', 0)).toEqual({})
  const c = sanitizeCache({
    fetchedAt: 10,
    nextAt: 9e15,
    limits: [{ kind: 'seven_day', percentUsed: 98, resetsAt: 'a' }, { kind: 'five_hour', percentUsed: 'NaN' }, null],
  }, 1_000)
  expect(c.nextAt).toBe(1_000 + 3_600_000)
  expect(c.limits).toEqual([{ kind: 'seven_day', percentUsed: 98, resetsAt: 'a' }])
  expect(c.fetchedAt).toBe(10)
})

test('공유 파일의 미래 fetchedAt은 버린다', async () => {
  expect(sanitizeCache({ fetchedAt: 5_000 }, 1_000).fetchedAt).toBeUndefined()
})

test('ctx %는 토큰 ÷ 분모로 계산하고, 토큰이 없으면 엔진 %를 쓴다', async () => {
  expect(buildUsage(null, { tokens: 232_000, window: 1_000_000, limits: [] }, false, 5).ctxPercent).toBe(23)
  expect(buildUsage(null, { window: 1_000_000, percent: 7, limits: [] }, false, 5).ctxPercent).toBe(7)
})

test('폴링 값은 limitsAt을 바꾸지 않고, 응답 값은 뒤로 가지 않게 찍는다', async () => {
  const prev = { ctxWindow: 1, limits: [{ kind: 'seven_day', percentUsed: 92 }], limitsAt: 100 }
  const lim = [{ kind: 'seven_day', percentUsed: 93 }]
  expect(buildUsage(prev, { window: 1, limits: lim }, false, 500).limitsAt).toBe(100)
  expect(buildUsage(prev, { window: 1, limits: lim }, true, 500).limitsAt).toBe(500)
  expect(buildUsage(prev, { window: 1, limits: lim }, true, 50).limitsAt).toBe(100)
})

test('엔진 limits가 비어 있으면 이전 limits를 유지한다', async () => {
  const prev = { ctxWindow: 1, limits: [{ kind: 'seven_day', percentUsed: 92 }], limitsAt: 100 }
  expect(buildUsage(prev, { window: 1, limits: [] }, true, 500)).toMatchObject({ limits: prev.limits, limitsAt: 100 })
})

const NOW = 1_000_000_000
const engine = (limitsAt: number) => ({
  ctxWindow: 1_000_000,
  limits: [
    { kind: 'seven_day', percentUsed: 92 },
    { kind: 'spend_limit', percentUsed: 10 },
  ],
  limitsAt,
})
const api = (fetchedAt: number) => ({ fetchedAt, limits: [{ kind: 'seven_day', percentUsed: 93 }] })

test('직접 조회 값이 5분 안이면 그 창은 직접 조회 값, 나머지 창은 엔진 값을 쓴다', async () => {
  expect(pickLimits(engine(NOW), api(NOW - 60_000), NOW)).toEqual([
    { kind: 'seven_day', percentUsed: 93 },
    { kind: 'spend_limit', percentUsed: 10 },
  ])
})

test('직접 조회 값이 5분 넘게 오래됐고 엔진 값이 더 새면 엔진 값을 쓴다', async () => {
  expect(pickLimits(engine(NOW - 1_000), api(NOW - 10 * 60_000), NOW)[0]).toEqual({ kind: 'seven_day', percentUsed: 92 })
})

test('직접 조회 값이 5분 넘게 오래됐어도 엔진 값보다 새면 직접 조회 값을 쓴다', async () => {
  expect(pickLimits(engine(NOW - 20 * 60_000), api(NOW - 10 * 60_000), NOW)[0]).toEqual({ kind: 'seven_day', percentUsed: 93 })
})

test('직접 조회 값이 없으면 엔진 값, 둘 다 없으면 빈 목록', async () => {
  expect(pickLimits(engine(NOW), null, NOW)).toEqual(engine(NOW).limits)
  expect(pickLimits(null, null, NOW)).toEqual([])
})

test('/api/oauth/usage 응답의 5h·7d를 0~100 그대로 읽고 6자리 소수 리셋 시각을 변환한다', async () => {
  const limits = parseClaudeUsage({
    five_hour: { utilization: 0.0, resets_at: '2026-10-13T08:40:00.259364+00:00' },
    seven_day: { utilization: 93.0, resets_at: '2026-10-13T17:00:00.259394+00:00' },
    iguana_necktie: { utilization: 5 },
  })
  expect(limits).toEqual([
    { kind: 'five_hour', percentUsed: 0, resetsAt: '2026-10-13T08:40:00.259Z' },
    { kind: 'seven_day', percentUsed: 93, resetsAt: '2026-10-13T17:00:00.259Z' },
  ])
})

test('창이 null이거나 사용률이 숫자가 아니면 건너뛴다', async () => {
  expect(parseClaudeUsage({ seven_day: null, five_hour: { utilization: 'x' } })).toEqual([])
})

test('사용률은 0~100으로 자르고 리셋 시각이 없으면 생략한다', async () => {
  expect(parseClaudeUsage({ seven_day: { utilization: 120 } })).toEqual([{ kind: 'seven_day', percentUsed: 100 }])
})

test('압축 창을 모델 창보다 작게 잡으면 그 값을 눈금으로 남기고, 같으면 남기지 않는다', async () => {
  expect(buildUsage(null, { tokens: 160_000, window: 1_000_000, limit: 400_000, limits: [] }, false, 5))
    .toMatchObject({ ctxPercent: 16, ctxWindow: 1_000_000, ctxLimit: 400_000 })
  expect(buildUsage(null, { tokens: 160_000, window: 1_000_000, limits: [] }, false, 5).ctxLimit).toBeUndefined()
})

test('눈금 위치는 압축 창 ÷ 모델 창, 색은 압축 창에 얼마나 가까운지로 정한다', async () => {
  expect(ctxView({ ctxPercent: 32, ctxTokens: 320_000, ctxWindow: 1_000_000, ctxLimit: 400_000, limits: [] }))
    .toEqual({ used: 32, colorPct: 80, markPct: 40 })
  expect(ctxView({ ctxPercent: 32, ctxTokens: 320_000, ctxWindow: 1_000_000, limits: [] }))
    .toEqual({ used: 32, colorPct: 32, markPct: undefined })
})

test('막대는 눈금이 있을 때만 눈금 선을 그린다', async () => {
  expect(bar(16, 'green', 100, 40)).toContain('data-mark="40"')
  expect(bar(16, 'green', 100)).not.toContain('data-mark')
})

const bd = (rawMaxTokens: number, isAutoCompactEnabled = true) => ({ rawMaxTokens, isAutoCompactEnabled })

test('분석이 모델 창보다 작은 압축 창을 보면 눈금을 남기고, 같거나 자동 압축이 꺼져 있으면 지운다', async () => {
  expect(nextCtxLimit(undefined, undefined, { window: 1_000_000, breakdown: bd(400_000) })).toEqual({ basis: 400_000, limit: 400_000 })
  expect(nextCtxLimit(400_000, 400_000, { window: 1_000_000, breakdown: bd(1_000_000) })).toEqual({ basis: null })
  expect(nextCtxLimit(400_000, 400_000, { window: 1_000_000, breakdown: bd(400_000, false) })).toEqual({ basis: null })
})

test('분석 없는 읽기는 지난 압축 창을 쓰되, 모델 창이 그보다 작아졌으면 눈금을 지운다', async () => {
  expect(nextCtxLimit(400_000, undefined, { window: 1_000_000 })).toEqual({ basis: 400_000, limit: 400_000 })
  expect(nextCtxLimit(null, 400_000, { window: 1_000_000 })).toEqual({ basis: null })
  expect(nextCtxLimit(400_000, 400_000, { window: 200_000 })).toEqual({ basis: 400_000 })
})

test('모듈이 다시 올라와 아직 안 쟀으면 저장된 눈금을 이어 쓴다', async () => {
  expect(nextCtxLimit(undefined, 400_000, { window: 1_000_000 })).toEqual({ basis: undefined, limit: 400_000 })
  expect(nextCtxLimit(undefined, undefined, { window: 1_000_000 })).toEqual({ basis: undefined })
})

test('토큰이 없으면 엔진 %로 색을 정하고, 모델 창이 0이면 눈금을 그리지 않는다', async () => {
  expect(ctxView({ ctxPercent: 32, ctxWindow: 1_000_000, ctxLimit: 400_000, limits: [] }).colorPct).toBe(80)
  expect(ctxView({ ctxPercent: 5, ctxWindow: 0, ctxLimit: 400_000, limits: [] }).markPct).toBeUndefined()
})

test('눈금은 막대 끝을 넘지 않는다', async () => {
  expect(bar(0, 'green', 100, 150)).toContain('x="98.0"')
  expect(bar(0, 'green', 100, 0)).toContain('x="0.0"')
})

const slot = (key: string, label: string, rem: number, left: string, atShort: string) =>
  ({ key, label, pending: false, rem, color: 'green', reset: { left, at: '', atShort } })
const claudeRow: RowSpec = {
  name: 'Claude',
  slots: [slot('five_hour', '5h', 75, '03:41', '화 06:24'), slot('seven_day', '7d', 31, '2d 13:59', '목 16:42')],
  ctx: { value: '22%', detail: '223K / 1.0M · 압축 400K' },
}
const codexRow: RowSpec = {
  name: 'Codex',
  slots: [slot('cx0-5h', '5h', 75, '03:41', '화 06:24'), slot('cx0-7d', '7d', 92, '2d 13:59', '목 16:42')],
}
const fit = (spec: RowSpec, columns?: number) => rowText(spec, fitLevel(spec, columns))

test('표시 폭은 한글을 2칸, 나머지를 1칸으로 센다', async () => {
  expect(cellWidth('압축 400K')).toBe(9)
  expect(cellWidth('5h:75% (03:41 · 화 06:24)')).toBe(25)
})

test('폭을 모르거나 넓으면 지금과 같은 글자를 그대로 그린다', async () => {
  const full = 'Claude 5h:75% (03:41 · 화 06:24) | 7d:31% (2d 13:59 · 목 16:42) | ctx 22% (223K / 1.0M · 압축 400K)'
  expect(fit(claudeRow)).toBe(full)
  expect(fit(claudeRow, 120)).toBe(full)
  expect(fit(codexRow, 120)).toBe('Codex  5h:75% (03:41 · 화 06:24) | 7d:92% (2d 13:59 · 목 16:42)')
})

test('90칸에선 리셋 시각을 빼고 남은 시간만 남긴다', async () => {
  expect(fit(claudeRow, 90)).toBe('Claude 5h:75% (03:41) | 7d:31% (2d 13:59) | ctx 22% (223K / 1.0M · 압축 400K)')
  expect(fit(codexRow, 90)).toBe('Codex  5h:75% (03:41 · 화 06:24) | 7d:92% (2d 13:59 · 목 16:42)')
})

test('70칸에선 ctx 괄호도 뺀다', async () => {
  expect(fit(claudeRow, 70)).toBe('Claude 5h:75% (03:41) | 7d:31% (2d 13:59) | ctx 22%')
  expect(fit(codexRow, 70)).toBe('Codex  5h:75% (03:41 · 화 06:24) | 7d:92% (2d 13:59 · 목 16:42)')
})

test('50칸에선 시간 괄호까지 빼고 %만 남긴다', async () => {
  expect(fit(claudeRow, 50)).toBe('Claude 5h:75% | 7d:31% | ctx 22%')
  expect(fit(codexRow, 50)).toBe('Codex  5h:75% (03:41) | 7d:92% (2d 13:59)')
})

test('어느 폭에서든 줄은 한 줄 폭을 넘지 않는다(가장 좁은 단계 제외)', async () => {
  for (const w of [120, 100, 90, 80, 70, 60, 50, 40]) {
    for (const spec of [claudeRow, codexRow]) expect(cellWidth(fit(spec, w))).toBeLessThan(w)
  }
})

test('대기 중 칸은 –로 그리고 리셋 괄호가 없다', async () => {
  const pending: RowSpec = { name: 'Codex', slots: [{ key: 'a', label: '5h', pending: true, rem: 0, color: 'gray', reset: null }] }
  expect(fit(pending, 50)).toBe('Codex  5h:–')
})

// 실제 그리기: 터미널 밴드를 폭별로 그려 줄마다 이어 붙인 글자를 본다
const bandAt = async ($: Parameters<TestBody>[0], columns: number) => {
  const ui = await $.ui.mount({ plugin: 'usage-band', surface: 'terminal', component: 'AbovePrompt',
    props: { hasSurvey: false, isCollapsed: false } as never, viewport: { columns, rows: 40 } })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '')
  await ui.unmount()
  const split = texts.findIndex(t => t.startsWith('Codex'))
  return [texts.slice(0, split).join(''), texts.slice(split).join('')]
}

test('터미널 밴드는 폭이 좁아질수록 리셋 시각 → ctx 괄호 → 시간 괄호 순으로 줄이고 한 줄을 지킨다', async ($, on) => {
  const now = 1_790_000_000_000
  mock.clock(on, { now })
  const at = (h: number) => new Date(now + h * 3_600_000).toISOString()
  const seeded: Record<string, unknown> = {
    usage: { ctxPercent: 22, ctxTokens: 223_000, ctxWindow: 1_000_000, ctxLimit: 400_000, limits: [], limitsAt: 0 },
    claude: { fetchedAt: now, limits: [
      { kind: 'five_hour', percentUsed: 25, resetsAt: at(3) }, { kind: 'seven_day', percentUsed: 69, resetsAt: at(61) }] },
    codex: { fetchedAt: now, accounts: [{ plan: 'pro',
      fiveHour: { usedPercent: 25, resetsAt: Math.floor(now / 1000) + 3 * 3600 },
      weekly: { usedPercent: 8, resetsAt: Math.floor(now / 1000) + 61 * 3600 } }] },
  }
  on('state.get', (_, e) => ({ value: { value: seeded[(e as { key: string }).key] ?? null } }) as never)

  const [c120, x120] = await bandAt($, 120)
  expect(c120).toMatch(/^Claude 5h:75% \(03:00 · . \d\d:\d\d\) \| 7d:31% \(2d 13:00 · . \d\d:\d\d\) \| ctx 22% \(223K \/ 1\.0M · 압축 400K\)$/)
  expect(x120).toMatch(/^Codex  5h:75% \(03:00 · . \d\d:\d\d\) \| 7d:92% \(2d 13:00 · . \d\d:\d\d\)$/)
  expect((await bandAt($, 90))[0]).toBe('Claude 5h:75% (03:00) | 7d:31% (2d 13:00) | ctx 22% (223K / 1.0M · 압축 400K)')
  expect((await bandAt($, 70))[0]).toBe('Claude 5h:75% (03:00) | 7d:31% (2d 13:00) | ctx 22%')
  expect(await bandAt($, 50)).toEqual(['Claude 5h:75% | 7d:31% | ctx 22%', 'Codex  5h:75% (03:00) | 7d:92% (2d 13:00)'])
})
