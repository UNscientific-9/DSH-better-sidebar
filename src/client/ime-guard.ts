/**
 * IME-composition key guard.
 *
 * While a Chinese/Japanese/Korean input method is composing (the user is
 * picking a candidate from the IME window), every pressed key BELONGS to the
 * input method: arrows move the candidate highlight, Enter/Space confirm the
 * composition, Escape cancels it. Page code must not process those keys —
 * a component that does (a number stepper calling preventDefault() on
 * ArrowUp/ArrowDown, a submit handler reacting to Enter, ...) silently
 * breaks the IME: candidates stop responding, the composition gets torn
 * apart, and only bare letters come out.
 *
 * This guard enforces that rule at the document boundary: a capture-phase
 * keydown/keyup listener that stops the event from propagating further
 * whenever a composition is in progress. Because it runs in the capture
 * phase on `document` — the outermost node — it fires BEFORE React's
 * delegated handlers (attached at the root container) and before any native
 * target/bubble listener, so an inlined third-party component (e.g. the
 * Univer office UI bundled into this plugin) can never intercept
 * composition keys. The browser's native IME processing is untouched:
 * stopPropagation only silences page JS, not the default action.
 *
 * The composition signal follows the DSH core convention (InputBar's IME
 * guard, issue #535): `isComposing` for modern engines, keyCode 229 as the
 * legacy signal engines emit without isComposing.
 *
 * The legacy 229 signal is only trusted while (or right after) a real
 * composition is running. Legacy engines (Safari) emit 229 keydowns with
 * `isComposing === false` *during* a composition, and that context is what
 * distinguishes them from synthetic 229 keydowns emitted outside any IME —
 * layout-switcher utilities (e.g. KeyRay's layout swap) send a keydown
 * carrying the whole converted word as a multi-character unicode string,
 * Chromium reports it as keyCode 229 / isComposing=false, and swallowing it
 * made the backspaces land while the replacement text never did: the word
 * silently disappeared instead of being rewritten.
 */

/** Live composition context, tracked by the guard's composition listeners. */
let guardComposing = false
/** Grace window (ms) after compositionend that still counts as composition,
 *  covering legacy engines' closing 229 keydown with isComposing === false. */
const GUARD_COMPOSITION_END_GRACE_MS = 50
let guardComposingUntil = 0

function imeCompositionLive(): boolean {
  return guardComposing || Date.now() < guardComposingUntil
}

/** The pure decision: is this keyboard event part of an IME composition?
 *  `isComposing` is optional on the input: React's synthetic KeyboardEvent
 *  type does not declare it (the DOM event always carries it), and the
 *  keyCode 229 fallback covers exactly those callers — but only inside a
 *  live composition context (see the module doc above). */
export function isImeComposition(event: { isComposing?: boolean; keyCode: number }): boolean {
  if (event.isComposing === true) return true
  if (event.keyCode !== 229) return false
  return imeCompositionLive()
}

/**
 * Register the document-level capture guard. Returns the disposer
 * (HMR-safe; call through `ctx.effect`).
 */
export function registerImeGuard(): () => void {
  const onKey = (event: KeyboardEvent): void => {
    if (isImeComposition(event)) event.stopPropagation()
  }
  const onCompositionStart = (): void => {
    guardComposing = true
  }
  const onCompositionEnd = (): void => {
    guardComposing = false
    guardComposingUntil = Date.now() + GUARD_COMPOSITION_END_GRACE_MS
  }
  document.addEventListener('keydown', onKey, true)
  document.addEventListener('keyup', onKey, true)
  document.addEventListener('compositionstart', onCompositionStart, true)
  document.addEventListener('compositionend', onCompositionEnd, true)
  return () => {
    document.removeEventListener('keydown', onKey, true)
    document.removeEventListener('keyup', onKey, true)
    document.removeEventListener('compositionstart', onCompositionStart, true)
    document.removeEventListener('compositionend', onCompositionEnd, true)
    guardComposing = false
    guardComposingUntil = 0
  }
}
