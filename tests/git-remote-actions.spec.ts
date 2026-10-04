/**
 * The Git panel's remote + AI routes over the real `/sidebar/api` surface:
 * `git.push` / `git.pull` against a real bare remote, and `git.suggest-message`
 * — which diff becomes the prompt, which provider/model route it runs on, and
 * every degradation branch (nothing pending, no session header, no LLM service,
 * a provider-side stream failure, an empty model answer).
 *
 * The route is mounted exactly as the plugin mounts it (see smoke.spec.ts). The
 * provider/model assertion is the point of the first case: the suggestion must
 * read the SESSION's folded `request/header`, not replay the deprecated
 * full-log snapshot it used to reverse-scan.
 */
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { apply } from '../src/index.ts'
import type { SidebarWebRoute, SidebarWebUpgradeRoute } from '../src/context-types.ts'

/** Fixture commit identity, confined to this process: no git config is touched. */
const FIXTURE_IDENTITY = {
  GIT_AUTHOR_NAME: 'dsh-better-sidebar-test',
  GIT_AUTHOR_EMAIL: 'test@dsh.invalid',
  GIT_COMMITTER_NAME: 'dsh-better-sidebar-test',
  GIT_COMMITTER_EMAIL: 'test@dsh.invalid',
}

/** Run one git command (throws on a non-zero exit). */
function gitRun(cwd: string, args: string[]): string {
  const result = spawnSync('git', ['-C', cwd, '--no-pager', '-c', 'color.ui=false', ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...FIXTURE_IDENTITY },
  })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args[0] ?? ''} exited with ${String(result.status)}`)
  return result.stdout
}

/** A repo on `main` with one commit. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-remote-'))
  gitRun(dir, ['init', '-q'])
  // Pin the eol policy: Git for Windows defaults to core.autocrlf=true, which
  // would smudge the byte-exact diff assertions below.
  gitRun(dir, ['config', 'core.autocrlf', 'false'])
  gitRun(dir, ['checkout', '-q', '-b', 'main'])
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n')
  gitRun(dir, ['add', '-A'])
  gitRun(dir, ['commit', '-q', '-m', 'base'])
  return dir
}

/** A working clone, a bare `origin` it tracks, and a peer clone of the same remote. */
interface RemoteFixture {
  /** The scratch directory holding all three (the only thing to clean up). */
  scratch: string
  origin: string
  work: string
  peer: string
}

function makeRemoteFixture(): RemoteFixture {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-sidebar-origin-'))
  const origin = join(scratch, 'origin.git')
  const work = join(scratch, 'work')
  const peer = join(scratch, 'peer')
  gitRun(scratch, ['init', '-q', '--bare', origin])
  // A bare repo's HEAD defaults to the machine's init.defaultBranch, and a
  // clone whose HEAD names a branch that does not exist yet checks out
  // NOTHING. Pin it so both clones start on the branch the tests push.
  gitRun(origin, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  gitRun(scratch, ['clone', '-q', origin, work])
  gitRun(work, ['config', 'core.autocrlf', 'false'])
  writeFileSync(join(work, 'a.txt'), 'one\n')
  gitRun(work, ['add', '-A'])
  gitRun(work, ['commit', '-q', '-m', 'base'])
  gitRun(work, ['push', '-q', '-u', 'origin', 'main'])
  gitRun(scratch, ['clone', '-q', origin, peer])
  gitRun(peer, ['config', 'core.autocrlf', 'false'])
  return { scratch, origin, work, peer }
}

/** One `llm.stream` answer: the chunks that fake adapter replies with. */
type StreamAnswer = (options: GenerateOptions) => StreamChunk[]

/** A stream that answers with `text`, framed the way a real adapter frames it. */
function textStream(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/**
 * Mount the plugin's `/sidebar/api` route against a minimal fake context.
 * `stream` answers every LLM call; `requestHeader` is the session's folded
 * header the suggestion reads its route from (undefined = no header yet). The
 * session carries NO header cwd on purpose: the payload's cwd must win, which
 * is how the real client addresses a session's workspace.
 */
function mount(options: {
  stream?: StreamAnswer
  requestHeader?: () => unknown
  llm?: boolean
  session?: boolean
} = {}): { route: SidebarWebRoute; calls: GenerateOptions[] } {
  const routes: SidebarWebRoute[] = []
  const calls: GenerateOptions[] = []
  const respond = options.stream ?? (() => textStream('feat: suggested'))
  const llm = {
    stream(streamOptions: GenerateOptions): AsyncIterable<StreamChunk> {
      calls.push(streamOptions)
      const chunks = respond(streamOptions)
      return (async function* () { for (const chunk of chunks) yield chunk })()
    },
  }
  const ctx = {
    webRuntime: { trustedHosts: [] },
    webServer: {
      register: (route: SidebarWebRoute) => { routes.push(route); return () => {} },
      registerUpgrade: (_route: SidebarWebUpgradeRoute) => () => {},
    },
    sessions: {
      get: (_id: string) => (options.session === false
        ? undefined
        : {
          header: {},
          snapshotEvents: () => [],
          requestHeader: options.requestHeader ?? (() => ({ config: { provider: 'test-provider', model: 'test-model' } })),
        }),
    },
    tools: { register: () => () => {} },
    // The vendored cordis runs registration effects immediately.
    effect: (fn: () => void | (() => void)) => { fn() },
    inject: () => () => {},
    on: () => () => {},
    get: (key: string) => (key === 'llm' && options.llm !== false ? llm : undefined),
  }
  apply(ctx as never)
  const route = routes.find(entry => entry.path === '/sidebar/api')
  if (route === undefined) throw new Error('the /sidebar/api route was not registered')
  return { route, calls }
}

interface Invoked<T> {
  ok: boolean
  status: number
  value?: T
  error?: { code?: string; message: string }
}

async function invoke<T = unknown>(route: SidebarWebRoute, method: string, payload: unknown): Promise<Invoked<T>> {
  const body = Buffer.from(JSON.stringify(payload))
  const req = {
    method: 'POST',
    url: `/sidebar/api/${method}`,
    headers: { host: '127.0.0.1:3080' },
    [Symbol.asyncIterator]: async function* () { yield body },
  } as never
  const out = { status: 200, body: '' }
  const res = {
    writeHead: (status: number) => { out.status = status },
    end: (chunk: unknown) => { out.body += String(chunk ?? '') },
  } as never
  await route.handler(req, res)
  return { ...JSON.parse(out.body) as Invoked<T>, status: out.status }
}

/** The prompt the last LLM call carried (the user message's text blocks). */
function promptOf(options: GenerateOptions): string {
  const first = options.messages[0]
  if (first === undefined) return ''
  return first.content.map(block => (block.type === 'text' ? block.text : '')).join('')
}

describe('git remote routes (real repository + bare origin)', () => {
  it('pushes the current branch to its upstream', async () => {
    const fixture = makeRemoteFixture()
    try {
      writeFileSync(join(fixture.work, 'a.txt'), 'one\ntwo\n')
      gitRun(fixture.work, ['add', '-A'])
      gitRun(fixture.work, ['commit', '-q', '-m', 'second'])
      const local = gitRun(fixture.work, ['rev-parse', 'main']).trim()

      const { route } = mount()
      const result = await invoke(route, 'git.push', { sessionId: 's-push', cwd: fixture.work })

      expect(result).toMatchObject({ ok: true, value: { ok: true } })
      // The remote actually moved — the route ran a real `git push`.
      expect(gitRun(fixture.origin, ['rev-parse', 'main']).trim()).toBe(local)
    } finally {
      rmSync(fixture.scratch, { recursive: true, force: true })
    }
  })

  it('reports git\'s own failure for a branch with no upstream', async () => {
    const dir = makeRepo()
    try {
      const { route } = mount()
      const result = await invoke(route, 'git.push', { sessionId: 's-noup', cwd: dir })

      // git-error, never a silent success: the panel shows the message and the
      // user sets the tracking in a terminal.
      expect(result.ok).toBe(false)
      expect(result.error?.code).toBe('git-error')
      expect(result.error?.message ?? '').not.toBe('')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('pulls a fast-forward onto the peer\'s commit', async () => {
    const fixture = makeRemoteFixture()
    try {
      writeFileSync(join(fixture.peer, 'b.txt'), 'from peer\n')
      gitRun(fixture.peer, ['add', '-A'])
      gitRun(fixture.peer, ['commit', '-q', '-m', 'peer work'])
      gitRun(fixture.peer, ['push', '-q', 'origin', 'main'])

      const { route } = mount()
      const pulled = await invoke(route, 'git.pull', { sessionId: 's-pull', cwd: fixture.work })

      expect(pulled).toMatchObject({ ok: true, value: { ok: true } })
      expect(readFileSync(join(fixture.work, 'b.txt'), 'utf8')).toBe('from peer\n')
    } finally {
      rmSync(fixture.scratch, { recursive: true, force: true })
    }
  })

  it('refuses a diverged branch instead of merging, leaving no merge to resolve', async () => {
    const fixture = makeRemoteFixture()
    try {
      writeFileSync(join(fixture.work, 'local.txt'), 'local\n')
      gitRun(fixture.work, ['add', '-A'])
      gitRun(fixture.work, ['commit', '-q', '-m', 'local work'])
      writeFileSync(join(fixture.peer, 'peer.txt'), 'peer\n')
      gitRun(fixture.peer, ['add', '-A'])
      gitRun(fixture.peer, ['commit', '-q', '-m', 'peer work'])
      gitRun(fixture.peer, ['push', '-q', 'origin', 'main'])
      const headBefore = gitRun(fixture.work, ['rev-parse', 'HEAD']).trim()

      const { route } = mount()
      const diverged = await invoke(route, 'git.pull', { sessionId: 's-pull', cwd: fixture.work })

      // --ff-only: the failure is the point. A merge here would strand a
      // headless panel inside an editor nobody can answer.
      expect(diverged.ok).toBe(false)
      expect(diverged.error?.code).toBe('git-error')
      expect(gitRun(fixture.work, ['rev-parse', 'HEAD']).trim()).toBe(headBefore)
      expect(gitRun(fixture.work, ['status', '--porcelain'])).toBe('')
      expect(() => readFileSync(join(fixture.work, '.git', 'MERGE_HEAD'), 'utf8')).toThrow()
    } finally {
      rmSync(fixture.scratch, { recursive: true, force: true })
    }
  })
})

describe('git.suggest-message', () => {
  it('prompts with the STAGED diff on the session\'s own provider/model route', async () => {
    const dir = makeRepo()
    try {
      writeFileSync(join(dir, 'a.txt'), 'one\nSTAGED\n')
      gitRun(dir, ['add', 'a.txt'])
      writeFileSync(join(dir, 'a.txt'), 'one\nSTAGED\nUNSTAGED\n')

      const { route, calls } = mount()
      const result = await invoke<{ message: string }>(route, 'git.suggest-message', {
        sessionId: 's-suggest', cwd: dir, language: 'en',
      })

      expect(result).toMatchObject({ ok: true, value: { message: 'feat: suggested' } })
      expect(calls).toHaveLength(1)
      const call = calls[0]!
      // The route comes from the session's folded header.
      expect(call.provider).toBe('test-provider')
      expect(call.model).toBe('test-model')
      expect(call.maxTokens).toBe(200)
      // Staged wins: that is exactly what `git commit` would record, so the
      // unstaged edit must not leak into the prompt.
      const prompt = promptOf(call)
      expect(prompt).toContain('+STAGED')
      expect(prompt).not.toContain('+UNSTAGED')
      expect(prompt).toContain('a.txt')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('falls back to the unstaged diff, then to a bare file list for untracked-only', async () => {
    const dir = makeRepo()
    try {
      writeFileSync(join(dir, 'a.txt'), 'one\nWORKTREE\n')
      const unstaged = mount()
      const first = await invoke<{ message: string }>(unstaged.route, 'git.suggest-message', { sessionId: 's', cwd: dir })
      expect(first.ok).toBe(true)
      expect(promptOf(unstaged.calls[0]!)).toContain('+WORKTREE')

      // Only an untracked file left: `git diff` has nothing to say, so the
      // prompt carries the file list alone.
      gitRun(dir, ['checkout', '--', 'a.txt'])
      writeFileSync(join(dir, 'brand-new.txt'), 'new\n')
      const untracked = mount()
      const second = await invoke<{ message: string }>(untracked.route, 'git.suggest-message', { sessionId: 's', cwd: dir })
      expect(second.ok).toBe(true)
      const prompt = promptOf(untracked.calls[0]!)
      expect(prompt).toContain('brand-new.txt')
      expect(prompt).not.toContain('@@')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('truncates a diff larger than the prompt budget', async () => {
    const dir = makeRepo()
    try {
      // ~40K of changed lines: well past the 12 000-character budget.
      const line = 'x'.repeat(80)
      writeFileSync(join(dir, 'big.txt'), Array.from({ length: 500 }, (_value, index) => `${String(index)}-${line}`).join('\n'))
      gitRun(dir, ['add', 'big.txt'])

      const { route, calls } = mount()
      const result = await invoke<{ message: string }>(route, 'git.suggest-message', { sessionId: 's', cwd: dir })

      expect(result.ok).toBe(true)
      const prompt = promptOf(calls[0]!)
      expect(prompt).toContain('…(diff truncated)')
      // 12 000 chars of diff + the wrapper text, never the whole 40K file.
      expect(prompt.length).toBeLessThan(13_500)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('refuses an empty pending set without calling the model', async () => {
    const dir = makeRepo()
    try {
      const { route, calls } = mount()
      const result = await invoke(route, 'git.suggest-message', { sessionId: 's', cwd: dir })

      expect(result.ok).toBe(false)
      // The client renders its own copy for this code, so the code — not a
      // generic git failure — is the contract.
      expect(result.error?.code).toBe('git-suggest-empty')
      expect(result.status).toBe(400)
      expect(calls).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('degrades to 503 for a session with no request header and for an absent LLM service', async () => {
    const dir = makeRepo()
    try {
      writeFileSync(join(dir, 'a.txt'), 'one\nDIRTY\n')

      // A cold session: the fold has no header yet, so there is no route to run on.
      const noHeader = mount({ requestHeader: () => undefined })
      const first = await invoke(noHeader.route, 'git.suggest-message', { sessionId: 's', cwd: dir })
      expect(first.ok).toBe(false)
      expect(first.error?.code).toBe('git-suggest-error')
      expect(first.status).toBe(503)
      expect(noHeader.calls).toHaveLength(0)

      // A deployment without the LLM surface: a clean 503, never a TypeError.
      const noLlm = mount({ llm: false })
      const second = await invoke(noLlm.route, 'git.suggest-message', { sessionId: 's', cwd: dir })
      expect(second.ok).toBe(false)
      expect(second.error?.code).toBe('git-suggest-error')
      expect(second.status).toBe(503)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('surfaces a provider stream failure and an empty answer as distinct errors', async () => {
    const dir = makeRepo()
    try {
      writeFileSync(join(dir, 'a.txt'), 'one\nDIRTY\n')

      // `llm.stream()` reports an adapter failure as a terminal finish chunk
      // rather than throwing: unchecked, the provider's real reason would be
      // reported as "the model returned an empty message".
      const failed = mount({
        stream: () => [{ type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMIT', message: 'provider said no' } } }],
      })
      const first = await invoke(failed.route, 'git.suggest-message', { sessionId: 's', cwd: dir })
      expect(first.ok).toBe(false)
      expect(first.status).toBe(502)
      expect(first.error?.message).toBe('provider said no')

      const empty = mount({ stream: () => textStream('   ') })
      const second = await invoke(empty.route, 'git.suggest-message', { sessionId: 's', cwd: dir })
      expect(second.ok).toBe(false)
      expect(second.status).toBe(500)
      expect(second.error?.message).toContain('empty')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('asks for the panel language, defaulting to en for anything else', async () => {
    const dir = makeRepo()
    try {
      writeFileSync(join(dir, 'a.txt'), 'one\nDIRTY\n')
      const zh = mount()
      await invoke(zh.route, 'git.suggest-message', { sessionId: 's', cwd: dir, language: 'zh' })
      expect(zh.calls[0]!.system).toContain('Conventional Commits')
      expect(promptOf(zh.calls[0]!)).toContain('改动的文件')

      const other = mount()
      await invoke(other.route, 'git.suggest-message', { sessionId: 's', cwd: dir, language: 'ja' })
      expect(promptOf(other.calls[0]!)).toContain('Changed files')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
