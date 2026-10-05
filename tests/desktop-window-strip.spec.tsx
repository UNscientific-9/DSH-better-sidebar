/**
 * The desktop shell's window contract must reach the DOM, not just the pure
 * chain (issue #430).
 *
 * `computeTitleBarStrip` is covered field by field in titlebar-strip.spec.ts;
 * what this file adds is the WIRING, which is where the regression actually
 * lived: the shell places the whole page below its own 36px frame and
 * publishes `safeAreaInsets.top = 0` through `ctx.desktopWindow`, yet still
 * stamps the render URL with `dsh-desktop-titlebar-inset=36`. If the Sidebar
 * never hands the service to the chain, that stamp wins and every panel gets
 * a second 36px blank strip at the top (`body[data-dsh-title-bar-compat]` +
 * `--dsh-title-bar-strip: 36px`).
 *
 * Rendered with the REAL Sidebar + real store/service against a minimal fake
 * context (the repo's jsdom mount pattern), so the assertion is on the
 * document state the CSS actually consumes.
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { setupReactAct } from './test-utils.ts'
setupReactAct()

import { Sidebar } from '../src/client/Sidebar.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import { createBetterSidebarService } from '../src/client/service.ts'
import { resetDesktopEnvForTests } from '../src/client/desktop-env.ts'
import type { Context, SidebarDesktopWindowService } from '../src/context-types.ts'

const shell = (mode: SidebarDesktopWindowService['mode'], top: number): SidebarDesktopWindowService => ({
  mode,
  platform: 'win32',
  material: 'off',
  safeAreaInsets: { top, right: 0, bottom: 0, left: 0 },
  dragRegion: { height: top, leftInset: 0, rightInset: 0 },
})

/**
 * Mount the real sidebar on a desktop-shell URL.
 * @param search - the render URL's query (the shell's own stamps).
 * @param desktopWindow - the service `ctx.get('desktopWindow')` answers, or
 * undefined for a shell that does not publish one.
 */
function mount(search: string, desktopWindow: SidebarDesktopWindowService | undefined): { unmount: () => void } {
  window.history.replaceState({}, '', `/${search}`)
  resetDesktopEnvForTests()
  // jsdom has no WebSocket; the panel's host feeds construct one on mount.
  vi.stubGlobal('WebSocket', class { close(): void {} })
  const store = createSidebarStore()
  store.setSession('s1')
  const service = createBetterSidebarService(store)
  // useSyncExternalStore requires STABLE snapshots across calls (the real DSH
  // services return stable objects) — a fresh object per call loops forever.
  const locale = { active: 'en' }
  const sessions = { byId: { s1: { id: 's1', cwd: '/ws' } } }
  const ctx = {
    locale: { subscribe: () => () => {}, getSnapshot: () => locale },
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => sessions } },
    get: (name: string) => name === 'betterSidebar' ? service : name === 'desktopWindow' ? desktopWindow : undefined,
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root: Root = createRoot(container)
  act(() => { root.render(createElement(Sidebar, { ctx: ctx as unknown as Context, store })) })
  return {
    unmount: () => {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}

/** The strip the plugin applied to the page, as the CSS reads it. */
function appliedStrip(): { compat: boolean; px: string } {
  return {
    compat: document.body.hasAttribute('data-dsh-title-bar-compat'),
    px: document.documentElement.style.getPropertyValue('--dsh-title-bar-strip'),
  }
}

afterEach(() => {
  document.body.innerHTML = ''
  document.body.removeAttribute('data-dsh-title-bar-compat')
  document.documentElement.style.removeProperty('--dsh-title-bar-strip')
  vi.unstubAllGlobals()
  resetDesktopEnvForTests()
})

describe('the shell window contract drives the applied strip', () => {
  it('compatibility + URL inset 36 + contract top 0 → no strip at all', () => {
    const view = mount(
      '?dsh-desktop-mode=compatibility&dsh-desktop-platform=win32&dsh-desktop-titlebar-inset=36',
      shell('compatibility', 0),
    )
    try {
      expect(appliedStrip()).toEqual({ compat: false, px: '' })
    } finally {
      view.unmount()
    }
  })

  it('extended + URL inset 36 + contract top 0 → no strip at all', () => {
    const view = mount(
      '?dsh-desktop-mode=extended&dsh-desktop-platform=darwin&dsh-desktop-titlebar-inset=36',
      shell('extended', 0),
    )
    try {
      expect(appliedStrip()).toEqual({ compat: false, px: '' })
    } finally {
      view.unmount()
    }
  })

  it('advanced + contract top 32 → the caption row is yielded', () => {
    const view = mount(
      '?dsh-desktop-mode=advanced&dsh-desktop-platform=win32',
      shell('advanced', 32),
    )
    try {
      expect(appliedStrip()).toEqual({ compat: true, px: '32px' })
    } finally {
      view.unmount()
    }
  })

  it('no service (plain browser / older shell) → the URL stamp chain is unchanged', () => {
    const view = mount(
      '?dsh-desktop-mode=compatibility&dsh-desktop-platform=win32&dsh-desktop-titlebar-inset=36',
      undefined,
    )
    try {
      expect(appliedStrip()).toEqual({ compat: true, px: '36px' })
    } finally {
      view.unmount()
    }
  })
})
