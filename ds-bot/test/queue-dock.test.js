import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

// jsdom comes from the harness that test/harness-resolve.mjs found, like the dsh packages.
const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { JSDOM } = createRequire(join(process.env.DSH_HARNESS ?? join(PLUGIN, '..', 'deepseek-harness'), 'package.json'))('jsdom')

const { outputFiles } = await build({
  stdin: {
    contents: "export { QueueDock } from './src/client/queue-dock.js'",
    resolveDir: PLUGIN,
  },
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})
const react = {
  createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: Symbol('Fragment'),
  useEffect() {}, useLayoutEffect() {}, useState: initial => [initial, () => {}],
  useMemo: make => make(), useRef: current => ({ current }), useId: () => 'id',
}
const dom = new JSDOM('<!doctype html><body></body>')
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  document: dom.window.document,
  window: { matchMedia: () => ({ matches: false }) },
  require: name => (name === 'react' ? react : {}),
})
const { QueueDock } = module.exports

const row = (id, kind, text) => ({ id, source: { kind }, content: [{ type: 'text', text }] })

const dock = (nextTurn, { running = false, pendingSubmissions = [], nextStep = [] } = {}) => QueueDock({
  useSession: selector => selector({ running, pendingSubmissions, subagent: null }),
  useProjection: () => ({ 'next-turn': nextTurn, 'next-step': nextStep }),
  updateQueue: async () => ({ ok: true }),
  loadImage: async () => 'about:blank',
  actions: { reportError: () => {} },
})

// The stub tree holds element objects, function components unevaluated; walk it
// for one class or text leaf.
function collect(node, found = { rows: [], texts: [] }) {
  if (node === null || node === undefined || typeof node === 'boolean') return found
  if (typeof node === 'string' || typeof node === 'number') { found.texts.push(String(node)); return found }
  if (Array.isArray(node)) { for (const item of node) collect(item, found); return found }
  if (typeof node !== 'object') return found
  if (typeof node.type === 'function') { collect(node.type(node.props), found); return found }
  if (typeof node.props?.className === 'string' && node.props.className.split(' ').includes('bt-queue-row')) found.rows.push(node)
  collect(node.props?.children, found)
  return found
}

test('team deliveries in the queue never draw as the user’s own rows (#663)', () => {
  const tree = dock([
    row('u1', 'user', 'ship it when you can'),
    row('b1', 'bot', '[Reply from Writer]\ndone'),
    row('b2', 'bot', '[Group post from Tester]\nlooks fine'),
  ])
  const { rows, texts } = collect(tree)
  assert.equal(rows.length, 1)
  assert.ok(texts.includes('ship it when you can'))
  assert.ok(!texts.some(text => text.includes('[Reply from') || text.includes('[Group post from')))
})

test('a queue of only Bot mail renders nothing', () => {
  const tree = dock([row('b1', 'bot', '[Reply from Writer]\ndone')])
  assert.equal(tree, null)
})

test('the count names only the user’s queued sends', () => {
  const tree = dock([
    row('u1', 'user', 'first'),
    row('u2', 'schedule', 'second, scheduled'),
    row('b1', 'bot', '[Message from Writer]\nnew task'),
  ])
  const { texts } = collect(tree)
  assert.ok(texts.includes('2 queued messages'))
})

test('a user send still in flight shows as sending', () => {
  const tree = dock([], { pendingSubmissions: [{ requestId: 'r1', placement: 'queued', text: 'on its way', attachments: [] }] })
  const { rows, texts } = collect(tree)
  assert.equal(rows.length, 1)
  assert.ok(texts.includes('Sending…'))
})

test('a queued row labels itself while a turn is running', () => {
  const tree = dock([row('u1', 'user', 'follow up next')], { running: true })
  const { rows, texts } = collect(tree)
  assert.equal(rows.length, 1)
  assert.ok(texts.includes('follow up next'))
  assert.ok(texts.includes('Queued'))
})

test('a next-step user message without a transcript steering echo stays visible in the dock', () => {
  const stepRow = { id: 's1', source: { kind: 'user', rpcId: 'rpc-1' }, content: [{ type: 'text', text: 'steered message' }] }
  const visible = dock([], { running: true, nextStep: [stepRow] })
  const got = collect(visible)
  assert.equal(got.rows.length, 1)
  assert.ok(got.texts.includes('steered message'))
  assert.ok(got.texts.includes('Sending…'))

  // When the transcript already shows the steering echo, the dock does not duplicate it.
  const deduped = dock([], {
    running: true,
    nextStep: [stepRow],
    pendingSubmissions: [{ requestId: 'rpc-1', placement: 'steering', text: 'steered message', attachments: [] }],
  })
  assert.equal(deduped, null)
})
