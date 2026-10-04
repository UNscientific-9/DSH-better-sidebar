# Git 面板：AI 提交信息建议 + Push/Pull — 移植记录（PR #434）

> 分支 `port/pr-434`（基于 `dev`，DSH 0.2.0-rc.1 线）。上游 PR `Feat/git commit message ai`
> 三个 commit：`6b98216` AI 建议 + 提交框置顶、`3ec82f2` Push/Pull、
> `80e64bc` 文件树 rename。**第三个 commit 整块丢弃**：`dev` 已有等价实现
> （commit `e39ea92` / PR #550，`src/fs-operations.ts` + `FileTree.tsx` 内联改名 + 21 份词典的
> rename 键），且 PR 的同名 `fs.rename` 路由读 `newName`、`dev` 读 `name`，机械合并会改成坏的；
> PR 那版还会在每个词典里重复插入 rename 键（TS1117，`pnpm typecheck` 必红）。

## 落地内容

两条用户可见能力，都在「文件变动」页的 Git 视角提交栏：

- **✨ 提交信息建议**：读暂存区差异（无暂存则读工作区差异，只有未跟踪文件则只给文件清单），
  截断到 12 000 字符，经宿主 `ctx.get('llm')` 的 `LlmRuntime.stream()` 生成一行 Conventional
  Commits 信息，填进输入框（仍可编辑、可重生成）。
- **Push / Pull**：提交栏底部两个按钮，`git push` 与 `git pull --ff-only`。

## 设计要点

- **路由**：`git.push` / `git.pull` / `git.suggest-message` 三条，与其余 git 路由同样经
  `gitCwdOf` + `selectedRepoOf` 解析目标检出，git 自己的 stderr 原样上报（无 upstream、认证失败、
  分支分叉都是用户去终端解决的问题）。`--ff-only` 是刻意的：无头面板里打开合并编辑器等于把用户
  困住，分叉就必须响亮失败——由 `tests/git-remote-actions.spec.ts` 钉住「HEAD 不动、工作区干净、
  没有 `MERGE_HEAD`」。
- **模型路由取 `Session.requestHeader()`，不扫事件日志**：上游 PR 读 `ctx.sessions.get(id)?.events`，
  而 `Session.events` 自 DSH 0.1.2-alpha.4 起就改名 `snapshotEvents()`，0.2.0-rc.1 更把它标成
  `new calls are prohibited`——照现状落地必走 503。改用增量维护的 `requestHeader()`：
  `EpochHeader.config`（`provider` / `model`）与 PR 从 `request/header` 事件里读的是同一份记录，
  但每次读是 O(新增事件) 而不是整段反扫。`src/context-types.ts` 的 `SidebarSessionStore` 镜像因此
  加了 `requestHeader()`，并给 `snapshotEvents()` 标上 `@deprecated`。
- **消息 source 用本插件自己的 producer kind**：`{ kind: 'plugin:dsh-better-sidebar' }`（复用
  `src/sidechat-routes.ts` 已有的 `MessageSourceMap` 增强）。会话格式 v4 硬拒裸 `plugin` kind，
  而 PR 写的正是 `{ kind: 'plugin', plugin: '…' }`。
- **块装配走宿主自己的 `BlockAssembler`**，与 agent loop / `dsh-session-title-llm` 同一套
  分块算法；并且**读 `assembler.finish`**——`LlmRuntime.stream()` 把适配器/超时失败规范成终结
  `finish` 块而不是抛错，不读它就会把「provider 拒绝了」报成「模型返回了空信息」。
  30s 上限（`AbortSignal.timeout`，与 sidechat create 同一形状）防止挂死的 provider 一直占住请求和
  ✨ 的转圈。
- **提交栏只有一个状态行**：Push/Pull 的失败与 commit/stage/discard 共用既有那条 `actionError`
  （文案前缀区分是哪个动作），没有照搬 PR 的第二条 `remoteError`——这个文件的既有约定就是
  「UI 两个错误通道，各司其职」，提交栏只拥有自己那一条。
- **提交框不置顶**：PR 把提交行搬到面板顶部，动机是当时它被夹在暂存/未暂存列表中间、要滚动才够得着；
  `dev` 的提交栏已经是 `position: sticky; bottom: 0` 的常驻底栏（`changes.module.css` 的
  `.commitBar` 注释写明了这个取舍），那个问题不存在了。改动因此只保留 Push/Pull 行落在栏内，
  且**状态行仍紧贴消息行**（`tests/changes-tab.spec.tsx` 钉住的既成契约）。

## i18n

8 个键（`generateCommitMessage` / `generatingCommitMessage` / `suggestCommitError` /
`suggestCommitEmpty` / `push` / `pull` / `pushError` / `pullError`）沿用上游 PR 的译文，
按 `commit` 键为锚点插入 zh、en 与 19 份第三语言词典。`generatingCommitMessage` 用在
✨ 按钮的 `aria-label` 上：转圈本身对读屏器什么也没说。

## 测试

- `tests/git-remote-actions.spec.ts`（11 例，宿主半区，真 git）：push 真把远端 main 推到本地
  commit；无 upstream 报 `git-error`；pull 快进；分叉拒绝且不留合并现场；建议走暂存差异优先、
  回退工作区差异、仅未跟踪只给文件清单；截断；空改动 `git-suggest-empty` 且不调模型；
  无 header / 无 llm 双 503；provider 终结失败 502 与空回答 500 分开；语言按面板。
  **变异验证**：把 `requestHeader()` 换回 PR 的 `snapshotEvents()` 反扫，5 个用例立刻转红。
- `tests/git-suggest-ui.spec.tsx`（5 例，jsdom）：按钮按是否有改动禁用、调用参数（locale +
  选中的检出）、只填框不提交、`git-suggest-empty` 与 provider 失败文案分开、Push/Pull 的
  调用参数与失败落在提交栏状态行。

## 未做

- 上游 PR 的提交框置顶（理由见上）。
- 上游 PR 未给这两个功能任何测试；这里补齐（见上两节）。
- 未做真机 `dsh web` 挂载验证：本节点的门禁是 typecheck + 全量 vitest + eslint。
