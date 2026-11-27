import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { createRuntime } from '../index.js'
import { SOURCE_KIND, STEER_CUT } from '../src/host/constants.js'
import { matchSideEnter, sideChatsOf, sideSurface } from '../src/client/side-model.js'
import { indexRoster } from '../src/client/sources.js'
import { fakeContext } from './fake-ctx.js'

const SHELL_SCHEMA = {
  oneOf: [
    { properties: { kind: { const: 'foreground' }, exitCode: {} } },
    { properties: { kind: { const: 'promoted' }, cwd: {}, jobId: {}, timeoutMs: {}, output: {} } },
    { properties: { kind: { const: 'background' }, jobId: {} } },
  ],
}

function makeInbox() {
  const nextStep = []
  const nextTurn = []
  return {
    nextStep,
    nextTurn,
    prepend: (t, m) => (t === 'next-turn' ? nextTurn : nextStep).unshift(m),
    append: (t, m) => (t === 'next-turn' ? nextTurn : nextStep).push(m),
    remove: (mid) => {
      for (const list of [nextStep, nextTurn]) {
        const at = list.findIndex(m => m.id === mid)
        if (at !== -1) { list.splice(at, 1); return true }
      }
      return false
    },
  }
}

async function startGroupSteerEnv() {
  const home = mkdtempSync(join(tmpdir(), 'dsb-gw-steer-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1,
    mainBotIds: ['m1'],
    revision: 1,
    bots: {
      m1: { id: 'm1', name: 'Chief', sessionId: 'dm-m1', createdAt: 1 },
      w1: { id: 'w1', name: 'Writer', sessionId: 'dm-w1', createdAt: 2 },
      c1: { id: 'c1', name: 'Coder', sessionId: 'dm-c1', createdAt: 3 },
    },
    rooms: {
      g1: {
        id: 'g1',
        name: 'Launch',
        named: true,
        members: ['m1', 'w1', 'c1'],
        admin: 'm1',
        mode: 'admin',
        notice: '',
        createdAt: 4,
        seq: 2,
        seen: { m1: 2, w1: 2, c1: 2 },
        log: [
          { seq: 1, who: 'User', text: 'Build feature X', time: 10 },
          { seq: 2, who: 'Chief', botId: 'm1', text: '@Writer @Coder split the work', time: 20 },
        ],
        sessions: { m1: 'gw-m1', w1: 'gw-w1', c1: 'gw-c1' },
        segments: { w1: [{ sessionId: 'gw-w1-old', endedAt: 5 }] },
      },
    },
    roomBatches: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
    prefs: {},
  }))

  const shellCalls = []
  const bashDef = {
    name: 'bash',
    description: 'shell',
    output: {
      schema: SHELL_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: `exit ${value?.exitCode ?? 0}` }],
    },
    execute: args => new Promise((res, rej) => { shellCalls.push({ args, res, rej }) }),
  }

  const agentMap = new Map()
  const agentCalls = []
  const roomFollowups = []
  const header = {
    config: { provider: 'deepseek', model: 'v4', maxTokens: 4096 },
    tools: [{ name: 'bash' }],
  }
  const makeAgent = (id, messages = [{ role: 'user', content: [{ type: 'text', text: 'Group context' }] }]) => {
    const inbox = makeInbox()
    const session = {
      id,
      seq: 5,
      header: { ...header, cwd: '/team' },
      inheritedEventCount: 0,
      deriveMessages: () => messages,
      toolHistory: () => [],
      requestHeader: () => header,
      snapshotEvents: () => [],
    }
    const agent = {
      id,
      session,
      status: 'running',
      inbox,
      ctx: {
        tools: { register: def => (agentCalls.push(['register', id, def]), () => {}), restrict: () => () => {} },
        on: (ev, fn) => (agentCalls.push(['on', id, ev, fn]), () => {}),
        effect: fn => fn?.(),
      },
      followup: (msg) => {
        agentCalls.push(['followup', id, msg])
        if (id === 'g1') roomFollowups.push(msg)
      },
      inject: msg => agentCalls.push(['inject', id, msg]),
      send: (msg, target) => inbox[target === 'next-turn' ? 'nextTurn' : 'nextStep'].push(msg),
      cancel: (cause, options) => agentCalls.push(['cancel', id, cause, options]),
    }
    agentMap.set(id, agent)
    return agent
  }

  for (const id of ['g1', 'dm-m1', 'dm-w1', 'dm-c1', 'gw-m1', 'gw-w1', 'gw-w1-old', 'gw-c1']) {
    makeAgent(id, [{ role: 'user', content: [{ type: 'text', text: `History of ${id}` }] }])
  }

  const llmRequests = []
  const ctx = fakeContext({
    services: {
      jobs: {
        read: jobId => ({
          job: { id: jobId, status: 'running', output: { spillPaths: [] } },
          lossy: false,
          chunks: [{ text: 'building...', channel: 'stdout' }],
        }),
      },
    },
  })
  ctx.tools.register(bashDef)
  ctx.tools.get = name => (name === 'bash' ? bashDef : undefined)
  ctx.tools.schemas = () => [{ name: 'bash' }]
  const origGet = ctx.get
  Object.assign(ctx, {
    get: name => (name === 'agents' ? agentMap : origGet(name)),
    llm: {
      listProviders: () => [],
      listModels: async () => [],
      resolveModelInfo: async () => ({ reasoning: { efforts: [] } }),
      async *stream(options) {
        llmRequests.push(options)
        yield { type: 'text-delta', index: 0, text: `Side answer from ${options.sessionId}` }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    workspaceRegistry: {
      get: () => ({ id: 'ws1', path: '/team' }),
      list: () => [{ id: 'ws1', path: '/team' }],
      resolveByPath: async () => undefined,
      create: async p => ({ id: 'ws1', path: p }),
      archiveSession: async () => {},
    },
    sessionController: {
      create: async () => ({ sessionId: 'fresh' }),
      resolveAgent: async id => ({ agent: agentMap.get(id) }),
      selectModel: async () => {},
      page: async () => ({ records: [], hasMore: false }),
    },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (route) => { ctx.route = route; return register(route) }
  const rt = createRuntime(ctx, { home })
  await rt.load()
  // Seed initial ledger lines to match room.seq = 2.
  rt.ledger.append('group-g1', { seq: 1, who: 'User', text: 'Build feature X', time: 10 })
  rt.ledger.append('group-g1', { seq: 2, who: 'Chief', botId: 'm1', text: '@Writer @Coder split the work', time: 20 })

  const call = async (endpoint, payload = {}) => (await ctx.route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  const emit = async (id, type, data, time = Date.now()) => {
    const session = agentMap.get(id)?.session ?? { id }
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) await listener(session, { type, data, time })
    }
    await new Promise(r => setTimeout(r, 0))
  }
  const emitStream = async (id, frame = { type: 'start' }) => {
    const agent = agentMap.get(id)
    for (const listener of ctx.listeners.get('agent/assistant-stream') ?? []) {
      await listener({ agent, frame })
    }
    await new Promise(r => setTimeout(r, 0))
  }
  const stop = async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5 })
  }
  return { rt, call, emit, emitStream, stop, agentMap, agentCalls, roomFollowups, shellCalls, llmRequests }
}

test('in-place user steer in a group member session cuts the model stream, logs to the group ledger, and preserves batch barriers', async (t) => {
  const env = await startGroupSteerEnv()
  t.after(env.stop)
  const { rt, emit, emitStream, agentMap, agentCalls, roomFollowups } = env
  const writerAgent = agentMap.get('gw-w1')

  // Both Writer (gw-w1) and Coder (gw-c1) start group turns called by Chief (m1) in batch b-1.
  await emit('gw-c1', 'turn/start', { turn: 1 }, 99)
  await emit('gw-w1', 'turn/start', { turn: 1 }, 100)
  rt.state.roomBatches = {
    'b-1': {
      key: 'b-1',
      roomId: 'g1',
      by: 'm1',
      pending: ['w1', 'c1'],
      done: [],
      doneIds: [],
      results: [],
      worked: true,
      answered: false,
    },
  }
  await emit('gw-w1', 'user/message', {
    turn: 1,
    source: { kind: SOURCE_KIND, role: 'room', roomId: 'g1', askedBy: 'm1', exchangeId: 'ex-w1' },
    content: [{ type: 'text', text: '[Group chat "Launch"]\nChief: @Writer @Coder split the work' }],
  }, 101)
  await emit('gw-w1', 'step/start', { turn: 1, step: 0 }, 102)
  await emitStream('gw-w1', { type: 'start' })

  // User types an in-place steer directly in gw-w1 while the model is streaming!
  const steerMsg = { id: 'u-steer-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Keep adapter.js backward-compatible' }] }
  writerAgent.inbox.nextStep.push(steerMsg)
  await emit('gw-w1', 'agent/inbox/spliced', { target: 'next-step', inserted: [steerMsg] }, 110)

  // 1. steer.js cuts the running model call with STEER_CUT and moves steerMsg to nextTurn.
  const cancelCall = agentCalls.find(c => c[0] === 'cancel' && c[1] === 'gw-w1')
  assert.ok(cancelCall, 'expected STEER_CUT cancel on gw-w1')
  assert.deepEqual(cancelCall[2], { kind: 'hook', reason: STEER_CUT })
  assert.equal(writerAgent.inbox.nextTurn[0]?.id, 'u-steer-1')

  // 2. Cut turn ends: batch b-1 MUST stay intact (both w1 and c1 still pending, no premature post!).
  await emit('gw-w1', 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'hook', reason: STEER_CUT } } }, 112)
  assert.deepEqual(rt.state.roomBatches['b-1'].pending, ['w1', 'c1'])
  assert.equal(roomFollowups.length, 0)

  // 3. Replacement turn starts with carried group trigger + user's steer message.
  await emit('gw-w1', 'turn/start', { turn: 2 }, 115)
  await emit('gw-w1', 'user/message', steerMsg, 116)

  // User steer was logged into group g1's ledger with @Writer prefix and room.seen.w1 advanced so Writer won't re-read it.
  const room = rt.roomOf('g1')
  assert.equal(room.seq, 3)
  assert.equal(room.log.at(-1).who, 'User')
  assert.equal(room.log.at(-1).text, '@Writer Keep adapter.js backward-compatible')
  assert.equal(room.seen.w1, 3)

  // 4. Writer finishes the steered turn; w1 leaves batch b-1 quietly because c1 is still working!
  await emit('gw-w1', 'assistant/message', {
    turn: 2,
    message: { content: [{ type: 'text', text: 'Updated adapter.js with full backward compatibility.' }] },
  }, 150)
  await emit('gw-w1', 'turn/end', { turn: 2, reason: { kind: 'completed' } }, 160)

  await new Promise(r => setTimeout(r, 20))
  assert.deepEqual(rt.state.roomBatches['b-1'].pending, ['c1'], 'c1 must remain pending in batch b-1')
  assert.deepEqual(rt.state.roomBatches['b-1'].doneIds, ['w1'])
  assert.equal(roomFollowups.length, 1)
  assert.equal(roomFollowups[0].source.quiet, true, 'post must stay quiet while peer c1 still works in batch')
})

test('shell detach and ad-hoc idle user input in a group member session work without touching unrelated batches', async (t) => {
  const env = await startGroupSteerEnv()
  t.after(env.stop)
  const { rt, emit, agentMap, agentCalls, shellCalls, roomFollowups } = env
  const writerAgent = agentMap.get('gw-w1')

  // 1. Shell execute hook detaches foreground bash on gw-w1 when steered by user.
  rt.shadowShells(writerAgent)
  const hook = agentCalls.find(c => c[0] === 'on' && c[1] === 'gw-w1' && c[2] === 'tools/execute')?.[3]
  assert.ok(hook, 'expected tools/execute steer hook on gw-w1')
  await emit('gw-c1', 'turn/start', { turn: 1 }, 9)
  await emit('gw-w1', 'turn/start', { turn: 1 }, 10)
  rt.state.roomBatches = {
    'b-1': {
      key: 'b-1',
      roomId: 'g1',
      by: 'm1',
      pending: ['w1', 'c1'],
      done: [],
      doneIds: [],
      results: [],
      worked: true,
      answered: false,
    },
  }
  const pendingExec = hook({ agent: writerAgent, callId: 'call-sh', name: 'bash', arguments: { command: 'npm test', workdir: 'pkg' }, signal: AbortSignal.timeout(30_000) }, () => { throw new Error('unexpected fallthrough') })
  const steer = { id: 'u-sh', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'skip slow suite' }] }
  writerAgent.inbox.nextStep.push(steer)
  await emit('gw-w1', 'agent/inbox/spliced', { target: 'next-step', inserted: [steer] }, 12)
  await emit('gw-w1', 'job/registered', { jobId: 'job-9', toolCall: { callId: 'call-sh' } }, 15)
  const promoted = (await pendingExec)?.value
  assert.equal(promoted.kind, 'promoted')
  assert.equal(promoted.jobId, 'job-9')
  assert.equal(promoted.cwd, resolve('/team', 'pkg'))
  shellCalls[0].res({ kind: 'foreground', exitCode: 0 })
  await emit('gw-w1', 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }, 30)
  await new Promise(r => setTimeout(r, 20))
  // Direct user abort cleaned w1 out of batch b-1 and posted stopped notice!
  assert.deepEqual(rt.state.roomBatches['b-1'].pending, ['c1'])
  assert.equal(roomFollowups.at(-1)?.source.stopped, true)

  // 2. Put w1 into a parked batch to verify an idle ad-hoc user message (role: 'user-steer') does not close it.
  rt.state.roomBatches['b-1'].pending = ['w1', 'c1']
  const beforeFollowups = roomFollowups.length
  await emit('gw-w1', 'turn/start', { turn: 2 }, 50)
  await emit('gw-w1', 'user/message', {
    turn: 2,
    source: { kind: 'user' },
    content: [{ type: 'text', text: '@Writer quick status?' }],
  }, 51)
  await emit('gw-w1', 'assistant/message', {
    turn: 2,
    message: { content: [{ type: 'text', text: 'Standing by.' }] },
  }, 55)
  await emit('gw-w1', 'turn/end', { turn: 2, reason: { kind: 'completed' } }, 60)
  await new Promise(r => setTimeout(r, 20))

  // Ledger recorded without duplicating @Writer, reply posted to group, and batch pending list untouched!
  assert.equal(rt.roomOf('g1').log.at(-1).text, '@Writer quick status?')
  assert.equal(roomFollowups.length, beforeFollowups + 1)
  assert.deepEqual(rt.state.roomBatches['b-1'].pending, ['w1', 'c1'])
})

test('side chats work on group member sessions, isolate private vs group scopes, and leave composer unblocked', async (t) => {
  const env = await startGroupSteerEnv()
  t.after(env.stop)
  const { rt, call, llmRequests } = env

  // Ask a side question in Writer's private chat vs Writer's group work session (and archived group segment).
  const privAsk = await call('side-ask', { sessionId: 'dm-w1', recent: true, text: 'Private question?' })
  assert.equal(privAsk.ok, true)
  await rt.sideJoin(privAsk.value.entryId)

  const groupAsk1 = await call('side-ask', { sessionId: 'gw-w1', recent: true, text: 'Why edit adapter.js?' })
  assert.equal(groupAsk1.ok, true)
  assert.notEqual(groupAsk1.value.chatId, privAsk.value.chatId, 'group side chat must not reuse private side chat')
  await rt.sideJoin(groupAsk1.value.entryId)

  // Asking from an archived group segment resolves to the active group session and reuses the group side chat.
  const groupAsk2 = await call('side-ask', { sessionId: 'gw-w1-old', recent: true, text: 'Follow-up in group?' })
  assert.equal(groupAsk2.ok, true)
  assert.equal(groupAsk2.value.chatId, groupAsk1.value.chatId)
  await rt.sideJoin(groupAsk2.value.entryId)

  // Cross-scope chatId misuse is refused.
  const cross = await call('side-ask', { sessionId: 'dm-w1', chatId: groupAsk1.value.chatId, text: 'Cross scope?' })
  assert.equal(cross.ok, false)

  assert.deepEqual(llmRequests.map(req => req.sessionId), ['dm-w1', 'gw-w1', 'gw-w1'])

  const state = (await call('state')).value
  const roster = indexRoster(state)
  assert.equal(sideSurface(roster, 'gw-w1'), 'bot')
  assert.equal(sideSurface(roster, 'g1'), 'group')
  assert.deepEqual(await matchSideEnter(roster, 'gw-w1', '/side check step 2', { attachments: 0 }), { claim: true })

  // Client sideChatsOf filters strictly by roomId scope.
  const privChats = sideChatsOf(roster, 'w1')
  const roomChats = sideChatsOf(roster, 'w1', 'g1')
  assert.equal(privChats.length, 1)
  assert.equal(privChats[0].roomId, undefined)
  assert.equal(roomChats.length, 1)
  assert.equal(roomChats[0].roomId, 'g1')
  assert.equal(roomChats[0].entries.length, 2)

  // Deleting the room cleans up its group side chats while preserving Writer's private side chat.
  await call('delete-room', { id: 'g1' })
  const afterDelete = indexRoster((await call('state')).value)
  assert.equal(sideChatsOf(afterDelete, 'w1').length, 1)
  assert.equal(sideChatsOf(afterDelete, 'w1', 'g1').length, 0)

  // Verify ReadOnlyDock on groupWork does NOT register keydown/click blockers on the composer card.
  const dockBundle = await build({
    entryPoints: [fileURLToPath(new URL('../src/client/read-only-dock.js', import.meta.url))],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    external: ['react'],
  })
  const listeners = []
  const mod = { exports: {} }
  runInNewContext(dockBundle.outputFiles[0].text, {
    module: mod,
    exports: mod.exports,
    document: {
      querySelector: () => ({
        addEventListener: type => listeners.push(type),
        removeEventListener() {},
      }),
    },
    require: () => ({
      createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
      useEffect: fn => { fn() },
      useRef: current => ({ current }),
    }),
  })
  mod.exports.ReadOnlyDock({
    sessionId: 'gw-w1',
    useUi: fn => fn({ readOnlyPart: null }),
    useRoster: fn => fn(roster),
    actions: { stopMemberWork() {}, openSession() {} },
  })
  assert.deepEqual(listeners, [], 'groupWork dock must leave composer Enter and Send unblocked')
})
