import { expect, test } from 'claude-code/testing'

import { buildUsage, nextBackoff, parseClaudeUsage, pickLimits, sanitizeCache } from './register'

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
