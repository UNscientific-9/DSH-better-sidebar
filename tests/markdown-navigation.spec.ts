/**
 * The pure half of markdown anchor navigation (`src/client/markdown-navigation.ts`):
 * GitHub heading slugs, the link-claim judge, the SOURCE rewrite that carries a
 * heading fragment past the host's `parseFileLink`, and the cross-file fragment
 * table. The DOM half — ids on real rendered markdown, the host delegate's
 * click path, in-preview scrolling — lives in tests/markdown-surface.spec.tsx,
 * which renders the REAL TextEditor (and therefore the real host `MarkdownText`).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  githubHeadingSlug,
  isHostLineFragment,
  markdownAnchorTarget,
  rememberMarkdownAnchor,
  rewriteLocalMarkdownLinks,
  takeMarkdownAnchor,
  type MarkdownAnchorTarget,
} from '../src/client/markdown-navigation.ts'

const DOC = '/ws/docs/README.md'
const CWD = '/ws'

/** The judged FILE target, failing loudly when the link was not claimed. The
 *  base is an object rather than two defaulted parameters: `undefined` is one
 *  of the cases under test ("no document, no cwd"), and a defaulted parameter
 *  cannot express it. */
function fileTarget(
  destination: string,
  base: { docPath?: string; cwd?: string } = { docPath: DOC, cwd: CWD },
): { path: string; fragment: string } {
  const target: MarkdownAnchorTarget | null = markdownAnchorTarget(destination, base.docPath, base.cwd)
  if (target === null || target.kind !== 'file') throw new Error(`not claimed as a file link: ${destination}`)
  return { path: target.path, fragment: target.fragment }
}

describe('githubHeadingSlug', () => {
  it('lower-cases, drops punctuation and collapses whitespace runs to one dash', () => {
    expect(githubHeadingSlug('Hello, World!')).toBe('hello-world')
    expect(githubHeadingSlug('  Mixed   CASE  ')).toBe('mixed-case')
    expect(githubHeadingSlug('API 参考 (v2)')).toBe('api-参考-v2')
    expect(githubHeadingSlug('`code` & "quotes"')).toBe('code-quotes')
    expect(githubHeadingSlug('Trailing punctuation:')).toBe('trailing-punctuation')
  })

  it('keeps Chinese text as its own id, like GitHub does', () => {
    expect(githubHeadingSlug('中文标题')).toBe('中文标题')
    expect(githubHeadingSlug('已核实的事实')).toBe('已核实的事实')
    // The full-width colon is punctuation: it goes, the text stays.
    expect(githubHeadingSlug('认领文件链接：在侧栏打开')).toBe('认领文件链接在侧栏打开')
  })

  it('keeps the dash and underscore GitHub keeps, and drops symbols', () => {
    expect(githubHeadingSlug('Foo-Bar_Baz')).toBe('foo-bar_baz')
    expect(githubHeadingSlug('C++ / C#')).toBe('c-c')
    expect(githubHeadingSlug('🎉 Party')).toBe('party')
  })

  it('yields an empty slug for text with nothing to keep', () => {
    expect(githubHeadingSlug('!!!')).toBe('')
    expect(githubHeadingSlug('   ')).toBe('')
    expect(githubHeadingSlug('')).toBe('')
  })
})

describe('isHostLineFragment', () => {
  it('recognizes the line grammar the host parses itself', () => {
    expect(isHostLineFragment('L24')).toBe(true)
    expect(isHostLineFragment('L24-L30')).toBe(true)
    // The host's own regex does not validate the range order either, so a
    // reversed range stays the host's business — this predicate mirrors the
    // host grammar exactly, no more.
    expect(isHostLineFragment('L24-L3')).toBe(true)
    expect(isHostLineFragment('l24')).toBe(false)
    expect(isHostLineFragment('L0')).toBe(false)
    expect(isHostLineFragment('标题')).toBe(false)
  })
})

describe('markdownAnchorTarget', () => {
  it('claims a relative .md link against the DOCUMENT directory, not the cwd', () => {
    // The whole point of the base rule: the link lives in /ws/docs, so its
    // sibling is /ws/docs/other.md — NOT /ws/other.md.
    expect(fileTarget('./other.md')).toEqual({ path: '/ws/docs/other.md', fragment: '' })
    expect(fileTarget('other.md')).toEqual({ path: '/ws/docs/other.md', fragment: '' })
  })

  it('collapses . and .. segments and accepts both markdown extensions', () => {
    expect(fileTarget('../a/b.markdown')).toEqual({ path: '/ws/a/b.markdown', fragment: '' })
    expect(fileTarget('./deep/./x/../y.md')).toEqual({ path: '/ws/docs/deep/y.md', fragment: '' })
    // The extension check is case-insensitive; other markdown-ish extensions
    // are NOT claimed this batch.
    expect(fileTarget('./OTHER.MD').path).toBe('/ws/docs/OTHER.MD')
    expect(markdownAnchorTarget('./other.mdx', DOC, CWD)).toBeNull()
  })

  it('keeps a fragment through the claim, percent-decoded — both spellings', () => {
    // As authored (a literal `#`) and as the host hands it back after decoding
    // this module's `%23` carrier.
    expect(fileTarget('./other.md#中文标题')).toEqual({ path: '/ws/docs/other.md', fragment: '中文标题' })
    expect(fileTarget('./other.md%23中文标题')).toEqual({ path: '/ws/docs/other.md', fragment: '中文标题' })
    expect(fileTarget('./other.md#%E6%A0%87%E9%A2%98')).toEqual({ path: '/ws/docs/other.md', fragment: '标题' })
    expect(fileTarget('./a%20b.md').path).toBe('/ws/docs/a b.md')
    // The host's own line destination is claimed as a FILE (the line rides the
    // host's `options.line`; it is not an anchor).
    expect(fileTarget('./other.md#L24')).toEqual({ path: '/ws/docs/other.md', fragment: 'L24' })
  })

  it('keeps an absolute path absolute (POSIX, drive letter, UNC)', () => {
    expect(fileTarget('/abs/x.md').path).toBe('/abs/x.md')
    // A drive-letter path LOOKS like a scheme (`C:`); it must stay a path.
    expect(fileTarget('C:\\docs\\x.md').path).toBe('C:\\docs\\x.md')
    expect(fileTarget('\\\\server\\share\\x.md').path).toBe('\\\\server\\share\\x.md')
    expect(fileTarget('/ws/docs/README.md#top')).toEqual({ path: '/ws/docs/README.md', fragment: 'top' })
  })

  it('resolves against the session cwd when the surface renders no file', () => {
    expect(fileTarget('./other.md', { cwd: CWD }).path).toBe('/ws/other.md')
    // With no base at all the relative spelling passes through for the opener
    // (which resolves it against the session cwd itself).
    expect(fileTarget('docs/other.md', {}).path).toBe('docs/other.md')
  })

  it('reads a bare fragment as the same document — decoded, and permissive', () => {
    expect(markdownAnchorTarget('#标题', DOC, CWD)).toEqual({ kind: 'same-page', fragment: '标题' })
    // `#` alone is "back to the top".
    expect(markdownAnchorTarget('#', DOC, CWD)).toEqual({ kind: 'same-page', fragment: '' })
    // A fragment with a space still names the heading whose slug it is.
    expect(markdownAnchorTarget('#Some Heading', DOC, CWD)).toEqual({ kind: 'same-page', fragment: 'Some Heading' })
    // …and the encoded carrier the rewriter writes reads the same way.
    expect(markdownAnchorTarget('%23标题', DOC, CWD)).toEqual({ kind: 'same-page', fragment: '标题' })
  })

  it('never claims remote links (http, https, mailto, protocol-relative)', () => {
    for (const destination of [
      'https://example.com/x.md',
      'http://example.com/x.md#a',
      'HTTPS://Example.com/X.MD',
      'mailto:me@example.com',
      'data:text/markdown,#x',
      '//example.com/x.md',
    ]) {
      expect(markdownAnchorTarget(destination, DOC, CWD), destination).toBeNull()
    }
    // The one that IS claimed, for contrast: the DOM would have resolved both
    // of these against the GUI origin, which is why the raw destination is
    // judged and why a query kills the claim.
    expect(fileTarget('other.md').path).toBe('/ws/docs/other.md')
  })

  it('leaves every other extension and unusable destination alone', () => {
    expect(markdownAnchorTarget('./notes.txt', DOC, CWD)).toBeNull()
    expect(markdownAnchorTarget('./image.png', DOC, CWD)).toBeNull()
    expect(markdownAnchorTarget('./src/a.ts', DOC, CWD)).toBeNull()
    expect(markdownAnchorTarget('./other.md?raw=1', DOC, CWD)).toBeNull()
    expect(markdownAnchorTarget('', DOC, CWD)).toBeNull()
    expect(markdownAnchorTarget('   ', DOC, CWD)).toBeNull()
  })
})

describe('rewriteLocalMarkdownLinks', () => {
  it('carries a heading fragment past the host parser as an encoded `#`', () => {
    expect(rewriteLocalMarkdownLinks('[x](./other.md#标题)', DOC, CWD)).toBe('[x](./other.md%23标题)')
    expect(rewriteLocalMarkdownLinks('[x](./other.md#)', DOC, CWD)).toBe('[x](./other.md%23)')
    expect(rewriteLocalMarkdownLinks('[x](#标题)', DOC, CWD)).toBe('[x](%23标题)')
    // The link label is untouched, titles survive, and the SAME destination the
    // judge accepts is the one the rewriter leaves alone.
    expect(rewriteLocalMarkdownLinks('[x](./other.md#标题 "title")', DOC, CWD)).toBe('[x](./other.md%23标题 "title")')
    expect(rewriteLocalMarkdownLinks('[x](./other.md#L24)', DOC, CWD)).toBe('[x](./other.md#L24)')
    expect(rewriteLocalMarkdownLinks('[x](./other.md)', DOC, CWD)).toBe('[x](./other.md)')
  })

  it('keeps every destination the plugin does not claim inert', () => {
    // `parseFileLink` refuses a destination carrying a query, so the appended
    // `?` is what stops a non-markdown local path from becoming a file-mention
    // button the plugin would not serve.
    expect(rewriteLocalMarkdownLinks('[x](./notes.txt)', DOC, CWD)).toBe('[x](./notes.txt?)')
    expect(rewriteLocalMarkdownLinks('[x](./notes.txt#anchor)', DOC, CWD)).toBe('[x](./notes.txt?#anchor)')
    expect(rewriteLocalMarkdownLinks('[x](../src/a.ts#L3)', DOC, CWD)).toBe('[x](../src/a.ts?#L3)')
    // Remote links keep their own anchor, query and all.
    expect(rewriteLocalMarkdownLinks('[x](https://e.com/a.md#top)', DOC, CWD)).toBe('[x](https://e.com/a.md#top)')
    expect(rewriteLocalMarkdownLinks('[x](mailto:me@e.com)', DOC, CWD)).toBe('[x](mailto:me@e.com)')
    expect(rewriteLocalMarkdownLinks('[x](//e.com/a.md)', DOC, CWD)).toBe('[x](//e.com/a.md)')
    // An already-queried destination is inert on its own.
    expect(rewriteLocalMarkdownLinks('[x](./a.md?raw=1)', DOC, CWD)).toBe('[x](./a.md?raw=1)')
  })

  it('leaves images to the image pass and code spans alone', () => {
    expect(rewriteLocalMarkdownLinks('![alt](./pic.png)', DOC, CWD)).toBe('![alt](./pic.png)')
    expect(rewriteLocalMarkdownLinks('`[x](./other.md#标题)`', DOC, CWD)).toBe('`[x](./other.md#标题)`')
    expect(rewriteLocalMarkdownLinks('```\n[x](./other.md#标题)\n```', DOC, CWD)).toBe('```\n[x](./other.md#标题)\n```')
    // An image nested in a link label keeps its own destination.
    expect(rewriteLocalMarkdownLinks('[![alt](./pic.png)](./other.md#x)', DOC, CWD))
      .toBe('[![alt](./pic.png)](./other.md%23x)')
  })

  it('rewrites reference definitions, brackets included', () => {
    expect(rewriteLocalMarkdownLinks('[id]: ./other.md#标题', DOC, CWD)).toBe('[id]: ./other.md%23标题')
    expect(rewriteLocalMarkdownLinks('[id]: <./a b.md#标题>', DOC, CWD)).toBe('[id]: <./a b.md%23标题>')
    expect(rewriteLocalMarkdownLinks('[id]: ./notes.txt', DOC, CWD)).toBe('[id]: ./notes.txt?')
    // An image-used definition was already turned into a media URL by the
    // image pass (which runs first) — never touched here.
    expect(rewriteLocalMarkdownLinks('[id]: http://gui/sidebar/file?path=%2Fx.png', DOC, CWD))
      .toBe('[id]: http://gui/sidebar/file?path=%2Fx.png')
  })

  it('is idempotent: a second pass over its own output changes nothing', () => {
    const once = rewriteLocalMarkdownLinks('[a](./other.md#标题) [b](./notes.txt) [c](#x) [d](./other.md#L3)', DOC, CWD)
    expect(rewriteLocalMarkdownLinks(once, DOC, CWD)).toBe(once)
  })
})

describe('the cross-file fragment table', () => {
  afterEach(() => { vi.useRealTimers() })

  it('hands a parked fragment to the target document exactly once', () => {
    rememberMarkdownAnchor('s1', '/ws', '/ws/docs/other.md', '标题')
    expect(takeMarkdownAnchor('s1', '/ws', '/ws/docs/other.md')).toBe('标题')
    // Consumed AND cleared: a second mount of the same document must not jump
    // again.
    expect(takeMarkdownAnchor('s1', '/ws', '/ws/docs/other.md')).toBeNull()
  })

  it('keys on session + path, matching the two spellings the surfaces hold', () => {
    // The click side has an absolute path; an editor tab opened from the chat
    // may hold the cwd-relative one (or a Windows separator). Both must meet.
    rememberMarkdownAnchor('s1', '/ws', 'docs/other.md', 'frag')
    expect(takeMarkdownAnchor('s1', '/ws', '/ws/docs/other.md')).toBe('frag')
    rememberMarkdownAnchor('s1', '/ws', '/ws/docs/other.md', 'frag')
    expect(takeMarkdownAnchor('s1', '/ws', 'docs\\other.md')).toBe('frag')
    // A different session, or a different file, is a miss.
    rememberMarkdownAnchor('s1', '/ws', '/ws/docs/other.md', 'frag')
    expect(takeMarkdownAnchor('s2', '/ws', '/ws/docs/other.md')).toBeNull()
    expect(takeMarkdownAnchor('s1', '/ws', '/ws/docs/third.md')).toBeNull()
  })

  it('never parks an empty fragment, and expires a stale one', () => {
    // Distinct keys per case: the table is module state shared by the file.
    rememberMarkdownAnchor('s1', '/ws', '/ws/docs/empty.md', '')
    expect(takeMarkdownAnchor('s1', '/ws', '/ws/docs/empty.md')).toBeNull()

    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    rememberMarkdownAnchor('s1', '/ws', '/ws/docs/stale.md', 'frag')
    vi.setSystemTime(new Date('2026-01-01T00:01:00Z'))
    // An open that never landed must not make a later, unrelated open jump.
    expect(takeMarkdownAnchor('s1', '/ws', '/ws/docs/stale.md')).toBeNull()
  })
})
