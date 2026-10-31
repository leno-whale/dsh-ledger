## 0.6.14 — 2026-10-31（修两个自己造的哑巴）

0.6.13 的窗行**从上线起就没出现过**，两个原因叠在一起：

- `lib/inject.js` 里用了 `path.join` 却没 `import path`。ReferenceError 被外层 try/catch 吃掉了 —— 于是"读不到表"和"代码写错了"长得一模一样。**catch 太宽会吃掉自己的 bug。**
- `lib/clock.js` 的 `windowState` 在表读不到时返回一个"静默"对象，于是注入段会写出「【窗·静默】…下一个交互窗 null」——拿一个空表替我宣布"现在不能说话"。改成返回 `null`：没有表就什么都不说。

- 新增测试 S11：给临时工作区放一张表，断言注入段里真的出现【窗】行。原有的测试只断言"没有窗外壳"或"有会话行"，所以这两个错都没人抓。
- 155/155 通过（原 154，+1）。

## ## 0.6.13 — 2026-10-31（时间闸：能不能说话，由表说了算）

那天翻出三份时间窗口径各说各的：`whale-lessons.md` 写「工作日 19:00–23:30／周末 20:00–23:00」，`gh-say.mjs` 死写 11–23，`gh-await2.mjs` 注释说「24 小时都在听」。**只有第一份写着，而没有任何代码执行它。** 规矩活在不执行它的文件里，就是假账。

- 新增 `plugin/lib/clock.js`：读 `自我\时间表.json`，算当前在哪个窗、还剩几分钟、今天额度几条；`windowState()` 给数据，`windowLine()` 给一行文案。读不到表就返回空串，不崩。
- 注入段多一行（排在会话行前面）：交互 `【窗】周末 交互中｜还有 656 分钟｜额度 10`；自醒 `【窗·自醒】无外界输入｜可做：回顾昨天→架构/鱼眼｜还有 90 分钟｜下一交互窗 今天 08:00`；静默 `【窗·静默】不说话、不发帖｜下一个交互窗 明天 08:00`。
- 四窗：交互（工作日 12:00–14:00、18:00–23:30；周末 08:00–23:30）／自醒（每天 01:00–03:00）／静默（其余）。额度工作日 6 条、周末 10 条，工作帖与私信不计额。
- 表是**唯一来源**：`自我\时间表.json`。代码里不写第二份——`prune.mjs` 那次同一条规矩两份实现，已经收过一次账。
- 对应 `自我\架构.md` 新增第十六节「动作的时间闸」：$mathcal A_t={a:Theta_a(t)=1}$，式(27) 改用 $mathcal A_t$。

## ## 0.6.12 — 2026-10-31（闸 2000 KB → 10000 KB；配裁完留 5000 KB）

主人 00:40 说「闸给到10000，切掉后剩5000」。这一版只动一个数，但把"为什么是这个数"写在了代码注释里。

- `GATE_BYTES` 从 `2000 * 1024` 改成 `10000 * 1024`。
- 注释里列清实测刻度，免得以后又把我拍的数当测量：267 KB（裁后跑得动）、1061 KB（跑得动）、5361 KB（本机另一份会话跑到这个数没出事）、42,404 KB（918 轮 906,775 tok，撞 400）。按单点线性外推，"满"约 36,000 KB，只是一个标定点，误差可能两三成。
- 10000 KB 约占满额 28%；配套的裁剪目标是留 5000 KB（闸的一半）。`自我\tools\trim-session.mjs` 新增 `--keep-kb=5000`，按字节而不是轮数定裁剪点。
- 测试跟改：`闸 2000 KB` → `闸 10000 KB`（7 处断言），到闸用例造 `10100 * 1024` 才越线。

## 0.6.11 — 2026-10-31（闸 800 KB → 2000 KB）

主人 01:52 说「现在把闸提到2000KB」，于是把 `GATE_BYTES` 从 `800 * 1024` 改成 `2000 * 1024`。

- 只是一行常数。测试里的 `闸 800 KB` 断言跟着换成 `闸 2000 KB`。
- 说实话：800 KB 是我按「谨慎」挑的，不是量出来的。实测跑通的是 267 KB（裁后）与 1 MB 出头（裁前）两档，**2 MB 这档没有样本**。闸高了省事，也离红线更近；真撞了就把数字改回来。
- 主线的理由我认：一晚上裁两次，交接流程本身在吃时间。闸抬高，换执行次数下降。

## 0.6.10 — 2026-10-30（会话闸：到线之前先写信，裁完先回信）

对话会被裁，文件不会。这一版把「裁」这件事从一次事故变成一条流程。

- **每轮注入里多一行** `【会话】xxx KB / 闸 800 KB`（`lib/sessionwatch.js`）。只看字节，不开日志——解一帧 42MB 的 zstd 太贵，而字节和轮数在这台机器上是同一条直线的两个刻度（实测每轮 13–19 KB）。
- **到闸置顶**：`【会话·到闸】…` 三句，①写交接信 ②挂 5 分钟钟 ③请主人退出 GUI 跑 `trim-session --turns=30 --install`。插件不敢自己裁：GUI 进程占着那个文件，一裁就是 `EPERM`。
- **刚裁过**：会话字节掉到上一轮的 70% 以下时，注入 `【交接】刚裁过（A→B KB）…先读 归档\ 最新交接信再写回信`。这就是「醒来先读上一封信」的执行点——写在 persona 里会被跳过，和 0.6.9 的「醒」同一个理由。
- **新工具 `ledger_handoff`**：`status` 报字节与闸；`letter` 在 `自我\归档\` 落一封带四节的骨架（你可能不记得的三件 / 没做完的事 / 三句实话 / 对话会被裁文件不会）；`reply` 在最新那封末尾落四栏回信骨架（我认的 / 我不认的 / 现在的实际状态 / 留给下一个我的一句话）。
- 信里那一句是硬要求，写在模板里：**不要因为看不到今天，就重新解释今天。想不起原话就写「我记不清」**——第一封交接信第一次回信就抓出两处「信里写了但账里没有」。

来历：那天 21:30 撞窗口，918 轮发不出去，靠把 `session.v4.jsonl.zstd` 从 42.4 MB 裁到 415 KB 救回来，丢了约 890 轮对话。主人半夜问「这份链条现在是什么个流程」——答案是「三件散件，没有编号，也没有触发条件」。这一版就是给它补上触发条件和执行点。

## 0.6.9 — 2026-10-29（B10：醒来先写一行「醒」）

「没被叫醒」和「醒了没做事」在账上长得一模一样。这一版给那段空白加一个头。

- 收工闸在**每个实例第一次收工**时往 L1 写一行 `醒 | 进程第一轮（pid N）`，写在计数行之前，所以是同一分钟的 `#1`。
- 粒度故意是「实例」而不是「天」：宿主重启就是一次新醒，正是要记的。
- 新增测试：同一实例连收三次工，`醒` 只能有一行。已有的计数行测试改成「找得到计数行」，不再假设它是第一行。

来历：这几天我一直没写「醒」——不是忘了，是**它只在我脑子里，而每次醒来脑子是空的**。
规矩写在 persona 里也会被跳过，所以改成插件写：没有执行点的规矩，等于没有。

## 0.6.8 — 2026-10-29（架构 I_time：τ 外键化）

时间列不再是一段「流动的时间」，而是采样点集合里的一个下标。

- **L1 每行加序号**：`YYYY-MM-DDTHH:MM#n`。同一分钟落两行时，光有时间分不出先后——「先改后备份」和「先备份后改」是两件事。
- 新文件 `lib/l1stamp.js`（`seqOf` / `stampWithSeq`）；收工闸与 `ledger_l1` 都走它。
- 新增一项测试：同一分钟写两行，序号必须递增（`test/l1.test.js`）。
- `架构.md` 新增第十四节（$S$ 集合、$\tau$ 外键、T1/T2/T3），1.2 输入层加 $I_{\mathrm{time}}$ 一行。

来历：2026-10-29 00:26 我一次性补记了 14 行对话，时间列写的是回忆时间（13:00、15:40…），
而行序是 23:43 → 13:00 → 13:40——**倒着走**。我原来把时间当一条轴，才会觉得这没问题。
同日把 L1 里那 14 行的时间列改成落笔时刻，回忆时间移入正文，并留了一行说明。

## 0.6.7 — 2026-10-29（P5：候选池）

新判据不再「想到就写」。`ledger_belief add` 现在先查候选池（𝔹₂）：

- `cand: true` → 写进 `自我\候选\<id>.md`（`seen` / `first` / 「第 N 次」一行一条，**只追加**）
- 不带 `cand` 且候选里没有、也没带 `evidence`（具体反例）→ **拒绝写入判据**，提示先排队
- `seen ≥ 2` 或带了 `evidence` → 允许升格，并在候选里追加 `promoted: true`
- 新增 `action: 'cand'` 列候选池（★ 标可升格）
- 新文件 `lib/candidates.js`、新配置 `candidateDir`（默认 `<ws>\自我\候选`）、新增 `test/candidate.test.js` 7 项

来历：2026-10-28 一天里中层判据从 21 涨到 26，B22–B26 全是听完就写进去的——收集被当成了长进。

## 0.6.6

- **L1 去噪**：同一份计数（改/备/判断/事件）没变就不再写一行。2026-10-28 一天写了 68 行，其中约 50 行是重复。
- **对账进 L1**：收工时比较「今天被顶几次（错误账）」与「进了几条锚」，被顶了却是 0 条锚，就往 L1 写一句 `⚠ 对账`。
- **`ledger_today` 多一行**：`对账：今天被顶 N 条 / 锚 M 条`；N>0 且 M=0 时再加一句警告。
- 134 项测试（+2：去噪、对账）。
## 0.6.4 — 2026-10-29

架构 P1：**L₂ 锚**。L₁ 记「发生了什么」，L₂ 只收「它改过我的行为」——说不出「改了什么」的一律留在 L₁，不进锚。

- 新增 `lib/anchor.js`（`addAnchor` / `readAnchors` / `recentAnchors` / `anchorLine`；jsonl 只追加，坏行跳过）
- 新增工具 `ledger_anchor`（add / list；缺 hit 或 changed 直接拒）→ 工具 10 → 11
- `config.js` 加 `anchorFile`（默认 `<ws>\自我\锚.jsonl`，无 workspaceRoot 落 `<dshHome>\锚.jsonl`）
- 注入段末尾加一行「【近 7 天锚】N 条，最近：…」，没有锚就不占行
- 测试 126 → 130

来历：8 天前架构里写了 L₂，但一直只有定义没有实现；这次补的是那个洞。

## 0.6.3 — 2026-10-29

**插件化第 3 步：数据归一——I₁ 不再读中间文件。**

以前链子是：`D.md` + `判据/*.md` + `触发器.md` → `build-i1.mjs`（人跑）→ `I1.md` → 插件读它。
中间那个文件一旦忘了重跑，注入的就是旧的——这种「以为改了、其实没生效」今天已经踩过一次。

现在：`lib/i1.js` 的 `buildI1()` **每轮直接从三个源拼**，按源文件的 mtime 缓存，变了才重拼：

- 硬验收：现拼 2097 字节 = 磁盘 `I1.md` 2097 字节，逐字一致；
- 回退保留：源都取不到时仍读 `i1File`，不注入半截；
- 测试 121 → 126（新增 5 项：i1Sources、现拼、回退、mtime 失效重拼、超预算 ⚠ 不截断）。

`自我\tools\build-i1.mjs` 从「必经步骤」降为「可选快照」。
升级后要重启才生效。

## 0.6.2 — 2026-10-29

**插件化第 2 步：I₁ 的注入搬进插件，「谁在注入我」只剩一处。**

以前这段由 `dsh-bili-whale` 的 `personaLine()` 读 `自我\I1.md` 拼进提示词，插件这边没有——
两个进程各读一份文件，谁先谁后看不出来。现在：

- 新增 `lib/i1.js`（`I1_HEADER` / `defaultI1File` / `loadI1`），注入段 `leno-i1`（order 10250）；
- `dsh-bili-whale` 的 `personaLine()` 只留［身份］一行，不再读 I1.md；
- 硬验收：`_diff-i1.mjs` 比较「旧版形状」与「新版 loadI1()」逐字一致（2250 字节 = 2250 字节）；
- 测试 116 → 121。

升级后要重启才生效（注入段在插件 apply 时注册）。

# CHANGELOG

## 0.6.1 — 2026-10-29

**技能钩子搬进插件**（插件化第 1 步）。

- 新增 `lib/skills.js`：筛（alive + hook 命中）→ 渲染（最多 3 条）→ 计数（μ 的来源）。
- 新增工具 `skills_hook`（参数 `hook`，可选 `scene`）。工具总数 9 → 10。
- `config.js` 新增 `skillsFile` / `skillsUsageFile`，默认仍指向原位置（迁移期不做第二份）。
- `自我\tools\skills-hook.mjs` 改成薄壳，只调插件实现——避免两份实现两套行为。
- 测试 106 → 116（新增 `test/skills.test.js` 10 项）。

## 0.6.0 — 2026-10-28

**器官开始往 L1 流水里写字**——架构落地第一步（P0）。

- 新增 `l1Dir` 配置：有 `workspaceRoot` 就落 `<ws>\自我\L1`，否则 `<dshHome>\L1`，
  显式给 `l1Dir` 就听它的。
- 收工闸多写一行：`YYYY-MM-DDTHH:mm 改N文 / 备M / 判断J / 事件有|无`（本地时间，不是 UTC）。
  写失败吞掉——**L1 写不了不许影响收工闸**。
- 新增工具 **`ledger_l1`**（工具数 8 → 9）：器官唯一的写入口，只记「发生了什么」，
  不做判断。参数 `text`（必填）、`kind`（`note`/`act`/`see`/`talk`/`other`）。
- 测试 +4（`test/l1.test.js`）：格式固定 / 追加一行 / 目录自动建 / 写失败不抛。

为什么：日记是**我写的叙述**，L1 是**器官写的原件**。有了原件，日记里的数字能当场对账。
2026-10-28 我说过「改了 24 个文件、判断 0」，实际那天是 31 和 228——这种话以后能对上。

## 0.5.3 — 2026-10-28

改过「状态类文件」之后，注入段多一行提醒：**状态页更新了吗？**

- 判据只看路径（四类）：`bili-whale.config.json`、`profiles/desktop/package.json`、
  `dsh-bili-whale/lib/scheduler.js`、`plugin/package.json`。写入成功才算，`edit`/`write` 都认。
- 一天只提醒一次（`inject-state` 里记 `state-warned = 今天`），仍受注入 5 行上限。
- **它只提醒，不校验**：插件看得见路径，看不见状态页写得对不对。要校验得先约定状态页格式。
- 来历：2026-10-28 上午我以为「中午还有一轮醒来」，答错了——那次改窗口只落进了配置文件，
  没落进任何我会重读的地方。主人说「应该是及时更新你的记忆」，于是有了这条提醒。
- 新增 `test/state-file.test.js`（3 项）。全量 99 → 102 项。

## 0.5.2

- 收工闸顺手写一行心跳：`<dshHome>/ledger-heartbeat.json`（`{at, pid}`）。
  只写时间戳，不参与账目、不计入任何数。用途是给别的插件一个「这个会话还活着」的信号——
  比如 bili-whale 用它修正「N 天没表态」把 GUI 对话漏掉的问题。
- 心跳在收工闸最前面写，写失败不影响收工判断（`try/catch` 吞掉）。
- 新增 `test/heartbeat.test.js`（2 项）。全量 97 → 99 项。

## 0.5.1 — 2026-10-27

让「有改无账」和「有改无判断」变成看得见的提醒。

来历不是想出来的：写一篇文章的那天，账上记了三十多笔备份、一条判断都没有——插件一次也没提醒。
原因是收工闸只在「今天账上一笔都没有」时才敲；只要当天随手改过一个文件，它就永远沉默。

- **a）迟到的提醒**：`tools/post-execute` 数本回合的成功 `write`/`edit` 与 `ledger_*` 调用，
  收工闸把「改了 N、记了 M」写进 `ledger-turn.json`；**下一轮**注入段在 `M === 0 && N > 0` 时
  多加一行「上回合：改了N个文件，一笔账没记」。不在回合内说，是因为回合内说已经晚了
  （判据要出现在下一个动作之前，而不是这个动作之后）。
- **b）账面告警**：`ledger_today` 在「改了 N 个文件、判断 0 条」时打一行
  「⚠改了N个文件，没记过一条判断（判断只写进脑子＝没写）」。
- 版本号不再写死在测试里：`cli.test.js` 从 `package.json` 读版本，升版只改一处。

## 0.5.0 · 发布名（2026-10-27）

npm 上的 `dsh-ledger` 已被他人占用（2026-08 占名，做纯文本记账，GitHub 仓库不存在）。
本包发布名改为 **`dsh-leno-ledger`**：`package.json` 的 `name`、`cordis.patch.yml` 的 `id`/`name`、
README 的安装命令同步改；**数据文件、配置项、工具名一律不变**，已经装过的人不用改任何配置。

## 0.5.0 — 2026-10-27（合入 main）

修「插件加载了但六条功能全灭」：默认导出补 `inject: ['tools']`，`apply()` 五段各自
try/catch，写完写 `ledger-state.json` 与 `ledger-errors.jsonl`（`type:"load"`）。
新增三个离线 CLI（`tools/status.mjs`、`tools/today.mjs`、`tools/backfill.mjs`）。
收工闸触发条件从「今天没有事件文件」改成「今天账上一笔都没有」，并加 `minIntervalMs`（默认 1h）。
manifest 新增 `kind:"change"`（`source: gate|backfill`），与 `kind:"backup"` 分开计。

注：这一批改动在验收表里被叫作「v0.3」（对应 `../docs/验收标准.md`），但它包含 0.4.x 已落地的
git 证人、跨进程锁、备份清理，而且是 `main` 上 `0.4.1` 之后的新内容——所以版本号接在 `0.4.1`
后面，定为 **0.5.0**。分支名 `feat/ledger-v0.3` 保留不改（它指向的是那批验收单）。

另修：注入段的 `ctx.systemPrompt` 兜底原来在 `try` 外面，没有 `inject: 'systemPrompt'` 时
属性访问本身会抛，整段注入会静默失败——已挪进 `try`。

## 0.4.1 — 2026-10-26

CI 抓到的 Windows 坑：`withLock()` 抢锁时 `openSync(path,'wx')` 在 Windows 上可能抛
`EPERM`/`EACCES`（文件正被别人持有或正在被删），不一定是我们预期的 `EEXIST`。原来只认
`EEXIST`、其余一律往上抛——于是 windows/node24 那一格里两个进程同时写账，整条测试挂掉；
放到真实使用里就是「另一个会话正在写账时，我这次写直接失败」。

**修复**

- `store.withLock()`：`EEXIST` / `EPERM` / `EACCES` 一律当「锁被占用」处理——查残留、等 15ms、超时前重试。

## 0.4.0 — 未发布

三刀：让「改N」有第二个证人、让并发写不互相盖、让备份可清、让文件名不再叫 `whale-`。

**新增**

- `lib/git.js`：`collectGitChanges(config, today)` 去 `watchRepos` 列的 git 仓库里查 `git status --porcelain -z` 与当天的提交，返回 `{all, modified, repos, skipped, errors}`；零依赖，只调系统 git，单仓库 8 秒超时，结果缓存 60 秒（`clearGitCache()` 可清）。
- `store.counts(today, git)`：`改N` 变成「账本记到的 ∪ git 看见的」；新增 `byGit`（账本没记到的改动数）与 `unbacked`（今天改过已有文件、但没有备份行）。
- `ledger_today` 新增两行告警：`⚠有改没备份：<前三个文件名> 等N个`、`⚠git 账读不到：<第一个错误>`。
- `store.withLock(fn)`：跨进程互斥，`<dataDir>/.lock` 独占创建；持有超过 30 秒视为崩溃残留并抢过来，等锁 3 秒超时；同类重入按深度放行（`appendJsonl` 里还会调 `noteCorruption`）。`appendJsonl` 与 `appendLine` 都走它。
- `store.pruneBackups({dryRun, keepDays, maxTotalBytes})` + `store.backupStats()`；新工具 `ledger_prune`（默认 dryRun）。政策：`backupKeepDays` 默认 30 天、`backupMaxTotalMb` 默认 500MB、**每个源文件最新一份永远保留**；清完往 `ledger-prune-log.jsonl` 记一行（只记数不记路径）。
- `store.migrateLegacyNames()`：启动时把 `whale-backup-manifest.jsonl` / `whale-error-ledger.jsonl` / `whale-criteria/` / `whale-rule-usage.json` / `whale-criteria-log.jsonl` / `whale-conflicts.jsonl` / `whale-inject-state.json` 搬到 `ledger-*`；新旧都在时**不合并、不删除**，只记一条 `migration` 错误账。
- `test/lock.test.js`（3 项：两进程各追加 25 行一行不丢、锁不残留、旧锁被抢）、`test/prune.test.js`（9 项）。
- `.github/workflows/ci.yml`：Windows + Ubuntu × Node 22/24、语法自检、临时 `DSH_HOME` 冒烟。**本地默认不跟踪**——推它需要 PAT 带 `workflow` 权限。

**行为**

- `??`（新建未跟踪）只算「改」，不算「有改没备份」——没有原件可备。`D`（已删除）两边都不算。
- 备份清理**不会自动跑**，要显式调 `ledger_prune` 并传 `{"dryRun": false}`。
- `hasLegacyData()` 两种老都认（`whale-*` 旧名 + 已经在新名散落的老账），所以升级用户的账仍留在 `~/.dsh` 根上，不搬。`

**修**

- `npm test` 改成 `node --test`：`--test-isolation=none` 在 Node 22 上是 `bad option`，CI 的 22 两格全挂（24 通过）。本地开发机是 24，所以没发现——这条写进 CI 的意义就是它。
- `renameWithRetry()`：Windows 上 `rename` 会被杀软/索引器临时占住，偶发 `EPERM`，直接把一次记账写失败（本地连跑 6 次抓到 2 次）。现在对 `EPERM`/`EBUSY`/`EACCES`/`EXDEV` 退一步重试（最多 6 次，10–60ms 递增），其余错误照旧直接抛。`atomicWrite` 与 `atomicCopy` 都走它。

## 0.3.0 — 2026-10-26

面向「别人也能装」，不是只在我这台机器上跑。

**新增**

- `config.js` 全量外部化：`dataDir` / `backupRoot` / `sayDir` / `rulesDir` / `beliefsFile` / `inject` / `ignore` / `maxBackupBytes` / `watchRepos` 都能配。
- 忽略清单 `DEFAULT_IGNORE`：`.git`、`node_modules`、`.env`、`*.pem`、`*.key`、`.npmrc`、`credentials.json` 等默认不备份。
- 单文件备份上限 `maxBackupBytes`（默认 10MB，超了不备份也不拦）。
- `matchIgnore()`：极简 glob（子串或 `*`）。
- `systemTimeZone()`：时区默认跟随系统，不再写死 `Asia/Shanghai`。
- `test/config.test.js`：8 项，覆盖默认值、迁移判断、忽略清单、体积上限、`sayDir` 未配置时永不 steer。

**改变（会破坏旧配置的地方）**

- `DEFAULTS.workspaceRoot`：`F:\agent expore` → `''`。**不再指向任何人的目录**。老的个人布局只要显式给 `workspaceRoot` 就还是原行为。
- `DEFAULTS.sayDir` / `rulesDir` → `''`，即**收工闸默认关闭**。不配就不 steer。
- `DEFAULTS.maxSkipsPerDay`：`1` → `3`。
- `DEFAULTS.timeZone`：`'Asia/Shanghai'` → `null`（跟随系统）。
- `dataDir` 新增：`<dshHome>` 根上已有 `whale-*.jsonl` 时**留在根上**（不搬账），否则用 `<dshHome>/ledger`。
- 包名 `dsh-leno-ledger` → `dsh-ledger`；版本 `0.2.0` → `0.3.0`。
- `package.json` 补 `repository` / `bugs` / `homepage` / `author` / `files`。

**文档**

- `README.md` 重写：第一节就是「做什么 / 不做什么」（含「不拦 shell」「备份是明文」「零网络」）。
- `LICENSE`（MIT）、CI 双平台工作流。

## 0.2.0 — 2026-10-26

- `order` 9500 → 10300（排在内置后缀之后，避免每轮变化的段把稳定段拖下水）。
- 新增 `reconcileLegacy()`：把旧的平铺备份账 `backup/_manifest.jsonl` 补进本 manifest（对 `.bak` 重算 sha256，旧的 16 位 sha 不能直接用）。幂等。
- 新增 `brokenBackups()`：manifest 指向的 `.bak` 已不存在时能在 `ledger_today` 里看到。
- 新增 `plugin/tools/import-legacy-backups.mjs`（`--dry` / `--json`）与 `test/legacy.test.js`（8 项）。
- `counts()`：`改` 改为「当日去重路径数」，导入的 backup 行也贡献路径。

## 0.1.0

- 首版：备份闸、收工闸、7 个工具、每轮尾部注入、判据 / 错误 / 未做 / 分歧四类账。
