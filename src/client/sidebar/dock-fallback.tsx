/**
 * 空白会话专用的底部工作台开关（issue #698 / #623）。
 *
 * blank 会话里宿主不渲染会话头，本插件挂在 `header.utilities` 的入口随之不可达；
 * 这里把同一个开关以 `position: fixed` 放到宿主「Open right sidebar」按钮的**左侧紧邻**
 * （按该按钮的 rect 对齐，随窗口 resize 与 500ms 周期重对齐）。
 *
 * **相位不足以判定互斥**：相位是每 1s 轮询来的，而会话头的入口由宿主在它认为合适的
 * 时机渲染，两者之间必然有窗口；相位读取失败时还会按「非 blank」降级，一个从未成功
 * 读到的会话可能一直停在 blank。而两套入口在版面上是**同一个位置**——真同时在场就是
 * 精确重叠成一团。所以除了相位，再加一条与相位无关的兜底：**会话头那套入口只要真的
 * 在 DOM 里，备用入口就让位**（`data-dsh-bottom-toggle` 不在 `[data-dsh-dock-fallback]`
 * 内的那个）。
 */
import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { SidebarStore } from '../state.ts'
import { BottomDockToggle } from '../Sidebar.tsx'
import { useSessionPhase } from '../session-phase.ts'
import css from '../sidebar.module.css'

/** 按钮尺寸与宿主展开按钮一致（28px），间距 8px。 */
const BUTTON_SIZE = 28
const GAP = 8

/**
 * 会话头那套入口现在是否在 DOM 里（备用入口自身不算）。
 * @returns 只要存在一个不在 `[data-dsh-dock-fallback]` 里的
 *  `[data-dsh-bottom-toggle]` 就为 true。
 */
function headerEntryPresent(): boolean {
  return [...document.querySelectorAll('[data-dsh-bottom-toggle]')]
    .some(element => element.closest('[data-dsh-dock-fallback]') === null)
}

/**
 * 量本按钮应放的 top/left：贴在宿主「右侧栏角落控件」的**左侧空位**上。
 *
 * 两件事都不能靠猜：
 *
 * 1. **锚点要认控件的两种形态**——右侧栏关闭时它带 `data-sidebar-right-expand`，
 *    打开时该属性整个消失、同一座位换成 `data-sidebar-right-toggle`。只认前者会落到
 *    下面的视口兜底坐标（`innerWidth - 44`），而那里正是宿主自己的角落按钮群。
 * 2. **让位不能让一个固定偏移**——宿主的角落控件是肩并肩一簇（实测打开态：
 *    Split / Fullscreen / Collapse 各 28px、间隔 8px）。只往左挪 `GAP + BUTTON_SIZE`
 *    正好落在**下一个**按钮上（实测：精确压住 Fullscreen 28x28px）。所以这里逐个槽位
 *    左移，直到该槽位与**任何**宿主按钮都不相交；找不到完全不重叠的位置时（极窄窗口）
 *    停在最左，宁可贴边也不叠。
 *
 * @returns 视口坐标下的 top/left。
 */
function measure(): { top: number; left: number } {
  const anchor = document.querySelector('[data-sidebar-right-expand], [data-sidebar-right-toggle]')
  if (anchor === null) return { top: 8, left: window.innerWidth - BUTTON_SIZE - GAP - 8 }
  const rect = anchor.getBoundingClientRect()
  const top = Math.max(4, rect.top + (rect.height - BUTTON_SIZE) / 2)
  // 同排的宿主按钮（本按钮自己除外）：只有与它竖直方向真的相交才算占位。
  const occupied = [...document.querySelectorAll('button, [role="button"]')]
    .filter(element => !element.hasAttribute('data-dsh-bottom-toggle'))
    .map(element => element.getBoundingClientRect())
    .filter(box => box.width > 4 && box.height > 4)
  let left = rect.left - GAP - BUTTON_SIZE
  for (let step = 0; step < 8; step++) {
    const collides = occupied.some(box => left < box.right + GAP / 2
      && left + BUTTON_SIZE > box.left - GAP / 2
      && top < box.bottom
      && top + BUTTON_SIZE > box.top)
    if (!collides) break
    left -= BUTTON_SIZE + GAP
  }
  return { top, left: Math.max(4, left) }
}

export function DockFallback({ store }: { store: SidebarStore }): ReactNode {
  const snapshot = useSyncExternalStore(
    useCallback((callback: () => void) => store.subscribe(callback), [store]),
    useCallback(() => store.getSnapshot(), [store]),
  )
  const phase = useSessionPhase(snapshot.sessionId)
  const [pos, setPos] = useState(measure)
  const [headerEntry, setHeaderEntry] = useState(headerEntryPresent)
  useEffect(() => {
    const onResize = (): void => {
      setPos(measure())
      setHeaderEntry(headerEntryPresent())
    }
    window.addEventListener('resize', onResize)
    const timer = setInterval(onResize, 500)
    return () => {
      window.removeEventListener('resize', onResize)
      clearInterval(timer)
    }
  }, [])
  // 相位判定在组件内部完成：非 blank（或尚未读到）时整个不渲染 ——
  // 会话头里的入口此时是唯一一套。
  if (phase === undefined || !phase.blank) return null
  // 兜底：相位说 blank、但会话头的入口确实在 DOM 里 —— 让位，绝不叠出第二套。
  if (headerEntry) return null
  // portal 到 body：面板宿主（z 20-30）的层叠上下文压不过会话头，按钮会被 titleRow
  // 拦截点击。40 高于 AppFrame(20) 与会话头、低于 DSH 浮层(100+)。
  return createPortal(
    <span
      className={css.dockFallback}
      data-dsh-dock-fallback
      style={{ top: pos.top, left: pos.left }}
    >
      <BottomDockToggle store={store} />
    </span>,
    document.body,
  )
}
