import { createElement as h, Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckIcon, ChevronDownIcon, ShieldIcon } from './icons.js'
import { Segmented, stepMenuFocus, useLinger, useViewport, viewBottom } from './motion.js'
import { t } from './i18n.js'

const LABELS = { 'read-only': 'Read only', 'workspace-write': 'Workspace', 'danger-full-access': 'Full access', review: 'Review for me' }
const DESCRIPTIONS = {
  'read-only': 'Can read files; edits and shell commands are blocked or ask first.',
  'workspace-write': 'Can edit files in its working folder; commands or actions outside ask first.',
  'danger-full-access': 'Runs edits and commands without asking.',
}
const DANGER = new Set(['danger-full-access'])
const PER_MEMBER = '__per_member__'

const keepComposerFocus = event => event.preventDefault()

export const presetDanger = value => DANGER.has(value)
export const presetName = (value, catalog) => (LABELS[value] ? t(LABELS[value]) : catalog?.options?.find(option => option.value === value)?.name ?? value)
export const presetDescription = (value, catalog) => (DESCRIPTIONS[value] ? t(DESCRIPTIONS[value]) : catalog?.options?.find(option => option.value === value)?.description ?? '')
export const engineNameOf = (bot, roster) => (bot?.engine ? ((roster?.models ?? []).find(model => model.provider === bot.engine)?.providerName ?? bot.engine) : undefined)

// The presets DeepSeek Harness offers, as one segmented choice. A pick shows at once
// and holds until the saved value catches up, or falls back when `onPick` resolves
// false. `repick` lets the shown preset be picked again.
export function PermissionPicker({ catalog, saved, onPick, repick = false, engineName }) {
  const [pending, setPending] = useState(null)
  // One save runs at a time. A pick made while one is in flight waits as `latest`
  // (newer ones overwrite it), so a request that settles cannot clear or reorder a
  // pick made after it; two saves never land out of order on the server.
  const flight = useRef({ value: undefined, latest: undefined })
  useEffect(() => {
    const flying = flight.current.value
    if (pending === saved && (flying === undefined || flying === pending)) setPending(null)
  }, [pending, saved])
  const send = (value) => {
    flight.current.value = value
    void Promise.resolve(onPick(value)).then(done => done !== false, () => false).then((ok) => {
      const wanted = flight.current.latest
      flight.current.latest = undefined
      if (wanted !== undefined && !(wanted === value && ok)) { send(wanted); return }
      flight.current.value = undefined
      if (!ok) setPending(null)
    })
  }
  const current = pending ?? saved
  const pick = (value) => {
    if (value === current && !repick) return
    setPending(value)
    if (flight.current.value !== undefined) { flight.current.latest = value; return }
    send(value)
  }
  const summary = presetDescription(current, catalog)
  return h('div', { className: 'bt-perm-picker' },
    h(Segmented, { label: t('Permissions'), value: current, className: 'bt-permissions' },
      catalog.options.map(option => h('button', {
        key: option.value, type: 'button', 'aria-pressed': option.value === current,
        title: option.description, onClick: () => pick(option.value),
        className: presetDanger(option.value) ? 'bt-perm-danger' : undefined,
      }, presetName(option.value, catalog)))),
    summary ? h('span', { key: current, className: 'bt-set-hint bt-perm-desc bt-veil' }, summary) : null,
    engineName ? h('span', { className: 'bt-set-hint bt-perm-cli-note' }, t('Applies to {engine}: Workspace prompts on shell commands; Full access runs without asking.', { engine: engineName })) : null)
}

// Compact in-chat permission switcher in `conversation.input.permission`.
// In a 1:1 Bot chat it switches `bot.permission`; in a group chat it switches between
// `Per member` and a group-wide override (`room.permission`); in a group member work
// session it reflects the effective preset (group override when set, else the member's).
export function BotPermissionPill({ sessionId, locked = false, useRoster, actions }) {
  const roster = useRoster(value => value)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(null)
  const [shown, leaving] = useLinger(open, 120)
  const button = useRef(null)
  const menu = useRef(null)
  const tick = useViewport()
  useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => { if (![button.current, menu.current].some(node => node?.contains(event.target))) setOpen(false) }
    const onKey = (event) => {
      if (stepMenuFocus(menu.current, event, button.current)) return
      if (event.key === 'Escape') { event.stopPropagation(); setOpen(false) }
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => { window.removeEventListener('mousedown', onDown, true); window.removeEventListener('keydown', onKey, true) }
  }, [open])
  useEffect(() => {
    if (locked && open) setOpen(false)
  }, [locked, open])
  const place = useMemo(() => {
    if (!shown || !button.current) return null
    const rect = button.current.getBoundingClientRect()
    const maxLeft = typeof window !== 'undefined' ? Math.max(8, window.innerWidth - 288) : rect.left
    return { left: Math.min(rect.left, maxLeft), bottom: viewBottom() - rect.top + 8 }
  }, [shown, open, tick])

  const catalog = roster.permissions
  const groupSession = sessionId !== undefined ? roster.groupSessionOf?.[sessionId] : undefined
  const room = groupSession ? (groupSession.room ?? roster.roomsById?.[groupSession.roomId]) : (sessionId !== undefined ? roster.roomsById?.[sessionId] : undefined)
  const bot = groupSession ? (groupSession.bot ?? roster.byId?.[groupSession.botId]) : (sessionId !== undefined ? roster.byId?.[sessionId] : undefined)
  const isGroupControl = Boolean(room && (!groupSession || room.permission !== undefined))
  const savedKey = isGroupControl
    ? (room.permission ?? PER_MEMBER)
    : (bot ? (bot.permission ?? catalog?.defaultPreset) : undefined)

  useEffect(() => {
    if (pending !== null && pending === savedKey) setPending(null)
  }, [pending, savedKey])

  if (sessionId === undefined || (!bot && !room) || !catalog?.options?.length) return null

  const activeKey = pending ?? savedKey
  const activePreset = activeKey === PER_MEMBER ? undefined : activeKey
  const danger = presetDanger(activePreset)
  const engineName = !isGroupControl ? engineNameOf(bot, roster) : undefined
  const pillLabel = isGroupControl
    ? (activePreset ? t('Group · {preset}', { preset: presetName(activePreset, catalog) }) : t('Per member'))
    : presetName(activePreset, catalog)
  const pillTitle = activePreset ? presetDescription(activePreset, catalog) : t('Each member uses its own permission preset.')

  const commit = (key, task) => {
    setOpen(false)
    setPending(key)
    void Promise.resolve(task()).then(
      () => { setPending(current => (current === key ? null : current)) },
      (error) => {
        setPending(current => (current === key ? null : current))
        actions?.reportError?.(error, 'permission')
      },
    )
  }

  const pickBot = (value) => {
    if (value === savedKey && bot.permission !== undefined) { setOpen(false); return }
    commit(value, () => actions.updateBot(bot.id, { permission: value }))
  }

  const pickRoom = (value) => {
    const key = value ?? PER_MEMBER
    if (key === savedKey) { setOpen(false); return }
    commit(key, () => actions.updateRoom(room.id, { permission: value }))
  }

  const menuEl = shown
    ? h('div', {
        ref: menu, className: 'bt-menu bt-menu-up bt-perm-menu', role: 'menu', 'aria-label': t('Permissions'),
        style: place ?? {}, 'data-leaving': leaving || undefined,
      },
      groupSession && isGroupControl
        ? h('div', { className: 'bt-perm-menu-head' }, t('Inherited from {name}', { name: room.name }))
        : isGroupControl
          ? h('div', { className: 'bt-perm-menu-head' }, t('Group permissions'))
          : null,
      isGroupControl
        ? h(Fragment, null,
            h('button', {
              type: 'button', role: 'menuitemradio', 'aria-checked': activeKey === PER_MEMBER,
              className: 'bt-perm-option', onClick: () => pickRoom(null),
            },
            h('span', { className: 'bt-perm-option-copy' },
              h('span', { className: 'bt-perm-option-name' }, t('Per member')),
              h('span', { className: 'bt-perm-option-desc' }, t('Each member uses its own permission preset.'))),
            activeKey === PER_MEMBER ? h('span', { className: 'bt-perm-option-check', 'aria-hidden': true }, h(CheckIcon)) : null),
            h('div', { className: 'bt-menu-sep', role: 'separator' }))
        : null,
      catalog.options.map((option) => {
        const selected = activeKey === option.value
        const isDanger = presetDanger(option.value)
        return h('button', {
          key: option.value, type: 'button', role: 'menuitemradio', 'aria-checked': selected,
          className: `bt-perm-option${isDanger ? ' bt-danger' : ''}`,
          onClick: () => (isGroupControl ? pickRoom(option.value) : pickBot(option.value)),
        },
        h('span', { className: 'bt-perm-option-copy' },
          h('span', { className: 'bt-perm-option-name' }, presetName(option.value, catalog)),
          h('span', { className: 'bt-perm-option-desc' }, presetDescription(option.value, catalog))),
        selected ? h('span', { className: 'bt-perm-option-check', 'aria-hidden': true }, h(CheckIcon)) : null)
      }),
      engineName
        ? h(Fragment, null,
            h('div', { className: 'bt-menu-sep', role: 'separator' }),
            h('div', { className: 'bt-perm-menu-note' }, t('Applies to {engine}: Workspace prompts on shell commands; Full access runs without asking.', { engine: engineName })))
        : null)
    : null

  return h(Fragment, null,
    h('button', {
      ref: button, type: 'button', className: 'bt-perm-pill',
      'data-danger': danger || undefined,
      'aria-label': t('Permission: {preset}', { preset: pillLabel }),
      'aria-haspopup': 'menu', 'aria-expanded': open,
      title: pillTitle, disabled: locked,
      onMouseDown: keepComposerFocus,
      onClick: () => setOpen(value => !value),
    },
    h('span', { className: 'bt-perm-pill-icon', 'aria-hidden': true }, h(ShieldIcon)),
    h('span', { className: 'bt-perm-pill-label' }, pillLabel),
    h('span', { className: 'bt-perm-pill-caret', 'aria-hidden': true }, h(ChevronDownIcon))),
    menuEl ? (typeof document !== 'undefined' && document.body ? createPortal(menuEl, document.body) : menuEl) : null)
}
