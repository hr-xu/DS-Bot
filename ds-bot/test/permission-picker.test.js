import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/permission-picker.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'browser', write: false, logLevel: 'silent',
  external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
})

// A minimal stateful React: hook cells live across renders and a setState re-renders,
// so the picker's async pick flow runs as on the page. Effects run when their deps
// change, as React runs them after paint.
const cells = []
const prevDeps = []
let hook = 0
let dirty = false
let pendingEffects = []
const changed = (deps, prev) => deps === undefined || prev === undefined || deps.length !== prev.length || deps.some((dep, i) => !Object.is(dep, prev[i]))
const react = {
  createContext: (initial) => { const ctx = { value: initial }; ctx.Provider = ({ value, children }) => { ctx.value = value; return children }; return ctx },
  useContext: ctx => ctx.value,
  useCallback: fn => fn,
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  createElement: (type, props, ...children) => ({ type, props: { ...props, children: children.flat(Infinity) } }),
  useState(initial) {
    const i = hook++
    if (!(i in cells)) cells[i] = typeof initial === 'function' ? initial() : initial
    return [cells[i], (next) => { cells[i] = typeof next === 'function' ? next(cells[i]) : next; dirty = true }]
  },
  useRef(initial) { const i = hook++; if (!(i in cells)) cells[i] = { current: initial }; return cells[i] },
  useEffect(fn, deps) { pendingEffects.push({ i: hook++, fn, deps }) },
  useLayoutEffect(fn, deps) { pendingEffects.push({ i: hook++, fn, deps }) },
  useMemo: make => make(),
  useId: () => 'id',
  Fragment: Symbol('Fragment'),
}
const resetHooks = () => { cells.length = 0; prevDeps.length = 0 }
const render = (component, props) => {
  let tree
  do {
    dirty = false
    hook = 0
    pendingEffects = []
    tree = component(props)
    for (const { i, fn, deps } of pendingEffects) {
      if (changed(deps, prevDeps[i])) { prevDeps[i] = deps; fn() }
    }
  } while (dirty)
  return tree
}
const module = { exports: {} }
runInNewContext(outputFiles[0].text, {
  module, exports: module.exports,
  setTimeout, clearTimeout,
  window: { innerWidth: 1200, innerHeight: 800, addEventListener() {}, removeEventListener() {} },
  require: name => (name === 'react' ? react : name === 'react-dom' ? { createPortal: node => node } : {}),
})
const { PermissionPicker, BotPermissionPill } = module.exports

function walk(node, found = []) {
  if (Array.isArray(node)) { for (const child of node) walk(child, found); return found }
  if (node === null || node === undefined || typeof node !== 'object') return found
  found.push(node)
  walk(node.props?.children, found)
  return found
}

function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object') return textOf(node.props?.children)
  return ''
}

const OPTIONS = [
  { value: 'read-only', description: 'read-only' },
  { value: 'workspace-write', description: 'workspace-write' },
  { value: 'danger-full-access', description: 'danger-full-access' },
  { value: 'review', description: 'review' },
]
const settle = () => new Promise(resolve => setImmediate(resolve))

// Mounts the picker on `props`; `requests` gets a deferred per `onPick` call, and
// `maxFlying` records the most requests open at once.
const mountPicker = (initial, repick = false) => {
  resetHooks()
  const requests = []
  let flying = 0
  const seen = { maxFlying: 0 }
  let props = { ...initial, repick }
  props.onPick = value => {
    flying += 1
    seen.maxFlying = Math.max(seen.maxFlying, flying)
    return new Promise((resolve, reject) => requests.push({
      value,
      resolve: (done) => { flying -= 1; resolve(done) },
      reject: (error) => { flying -= 1; reject(error) },
    }))
  }
  let tree
  const rerender = (patch) => { props = { ...props, ...patch }; tree = render(PermissionPicker, props); return tree }
  const buttons = () => walk(tree).filter(node => node.type === 'button')
  const picker = {
    requests, seen, rerender,
    tree: () => tree,
    press(value) { buttons().find(button => button.props.title === value).props.onClick(); rerender() },
    pressed() { return buttons().find(button => button.props['aria-pressed'])?.props.title },
    // Lets settled request continuations and their state updates land.
    async flush() { await settle(); rerender() },
  }
  rerender()
  return picker
}

// #266: one save in flight; the latest pick wins, a failed request cannot clear it.
test('a newer pick survives an older request failing', async () => {
  const picker = mountPicker({ catalog: { options: OPTIONS }, saved: 'read-only' })
  picker.press('workspace-write')
  picker.press('danger-full-access')
  assert.equal(picker.requests.length, 1)
  assert.equal(picker.pressed(), 'danger-full-access')
  picker.requests[0].resolve(false)
  await picker.flush()
  assert.equal(picker.requests.length, 2)
  assert.equal(picker.requests[1].value, 'danger-full-access')
  assert.equal(picker.pressed(), 'danger-full-access')
  picker.requests[1].resolve(true)
  picker.rerender({ saved: 'danger-full-access' })
  await picker.flush()
  assert.equal(picker.requests.length, 2)
  assert.equal(picker.pressed(), 'danger-full-access')
  assert.equal(picker.seen.maxFlying, 1)
})

test('a newer pick that fails falls back to what the server saved', async () => {
  const picker = mountPicker({ catalog: { options: OPTIONS }, saved: 'read-only' })
  picker.press('workspace-write')
  picker.press('danger-full-access')
  picker.requests[0].resolve(true)
  picker.rerender({ saved: 'workspace-write' })
  await picker.flush()
  assert.equal(picker.requests.length, 2)
  picker.requests[1].resolve(false)
  await picker.flush()
  assert.equal(picker.pressed(), 'workspace-write')
  assert.equal(picker.seen.maxFlying, 1)
})

test('a single failed pick falls back to the saved value', async () => {
  const picker = mountPicker({ catalog: { options: OPTIONS }, saved: 'read-only' })
  picker.press('workspace-write')
  assert.equal(picker.pressed(), 'workspace-write')
  picker.requests[0].resolve(false)
  await picker.flush()
  assert.equal(picker.pressed(), 'read-only')
  // A rejected request fails the same way.
  picker.press('workspace-write')
  assert.equal(picker.requests.length, 2)
  picker.requests[1].reject(new Error('offline'))
  await picker.flush()
  assert.equal(picker.pressed(), 'read-only')
})

test('the last remembered pick wins; it is sent once even when it repeats the sent one', async () => {
  const picker = mountPicker({ catalog: { options: OPTIONS }, saved: 'read-only' })
  picker.press('workspace-write')
  picker.press('danger-full-access')
  picker.press('workspace-write')
  assert.equal(picker.requests.length, 1)
  picker.requests[0].resolve(true)
  picker.rerender({ saved: 'workspace-write' })
  await picker.flush()
  assert.equal(picker.requests.length, 1, 'the pick that repeats the sent one is not sent again')
  assert.equal(picker.pressed(), 'workspace-write')
})

test('review uses the same single choice and save queue as ordinary permissions', async () => {
  const picker = mountPicker({ catalog: { options: OPTIONS }, saved: 'danger-full-access' })
  picker.press('review')
  assert.equal(picker.pressed(), 'review')
  assert.equal(picker.requests[0].value, 'review')
  picker.press('read-only')
  assert.equal(picker.pressed(), 'read-only')
  picker.requests[0].resolve(true)
  await picker.flush()
  assert.equal(picker.requests[1].value, 'read-only')
  picker.requests[1].resolve(true)
  const tree = picker.rerender({ saved: 'read-only' })
  await picker.flush()
  assert.equal(tree.props.children.filter(button => button.props['aria-pressed']).length, 1)
})

test('repick still lets the shown preset be picked again', async () => {
  const picker = mountPicker({ catalog: { options: OPTIONS }, saved: 'read-only' }, true)
  picker.press('read-only')
  assert.equal(picker.requests.length, 1)
  assert.equal(picker.requests[0].value, 'read-only')
  picker.requests[0].resolve(true)
  await picker.flush()
})

test('PermissionPicker shows plain-language preset description and optional local-CLI note', () => {
  const picker = mountPicker({ catalog: { options: OPTIONS }, saved: 'workspace-write', engineName: 'Antigravity' })
  const nodes = walk(picker.tree())
  const desc = nodes.find(node => node.props?.className?.includes('bt-perm-desc'))
  const note = nodes.find(node => node.props?.className?.includes('bt-perm-cli-note'))
  assert.equal(textOf(desc), 'Can edit files in its working folder; commands or actions outside ask first.')
  assert.equal(textOf(note), 'Applies to Antigravity: Workspace prompts on shell commands; Full access runs without asking.')

  picker.rerender({ saved: 'danger-full-access', engineName: undefined })
  const updated = walk(picker.tree())
  assert.equal(textOf(updated.find(node => node.props?.className?.includes('bt-perm-desc'))), 'Runs edits and commands without asking.')
  assert.equal(updated.find(node => node.props?.className?.includes('bt-perm-cli-note')), undefined)
})

function mountPill({ sessionId, roster, locked = false }) {
  resetHooks()
  const calls = []
  const actions = {
    updateBot: (id, patch) => { calls.push(['bot', id, patch.permission]); return Promise.resolve() },
    updateRoom: (id, patch) => { calls.push(['room', id, patch.permission]); return Promise.resolve() },
  }
  let currentRoster = roster
  const useRoster = select => select(currentRoster)
  let tree
  const rerender = (nextRoster) => {
    if (nextRoster !== undefined) currentRoster = nextRoster
    tree = render(BotPermissionPill, { sessionId, locked, useRoster, actions })
    return tree
  }
  rerender()
  return {
    calls, rerender,
    tree: () => tree,
    trigger: () => walk(tree).find(node => node.props?.className === 'bt-perm-pill'),
    options: () => walk(tree).filter(node => node.props?.role === 'menuitemradio'),
    open() { this.trigger().props.onClick(); rerender() },
  }
}

test('BotPermissionPill switches a 1:1 Bot preset and shows local-CLI note when running on a CLI', async () => {
  const catalog = { options: OPTIONS, defaultPreset: 'workspace-write' }
  const bot = { id: 'b1', name: 'Agy', engine: 'agy' }
  const roster = {
    permissions: catalog,
    byId: { s1: bot, b1: bot },
    roomsById: {},
    models: [{ provider: 'agy', providerName: 'Antigravity' }],
  }
  const pill = mountPill({ sessionId: 's1', roster })
  assert.equal(textOf(pill.trigger()), 'Workspace')
  assert.equal(pill.trigger().props['data-danger'], undefined)

  pill.open()
  const items = pill.options()
  assert.equal(items.length, 3)
  const note = walk(pill.tree()).find(node => node.props?.className === 'bt-perm-menu-note')
  assert.equal(textOf(note), 'Applies to Antigravity: Workspace prompts on shell commands; Full access runs without asking.')

  items[2].props.onClick()
  pill.rerender()
  assert.deepEqual(pill.calls, [['bot', 'b1', 'danger-full-access']])
  assert.equal(pill.trigger().props['data-danger'], true)
  await settle()
})

test('BotPermissionPill toggles group chats between Per member and group-wide presets', async () => {
  const catalog = { options: OPTIONS, defaultPreset: 'workspace-write' }
  const room = { id: 'r1', name: 'Ops' }
  const roster = { permissions: catalog, byId: {}, roomsById: { r1: room } }
  const pill = mountPill({ sessionId: 'r1', roster })
  assert.equal(textOf(pill.trigger()), 'Per member')

  pill.open()
  const items = pill.options()
  assert.equal(items.length, 4)
  assert.equal(items[0].props['aria-checked'], true)

  items[3].props.onClick()
  pill.rerender({ ...roster, roomsById: { r1: { ...room, permission: 'danger-full-access' } } })
  assert.deepEqual(pill.calls, [['room', 'r1', 'danger-full-access']])
  assert.equal(textOf(pill.trigger()), 'Group · Full access')
  assert.equal(pill.trigger().props['data-danger'], true)

  pill.open()
  pill.options()[0].props.onClick()
  assert.deepEqual(pill.calls[1], ['room', 'r1', null])
  await settle()
})

test('BotPermissionPill handles group member work sessions and hides for unknown sessions or empty catalogs', () => {
  const catalog = { options: OPTIONS, defaultPreset: 'workspace-write' }
  const bot = { id: 'b1', name: 'Ada', permission: 'read-only' }
  const room = { id: 'r1', name: 'Ops', permission: 'danger-full-access' }
  const inherited = mountPill({
    sessionId: 'gs1',
    roster: { permissions: catalog, byId: { b1: bot }, roomsById: { r1: room }, groupSessionOf: { gs1: { room, bot } } },
  })
  assert.equal(textOf(inherited.trigger()), 'Group · Full access')
  inherited.open()
  const head = walk(inherited.tree()).find(node => node.props?.className === 'bt-perm-menu-head')
  assert.equal(textOf(head), 'Inherited from Ops')

  const perMemberWork = mountPill({
    sessionId: 'gs2',
    roster: { permissions: catalog, byId: { b1: bot }, roomsById: { r2: { id: 'r2', name: 'Docs' } }, groupSessionOf: { gs2: { room: { id: 'r2', name: 'Docs' }, bot } } },
  })
  assert.equal(textOf(perMemberWork.trigger()), 'Read only')

  const unknown = mountPill({ sessionId: 'other', roster: { permissions: catalog, byId: {}, roomsById: {} } })
  assert.equal(unknown.tree(), null)

  const noCatalog = mountPill({ sessionId: 'b1', roster: { permissions: { options: [] }, byId: { b1: bot }, roomsById: {} } })
  assert.equal(noCatalog.tree(), null)
})
