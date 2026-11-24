import { createElement as h, useEffect, useRef } from 'react'
import { t } from './i18n.js'

const BackMiniIcon = () => h('svg', { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
  h('path', { d: 'M9.8 3.8L5.5 8l4.3 4.2' }))
const PauseMiniIcon = () => h('svg', { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', 'aria-hidden': true },
  h('path', { d: 'M5.5 3.5v9M10.5 3.5v9' }))
const PlayMiniIcon = () => h('svg', { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': true },
  h('path', { d: 'M5.2 3.6l7.2 4.4-7.2 4.4V3.6z' }))
const StopMiniIcon = () => h('svg', { width: 13, height: 13, viewBox: '0 0 16 16', fill: 'currentColor', 'aria-hidden': true },
  h('rect', { x: 4, y: 4, width: 8, height: 8, rx: 1.8 }))

// Above the composer: the part the user opened is still running in the background, so
// this chat takes no input until that turn ends or the user stops it. Two sessions
// running at once means two model calls.
const useDefaultMain = () => true
export function ReadOnlyDock({ sessionId, useSessions = useDefaultMain, useUi, useRoster, actions }) {
  const readOnlyPart = useUi(state => state.readOnlyPart)
  const groupWork = useRoster(state => state.groupSessionOf?.[sessionId])
  const bot = useRoster(state => state.byId?.[sessionId] ?? Object.values(state.byId ?? {}).find(entry => entry?.sessionId === sessionId))
  const running = useRoster(state => state.partsRunning?.[sessionId] === true)
  const inMain = useSessions(list => (list.byId?.[sessionId]?.retainedBy?.mainView ?? 0) > 0)
  const blocksInput = readOnlyPart !== null && readOnlyPart === sessionId && running
  const active = groupWork !== undefined || blocksInput
  const root = useRef(null)
  // The part goes idle: what kept the input off is over.
  useEffect(() => {
    if (readOnlyPart !== null && readOnlyPart === sessionId && !running) actions.clearReadOnlyPart?.()
  }, [readOnlyPart, sessionId, running])
  // DSH owns the composer, so a switched-in running session blocks its two send paths
  // here: Enter and the send button. Group working sessions stay open for in-place steering.
  useEffect(() => {
    if (!blocksInput) return undefined
    const card = root.current?.closest('[data-conversation-content]')?.querySelector('[data-composer-card]')
      ?? root.current?.closest('[data-composer-card]')
      ?? document.querySelector('[data-composer-card]')
    if (card === null || card === undefined) return undefined
    const onKey = (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && !event.isComposing) {
        event.preventDefault()
        event.stopImmediatePropagation()
      }
    }
    const onClick = (event) => {
      const button = event.target?.closest?.('button')
      if (button === null || button === undefined) return
      if (/send|发送/i.test(button.getAttribute('aria-label') ?? '')) {
        event.preventDefault()
        event.stopImmediatePropagation()
      }
    }
    card.addEventListener('keydown', onKey, true)
    card.addEventListener('click', onClick, true)
    return () => {
      card.removeEventListener('keydown', onKey, true)
      card.removeEventListener('click', onClick, true)
    }
  }, [blocksInput])
  if (groupWork !== undefined) {
    const held = groupWork.room.heldMembers?.[groupWork.bot.id]
    const paused = Boolean(held)
    const parkedCount = Number(held?.parked ?? 0)
    const canPause = !paused && running && Boolean(actions.pauseMemberWork)
    const showDock = paused || canPause || inMain
    const pausedLabel = parkedCount > 0
      ? t('Paused · {count} waiting', { count: parkedCount })
      : (inMain ? t('Paused in {name}', { name: groupWork.room.name }) : t('Paused'))
    return h('div', { ref: root, className: 'bt-work-dock', hidden: !showDock ? true : undefined, role: 'status' },
      paused
        ? h('span', { className: 'bt-work-pill', 'data-tone': 'warn' },
            h('span', { className: 'bt-work-dot', 'aria-hidden': true }),
            h('span', null, pausedLabel))
        : null,
      paused && actions.resumeMemberWork
        ? h('button', { type: 'button', className: 'bt-work-pill', 'data-tone': 'accent', onClick: () => actions.resumeMemberWork(groupWork.room.id, groupWork.bot.id) },
            h(PlayMiniIcon),
            h('span', null, t('Resume')))
        : null,
      paused
        ? h('button', { type: 'button', className: 'bt-work-pill', onClick: () => actions.stopMemberWork(groupWork.room.id, groupWork.bot.id) },
            h(StopMiniIcon),
            h('span', null, t('Stop')))
        : null,
      canPause
        ? h('button', { type: 'button', className: 'bt-work-pill', onClick: () => actions.pauseMemberWork(groupWork.room.id, groupWork.bot.id) },
            h(PauseMiniIcon),
            h('span', null, t('Pause')))
        : null,
      inMain
        ? h('button', { type: 'button', className: 'bt-work-pill bt-work-back', onClick: () => actions.openSession(groupWork.room.id) },
            h(BackMiniIcon),
            h('span', null, t('Back to {name}', { name: groupWork.room.name })))
        : null)
  }
  return h('div', { ref: root, className: 'bt-readonly-dock', 'data-on': active ? '' : undefined, role: 'status', hidden: !active },
    h('span', { className: 'bt-readonly-text' }, t('This session is still running. Wait for it to finish, or stop it.')),
    h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => actions.stopChat(bot.id) }, t('Stop')))
}

export const READ_ONLY_CSS = `
.bt-readonly-dock{display:none}
.bt-readonly-dock[data-on]{display:flex;align-items:center;justify-content:space-between;gap:8px;margin:0 0 6px;padding:8px 10px;border:.5px solid var(--bt-line);border-radius:12px;background:var(--bt-card);font-size:12px;line-height:17px;color:var(--bt-ink-2)}
.bt-readonly-text{min-width:0}
.bt-work-dock{display:flex;justify-content:center;align-items:center;flex-wrap:wrap;gap:8px;margin:0 auto 8px;pointer-events:none}
.bt-work-dock[hidden]{display:none}
.bt-work-pill{pointer-events:auto;display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 13px;border:0;border-radius:999px;background:var(--bt-main);box-shadow:0 0 0 .5px var(--bt-line-2),0 2px 8px -2px rgba(0,0,0,.12);color:var(--bt-ink-2);font:inherit;font-size:13px;line-height:18px;font-weight:500;cursor:pointer;white-space:nowrap;transition:background-color .12s ease,color .12s ease,transform .14s cubic-bezier(.22,1,.36,1)}
button.bt-work-pill:hover{background:color-mix(in srgb,var(--bt-ink) 4%,var(--bt-main));color:var(--bt-ink)}
button.bt-work-pill:active{transform:scale(.97)}
span.bt-work-pill{cursor:default}
.bt-work-pill svg{width:13px;height:13px;flex:none}
.bt-work-pill[data-tone=warn]{color:var(--bt-star)}
.bt-work-pill[data-tone=accent]{background:var(--bt-accent);color:var(--bt-accent-ink);box-shadow:0 2px 8px -2px rgba(0,0,0,.18)}
button.bt-work-pill[data-tone=accent]:hover{background:color-mix(in srgb,var(--bt-ink) 10%,var(--bt-accent));color:var(--bt-accent-ink)}
.bt-work-dot{width:7px;height:7px;border-radius:50%;background:currentColor;flex:none}
`
