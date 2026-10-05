/**
 * The title-bar strip resolution chain: the desktop shell's own window
 * contract first (present → its `safeAreaInsets.top` is authoritative),
 * then standard WCO geometry (authoritative even when 0), then the
 * documented URL inset contract parameter, then the opt-in preset / custom
 * scheme — and 0 (plain web, nothing modified) otherwise. No per-shell
 * branch lives in the core.
 */
import { describe, expect, it } from 'vitest'
import { computeTitleBarStrip } from '../src/client/titlebar-strip.ts'
import type { DesktopEnv } from '../src/client/desktop-env.ts'
import type { WcoSnapshot } from '../src/client/wco.ts'
import type { ShellPreset } from '../src/client/shell-presets.ts'
import type { SidebarDesktopWindowService } from '../src/context-types.ts'

const env = (partial: Partial<DesktopEnv>): DesktopEnv => ({
  desktop: false,
  mode: null,
  platform: null,
  titlebarInset: 0,
  ...partial,
})

const wco = (present: boolean, height = 0): WcoSnapshot => ({ present, height })

const noPreset: ShellPreset | undefined = undefined

/** One desktop-shell window contract snapshot (only the read field varies). */
const shell = (
  mode: SidebarDesktopWindowService['mode'],
  top: number,
): SidebarDesktopWindowService => ({
  mode,
  platform: mode === 'advanced' ? 'win32' : 'darwin',
  material: 'off',
  safeAreaInsets: { top, right: 0, bottom: 0, left: 0 },
  dragRegion: { height: top, leftInset: 0, rightInset: 0 },
})

describe('computeTitleBarStrip', () => {
  it('keeps plain web untouched: no WCO, no inset, no scheme → 0', () => {
    expect(computeTitleBarStrip(env({}), wco(false), 'auto', noPreset, 40)).toBe(0)
    expect(computeTitleBarStrip(env({}), wco(false), 'custom', noPreset, 40)).toBe(40)
  })

  it('the explicit WEB scheme forces 0 — not even standard WCO geometry applies', () => {
    const desktop = env({ desktop: true, mode: 'advanced', platform: 'win32' })
    // The user declared "DSH official web": no adaptation at all, even when
    // a real overlay exists or a preset is active.
    expect(computeTitleBarStrip(desktop, wco(true, 36), 'web', noPreset, 40)).toBe(0)
    expect(computeTitleBarStrip(desktop, wco(false), 'web', noPreset, 40)).toBe(0)
    expect(computeTitleBarStrip(desktop, wco(false), 'web', {
      id: 't', title: 't', desc: '', stripFor: () => 20,
    }, 40)).toBe(0)
    // ... and the shell contract does not override that explicit choice.
    expect(computeTitleBarStrip(desktop, wco(false), 'web', noPreset, 40, shell('advanced', 32))).toBe(0)
  })

  it('trusts the standard WCO geometry first in every scheme (even 0 — e.g. maximized)', () => {
    const desktop = env({ desktop: true, mode: 'advanced', platform: 'win32' })
    expect(computeTitleBarStrip(desktop, wco(true, 36), 'auto', noPreset, 0)).toBe(36)
    expect(computeTitleBarStrip(desktop, wco(true, 36), 'preset', noPreset, 0)).toBe(36)
    expect(computeTitleBarStrip(desktop, wco(true, 36), 'custom', noPreset, 40)).toBe(36)
    // Authoritative zero: the overlay is hidden while maximized — no strip.
    expect(computeTitleBarStrip(desktop, wco(true, 0), 'auto', noPreset, 40)).toBe(0)
  })

  it('applies the documented URL inset contract parameter before any scheme', () => {
    const stamped = env({ desktop: true, mode: 'advanced', platform: 'darwin', titlebarInset: 20 })
    expect(computeTitleBarStrip(stamped, wco(false), 'auto', noPreset, 0)).toBe(20)
    expect(computeTitleBarStrip(stamped, wco(false), 'preset', noPreset, 0)).toBe(20)
  })

  it('uses the opt-in preset strip under the preset scheme only', () => {
    const preset: ShellPreset = {
      id: 't', title: 't', desc: '',
      stripFor: (e) => e.platform === 'darwin' ? 20 : undefined,
    }
    const darwin = env({ desktop: true, mode: 'advanced', platform: 'darwin' })
    expect(computeTitleBarStrip(darwin, wco(false), 'preset', preset, 0)).toBe(20)
    // Auto never applies the preset — only standard signals.
    expect(computeTitleBarStrip(darwin, wco(false), 'auto', preset, 0)).toBe(0)
    // Custom never applies the preset either.
    expect(computeTitleBarStrip(darwin, wco(false), 'custom', preset, 0)).toBe(0)
  })

  it('uses the manual strip px under the custom scheme only', () => {
    expect(computeTitleBarStrip(env({}), wco(false), 'custom', noPreset, 56)).toBe(56)
    expect(computeTitleBarStrip(env({}), wco(false), 'auto', noPreset, 56)).toBe(0)
    expect(computeTitleBarStrip(env({}), wco(false), 'preset', noPreset, 56)).toBe(0)
  })

  // The desktop shell's own window contract (`ctx.desktopWindow`) — issue
  // #430. The shell reserves its title bar by placing the WHOLE page below it
  // (compatibility / extended) yet still publishes the
  // `dsh-desktop-titlebar-inset=36` URL stamp describing that same reserve;
  // reading the stamp as "pixels the page must additionally yield" left a
  // second 36px blank strip at the top of every panel. `safeAreaInsets.top`
  // is that reserve ALREADY APPLIED, so it outranks the stamp.
  describe('the shell window contract (ctx.desktopWindow)', () => {
    it('(a) compatibility / extended report a zero inset → nothing is reserved', () => {
      const stamped = env({ desktop: true, mode: 'compatibility', platform: 'win32', titlebarInset: 36 })
      expect(computeTitleBarStrip(stamped, wco(false), 'auto', noPreset, 0, shell('compatibility', 0))).toBe(0)
      const extended = env({ desktop: true, mode: 'extended', platform: 'win32', titlebarInset: 36 })
      expect(computeTitleBarStrip(extended, wco(false), 'auto', noPreset, 0, shell('extended', 0))).toBe(0)
    })

    it('(b) advanced reports the caption row it draws INTO the content → that height', () => {
      const advanced = env({ desktop: true, mode: 'advanced', platform: 'win32' })
      expect(computeTitleBarStrip(advanced, wco(false), 'auto', noPreset, 0, shell('advanced', 32))).toBe(32)
      // The value is the SHELL's, not a constant: macOS advanced reports 20.
      expect(computeTitleBarStrip(advanced, wco(false), 'auto', noPreset, 0, shell('advanced', 20))).toBe(20)
    })

    it('(c) without the service the existing chain is untouched (older shells, plain pages)', () => {
      const stamped = env({ desktop: true, mode: 'compatibility', platform: 'win32', titlebarInset: 36 })
      expect(computeTitleBarStrip(stamped, wco(false), 'auto', noPreset, 0)).toBe(36)
      expect(computeTitleBarStrip(stamped, wco(false), 'preset', noPreset, 0)).toBe(36)
    })

    it('(d) with the service the URL stamp is IGNORED, whatever it says', () => {
      const stamped = env({ desktop: true, mode: 'extended', platform: 'darwin', titlebarInset: 36 })
      expect(computeTitleBarStrip(stamped, wco(false), 'auto', noPreset, 40, shell('extended', 0))).toBe(0)
      // ... including the custom scheme's manual px, which the shell's real
      // geometry outranks exactly like WCO always did.
      expect(computeTitleBarStrip(stamped, wco(false), 'custom', noPreset, 40, shell('extended', 0))).toBe(0)
      // Even a present WCO overlay does not outrank the shell's own contract.
      expect(computeTitleBarStrip(stamped, wco(true, 36), 'auto', noPreset, 0, shell('extended', 0))).toBe(0)
    })

    it('falls through to the standard chain for a service without a usable top', () => {
      const stamped = env({ desktop: true, mode: 'compatibility', platform: 'win32', titlebarInset: 36 })
      const broken = {
        ...shell('compatibility', 0),
        safeAreaInsets: undefined,
      } as unknown as SidebarDesktopWindowService
      expect(computeTitleBarStrip(stamped, wco(false), 'auto', noPreset, 0, broken)).toBe(36)
      const nan = { ...shell('compatibility', 0), safeAreaInsets: { top: Number.NaN, right: 0, bottom: 0, left: 0 } }
      expect(computeTitleBarStrip(stamped, wco(true, 24), 'auto', noPreset, 0, nan)).toBe(24)
    })
  })
})

