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

/** 量宿主展开按钮的位置，返回本按钮应放的 top/left。 */
function measure(): { top: number; left: number } {
  const expand = document.querySelector('[data-sidebar-right-expand]')
  if (expand === null) return { top: 8, left: window.innerWidth - BUTTON_SIZE - GAP - 8 }
  const rect = expand.getBoundingClientRect()
  return {
    top: Math.max(4, rect.top + (rect.height - BUTTON_SIZE) / 2),
    left: Math.max(4, rect.left - GAP - BUTTON_SIZE),
  }
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
