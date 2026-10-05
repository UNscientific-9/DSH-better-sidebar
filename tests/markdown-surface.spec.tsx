/**
 * The DOM half of markdown cross-file / anchor navigation, rendered through the
 * REAL TextEditor (and therefore the real host `MarkdownText`): heading slugs
 * on rendered headings, the host delegate that makes a claimed local link
 * clickable at all, the DECODED `%23` fragment carrier, same-page scrolling in
 * the preview's own container, and the parked cross-file fragment landing once
 * the target document renders.
 *
 * Why the delegate is the mechanism (and not a click listener on the
 * container): the host renderer gives a local destination a clickable element
 * ONLY when a surrounding `MarkdownDelegateProvider` supplies `openFile` —
 * otherwise the link is inert prose, and a heading fragment makes the whole
 * destination unparseable for the renderer. Both halves are asserted here,
 * including the boundary: the same markdown rendered OUTSIDE the plugin's
 * surface stays inert.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { renderRoot, setupReactAct } from './test-utils.ts'
import { TextEditor } from '../src/client/TextEditor.tsx'
import { attachLocale } from '../src/client/locales.ts'
import { createSidebarStore, allLeaves } from '../src/client/state.ts'
import { createBetterSidebarService, type FileViewerProps } from '../src/client/service.ts'
import { hideEmptyAnchors, jumpToFragment } from '../src/client/markdown-navigation.ts'
import { MARKDOWN_SURFACE_ATTR } from '../src/client/use-markdown-surface.ts'
import type { Context } from '../src/context-types.ts'

setupReactAct()

/** Minimal structural fake of the DSH LocaleService face the sidebar uses. */
class FakeLocale {
  active: string = 'en'
  getSnapshot(): { active: string } {
    return { active: this.active }
  }
  subscribe(_fn: () => void): () => void {
    return () => {}
  }
}

const SESSION = 's1'

interface Mounted {
  container: HTMLDivElement
  /** Every editor tab the sidebar currently holds (path-typed ones last). */
  tabs: () => { type: string; path?: string }[]
  unmount: () => void
}

/**
 * Mount the real TextEditor on one markdown file, backed by the plugin's own
 * sidebar service — so a claimed link's open is observed the way the app
 * observes it (a tab landing in the store), not through a stub.
 */
function mountEditor(content: string, path: string): Mounted {
  attachLocale(new FakeLocale())
  const store = createSidebarStore()
  const service = createBetterSidebarService(store)
  // openTab refuses a type nobody registered.
  service.registerTab({ id: 'editor', title: 'Editor', dedupeKey: (tab) => tab.path, component: () => null })
  store.setSession(SESSION)
  const ctx = {
    betterSidebar: service,
    get: (name: string) => name === 'betterSidebar' ? service : undefined,
    sessions: { list: { subscribe: () => () => {}, getSnapshot: () => ({ byId: { [SESSION]: { cwd: '/p' } } }) } },
  } as unknown as Context
  const props: FileViewerProps = {
    ctx,
    store,
    scope: { sessionId: SESSION, cwd: '/p' },
    path,
    title: path.slice(path.lastIndexOf('/') + 1),
    viewerId: 'markdown',
    content,
  }
  const mounted = renderRoot(createElement(TextEditor, props))
  return {
    container: mounted.container,
    tabs: () => allLeaves(store.getSnapshot().state!.bottomSplits).flatMap(leaf => leaf.tabs),
    unmount: mounted.unmount,
  }
}

/** The plugin's markdown surface container inside a mounted editor. */
function surfaceOf(container: HTMLElement): HTMLElement {
  const surface = container.querySelector<HTMLElement>(`[${MARKDOWN_SURFACE_ATTR}]`)
  if (surface === null) throw new Error('markdown surface container not found')
  return surface
}

/** The host-rendered file link whose destination is `title`, or null. */
function fileLink(surface: HTMLElement, title: string): HTMLButtonElement | null {
  return [...surface.querySelectorAll('button')].find(button => button.title === title) ?? null
}

/** Pin one element's measured top edge (jsdom has no layout). */
function stubRectTop(element: Element, top: number): void {
  element.getBoundingClientRect = (): DOMRect => ({
    top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top,
    toJSON: () => ({}),
  }) as DOMRect
}

/** Observe every write to an element's scrollTop (jsdom accepts the write but
 *  has no layout to derive one from). */
function watchScrollTop(element: HTMLElement): () => number {
  let value = 0
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => value,
    set: (next: number) => { value = next },
  })
  return () => value
}

/** Click one element the way a reader would. */
function click(element: HTMLElement): void {
  act(() => { element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
}

/** Flush the microtasks the surface installer queues (pending anchor, pass). */
async function flushMicrotasks(): Promise<void> {
  await act(async () => { await new Promise(resolve => { setTimeout(resolve, 0) }) })
}

/** `scrollIntoView` is absent in jsdom; a spy proves the jump never uses it
 *  (it would drag every scrollable ancestor, i.e. the whole sidebar). */
const scrollIntoView = vi.fn()
const scrollTo = vi.fn()
beforeEach(() => {
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: scrollIntoView })
  window.scrollTo = scrollTo as unknown as typeof window.scrollTo
})
afterEach(() => {
  scrollIntoView.mockClear()
  scrollTo.mockClear()
  attachLocale(undefined)
  document.body.innerHTML = ''
})

describe('the markdown preview surface', () => {
  it('slugs rendered headings like GitHub, keeps authored ids, and reserves them first', () => {
    const mounted = mountEditor([
      '## Hello, World!',
      '',
      '## Hello, World!',
      '',
      '### 中文标题',
      '',
      '<h2 id="custom">Authored</h2>',
      '',
      '<a id="anchor"></a>',
      '',
      '## custom',
      '',
    ].join('\n'), '/p/docs/README.md')
    const surface = surfaceOf(mounted.container)
    const ids = [...surface.querySelectorAll('h2, h3')].map(heading => heading.id)
    // The host renders bare `h1..h6` (no ids) — every id below is the plugin's.
    expect(ids).toEqual(['hello-world', 'hello-world-1', '中文标题', 'custom', 'custom-1'])
    // The authored id is kept AND reserved: the later heading with the same
    // slug gets the suffix instead of stealing it.
    expect(surface.querySelector('h2#custom')?.textContent).toBe('Authored')
    mounted.unmount()
  })

  it('collapses an explicit empty anchor without losing its id, and deep links still land', async () => {
    const mounted = mountEditor('intro <a id="hidden-anchor"></a> tail\n\n[jump](#hidden-anchor)\n', '/p/docs/README.md')
    const surface = surfaceOf(mounted.container)
    // The raw-HTML pass ran before the surface pass observed the tree.
    await flushMicrotasks()
    const hidden = surface.querySelector<HTMLAnchorElement>('a#hidden-anchor')
    expect(hidden?.hidden).toBe(true)
    // …and the id is still there, so `#hidden-anchor` keeps resolving: the jump
    // measures the nearest VISIBLE ancestor (a hidden box has no position).
    expect(hidden?.id).toBe('hidden-anchor')
    const scrollTop = watchScrollTop(surface)
    stubRectTop(surface, 0)
    stubRectTop(hidden!.parentElement!, 260)
    click(fileLink(surface, '#hidden-anchor')!)
    expect(scrollTop()).toBe(252)
    mounted.unmount()
  })

  it('renders a claimed .md link as the host file link and opens the DOCUMENT-relative target', () => {
    const mounted = mountEditor('See [other](./other.md) and [abs](/p/docs/third.md).\n', '/p/docs/README.md')
    const surface = surfaceOf(mounted.container)
    const link = fileLink(surface, './other.md')
    expect(link).not.toBeNull()
    // The claim is the host's file link, not an anchor: nothing here navigates
    // the page away (the host renders a button).
    expect(link?.closest('a')).toBeNull()
    click(link!)
    // `/p/docs/other.md`, NOT `/p/other.md`: the base is the rendered document.
    expect(mounted.tabs().map(tab => tab.path)).toEqual(['/p/docs/other.md'])
    click(fileLink(surface, '/p/docs/third.md')!)
    expect(mounted.tabs().map(tab => tab.path)).toEqual(['/p/docs/other.md', '/p/docs/third.md'])
    mounted.unmount()
  })

  it('keeps remote links as links and non-markdown local links as inert text', () => {
    const mounted = mountEditor([
      '[site](https://example.com/a.md)',
      '',
      '[notes](./notes.txt)',
      '',
      '[image](./pic.png)',
      '',
      '[dir](./docs)',
      '',
    ].join('\n'), '/p/docs/README.md')
    const surface = surfaceOf(mounted.container)
    // http(s) keeps today's behavior verbatim: a real anchor to the destination.
    const external = surface.querySelector<HTMLAnchorElement>('a[href="https://example.com/a.md"]')
    expect(external).not.toBeNull()
    // Everything the plugin does not claim stays what it renders as today —
    // plain text — instead of a file-mention button that would do nothing.
    for (const label of ['notes', 'image', 'dir']) {
      expect(surface.textContent, label).toContain(label)
    }
    for (const destination of ['./notes.txt', './pic.png', './docs']) {
      expect(fileLink(surface, destination), destination).toBeNull()
    }
    // …and no link of the document produced a tab.
    click(surface)
    expect(mounted.tabs()).toEqual([])
    mounted.unmount()
  })

  it('scopes the claim to the plugin surface: the same markdown elsewhere stays inert', () => {
    const bare = renderRoot(createElement(MarkdownText, {
      text: '[other](./other.md)\n',
      labels: { code: { copyLabel: 'c', copiedLabel: 'C' }, footnotes: '' },
    }))
    // No provider, no claim: the host renders the local destination as text
    // (this is exactly why the plugin has to wrap its own surfaces).
    expect(bare.container.querySelector('button')).toBeNull()
    expect(bare.container.querySelector('a')).toBeNull()
    expect(bare.container.textContent).toContain('other')
    bare.unmount()
  })

  it('scrolls the preview container itself for a same-page fragment', () => {
    const mounted = mountEditor('[jump](#目标标题)\n\n## 目标标题\n', '/p/docs/README.md')
    const surface = surfaceOf(mounted.container)
    const heading = surface.querySelector<HTMLElement>('h2#目标标题')!
    const scrollTop = watchScrollTop(surface)
    stubRectTop(heading, 120)
    // The link is a host file link whose destination the delegate decodes back
    // into a same-document fragment.
    const link = fileLink(surface, '#目标标题')
    expect(link).not.toBeNull()
    click(link!)
    expect(scrollTop()).toBe(112) // 120 - the 8px padding
    // Never the window, never scrollIntoView (that would scroll every ancestor).
    expect(scrollTo).not.toHaveBeenCalled()
    expect(scrollIntoView).not.toHaveBeenCalled()
    // A same-page jump opens nothing.
    expect(mounted.tabs()).toEqual([])
    mounted.unmount()
  })

  it('ignores a fragment the document does not carry', () => {
    const mounted = mountEditor('[jump](#missing)\n\n## Present\n', '/p/docs/README.md')
    const surface = surfaceOf(mounted.container)
    const scrollTop = watchScrollTop(surface)
    click(fileLink(surface, '#missing')!)
    expect(scrollTop()).toBe(0)
    expect(scrollTo).not.toHaveBeenCalled()
    expect(mounted.tabs()).toEqual([])
    mounted.unmount()
  })

  it('opens a cross-file target and lands the parked fragment once that file renders', async () => {
    // The link's fragment cannot reach the host parser as authored — this is
    // the `%23` carrier, end to end: rewrite → host decode → delegate → park.
    const source = mountEditor('[jump](./other.md#目标标题)\n', '/p/docs/README.md')
    const link = fileLink(surfaceOf(source.container), './other.md#目标标题')
    expect(link).not.toBeNull()
    click(link!)
    expect(source.tabs().map(tab => tab.path)).toEqual(['/p/docs/other.md'])
    source.unmount()

    // The target document renders in its own editor (same session, same path
    // spelling the open used) and takes the parked fragment.
    const target = mountEditor('## 目标标题\n', '/p/docs/other.md')
    const targetSurface = surfaceOf(target.container)
    const scrollTop = watchScrollTop(targetSurface)
    const heading = targetSurface.querySelector<HTMLElement>('h2#目标标题')!
    stubRectTop(heading, 200)
    await flushMicrotasks()
    expect(scrollTop()).toBe(192)
    expect(scrollTo).not.toHaveBeenCalled()
    expect(scrollIntoView).not.toHaveBeenCalled()
    target.unmount()

    // Consumed: a later mount of the same document does not jump again.
    const again = mountEditor('## 目标标题\n', '/p/docs/other.md')
    const againSurface = surfaceOf(again.container)
    const againScrollTop = watchScrollTop(againSurface)
    stubRectTop(againSurface.querySelector<HTMLElement>('h2#目标标题')!, 200)
    await flushMicrotasks()
    expect(againScrollTop()).toBe(0)
    again.unmount()
  })
})

describe('the document pass', () => {
  it('measures a collapsed anchor through its nearest visible ancestor', () => {
    const root = document.createElement('div')
    root.innerHTML = '<p id="wrapper"><a id="empty"></a></p>'
    hideEmptyAnchors(root)
    const empty = root.querySelector<HTMLElement>('a#empty')!
    expect(empty.hidden).toBe(true)
    // A hidden element has no box of its own: the paragraph carries the
    // position, and that is what the jump must measure.
    stubRectTop(root, 0)
    stubRectTop(empty, 0)
    stubRectTop(root.querySelector<HTMLElement>('p#wrapper')!, 300)
    const scrollTop = watchScrollTop(root)
    expect(jumpToFragment(root, 'empty')).toBe(true)
    expect(scrollTop()).toBe(292)
  })

  it('opens a collapsed details block a fragment lives in', () => {
    const root = document.createElement('div')
    root.innerHTML = '<details><summary>more</summary><h2 id="deep">Deep</h2></details>'
    stubRectTop(root, 0)
    expect(jumpToFragment(root, 'deep')).toBe(true)
    expect(root.querySelector('details')?.hasAttribute('open')).toBe(true)
  })
})
