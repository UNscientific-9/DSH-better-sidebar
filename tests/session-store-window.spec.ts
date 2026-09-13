/**
 * `sessionEventWindow` merge semantics (src/session-store.ts). The plans route
 * is the only extraRows caller and pays the merge on every attach poll, so the
 * fast path (extra rows all overlapped by the base → keep `base` untouched)
 * must not move any observable value. These tests pin the WINDOW CONTRACT —
 * merge order, cap, tail, cursor — across both merge paths; the plans route's
 * own row filtering lives in plans-routes.spec.ts.
 */
import { describe, expect, it } from 'vitest'
import { sessionEventWindow } from '../src/session-store.ts'
import type { Context, SidebarSessionEvent } from '../src/context-types.ts'

/** One generic log row (the window is shape-agnostic: take sees it all). */
function row(seq: number): SidebarSessionEvent {
  return { type: 'tool/call', seq, time: seq, data: { seq } }
}

/** A context serving one live store session and an optional persistence face. */
function ctxWith(
  live: readonly SidebarSessionEvent[] | undefined,
  persisted: readonly SidebarSessionEvent[] | undefined,
): Context {
  return {
    sessions: {
      get: () => live === undefined ? undefined : { header: {}, snapshotEvents: () => live },
    },
    get: (key: string) => key === 'sessionPersistence' && persisted !== undefined
      ? {
          open: async () => ({
            header: {},
            read: async () => ({ events: persisted }),
            close: async () => {},
          }),
        }
      : undefined,
  } as unknown as Context
}

/** Ship everything past the cursor — the routes' common take shape. */
const takeAll = (
  log: readonly SidebarSessionEvent[],
  afterSeq: number,
): readonly SidebarSessionEvent[] => log.filter(event => event.seq > afterSeq)

/** takeAll with a tail cap (what the routes do on top of the predicate). */
function takeCapped(cap: number) {
  return (log: readonly SidebarSessionEvent[], afterSeq: number): readonly SidebarSessionEvent[] => {
    const filtered = log.filter(event => event.seq > afterSeq)
    return filtered.length > cap ? filtered.slice(filtered.length - cap) : filtered
  }
}

describe('sessionEventWindow merge', () => {
  it('keeps the base untouched when the extra rows all overlap it', async () => {
    // Same seqs as the base but DISTINCT row objects: the old merge would
    // replace every base row with its mirror copy; the fast path must keep
    // the store's own rows (same seq ⇒ same event, so the VALUES agree).
    const base = [row(0), row(1), row(2)]
    const { events, lastSeq } = await sessionEventWindow(
      ctxWith(base, undefined),
      { sessionId: 's' },
      takeAll,
      () => [row(0), row(1), row(2)],
    )
    expect(events.map(event => event.seq)).toEqual([0, 1, 2])
    expect(lastSeq).toBe(2)
    // Fast-path sentinel: the shipped rows ARE the base rows. A regression
    // back to the unconditional Map merge swaps in the mirror copies and
    // fails this identity check.
    expect(events[0]).toBe(base[0])
    expect(events[2]).toBe(base[2])
  })

  it('merges rows the base lacks (the store frozen after a host restart)', async () => {
    const base = [row(0), row(1), row(2)]
    const extra = [row(0), row(1), row(2), row(3), row(4)]
    const { events, lastSeq } = await sessionEventWindow(
      ctxWith(base, undefined),
      { sessionId: 's' },
      takeAll,
      () => extra,
    )
    // Ascending order preserved, the gap rows included, cursor on the tail.
    expect(events.map(event => event.seq)).toEqual([0, 1, 2, 3, 4])
    expect(lastSeq).toBe(4)
  })

  it('an empty extra behaves exactly like no mirror', async () => {
    const base = [row(1), row(2)]
    const bare = await sessionEventWindow(ctxWith(base, undefined), { sessionId: 's' }, takeAll)
    const mirrored = await sessionEventWindow(
      ctxWith(base, undefined),
      { sessionId: 's' },
      takeAll,
      () => [],
    )
    expect(mirrored).toEqual(bare)
    expect(bare.events.map(event => event.seq)).toEqual([1, 2])
  })

  it('an empty base serves rows that exist only in the extra', async () => {
    const { events, lastSeq } = await sessionEventWindow(
      ctxWith(undefined, undefined),
      { sessionId: 's' },
      takeAll,
      () => [row(5), row(6)],
    )
    expect(events.map(event => event.seq)).toEqual([5, 6])
    expect(lastSeq).toBe(6)
  })

  it('a single-row base fully overlapped by the extra takes the fast path', async () => {
    const base = [row(5)]
    const { events, lastSeq } = await sessionEventWindow(
      ctxWith(base, undefined),
      { sessionId: 's' },
      takeAll,
      () => [row(5)],
    )
    expect(events.map(event => event.seq)).toEqual([5])
    expect(lastSeq).toBe(5)
    expect(events[0]).toBe(base[0])
  })

  it('cap and tail semantics hold identically on the merged log', async () => {
    // The base freezes at seq 4; the mirror carries two rows beyond it. The
    // take sees the WHOLE merged log before capping — the tail rows ship,
    // the head rolls off, and the cursor is the newest SHIPPED seq.
    const base = [row(0), row(1), row(2), row(3), row(4)]
    const extra = [row(0), row(1), row(2), row(3), row(4), row(5), row(6)]
    const { events, lastSeq } = await sessionEventWindow(
      ctxWith(base, undefined),
      { sessionId: 's' },
      takeCapped(3),
      () => extra,
    )
    expect(events.map(event => event.seq)).toEqual([4, 5, 6])
    expect(lastSeq).toBe(6)
  })

  it('the persisted log backs the base, and a fully overlapped mirror stays on the fast path', async () => {
    const persisted = [row(0), row(1)]
    const { events, lastSeq } = await sessionEventWindow(
      ctxWith(undefined, persisted),
      { sessionId: 's' },
      takeAll,
      () => [row(0), row(1)],
    )
    expect(events.map(event => event.seq)).toEqual([0, 1])
    expect(lastSeq).toBe(1)
    expect(events[0]).toBe(persisted[0])
  })

  it('afterSeq still gates the window and an empty window reuses its cursor', async () => {
    const base = [row(0), row(1), row(2)]
    const extra = () => [row(0), row(1), row(2), row(3), row(4)]
    const gated = await sessionEventWindow(
      ctxWith(base, undefined), { sessionId: 's', afterSeq: 2 }, takeAll, extra,
    )
    expect(gated.events.map(event => event.seq)).toEqual([3, 4])
    expect(gated.lastSeq).toBe(4)
    // Past the end: no rows, but the cursor comes back so the next poll
    // resumes exactly here (floored at 0 for an absent cursor).
    const drained = await sessionEventWindow(
      ctxWith(base, undefined), { sessionId: 's', afterSeq: 9 }, takeAll, extra,
    )
    expect(drained.events).toEqual([])
    expect(drained.lastSeq).toBe(9)
    const fresh = await sessionEventWindow(
      ctxWith([], undefined), { sessionId: 's' }, takeAll, () => [],
    )
    expect(fresh.events).toEqual([])
    expect(fresh.lastSeq).toBe(0)
  })
})
