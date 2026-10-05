/**
 * Desktop-shell detection for the sidebar. Shells may stamp the render URL
 * with `dsh-desktop-mode` / `dsh-desktop-platform` (the official Electron
 * shell does) and expose `window.__DSH_DESKTOP_FILE_PATH__` through a
 * preload. Parsed once per page and memoized (the URL never changes
 * mid-session); `resetDesktopEnvForTests` clears the memo for unit tests.
 *
 * GEOMETRY POLICY: this module only REPORTS shell facts — it never decides
 * how to adapt. The strip height comes from the shell's own window contract
 * when the shell publishes one (`ctx.desktopWindow` — see
 * {@link probeDesktopWindow}), then from standard signals (the Window
 * Controls Overlay API, see wco.ts), then the documented contract parameter
 * `dsh-desktop-titlebar-inset` (a shell may stamp the real pixels it reserves
 * at the top), then the user's chosen scheme (preset / custom). The legacy
 * win32-advanced 32px constant is gone from the core: it lives in the opt-in
 * shell preset (shell-presets.ts) as a fallback for shells without the WCO
 * API.
 */
import type { Context, SidebarDesktopWindowService } from '../context-types.ts'

/** The three presentation modes the official desktop shell documents. */
export type DesktopMode = 'compatibility' | 'extended' | 'advanced'

export interface DesktopEnv {
  /** Running inside a desktop shell (any URL stamp or preload marker). */
  readonly desktop: boolean
  /**
   * `advanced` = the shell draws a compact caption row INTO the web content
   * (so the page itself has to yield those pixels);
   * `compatibility` / `extended` = the shell keeps a native/framed title bar
   * ABOVE the content (compatibility ships the complete upstream frame below
   * it, extended hosts the same surfaces itself) — both report a zero content
   * inset, i.e. the page starts below chrome the shell already owns.
   */
  readonly mode: DesktopMode | null
  /** Shell platform stamp ('darwin' | 'win32' | …), lowercased, or null. */
  readonly platform: string | null
  /**
   * Contract parameter `dsh-desktop-titlebar-inset`: pixels the shell
   * reserves at the top of the web content for its own chrome (0–120,
   * clamped; 0 when absent). Standard WCO geometry takes precedence over
   * this whenever the API is available.
   */
  readonly titlebarInset: number
}

let cached: DesktopEnv | undefined

/** Read the shell's desktop stamps (memoized per page; SSR-safe). */
export function parseDesktopEnv(): DesktopEnv {
  if (cached !== undefined) return cached
  const hasWindow = typeof window !== 'undefined'
  const hasPreloadMarker = hasWindow
    && typeof (window as { __DSH_DESKTOP_FILE_PATH__?: unknown }).__DSH_DESKTOP_FILE_PATH__ !== 'undefined'
  // location.search includes the leading '?', which URLSearchParams does NOT
  // strip (it would become part of the first key) — drop it explicitly.
  // SSR (no window) resolves the empty environment: nothing desktop.
  const params = hasWindow
    ? new URLSearchParams(window.location.search.replace(/^\?/, ''))
    : new URLSearchParams()
  const modeParam = params.get('dsh-desktop-mode')
  const mode = modeParam === 'compatibility' || modeParam === 'extended' || modeParam === 'advanced'
    ? modeParam
    : null
  const platformParam = params.get('dsh-desktop-platform')
  const platform = platformParam !== null && platformParam !== '' ? platformParam.toLowerCase() : null
  const desktop = mode !== null || hasPreloadMarker
  cached = {
    desktop,
    mode,
    platform,
    titlebarInset: parseTitlebarInset(params.get('dsh-desktop-titlebar-inset')),
  }
  return cached
}

/** Clamp the contract inset parameter into 0–120 (invalid/absent → 0). */
function parseTitlebarInset(raw: string | null): number {
  if (raw === null) return 0
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return 0
  return Math.min(120, Math.max(0, Math.round(parsed)))
}

/**
 * The desktop shell's own window contract (`ctx.desktopWindow`, a CLIENT
 * cordis service provided by the official Electron shell — see
 * docs/plugin-services of anywhere-labs/dsh-desktop), or undefined on a
 * plain browser page.
 *
 * This is the authority the whole geometry question belongs to: the shell
 * reports where IT starts placing the upstream content surface, so a shell
 * that already moved the page below its own title bar reports
 * `safeAreaInsets.top = 0` there and must NOT be compensated again by the
 * plugin's strip (which is what the `dsh-desktop-titlebar-inset` URL stamp
 * used to cause — a second 36px of blank space, issue #864).
 *
 * PROBED, never injected: `dsh.client.inject` treats a missing service as
 * "keep this plugin pending", and a plain browser never provides this one —
 * listing it would stop the whole plugin from ever mounting. Read at CALL
 * time rather than memoized like the URL stamps above: the service is
 * published by the shell's own client plugin fiber, so it can legitimately
 * be absent on the first read and present later.
 *
 * @param ctx - client context (any context without a `get` face — a minimal
 * test double — resolves to undefined).
 * @returns the shell's window service, or undefined when there is none.
 */
export function probeDesktopWindow(ctx: Context): SidebarDesktopWindowService | undefined {
  try {
    if (typeof ctx.get !== 'function') return undefined
    return ctx.get('desktopWindow') as SidebarDesktopWindowService | undefined
  } catch (error) {
    // Probing is best-effort by contract: an incompatible host leaves the
    // caller on the standard-signal chain instead of crashing the render.
    console.error('[dsh-better-sidebar] desktop-window probe failed', error)
    return undefined
  }
}

/**
 * Absolute base for the plugin's own host transports — the HTTP routes
 * (`/sidebar/api/*`, `/sidebar/file`, `/sidebar/bundle/*`, …) and the
 * WebSockets (`/sidebar/ws/*`) resolve through the same source
 * (see `host-route-url.ts`).
 *
 * A desktop shell may serve the GUI from a custom scheme: the official Electron
 * shell uses `dsh-app://app/`, whose `location.host` is the literal string
 * `app`. Resolving a route against that origin produces `ws://app/...`, which
 * can never complete a DNS lookup — every socket the sidebar opens then fails
 * with a connection error. The shell publishes the Host's real base through
 * `__DSH_TRANSPORT__.streamBaseUrl`, the same source DSH's own downlink mux
 * resolves through (`stream-client.ts` in `@deepseek-ai/dsh-api-gateway`), so
 * prefer it and fall back to `document.baseURI` for ordinary http(s) pages —
 * that base is also what carries a reverse-proxy directory prefix.
 * @returns A URL string usable as the base argument of `new URL`, or '' when
 * neither source exists (non-DOM specs); route resolution then substitutes a
 * placeholder origin it never actually requests.
 */
export function hostTransportBase(): string {
  const transport = (globalThis as { __DSH_TRANSPORT__?: { streamBaseUrl?: string } }).__DSH_TRANSPORT__
  const base = transport?.streamBaseUrl
  if (base !== undefined && base !== '') return base
  return typeof document !== 'undefined' && typeof document.baseURI === 'string' ? document.baseURI : ''
}

/** Test hook: drop the memo so the next parse re-reads the URL/globals. */
export function resetDesktopEnvForTests(): void {
  cached = undefined
}
