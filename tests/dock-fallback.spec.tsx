/**
 * 空白会话的底部入口（issue #698 / #623）。
 *
 * 判定来自插件 host 半区的 `session.phase` 路由（与宿主会话列表投影同一规则），客户端
 * 不做任何 DOM 探测。这里用 vi.mock 替换该路由的客户端封装，钉住三件事：
 * 1. `blank` → 渲染右上角备用入口（`position: fixed`，紧邻宿主「Open right sidebar」按钮，
 *    位置由该按钮的 rect 对齐），且点击写 store（`bottomOpen` 翻转）；
 * 2. 非 `blank` → 整个不渲染（入口只有会话头里那一套）；
 * 3. 尚未读到相位（undefined）→ 不渲染（先不闪备用入口）。
 *
 * 备用入口经 portal 挂在 `document.body`（脱离面板宿主的层叠上下文），断言/点击都从
 * document 出发；afterEach 清理 body 上的残留，避免跨用例串扰。
 */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
// First import: browser globals before the primitive-carrying sidebar graph loads.
import './browser-globals.ts'
import { renderRoot, setupReactAct } from './test-utils.ts'
import { DockFallback } from '../src/client/sidebar/dock-fallback.tsx'
import { sessionPhase } from '../src/client/api.ts'
import { createSidebarStore } from '../src/client/state.ts'

setupReactAct()

vi.mock('../src/client/api.ts', () => ({
  sessionPhase: vi.fn(async () => ({ blank: true })),
}))

/** 把 mock 的返回改成指定相位。 */
function phaseIs(blank: boolean): void {
  vi.mocked(sessionPhase).mockImplementation(async () => ({ blank }))
}

/** 现场改为「相位读取永远挂起」。 */
function phasePending(): void {
  vi.mocked(sessionPhase).mockImplementation(() => new Promise(() => { /* 挂起 */ }))
}

function renderDockFallback(): { unmount: () => void; store: ReturnType<typeof createSidebarStore> } {
  const store = createSidebarStore()
  store.setSession('s1')
  const view = renderRoot(createElement(DockFallback, { store }))
  return { unmount: view.unmount, store }
}

/** 备用入口经 portal 挂在 body 上，因此点击/断言都从 document 出发。 */
function clickFallbackToggle(): void {
  const element = document.querySelector('[data-dsh-dock-fallback] [data-dsh-bottom-toggle]')
  if (element === null) throw new Error('missing element: fallback bottom toggle')
  act(() => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

describe('dock fallback（空白会话入口）', () => {
  // 失败用例可能把 portal 节点留在 body 上：每个用例后清干净，避免串扰。
  afterEach(() => {
    for (const element of document.querySelectorAll('[data-dsh-dock-fallback]')) element.remove()
  })

  it('renders the fallback entry and flips the bottom workbench through the store', async () => {
    const { unmount, store } = renderDockFallback()
    try {
      await vi.waitFor(() => {
        expect(document.querySelector('[data-dsh-dock-fallback]'), '备用入口容器').not.toBeNull()
      })
      expect(document.querySelector('[data-dsh-bottom-toggle]'), '底部入口').not.toBeNull()
      expect(store.getSnapshot().state?.bottomOpen).toBe(false)

      clickFallbackToggle()
      expect(store.getSnapshot().state?.bottomOpen).toBe(true)
    } finally {
      unmount()
    }
  })

  it('renders nothing once the session is no longer blank', () => {
    phaseIs(false)
    const { unmount } = renderDockFallback()

    expect(document.querySelector('[data-dsh-dock-fallback]'), '非 blank 不该有备用入口').toBeNull()
    unmount()
  })

  it('renders nothing before the first phase read settles', () => {
    phasePending()
    const { unmount } = renderDockFallback()

    expect(document.querySelector('[data-dsh-dock-fallback]'), '相位未知时先不渲染').toBeNull()
    unmount()
  })

  // 相位是**轮询**来的（blank 期间每 1s 一次），而会话头的入口由宿主在它认为合适的
  // 时机渲染：两者之间必然存在窗口——更糟的是相位读取失败时按「非 blank」降级、但从未
  // 成功过一次的会话也可能一直停在 blank。凭相位判定「会话头不可达」因此不够：
  // 备用入口与会话头入口在版面上是**同一个位置**（都紧邻宿主「Open right sidebar」），
  // 两个都在时会精确重叠成一团。所以再加一条与相位无关的兜底：会话头那套入口只要
  // 真的在 DOM 里，备用入口就让位。
  it('yields to the session header entry whenever the host is rendering it', async () => {
    phaseIs(true) // 相位仍说 blank —— 正是会重叠的那种不一致
    const header = document.createElement('div')
    header.innerHTML = '<button data-dsh-bottom-toggle aria-label="Expand bottom panel"></button>'
    document.body.append(header)
    const { unmount } = renderDockFallback()
    try {
      // 等相位真的落地（否则断言只是在「还没读到相位」上白过）。
      await act(async () => { await new Promise(resolve => { setTimeout(resolve, 0) }) })
      expect(vi.mocked(sessionPhase), '相位必须已经读过一次').toHaveBeenCalled()
      expect(document.querySelector('[data-dsh-dock-fallback]'), '会话头入口在场时备用入口必须让位').toBeNull()
      expect(
        document.querySelectorAll('[data-dsh-bottom-toggle]'),
        '整页仍然只有一个底部入口',
      ).toHaveLength(1)
    } finally {
      unmount()
      header.remove()
    }
  })

  // 宿主那个角落控件有两种形态：右侧栏关闭时带 `data-sidebar-right-expand`，打开时
  // 这个属性消失、同一座位换成 `data-sidebar-right-toggle`。只认前者的话，右侧栏一
  // 打开就落到视口兜底坐标（innerWidth - 44），而那里正是宿主自己的角落按钮群 ——
  // 备用入口会精确压在「收起右侧栏」上（真机实测重叠 18px，与用户截图一致）。
  it('anchors to the host corner control in its OPEN form as well', async () => {
    phaseIs(true)
    const anchor = document.createElement('button')
    anchor.setAttribute('data-sidebar-right-toggle', 'true')
    anchor.getBoundingClientRect = () => ({
      x: 500, y: 10, left: 500, top: 10, width: 28, height: 28, right: 528, bottom: 38,
      toJSON: () => ({}),
    }) as DOMRect
    document.body.append(anchor)
    const { unmount } = renderDockFallback()
    try {
      await act(async () => { await new Promise(resolve => { setTimeout(resolve, 0) }) })
      const shell = document.querySelector<HTMLElement>('[data-dsh-dock-fallback]')
      expect(shell, '空白会话里备用入口应当在').not.toBeNull()
      // 500 - GAP(8) - BUTTON_SIZE(28) = 464；落在视口兜底时会是 innerWidth - 44。
      expect(shell!.style.left, '锚点应当是宿主打开的角落控件，而不是视口兜底').toBe('464px')
    } finally {
      unmount()
      anchor.remove()
    }
  })

  // 宿主的角落控件是肩并肩一簇（实测：Split / Fullscreen / Collapse 各 28px、间隔 8px）。
  // 只往左让一个固定偏移会正好落在**下一个**按钮上（实测精确压住 Fullscreen 28x28px），
  // 所以让位必须逐个槽位试探到真的空出来。
  it('keeps stepping left until the slot is free of host buttons', async () => {
    phaseIs(true)
    const rect = (left: number, top: number) => () => ({
      x: left, y: top, left, top, width: 28, height: 28, right: left + 28, bottom: top + 28,
      toJSON: () => ({}),
    }) as DOMRect
    // 宿主锚点（打开形态）在 500；紧邻左侧 464..492 上已经站着 Fullscreen。
    const anchor = document.createElement('button')
    anchor.setAttribute('data-sidebar-right-toggle', 'true')
    anchor.getBoundingClientRect = rect(500, 10)
    const fullscreen = document.createElement('button')
    fullscreen.setAttribute('aria-label', 'Fullscreen')
    fullscreen.getBoundingClientRect = rect(464, 10)
    document.body.append(anchor, fullscreen)
    const { unmount } = renderDockFallback()
    try {
      await act(async () => { await new Promise(resolve => { setTimeout(resolve, 0) }) })
      const shell = document.querySelector<HTMLElement>('[data-dsh-dock-fallback]')
      expect(shell, '空白会话里备用入口应当在').not.toBeNull()
      // 464 被占 → 再让一格到 428；停在 464 就是压在 Fullscreen 上。
      expect(shell!.style.left, '占位时必须继续左移，不能停在 Fullscreen 上').toBe('428px')
    } finally {
      unmount()
      anchor.remove()
      fullscreen.remove()
    }
  })

  it('degrades to nothing when the host route is unavailable', async () => {
    vi.mocked(sessionPhase).mockRejectedValue(new Error('unsupported'))
    const { unmount } = renderDockFallback()
    try {
      // 路由/宿主不支持：按非 blank 降级（不渲染备用入口，入口留在会话头）。
      await vi.waitFor(() => {
        expect(vi.mocked(sessionPhase)).toHaveBeenCalled()
      })
      expect(document.querySelector('[data-dsh-dock-fallback]'), '降级时不渲染备用入口').toBeNull()
    } finally {
      unmount()
    }
  })
})
