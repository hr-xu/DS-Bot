import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { createRuntime } from '../index.js'
import { createSource, indexRoster } from '../src/client/sources.js'
import { panelHasStrip } from '../src/client/side-model.js'
import { teamActions } from '../src/client/team-actions.js'
import { fakeContext } from './fake-ctx.js'

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

test('earlier parts keep chains of thought, CLI activity lines, thinking duration, and group member segments', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsb-member-sessions-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1,
    mainBotIds: ['m1'],
    revision: 1,
    bots: {
      m1: { id: 'm1', sessionId: 'm1', name: 'Chief', createdAt: 1 },
      w1: { id: 'w1', sessionId: 'w-cur', name: 'Writer', createdAt: 2, segments: [{ sessionId: 'w-old', startedAt: 5, endedAt: 50 }] },
    },
    rooms: {
      g1: {
        id: 'g1',
        name: 'Launch',
        named: true,
        members: ['m1', 'w1'],
        admin: 'm1',
        mode: 'everyone',
        notice: '',
        createdAt: 3,
        sessions: { w1: 'gw-cur' },
        segments: { w1: [{ sessionId: 'gw-old', startedAt: 10, endedAt: 80 }] },
      },
    },
    exchanges: [],
    exchangeTurns: {},
    questions: {},
  }))

  const pages = {
    'w-old': [
      { seq: 1, time: 1000, type: 'turn/start', data: { turn: 1 } },
      { seq: 2, time: 1000, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Analyze this' }] } },
      { seq: 3, time: 3600, type: 'assistant/message', data: {
        turn: 1,
        stream: [{ type: 'reasoning-chunks', time0: 1100, dt: [0, 2500], texts: ['Checking ', 'edge cases'] }],
        message: { content: [
          { type: 'reasoning', text: '<signature>sig</signature>\nChecking edge cases\n▸ bash `npm test`' },
          { type: 'text', text: 'All tests pass.' },
        ] },
      } },
      { seq: 4, time: 3700, type: 'turn/end', data: { turn: 1, reason: { kind: 'stop' } } },
    ],
    'gw-old': [
      { seq: 1, time: 2000, type: 'turn/start', data: { turn: 2 } },
      { seq: 2, time: 2000, type: 'user/message', data: {
        source: { kind: 'bot', role: 'room', exchangeId: 'ex-1' },
        content: [{ type: 'text', text: '[Group chat "Launch" · Chief, Writer]\nUser: @Writer audit auth.js\nReply directly in this group — your text is posted here.' }],
      } },
      { seq: 3, time: 2200, type: 'assistant/message', data: { turn: 2, message: { content: [
        { type: 'reasoning', text: 'Inspecting auth flow first.' },
      ] } } },
      { seq: 4, time: 2400, type: 'tool/call', data: { callId: 'c1', name: 'read_file', arguments: JSON.stringify({ path: 'src/auth.js' }) } },
      { seq: 5, time: 2800, type: 'assistant/message', data: { turn: 2, message: { content: [
        { type: 'text', text: 'Found the token expiry issue.' },
      ] } } },
      { seq: 6, time: 2900, type: 'turn/end', data: { turn: 2, reason: { kind: 'stop' } } },
    ],
  }

  const ctx = fakeContext({
    services: {
      sessionProjections: {
        register() {},
        snapshot: session => ({ values: { sessionTag: session.id } }),
      },
    },
  })
  ctx.sessionController = {
    resolveAgent: async sessionId => ({ agent: { id: sessionId, session: { id: sessionId, seq: 99 } } }),
    page: async ({ address }) => ({
      records: (pages[address.sessionId] ?? []).map(event => ({ event })),
      hasMore: false,
    }),
  }
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (route) => { ctx.route = route; return register(route) }
  const rt = createRuntime(ctx, { home })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const call = async (endpoint, payload = {}) => (await ctx.route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()

  const stateRes = await call('state')
  assert.equal(stateRes.ok, true)
  const room = stateRes.value.rooms.find(r => r.id === 'g1')
  assert.deepEqual(room.memberSessions, { w1: 'gw-cur' })
  assert.deepEqual(room.memberParts, { w1: ['gw-old'] })

  // Live group member turns report in partsRunning and indexRoster maps groupSessionOf.
  rt.live.set('gw-cur', { turn: {} })
  const liveState = (await call('state')).value
  assert.equal(liveState.partsRunning['gw-cur'], true)
  const roster = indexRoster(liveState)
  assert.equal(roster.groupSessionOf['gw-cur']?.room.id, 'g1')
  assert.equal(roster.groupSessionOf['gw-cur']?.bot.id, 'w1')

  // run-stats scopes to a group session owned by the Bot, and falls back to chatOf otherwise.
  assert.deepEqual((await call('run-stats', { botId: 'w1', sessionId: 'gw-cur' })).value, { sessionTag: 'gw-cur' })
  assert.deepEqual((await call('run-stats', { botId: 'w1', sessionId: 'm1' })).value, { sessionTag: 'w-cur' })
  assert.deepEqual((await call('run-stats', { botId: 'w1' })).value, { sessionTag: 'w-cur' })

  // Earlier page of 1:1 chat keeps activity + think + duration ms.
  const ownEarlier = (await call('earlier', { sessionId: 'w-cur' })).value
  assert.deepEqual(
    ownEarlier.items.map(item => [item.kind, item.text ?? item.lines?.join('|')]),
    [
      ['user', 'Analyze this'],
      ['activity', 'bash `npm test`'],
      ['think', 'Checking edge cases'],
      ['bot', 'All tests pass.'],
    ],
  )
  const thinkItem = ownEarlier.items.find(item => item.kind === 'think')
  assert.equal(thinkItem.ms, 2500)

  // Earlier page of group member session resolves via groupOwners and renders room-prompt + tool activity + think.
  const groupEarlier = (await call('earlier', { sessionId: 'gw-cur' })).value
  assert.deepEqual(
    groupEarlier.items.map(item => [item.kind, item.text ?? item.lines?.join('|')]),
    [
      ['room-prompt', 'User: @Writer audit auth.js'],
      ['think', 'Inspecting auth flow first.'],
      ['activity', 'read_file `src/auth.js`'],
      ['bot', 'Found the token expiry issue.'],
    ],
  )
})

test('group member session views render header navigation, read-only dock, thinking, prompts, tools, and drawer entries', async () => {
  const [{ HeaderPill }, { ReadOnlyDock }, { AssistantCell, TriggerCell, ToolCell, ChatRows }, { DetailsDrawer }] = await Promise.all([
    loadClientModule('../src/client/header.js'),
    loadClientModule('../src/client/read-only-dock.js'),
    loadClientModule('../src/client/cells.js'),
    loadClientModule('../src/client/details-drawer.js'),
  ])

  const writer = { id: 'w1', sessionId: 'w1', name: 'Writer', role: 'Author', color: 'deepseek', parts: [] }
  const chief = { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Lead', color: 'blue', parts: [] }
  const room = {
    id: 'g1',
    sessionId: 'g1',
    name: 'Launch',
    named: true,
    members: ['m1', 'w1'],
    admin: 'm1',
    mode: 'admin',
    memberSessions: { w1: 'gw-1' },
    memberParts: { w1: ['gw-0'] },
    parts: ['gw-1', 'gw-0'],
    ownParts: [],
  }
  const roster = indexRoster({
    revision: 1,
    mainBotId: 'm1',
    mainBotIds: ['m1'],
    bots: [chief, writer],
    rooms: [room],
    agents: [],
    sections: [],
    exchangeTurns: {},
    questions: {},
    prefs: {}, // thinking is OFF by default
    partsRunning: { 'gw-1': true },
  })

  // 1. HeaderPill shows "Writer · Launch" and a "Back to Launch" button.
  const opened = []
  const pillTree = HeaderPill({
    sessionId: 'gw-1',
    useRoster: hook(roster),
    useSessions: hook({ byId: {} }),
    useSessionStatus: hook(new Map([['gw-1', { running: true }]])),
    useSession: hook({}),
    useActivity: hook({}),
    useMemoryNews: hook({}),
    useTurnClock: hook({}),
    useUi: hook({}),
    useLive: hook({}),
    actions: { openSession: id => opened.push(id), toggleDetails() {} },
  })
  assert.ok(textContent(pillTree).includes('Writer · Launch'))
  const backBtn = walk(pillTree, n => n.type === 'button' && n.props?.['aria-label'] === 'Back to Launch')[0]
  assert.ok(backBtn, 'expected Back to Launch button in header')
  backBtn.props.onClick()
  assert.deepEqual(opened, ['g1'])

  // 2. ReadOnlyDock turns on for groupWork and offers Back to Launch without duplicating Stop.
  const dockTree = ReadOnlyDock({
    sessionId: 'gw-1',
    useUi: hook({ readOnlyPart: null }),
    useRoster: hook(roster),
    actions: {
      openSession: id => opened.push(id),
    },
  })
  assert.equal(dockTree.props.className, 'bt-work-dock')
  assert.equal(dockTree.props.hidden, undefined)
  assert.equal(walk(dockTree, n => n.type === 'button' && textContent(n) === 'Stop').length, 0)
  const dockBackBtn = walk(dockTree, n => n.type === 'button' && textContent(n) === 'Back to Launch')[0]
  assert.ok(dockBackBtn)
  dockBackBtn.props.onClick()
  assert.deepEqual(opened, ['g1', 'g1'])

  // 3. AssistantCell shows ThinkingRow in groupWork even when prefs.thinking is false.
  const stepData = {
    turn: 1,
    step: 0,
    seq: 10,
    status: 'settled',
    blocks: [
      { kind: 'reasoning', text: 'Deep reasoning in group session' },
      { kind: 'text', text: 'Final answer' },
    ],
  }
  const assistantTree = AssistantCell({
    node: { key: 'n1', data: stepData },
    sessionId: 'gw-1',
    useTurnData: () => null,
    useRoster: hook(roster),
    useUi: hook({}),
    useTurnSteps: () => [stepData],
    useTurnContext: () => [],
    actions: { noteLive() {} },
  })
  const thinkDetails = walk(assistantTree, n => n.type === 'details' && n.props?.className === 'bt-think')
  assert.equal(thinkDetails.length, 1)
  assert.ok(textContent(thinkDetails[0]).includes('Deep reasoning in group session'))

  // 4. TriggerCell shows room prompt in groupWork, but hides it in 1:1 chat.
  const triggerNode = {
    key: 't1',
    data: {
      turn: 1,
      time: 1000,
      source: { kind: 'bot', role: 'room' },
      content: [{ type: 'text', text: '[Group chat "Launch"]\nUser: @Writer check performance\nReply directly in this group — your text is posted here.' }],
    },
  }
  const groupTrigger = TriggerCell({
    node: triggerNode,
    sessionId: 'gw-1',
    useRoster: hook(roster),
    useSessions: hook({ byId: {} }),
    useTurnClock: hook({}),
    useUi: hook({}),
    actions: { noteTurnPeer() {} },
  })
  assert.ok(textContent(groupTrigger).includes('User: @Writer check performance'))
  assert.equal(textContent(groupTrigger).includes('Reply directly in this group'), false)

  const ownTrigger = TriggerCell({
    node: triggerNode,
    sessionId: 'w1',
    useRoster: hook(roster),
    useSessions: hook({ byId: {} }),
    useTurnClock: hook({}),
    useUi: hook({}),
    actions: { noteTurnPeer() {} },
  })
  assert.equal(textContent(ownTrigger), '')

  // 5. ToolCell renders non-team tool calls in groupWork, while keeping 1:1 chat clean.
  const toolNode = {
    key: 'tc1',
    data: {
      root: {
        callId: 'c1',
        turn: 1,
        kind: 'tool-result',
        name: 'bash',
        argsRaw: JSON.stringify({ command: 'git status -sb' }),
      },
    },
  }
  const groupTool = ToolCell({
    node: toolNode,
    sessionId: 'gw-1',
    useRoster: hook(roster),
    actions: { noteLive() {}, noteCards() {} },
  })
  assert.ok(textContent(groupTool).includes('bash '))
  assert.ok(textContent(groupTool).includes('git status -sb'))

  const ownTool = ToolCell({
    node: toolNode,
    sessionId: 'w1',
    useRoster: hook(roster),
    actions: { noteLive() {}, noteCards() {} },
  })
  assert.equal(textContent(ownTool), '')

  // 6. ChatRows merges consecutive same-turn think items and honors showThink.
  const rowsItems = [
    { kind: 'think', turn: 3, seq: 1, text: 'First thought.', time: 10 },
    { kind: 'think', turn: 3, seq: 2, text: 'Second thought.', ms: 4200, time: 20 },
    { kind: 'bot', turn: 3, seq: 3, text: 'Done.', time: 30 },
  ]
  const groupRows = ChatRows({ items: rowsItems, sessionId: 'gw-1', roster, actions: {} })
  const mergedThink = walk(groupRows, n => n.type === 'details' && n.props?.className === 'bt-think')
  assert.equal(mergedThink.length, 1)
  assert.ok(textContent(mergedThink[0]).includes('First thought.\n\nSecond thought.'))
  assert.ok(textContent(mergedThink[0]).includes('4s'))

  const ownRowsDefault = ChatRows({ items: rowsItems, sessionId: 'w1', roster, actions: {} })
  assert.equal(walk(ownRowsDefault, n => n.type === 'details' && n.props?.className === 'bt-think').length, 0)

  const ownRowsWithPref = ChatRows({ items: rowsItems, sessionId: 'w1', roster: { ...roster, prefs: { thinking: true } }, actions: {} })
  assert.equal(walk(ownRowsWithPref, n => n.type === 'details' && n.props?.className === 'bt-think').length, 1)

  // 7. DetailsDrawer exposes member "Session" button on group details and "Group sessions" on Bot details.
  const workOpened = []
  const groupDrawer = DetailsDrawer({
    sessionId: 'g1',
    hasStrip: false,
    roster,
    actions: {
      closeOverlay() {},
      openSession() {},
      openGroupWork: (rId, bId) => workOpened.push([rId, bId]),
      todos: async () => [],
    },
    useSessions: hook({ byId: {} }),
    useSessionStatus: hook(new Map()),
    useActivity: hook({}),
    useWork: hook({ bots: {}, rooms: {}, approvals: [] }),
  })
  const sessionBtn = walk(groupDrawer, n => n.type === 'button' && n.props?.['aria-label'] === 'Session · Writer')[0]
  assert.ok(sessionBtn, 'expected Session button on Writer member row')
  sessionBtn.props.onClick()
  assert.deepEqual(workOpened, [['g1', 'w1']])

  const botDrawer = DetailsDrawer({
    sessionId: 'w1',
    hasStrip: false,
    roster,
    actions: {
      closeOverlay() {},
      openSession() {},
      openGroupWork: (rId, bId) => workOpened.push([rId, bId]),
      schedules: async () => [],
    },
    useSessions: hook({ byId: {} }),
    useSessionStatus: hook(new Map()),
    useActivity: hook({}),
    useWork: hook({ bots: {}, rooms: {}, approvals: [] }),
  })
  assert.ok(!textContent(botDrawer).includes('Group sessions'))
  assert.deepEqual(workOpened, [['g1', 'w1']])

  // 8. Right-hand BotPanel work tabs open beside the group chat and fold back when closed.
  assert.equal(panelHasStrip(false, 0, 0, false, 1), true)
  const uiSource = createSource({ details: 'g1', view: 'details', work: null, works: {}, renaming: false, tab: null, side: null })
  const rosterSource = createSource(roster)
  const panelActs = teamActions({
    call: async () => ({}),
    after: p => p,
    partFor: id => id,
    roster: rosterSource,
    ui: uiSource,
    live: createSource({}),
    cards: createSource({}),
    heldCards: createSource({}),
    turnClock: createSource({}),
  })
  panelActs.openPanelWork('g1', 'gw-1')
  assert.equal(uiSource.getSnapshot().view, 'work')
  assert.equal(uiSource.getSnapshot().work, 'gw-1')
  assert.deepEqual(uiSource.getSnapshot().works['room:g1'], ['gw-1'])
  panelActs.followPanel('gw-1')
  assert.equal(uiSource.getSnapshot().view, 'details')
  panelActs.openPanelWork('g1', 'gw-1')
  panelActs.closePanelWork('g1', 'gw-1')
  assert.equal(uiSource.getSnapshot().view, 'details')
  assert.equal(uiSource.getSnapshot().work, null)

  // 9. ReadOnlyDock renders rounded Back pill in main view and stays quiet when embedded in BotPanel.
  const embeddedDock = ReadOnlyDock({
    sessionId: 'gw-1',
    useSessions: hook({ byId: { 'gw-1': { retainedBy: { botPanel: 1 } } } }),
    useUi: hook({ readOnlyPart: null }),
    useRoster: hook(roster),
    actions: { openSession() {} },
  })
  assert.equal(embeddedDock.props.hidden, true)
  const mainDock = ReadOnlyDock({
    sessionId: 'gw-1',
    useSessions: hook({ byId: { 'gw-1': { retainedBy: { mainView: 1 } } } }),
    useUi: hook({ readOnlyPart: null }),
    useRoster: hook(roster),
    actions: { openSession() {} },
  })
  assert.equal(mainDock.props.hidden, undefined)
  assert.ok(walk(mainDock, n => n.type === 'button' && String(n.props?.className ?? '').includes('bt-work-pill')).length > 0)

  // 10. Interleaved local-CLI blocks render in chronological order with collapsed ActivityFold and clean lines.
  const interleavedStep = {
    turn: 2,
    step: 0,
    seq: 20,
    status: 'settled',
    blocks: [
      { kind: 'reasoning', text: '▸ userMessage\n' },
      { kind: 'text', text: 'I will inspect the files first.' },
      { kind: 'reasoning', text: '▸ /bin/zsh -lc pwd\n▸ /bin/zsh -lc "python3 -c \'print(1)\'"\n' },
      { kind: 'text', text: 'Here is the final report.' },
    ],
  }
  const reasoningSlot = AssistantCell({
    node: { key: 'i1', data: interleavedStep },
    groupPart: 'reasoning',
    sessionId: 'gw-1',
    useRoster: hook(roster),
    useUi: hook({}),
    useTurnSteps: () => [interleavedStep],
    useTurnContext: () => [],
    actions: { noteLive() {} },
  })
  assert.equal(textContent(reasoningSlot), '')
  const responseSlot = AssistantCell({
    node: { key: 'i1', data: interleavedStep },
    groupPart: 'response',
    sessionId: 'gw-1',
    useRoster: hook(roster),
    useUi: hook({}),
    useTurnSteps: () => [interleavedStep],
    useTurnContext: () => [],
    actions: { noteLive() {} },
  })
  const fullText = textContent(responseSlot)
  assert.equal(fullText.includes('userMessage'), false)
  assert.equal(fullText.includes('/bin/zsh -lc'), false)
  const idxIntro = fullText.indexOf('I will inspect the files first.')
  const idxCmd = fullText.indexOf('Ran 2 steps')
  const idxOutro = fullText.indexOf('Here is the final report.')
  assert.ok(idxIntro >= 0 && idxCmd > idxIntro && idxOutro > idxCmd, `expected chronological order, got: ${fullText}`)
  const folds = walk(responseSlot, n => n.type === 'details' && String(n.props?.className ?? '').includes('bt-act-fold'))
  assert.equal(folds.length, 1)
  assert.equal(folds[0].props.open, false)
})
