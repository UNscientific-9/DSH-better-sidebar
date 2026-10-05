/**
 * Desktop-shell detection tests: URL stamps (dsh-desktop-mode/platform)
 * from the official Electron shell, the preload marker
 * (__DSH_DESKTOP_FILE_PATH__), the `dsh-desktop-titlebar-inset` contract
 * parameter, and the shell's own window service probe
 * (`ctx.desktopWindow` — see titlebar-strip.spec.ts for how the chain
 * consumes it). Geometry ADAPTATION is deliberately NOT here — the strip
 * resolution chain lives in titlebar-strip.ts (standard WCO first, see
 * wco.spec.ts), keeping this module a pure environment reporter.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import './browser-globals.ts'
import { parseDesktopEnv, probeDesktopWindow, resetDesktopEnvForTests } from '../src/client/desktop-env.ts'
import type { Context, SidebarDesktopWindowService } from '../src/context-types.ts'

function setSearch(search: string): void {
  ;(window.location as { search: string }).search = search
}

beforeEach(() => {
  resetDesktopEnvForTests()
  delete (window as unknown as Record<string, unknown>).__DSH_DESKTOP_FILE_PATH__
  setSearch('/')
})

describe('parseDesktopEnv', () => {
  it('reports a plain browser page as non-desktop with no inset', () => {
    expect(parseDesktopEnv()).toEqual({ desktop: false, mode: null, platform: null, titlebarInset: 0 })
  })

  it('parses win32 advanced stamps (no overlay guess — geometry comes from WCO/preset)', () => {
    setSearch('?dsh-desktop-mode=advanced&dsh-desktop-platform=win32')
    const env = parseDesktopEnv()
    expect(env.desktop).toBe(true)
    expect(env.mode).toBe('advanced')
    expect(env.platform).toBe('win32')
    expect(env.titlebarInset).toBe(0)
  })

  it('parses darwin advanced stamps', () => {
    setSearch('?dsh-desktop-mode=advanced&dsh-desktop-platform=darwin')
    const env = parseDesktopEnv()
    expect(env.desktop).toBe(true)
    expect(env.platform).toBe('darwin')
    expect(env.titlebarInset).toBe(0)
  })

  it('parses compatibility mode as desktop with the native frame (no adaptation)', () => {
    setSearch('?dsh-desktop-mode=compatibility&dsh-desktop-platform=win32')
    const env = parseDesktopEnv()
    expect(env.desktop).toBe(true)
    expect(env.mode).toBe('compatibility')
    expect(env.titlebarInset).toBe(0)
  })

  it('parses extended mode — the shell-owned 36px frame with compatibility geometry', () => {
    // Extended window (DSH Desktop 2.x): the shell hosts the upstream
    // surfaces below its OWN frame, exactly like compatibility — the mode is
    // not an unknown value, and must not be read as `advanced` (whose preset
    // strip would reserve the caption row a second time).
    setSearch('?dsh-desktop-mode=extended&dsh-desktop-platform=darwin&dsh-desktop-titlebar-inset=36')
    const env = parseDesktopEnv()
    expect(env.desktop).toBe(true)
    expect(env.mode).toBe('extended')
    expect(env.platform).toBe('darwin')
    // The stamp is still REPORTED verbatim: it is the shell's own reserve
    // (the strip chain ignores it only because the window service exists).
    expect(env.titlebarInset).toBe(36)
  })

  it('detects the desktop preload marker even without URL stamps', () => {
    ;(window as unknown as Record<string, unknown>).__DSH_DESKTOP_FILE_PATH__ = { getPathForFile: () => '' }
    const env = parseDesktopEnv()
    expect(env.desktop).toBe(true)
    expect(env.mode).toBeNull()
    expect(env.titlebarInset).toBe(0)
  })

  it('ignores unknown mode values (exotic shells keep plain-browser semantics)', () => {
    setSearch('?dsh-desktop-mode=weird&dsh-desktop-platform=win32')
    expect(parseDesktopEnv().mode).toBeNull()
    expect(parseDesktopEnv().desktop).toBe(false)
  })

  it('reads the documented titlebar-inset contract parameter (clamped 0–120)', () => {
    setSearch('?dsh-desktop-mode=advanced&dsh-desktop-platform=win32&dsh-desktop-titlebar-inset=36')
    expect(parseDesktopEnv().titlebarInset).toBe(36)
    setSearch('?dsh-desktop-mode=advanced&dsh-desktop-titlebar-inset=200')
    resetDesktopEnvForTests()
    expect(parseDesktopEnv().titlebarInset).toBe(120)
    setSearch('?dsh-desktop-mode=advanced&dsh-desktop-titlebar-inset=-5')
    resetDesktopEnvForTests()
    expect(parseDesktopEnv().titlebarInset).toBe(0)
    setSearch('?dsh-desktop-mode=advanced&dsh-desktop-titlebar-inset=abc')
    resetDesktopEnvForTests()
    expect(parseDesktopEnv().titlebarInset).toBe(0)
  })

  it('memoizes across calls until the test hook resets', () => {
    setSearch('?dsh-desktop-mode=advanced&dsh-desktop-platform=win32')
    const first = parseDesktopEnv()
    setSearch('/')
    expect(parseDesktopEnv()).toBe(first)
    resetDesktopEnvForTests()
    expect(parseDesktopEnv().desktop).toBe(false)
  })
})

describe('probeDesktopWindow', () => {
  const service: SidebarDesktopWindowService = {
    mode: 'extended',
    platform: 'win32',
    material: 'off',
    safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    dragRegion: { height: 0, leftInset: 0, rightInset: 0 },
  }

  /** A client context whose `get` answers one service name. */
  const ctxWith = (name: string, value: unknown): Context => ({
    get: (asked: string): unknown => asked === name ? value : undefined,
  }) as unknown as Context

  it('returns the shell service the client context publishes', () => {
    expect(probeDesktopWindow(ctxWith('desktopWindow', service))).toBe(service)
  })

  it('returns undefined on a plain browser page (the service is never injected)', () => {
    expect(probeDesktopWindow(ctxWith('desktopWindow', undefined))).toBeUndefined()
    expect(probeDesktopWindow({} as Context)).toBeUndefined()
  })

  it('stays best-effort when the context getter throws', () => {
    const ctx: Context = {
      get: (): never => { throw new Error('cannot get property without inject') },
    } as unknown as Context
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(probeDesktopWindow(ctx)).toBeUndefined()
      // Assert inside the spy's lifetime: mockRestore also clears the calls.
      expect(logged).toHaveBeenCalledTimes(1)
    } finally {
      logged.mockRestore()
    }
  })
})
