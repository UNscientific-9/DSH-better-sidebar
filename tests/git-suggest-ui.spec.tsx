/**
 * The commit bar's two new affordances: the sparkle button that asks the host
 * for a commit message, and the Push / Pull row under the message box.
 *
 * These pin the WIRING the host routes cannot see — which args each action
 * sends (scope, locale, selected checkout), that a suggestion only FILLS the
 * box instead of committing, and that every failure lands on the bar's one
 * status line (`changes-tab.spec.tsx` pins that channel's placement).
 *
 * The copy assertions go through `t()`, so they follow the active locale
 * rather than pinning one language's strings.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { GitLens } from '../src/client/changes/GitLens.tsx'
import { createSidebarStore } from '../src/client/state.ts'
import { api, SidebarApiError, type GitStatusResult, type GitWorktree } from '../src/client/api.ts'
import { t } from '../src/client/locales.ts'

import { setupReactAct } from './test-utils.ts'
setupReactAct()

const MAIN = 'C:/repo/main'

/** Install one inventory whose status carries `entries`. */
function mockGit(entries: Array<{ path: string; xy: string }>): void {
  vi.spyOn(api, 'gitWorktrees').mockResolvedValue([
    { path: MAIN, branch: 'main', current: true, changes: entries.length },
  ] as GitWorktree[])
  vi.spyOn(api, 'gitStatus').mockResolvedValue({ isRepo: true, branch: 'main', entries } as GitStatusResult)
  vi.spyOn(api, 'gitBranch').mockResolvedValue({ current: 'main', names: ['main'] })
  vi.spyOn(api, 'gitLog').mockResolvedValue([])
}

function mountGit(root: Root): void {
  act(() => {
    root.render(createElement(GitLens, {
      scope: { sessionId: 'session', cwd: MAIN },
      store: createSidebarStore(),
      onOpenFile: () => {},
      onPreview: () => {},
      selectedRef: null,
      visible: true,
      refreshTick: 0,
    }))
  })
}

async function flushEffects(): Promise<void> {
  // The refresh chain (inventory → branches/log → state) is several promise
  // hops deep, so a shallow flush asserts on rows still in flight.
  for (let round = 0; round < 5; round += 1) await act(async () => { await Promise.resolve() })
}

function makeRoot(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div')
  document.body.append(container)
  return { container, root: createRoot(container) }
}

/** The sparkle button (its accessible name is the generate/suggesting copy). */
function suggestButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${t('generateCommitMessage')}"]`)
  if (button === null) throw new Error('the commit-message suggestion button is not rendered')
  return button
}

/** One text button of the commit bar, by its label. */
function textButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find(candidate => candidate.textContent === label)
  if (button === undefined) throw new Error(`no commit-bar button labelled "${label}"`)
  return button
}

/** The commit message box. */
function commitInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(`input[placeholder="${t('commitPlaceholder')}"]`)
  if (input === null) throw new Error('the commit message box is not rendered')
  return input
}

/** One rendered error line of the commit bar. */
function errorLine(container: HTMLElement, text: string): HTMLElement | undefined {
  return [...container.querySelectorAll<HTMLElement>('[role="alert"]')]
    .find(node => (node.textContent ?? '').includes(text))
}

beforeEach(() => {
  Object.defineProperty(globalThis.navigator, 'language', { value: 'zh-CN', configurable: true })
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

describe('GitLens commit bar: AI suggestion and remote actions', () => {
  it('offers the suggestion only while something is pending, then fills the box', async () => {
    mockGit([{ path: 'src/a.ts', xy: ' M' }])
    const suggest = vi.spyOn(api, 'gitSuggestMessage').mockResolvedValue({ message: 'feat: from the model' })
    const commit = vi.spyOn(api, 'gitCommit').mockResolvedValue({ ok: true })

    const { container, root } = makeRoot()
    try {
      mountGit(root)
      await flushEffects()

      await act(async () => { suggestButton(container).click() })
      await flushEffects()

      // The panel's own locale and selected checkout ride the call; the scope
      // is the live one every other git call uses. The first inventory pass
      // selects the clean primary checkout, so that is what travels.
      expect(suggest).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'session', cwd: MAIN }),
        'zh',
        MAIN,
      )
      // The suggestion FILLS the box — it is a draft the user still edits and
      // commits, never a commit of its own.
      expect(commitInput(container).value).toBe('feat: from the model')
      expect(commit).not.toHaveBeenCalled()
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('disables the suggestion button when the tree is clean', async () => {
    mockGit([])

    const { container, root } = makeRoot()
    try {
      mountGit(root)
      await flushEffects()

      expect(suggestButton(container).disabled).toBe(true)
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('asks for English when the panel is not Chinese', async () => {
    Object.defineProperty(globalThis.navigator, 'language', { value: 'en-US', configurable: true })
    mockGit([{ path: 'src/a.ts', xy: ' M' }])
    const suggest = vi.spyOn(api, 'gitSuggestMessage').mockResolvedValue({ message: 'feat: english' })

    const { container, root } = makeRoot()
    try {
      mountGit(root)
      await flushEffects()

      await act(async () => { suggestButton(container).click() })
      await flushEffects()

      expect(suggest).toHaveBeenCalledWith(expect.anything(), 'en', MAIN)
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('separates an empty pending set from a provider failure on the bar\'s status line', async () => {
    mockGit([{ path: 'src/a.ts', xy: ' M' }])
    vi.spyOn(api, 'gitSuggestMessage')
      // The host's own precondition code: the client renders its dedicated copy
      // rather than prefixing a provider message nobody needs.
      .mockRejectedValueOnce(new SidebarApiError('git-suggest-empty', 'no pending changes'))
      .mockRejectedValueOnce(new SidebarApiError('git-suggest-error', 'the harness LLM service is unavailable'))

    const { container, root } = makeRoot()
    try {
      mountGit(root)
      await flushEffects()

      await act(async () => { suggestButton(container).click() })
      await flushEffects()
      expect(errorLine(container, t('suggestCommitEmpty'))).toBeDefined()

      await act(async () => { suggestButton(container).click() })
      await flushEffects()
      expect(errorLine(container, `${t('suggestCommitError')}: the harness LLM service is unavailable`)).toBeDefined()

      // The box keeps whatever it held: a failed suggestion never commits or clears.
      expect(commitInput(container).value).toBe('')
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })

  it('pushes and pulls the selected checkout, reporting failures on the same status line', async () => {
    mockGit([{ path: 'src/a.ts', xy: ' M' }])
    const push = vi.spyOn(api, 'gitPush').mockResolvedValue({ ok: true })
    const pull = vi.spyOn(api, 'gitPull').mockRejectedValue(new Error('Not possible to fast-forward'))

    const { container, root } = makeRoot()
    try {
      mountGit(root)
      await flushEffects()

      await act(async () => { textButton(container, t('push')).click() })
      await flushEffects()
      expect(push).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session' }), MAIN)

      await act(async () => { textButton(container, t('pull')).click() })
      await flushEffects()
      expect(pull).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session' }), MAIN)
      expect(errorLine(container, `${t('pullError')}: Not possible to fast-forward`)).toBeDefined()
    } finally {
      act(() => { root.unmount() })
      container.remove()
    }
  })
})
