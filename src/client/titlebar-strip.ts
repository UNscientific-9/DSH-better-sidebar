/**
 * The title-bar strip resolution chain — the ONE place that decides how
 * many pixels the sidebar yields at the top. Standard signals first, then
 * the user's chosen scheme; never a per-shell branch:
 *
 *   0. `web` scheme — EXPLICIT "DSH official web": never adapt, not even
 *      standard WCO geometry (the user declares the plain web UI).
 *   1. The desktop shell's own window contract (`ctx.desktopWindow`, see
 *      desktop-env.ts) — authoritative when present: `safeAreaInsets.top` is
 *      where the SHELL starts placing the content, so it already accounts for
 *      everything the shell reserved. This is what keeps a shell that moved
 *      the page below its own title bar (compatibility / extended, inset 0)
 *      from being compensated a second time by the URL stamp below.
 *   2. Window Controls Overlay real geometry (standard API, authoritative
 *      when present — even 0, e.g. the overlay is hidden while maximized).
 *   3. The `dsh-desktop-titlebar-inset` URL contract parameter (a shell
 *      declares the exact pixels it reserves) — only for shells old enough
 *      not to publish the service above.
 *   4. The active shell preset's strip (scheme `preset` — opt-in data).
 *   5. The legacy manual `titleBarStripPx` (scheme `custom`).
 *   6. 0 — plain-browser semantics, nothing modified.
 *
 * The result drives `--dsh-title-bar-strip` + `body[data-dsh-title-bar-compat]`
 * exactly like the legacy boolean did; only the VALUE source changed.
 */
import type { DesktopEnv } from './desktop-env.ts'
import type { TitleBarScheme } from '../prefs-shared.ts'
import type { WcoSnapshot } from './wco.ts'
import type { SidebarDesktopWindowService } from '../context-types.ts'
import { presetStripFor, type ShellPreset } from './shell-presets.ts'

export function computeTitleBarStrip(
  env: DesktopEnv,
  wco: WcoSnapshot,
  scheme: TitleBarScheme,
  preset: ShellPreset | undefined,
  customStripPx: number,
  desktopWindow?: SidebarDesktopWindowService | undefined,
): number {
  if (scheme === 'web') return 0
  // The shell's own contract outranks every signal below, including a URL
  // stamp the shell itself published: the stamp is the shell's OWN reserve,
  // and the shell's `safeAreaInsets.top` is that reserve already applied.
  // A service without a usable `top` (an older/incompatible host) falls
  // through to the standard chain instead of throwing mid-render.
  const shellTop = desktopWindow?.safeAreaInsets?.top
  if (typeof shellTop === 'number' && Number.isFinite(shellTop)) return shellTop
  if (wco.present) return wco.height
  if (env.titlebarInset > 0) return env.titlebarInset
  if (scheme === 'preset') return presetStripFor(preset, env) ?? 0
  if (scheme === 'custom') return customStripPx
  return 0
}
