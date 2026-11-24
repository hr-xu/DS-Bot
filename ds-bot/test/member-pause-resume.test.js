import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { createRuntime } from '../index.js'
import { SOURCE_KIND } from '../src/host/constants.js'
import { indexRoster } from '../src/client/sources.js'
import { fakeContext } from './fake-ctx.js'
import { afterRound } from './relay-rows.js'

function loadClientModule(relPath) {
  return build({
    entryPoints: [fileURLToPath(new URL(relPath, import.meta.url))],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
  }).then((bundle) => {
    const mod = { exports: {} }
    runInNewContext(bundle.outputFiles[0].text, {
      module: mod,
      exports: mod.exports,
      URL,
      URLSearchParams,
      Date,
      setTimeout,
      clearTimeout,
      window: { innerWidth: 1280, addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) },
      document: { body: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, documentElement: {}, querySelector: () => null },
      navigator: { clipboard: { writeText: async () => {} } },
      require: (name) => {
        const platform = {
          react: {
            createContext: (initial) => {
              const ctx = { value: initial }
              ctx.Provider = ({ value, children }) => { ctx.value = value; return children }
              return ctx
            },
            useContext: ctx => ctx.value,
            useId: () => 'id-1',
            useSyncExternalStore: (_sub, get) => get(),
            createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
            useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
            useEffect: () => {},
            useLayoutEffect: () => {},
            useRef: current => ({ current }),
            useMemo: make => make(),
            useCallback: fn => fn,
            Fragment: 'fragment',
          },
          'react-dom': { createPortal: node => node },
          '@deepseek-ai/dsh-client-ui-primitives': {
            MarkdownText: ({ text }) => ({ type: 'md', props: { text }, children: [text] }),
            writeClipboard: async () => true,
          },
        }
        if (!(name in platform)) throw new Error(`unexpected external module: ${name}`)
        return platform[name]
      },
    })
    return mod.exports
  })
}

function walk(node, match, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const item of node) walk(item, match, out)
    return out
  }
  if (typeof node.type === 'function') {
    const rendered = node.type({ ...node.props, children: node.children })
    return walk(rendered, match, out)
  }
  if (match(node)) out.push(node)
  for (const child of node.children ?? []) walk(child, match, out)
  return out
}

function textContent(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textContent).join('')
  if (typeof node.type === 'function') return textContent(node.type({ ...node.props, children: node.children }))
  return (node.children ?? []).map(textContent).join('')
}

const hook = value => select => (typeof select === 'function' ? select(value) : value)

const seed = (room = {}) => ({
  version: 1,
  mainBotIds: ['a'],
  bots: {
    a: { id: 'a', name: 'Chief', role: 'Boss', sessionId: 'a', createdAt: 1 },
    b: { id: 'b', name: 'Writer', role: 'Write', sessionId: 'b', createdAt: 2 },
    c: { id: 'c', name: 'Tester', role: 'Test', sessionId: 'c', createdAt: 3 },
  },
  rooms: {
    r1: {
      id: 'r1',
      name: 'Ops',
      members: ['a', 'b', 'c'],
      mode: 'admin',
      admin: 'a',
      named: true,
      sessions: { a: 'ga', b: 'gb', c: 'gc' },
      log: [],
      seq: 0,
      seen: {},
      ...room,
    },
  },
  agents: {},
  exchanges: [],
  exchangeTurns: {},
  questions: {},
  prefs: {},
  revision: 0,
})

async function start(t, room) {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-pause-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(seed(room)))
  const ctx = fakeContext()
  const agents = new Map()
  const agentOf = (sessionId) => {
    if (!agents.has(sessionId)) {
      const calls = []
      const cancelled = []
      const held = []
      const nextStep = []
      const inbox = {
        nextStep,
        nextTurn: held,
        remove(id) {
          for (const list of [nextStep, held]) {
            const at = list.findIndex(message => message.id === id)
            if (at !== -1) { list.splice(at, 1); return true }
          }
          return false
        },
      }
      const keep = list => (message) => { calls.push(message); list.push(message) }
      agents.set(sessionId, {
        id: sessionId,
        session: {
          id: sessionId,
          header: { cwd: '/team' },
          deriveMessages: () => [],
          toolHistory: () => [],
        },
        calls,
        cancelled,
        inbox,
        followup: keep(held),
        steer: keep(nextStep),
        cancel(reason) { cancelled.push(reason) },
      })
    }
    return agents.get(sessionId)
  }
  Object.assign(ctx, {
    llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({}) },
    workspaceRegistry: { get: () => undefined, resolveByPath: async () => undefined, create: async path => ({ id: 'w1', path }), archiveSession: async () => {} },
    sessionController: { create: async () => ({ sessionId: 's1' }), resolveAgent: async sessionId => ({ agent: agentOf(sessionId) }), selectModel: async () => {} },
    sessionTitle: { rename: async () => {} },
    sessions: { flush: async () => {} },
  })
  let route
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (options) => { route = options; return register(options) }
  const rt = createRuntime(ctx, { home })
  t.after(async () => {
    await ctx.dispose()
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  })
  let seq = 0
  const turns = new Map()
  const emit = (id, type, data) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) {
      if (listener.length >= 2) listener({ id }, { type, seq: ++seq, data })
    }
  }
  const tool = (name, args, sessionId, exec = {}) => rt.teamTools.find(d => d.name === name).execute(args, { agent: { id: sessionId }, ...exec })
  const call = async (endpoint, payload) => (await route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  const begin = (sessionId) => {
    const message = agentOf(sessionId).calls.at(-1)
    agentOf(sessionId).inbox.nextTurn.length = 0
    agentOf(sessionId).inbox.nextStep.length = 0
    const turn = (turns.get(sessionId) ?? 0) + 1
    turns.set(sessionId, turn)
    emit(sessionId, 'turn/start', { turn })
    emit(sessionId, 'user/message', { content: message.content, source: message.source })
    return message
  }
  const finish = (sessionId, reply) => {
    emit(sessionId, 'assistant/message', { message: { content: [{ type: 'text', text: reply }] } })
    emit(sessionId, 'turn/end', { turn: turns.get(sessionId), reason: { kind: 'completed' } })
  }
  const abort = (sessionId, reason = { kind: 'aborted' }) => {
    emit(sessionId, 'turn/end', { turn: turns.get(sessionId), reason })
  }
  const round = (callId, message, sessionId = 'r1') => {
    emit(sessionId, 'user/message', message)
    let result
    const stop = new AbortController()
    t.after(() => stop.abort())
    void tool('group_relay', {}, sessionId, { callId, signal: stop.signal }).then(async (value) => { result = await afterRound(rt, sessionId, value) })
    return () => result
  }
  const say = text => ({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  const takePost = () => {
    const post = agentOf('r1').calls.shift()
    return { content: post.content, source: post.source }
  }
  await tool('list_bots', {}, 'a')
  return { home, rt, ctx, agentOf, emit, tool, call, begin, finish, abort, round, say, takePost }
}

const settle = async (check) => {
  const until = Date.now() + 3000
  while (!check() && Date.now() < until) await new Promise(resolve => setImmediate(resolve))
  assert.ok(check(), 'condition not reached')
}
const until = async (check, ms = 3000) => {
  const stop = Date.now() + ms
  while (!check() && Date.now() < stop) await new Promise(resolve => setTimeout(resolve, 15))
  assert.ok(check(), 'condition not reached')
}
const textOf = message => message.content.map(block => block.text ?? '').join('\n')
const kinds = result => result.replies.map(reply => [reply.kind ?? 'message', reply.name])

test('pausing a running member preserves batch barriers, parks incoming @calls, and resuming with a note settles the batch', async (t) => {
  const host = await start(t)
  const r1 = host.round('c1', host.say('@Chief 拆一下文档和测试'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer 写文档 @Tester 跑测试')

  // Both Writer (gb) and Tester (gc) are called in the same batch by Chief (a).
  await settle(() => host.agentOf('gb').calls.length === 1 && host.agentOf('gc').calls.length === 1)
  const writerCall = host.begin('gb')
  const testerCall = host.begin('gc')
  assert.equal(writerCall.source.askedBy, 'a')
  assert.equal(testerCall.source.askedBy, 'a')

  // Pause Writer mid-turn while the round is active.
  const pauseRes = await host.call('pause-member-work', { roomId: 'r1', botId: 'b' })
  assert.equal(pauseRes.ok, true)
  assert.equal(pauseRes.value, true)
  assert.equal(host.agentOf('gb').cancelled.length, 1)
  assert.equal(host.agentOf('gb').cancelled[0].reason, 'ds-bot/member-paused')
  host.abort('gb')

  // Tester finishes its turn inside the round.
  host.finish('gc', '测试全部通过')
  await until(() => r1() !== undefined)
  assert.deepEqual(kinds(r1()), [
    ['message', 'Chief'],
    ['member-paused', 'Writer'],
    ['message', 'Tester'],
  ])

  // Chief must NOT be woken yet because Writer's hold keeps the batch barrier open.
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(host.agentOf('ga').calls.length, 1, 'Chief must wait while Writer is paused')
  assert.equal(host.rt.roomBatchPending('r1'), true)

  // Incoming @Writer call while paused parks instead of starting a turn.
  const r2 = host.round('c2', host.say('@Writer 记得补上配置示例'))
  await until(() => r2() !== undefined)
  assert.equal(host.agentOf('gb').calls.length, 1, 'paused Writer must not start a turn on @mention')

  const viewState = (await host.call('state')).value
  const roomView = viewState.rooms.find(r => r.id === 'r1')
  assert.equal(roomView.heldMembers?.b?.parked, 1)

  // Persisted state keeps heldMembers and batch pending across disk save.
  const disk = JSON.parse(readFileSync(join(host.home, 'state.json'), 'utf8'))
  assert.equal(disk.rooms.r1.heldMembers.b.parked.length, 1)
  const batchEntry = Object.values(disk.roomBatches)[0]
  assert.deepEqual(batchEntry.pending, ['b'])

  // Resume Writer with an instruction note.
  const resumeRes = await host.call('resume-member-work', {
    roomId: 'r1',
    botId: 'b',
    note: '只写核心配置段落即可',
  })
  assert.equal(resumeRes.ok, true)
  assert.equal(resumeRes.value, true)

  const clearedView = (await host.call('state')).value.rooms.find(r => r.id === 'r1')
  assert.equal(clearedView.heldMembers, undefined)

  await settle(() => host.agentOf('gb').calls.length === 2)
  const resumedMsg = host.begin('gb')
  assert.equal(resumedMsg.source.role, 'room')
  assert.equal(resumedMsg.source.askedBy, 'a')
  const promptText = textOf(resumedMsg)
  assert.ok(promptText.includes('The user paused your work in this group and has now resumed it.'))
  assert.ok(promptText.includes('记得补上配置示例'), 'unseen group messages while paused are included')
  assert.ok(promptText.includes('只写核心配置段落即可'), 'user resume note is included')

  // Writer finishes the resumed turn -> posts late reply and wakes Chief for the completed batch!
  host.finish('gb', '核心配置文档已补齐')
  await until(() => host.agentOf('r1').calls.length === 1)
  const latePost = host.takePost()
  assert.equal(latePost.source.askedBy, 'a')
  assert.equal(latePost.source.batchEnd, true)

  const r3 = host.round('c3', latePost)
  await settle(() => host.agentOf('ga').calls.length === 2)
  const chiefWake = host.begin('ga')
  assert.ok(textOf(chiefWake).includes('核心配置文档已补齐'))
  host.finish('ga', '收到，全部完成')
  await until(() => r3() !== undefined)
  assert.equal(host.rt.roomBatchPending('r1'), false)
})

test('typing directly in a paused member session lifts the hold, and stopping a paused member releases the batch barrier', async (t) => {
  const host = await start(t)

  // Part A: Direct user message in gb lifts hold and preserves askedBy batch settlement.
  const r1 = host.round('c1', host.say('@Chief 安排 Writer 写说明'))
  await settle(() => host.agentOf('ga').calls.length === 1)
  host.begin('ga')
  host.finish('ga', '@Writer 写一下安装说明')
  await settle(() => host.agentOf('gb').calls.length === 1)
  host.begin('gb')

  await host.call('pause-member-work', { roomId: 'r1', botId: 'b' })
  host.abort('gb')
  await until(() => r1() !== undefined)
  assert.ok(host.rt.roomOf('r1').heldMembers?.b)

  // User types directly in Writer's group session ('gb').
  host.emit('gb', 'turn/start', { turn: 99 })
  host.emit('gb', 'user/message', {
    content: [{ type: 'text', text: '改成只写 macOS 安装步骤' }],
    source: { kind: 'user' },
  })
  await until(() => host.rt.roomOf('r1').heldMembers === undefined)
  assert.equal(host.rt.roomOf('r1').log.at(-1).text, '@Writer 改成只写 macOS 安装步骤')
  assert.equal(host.rt.live.get('gb')?.info?.role, 'room')
  assert.equal(host.rt.live.get('gb')?.info?.askedBy, 'a')

  host.emit('gb', 'assistant/message', { message: { content: [{ type: 'text', text: 'macOS 步骤已写好' }] } })
  host.emit('gb', 'turn/end', { turn: 99, reason: { kind: 'completed' } })
  await until(() => host.agentOf('r1').calls.length === 1)
  const steeredPost = host.takePost()
  assert.equal(steeredPost.source.askedBy, 'a')
  const r2 = host.round('c2', steeredPost)
  await settle(() => host.agentOf('ga').calls.length === 2)
  host.begin('ga')
  host.finish('ga', '好')
  await until(() => r2() !== undefined)

  // Part B: Stopping a paused member clears hold and drops it from a multi-member batch so Chief wakes for completed peers.
  const r3 = host.round('c3', host.say('@Chief 再安排一轮'))
  await settle(() => host.agentOf('ga').calls.length === 3)
  host.begin('ga')
  host.finish('ga', '@Writer 改 README @Tester 跑回归')
  await settle(() => host.agentOf('gb').calls.length === 2 && host.agentOf('gc').calls.length === 1)
  host.begin('gb')
  host.begin('gc')

  await host.call('pause-member-work', { roomId: 'r1', botId: 'b' })
  host.abort('gb')
  host.finish('gc', '回归测试通过')
  await until(() => r3() !== undefined)
  assert.equal(host.rt.roomBatchPending('r1'), true)

  // Now stop paused Writer: hold clears, batch drops Writer, and Tester's completed batch wakes Chief!
  const stopRes = await host.call('stop-member-work', { roomId: 'r1', botId: 'b' })
  assert.equal(stopRes.ok, true)
  assert.equal(stopRes.value, true)
  assert.equal(host.rt.roomOf('r1').heldMembers, undefined)
  assert.equal(host.rt.roomBatchPending('r1'), false)

  await until(() => host.agentOf('r1').calls.length >= 1)
  // Drain posts delivered to r1 (the batch wake post + the stopped notice).
  while (host.agentOf('r1').calls.length > 0) {
    const post = host.takePost()
    if (post.source.stopped === true) continue
    assert.equal(post.source.askedBy, 'a')
  }
})

test('client member status, drawer buttons, read-only dock, and relay events render pause and resume states', async () => {
  const [
    { memberWork, busyMembers, MemberState, StopMemberWork },
    { ReadOnlyDock },
    { TriggerCell, ChatRows },
  ] = await Promise.all([
    loadClientModule('../src/client/member-status.js'),
    loadClientModule('../src/client/read-only-dock.js'),
    loadClientModule('../src/client/cells.js'),
  ])

  const chief = { id: 'a', sessionId: 'a', name: 'Chief', role: 'Boss', color: 'blue', parts: [] }
  const writer = { id: 'b', sessionId: 'b', name: 'Writer', role: 'Write', color: 'deepseek', parts: [] }
  const heldRoom = {
    id: 'r1',
    sessionId: 'r1',
    name: 'Ops',
    named: true,
    members: ['a', 'b'],
    admin: 'a',
    mode: 'admin',
    memberSessions: { b: 'gb' },
    heldMembers: { b: { at: Date.now() - 5000, parked: 2 } },
  }
  const roster = indexRoster({
    revision: 1,
    mainBotId: 'a',
    mainBotIds: ['a'],
    bots: [chief, writer],
    rooms: [heldRoom],
    agents: [],
    sections: [],
    exchangeTurns: {},
    questions: {},
    prefs: {},
    partsRunning: {},
  })

  // 1. memberWork reports 'paused' and busyMembers excludes paused members from the running dock.
  const entries = memberWork(heldRoom, { bots: {}, rooms: {}, approvals: [] })
  const writerEntry = entries.find(item => item.id === 'b')
  assert.equal(writerEntry.state, 'paused')
  assert.equal(writerEntry.here, true)
  assert.equal(busyMembers(heldRoom, { bots: {}, rooms: {}, approvals: [] }, roster).length, 0)

  // 2. MemberState shows parked count when paused, while sidebar StopMemberWork stays hidden when not running.
  const stateTree = MemberState({ entry: writerEntry, bot: writer })
  assert.ok(textContent(stateTree).includes('Paused · 2 waiting'))
  assert.equal(StopMemberWork({ entry: writerEntry, bot: writer, room: heldRoom, actions: {} }), null)

  const calls = []
  const actions = {
    pauseMemberWork: (rId, bId) => calls.push(['pause', rId, bId]),
    resumeMemberWork: (rId, bId) => calls.push(['resume', rId, bId]),
    stopMemberWork: (rId, bId) => calls.push(['stop', rId, bId]),
    openSession: id => calls.push(['open', id]),
    reportError() {},
  }

  // 3. Running group session dock renders Pause + Back to Ops (without duplicating composer Stop).
  const runningRoster = indexRoster({
    revision: 2,
    mainBotId: 'a',
    mainBotIds: ['a'],
    bots: [chief, writer],
    rooms: [{ ...heldRoom, heldMembers: undefined }],
    agents: [],
    sections: [],
    exchangeTurns: {},
    questions: {},
    prefs: {},
    partsRunning: { gb: true },
  })
  const runningDock = ReadOnlyDock({
    sessionId: 'gb',
    useUi: hook({ readOnlyPart: null }),
    useRoster: hook(runningRoster),
    actions,
  })
  const runningButtons = walk(runningDock, n => n.type === 'button')
  assert.deepEqual(runningButtons.map(textContent), ['Pause', 'Back to Ops'])
  runningButtons[0].props.onClick()
  assert.deepEqual(calls, [['pause', 'r1', 'b']])

  // 4. ReadOnlyDock shows Paused · N waiting + Resume + Stop when held (and omits Back when embedded in BotPanel).
  const pausedDock = ReadOnlyDock({
    sessionId: 'gb',
    useUi: hook({ readOnlyPart: null }),
    useRoster: hook(roster),
    actions,
  })
  assert.ok(textContent(pausedDock).includes('Paused · 2 waiting'))
  const dockButtons = walk(pausedDock, n => n.type === 'button')
  assert.deepEqual(dockButtons.map(textContent), ['Resume', 'Stop', 'Back to Ops'])
  dockButtons[0].props.onClick()
  dockButtons[1].props.onClick()
  assert.deepEqual(calls, [['pause', 'r1', 'b'], ['resume', 'r1', 'b'], ['stop', 'r1', 'b']])

  const embeddedPausedDock = ReadOnlyDock({
    sessionId: 'gb',
    useSessions: hook({ byId: { gb: { retainedBy: { botPanel: 1 } } } }),
    useUi: hook({ readOnlyPart: null }),
    useRoster: hook(roster),
    actions,
  })
  assert.deepEqual(walk(embeddedPausedDock, n => n.type === 'button').map(textContent), ['Resume', 'Stop'])

  // 5. TriggerCell suppresses raw memberPaused / memberResumed post triggers, and ChatRows renders RelayEvent lines.
  for (const flag of ['memberPaused', 'memberResumed']) {
    const hidden = TriggerCell({
      node: {
        key: flag,
        data: {
          turn: 1,
          seq: 1,
          content: [{ type: 'text', text: '[Group post from Writer]\n' }],
          source: { kind: SOURCE_KIND, role: 'post', senderSessionId: 'b', senderName: 'Writer', [flag]: true },
        },
      },
      sessionId: 'r1',
      useRoster: hook(roster),
      useSessions: hook({ byId: {} }),
      useTurnClock: hook({}),
      useUi: hook({}),
      actions: { ...actions, noteTurnPeer() {} },
    })
    assert.equal(textContent(hidden), '')
  }

  const relayRows = ChatRows({
    items: [
      { kind: 'relay', reply: { kind: 'member-paused', botId: 'b', name: 'Writer' }, time: 10 },
      { kind: 'relay', reply: { kind: 'member-resumed', botId: 'b', name: 'Writer' }, time: 20 },
    ],
    sessionId: 'r1',
    roster,
    actions,
  })
  assert.ok(textContent(relayRows).includes("You paused Writer's work"))
  assert.ok(textContent(relayRows).includes("You resumed Writer's work"))
})
