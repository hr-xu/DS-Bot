import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runStatsOf } from '../src/client/text.js'
import { install as installChannel, runStatsValues } from '../src/host/channel.js'
import { fakeContext } from './fake-ctx.js'

const texts = values => runStatsOf(values).map(entry => entry.text)

test('the figures read as DSH counts them', () => {
  const values = {
    sessionStats: { turns: 12, decodeMs: 4000, decodeTokens: 150 },
    tokenUsage: { uncachedInputTokens: 50, cacheReadTokens: 900, cacheWriteTokens: 50, outputTokens: 400 },
    contextPressure: { pressureTokens: 41_000, contextWindow: 100_000 },
  }
  assert.deepEqual(texts(values), ['12 turns', '38 tok/s', 'Cache hit 90%', 'Context 41%'])
  assert.equal(runStatsOf(values).at(-1).title, '41.0K of 100.0K tokens of context in use')
})

test('a slow speed keeps a decimal, and a projected count wins over the last measure', () => {
  const values = {
    sessionStats: { turns: 1, decodeMs: 2000, decodeTokens: 9 },
    contextPressure: { pressureTokens: 10, projectedTokens: 30, contextWindow: 100 },
  }
  assert.deepEqual(texts(values), ['1 turn', '4.5 tok/s', 'Context 30%'])
})

test('a cache hit short of whole never reads 100%', () => {
  const hit = cacheReadTokens => texts({ tokenUsage: { uncachedInputTokens: 1000 - cacheReadTokens, cacheReadTokens } })
  assert.deepEqual(hit(996), ['Cache hit 99.6%'])
  assert.deepEqual(hit(1000), ['Cache hit 100%'])
  assert.deepEqual(hit(0), ['Cache hit 0%'])
})

test('nothing to count leaves the line empty', () => {
  assert.deepEqual(runStatsOf(null), [])
  assert.deepEqual(runStatsOf({ sessionStats: { turns: 0, decodeMs: 0, decodeTokens: 0 }, tokenUsage: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }), [])
  assert.deepEqual(texts({ contextPressure: { contextWindow: 100 } }), [])
})

test('runStatsValues overlays local agent live context without mutating DSH projections', () => {
  const original = {
    sessionStats: { turns: 2, decodeMs: 1000, decodeTokens: 40 },
    tokenUsage: { uncachedInputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 0, outputTokens: 40 },
    contextPressure: { pressureTokens: 17_436, projectedTokens: 18_100, contextWindow: 200_000 },
  }
  const overlaid = runStatsValues(original, { used: 12_984, size: 1_048_576, compactions: 0 })
  assert.notEqual(overlaid, original)
  assert.notEqual(overlaid.contextPressure, original.contextPressure)
  // Original DSH projection object stays untouched.
  assert.deepEqual(original.contextPressure, { pressureTokens: 17_436, projectedTokens: 18_100, contextWindow: 200_000 })
  assert.deepEqual(overlaid.contextPressure, { pressureTokens: 12_984, projectedTokens: 12_984, contextWindow: 1_048_576 })
  assert.deepEqual(texts(overlaid), ['2 turns', '40 tok/s', 'Cache hit 90%', 'Context 1%'])
  assert.equal(runStatsOf(overlaid).at(-1).title, '13.0K of 1.0M tokens of context in use')

  // Zero usage is valid; partial updates preserve the other field; invalid numbers are ignored.
  const zero = runStatsValues({ contextPressure: { pressureTokens: 50, projectedTokens: 60, contextWindow: 200_000 } }, { used: 0, size: 1_048_576 })
  assert.deepEqual(zero.contextPressure, { pressureTokens: 0, projectedTokens: 0, contextWindow: 1_048_576 })
  assert.equal(runStatsOf(zero).at(-1).text, 'Context 0%')

  const sizeOnly = runStatsValues(original, { size: 475_000, compactions: 1 })
  assert.deepEqual(sizeOnly.contextPressure, { pressureTokens: 17_436, projectedTokens: 18_100, contextWindow: 475_000 })

  const usedOnly = runStatsValues({ contextPressure: { contextWindow: 475_000 } }, { used: 25_000, compactions: 0 })
  assert.deepEqual(usedOnly.contextPressure, { pressureTokens: 25_000, projectedTokens: 25_000, contextWindow: 475_000 })

  assert.equal(runStatsValues(original, undefined), original)
  assert.equal(runStatsValues(original, { used: -1, size: 0, compactions: 0 }), original)
})

test('run-stats endpoint overlays local agent context only for local agent sessions', async (t) => {
  const localSnap = { sessionStats: { turns: 1 }, contextPressure: { pressureTokens: 17_436, projectedTokens: 18_100, contextWindow: 200_000 } }
  const modelSnap = { sessionStats: { turns: 1 }, contextPressure: { pressureTokens: 5_000, projectedTokens: 5_000, contextWindow: 128_000 } }
  const ctx = fakeContext({
    services: {
      sessionProjections: {
        snapshot: session => ({ values: session.id === 's-local' ? localSnap : modelSnap }),
      },
    },
  })
  t.after(() => ctx.dispose())
  const bots = {
    local: { id: 'local', sessionId: 's-local', model: 'local-antigravity/gemini-4-carbon' },
    plain: { id: 'plain', sessionId: 's-plain', model: 'deepseek/deepseek-chat' },
  }
  const rt = {
    ctx,
    home: '/tmp/dsb-run-stats-test',
    state: { bots, rooms: {}, agents: {}, mainBotIds: [], prefs: {}, exchanges: [], exchangeTurns: {}, questions: {}, views: {}, closedCards: {}, sections: [], capabilities: { items: {} }, revision: 1 },
    load: async () => {},
    refresh: async () => {},
    readOnly: () => undefined,
    phoneServe: () => {},
    onSaved: () => () => {},
    botOf: id => bots[id],
    chatOf: id => bots[id]?.sessionId,
    resolveAgent: async id => ({ session: { id } }),
    isLocalAgentSession: id => id === 's-local',
    localAgentContext: id => (id === 's-local' ? { used: 12_984, size: 1_048_576, compactions: 0 } : { used: 999, size: 999_999 }),
  }
  installChannel(rt)

  const localRes = await rt.channelCall('run-stats', { botId: 'local' })
  assert.equal(localRes.ok, true)
  assert.deepEqual(localRes.value.contextPressure, { pressureTokens: 12_984, projectedTokens: 12_984, contextWindow: 1_048_576 })
  assert.deepEqual(localSnap.contextPressure, { pressureTokens: 17_436, projectedTokens: 18_100, contextWindow: 200_000 })

  const plainRes = await rt.channelCall('run-stats', { botId: 'plain' })
  assert.equal(plainRes.ok, true)
  assert.deepEqual(plainRes.value.contextPressure, { pressureTokens: 5_000, projectedTokens: 5_000, contextWindow: 128_000 })
})
