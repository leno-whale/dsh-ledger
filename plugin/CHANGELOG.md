# CHANGELOG

## 0.3.0 — 2026-10-26（本分支交付版本）

修「插件加载了但六条功能全灭」：默认导出补 `inject: ['tools']`，`apply()` 五段各自
try/catch，写完写 `ledger-state.json` 与 `ledger-errors.jsonl`（`type:"load"`）。
新增三个离线 CLI（`tools/status.mjs`、`tools/today.mjs`、`tools/backfill.mjs`）。
收工闸触发条件从「今天没有事件文件」改成「今天账上一笔都没有」，并加 `minIntervalMs`（默认 1h）。
manifest 新增 `kind:"change"`（`source: gate|backfill`），与 `kind:"backup"` 分开计。
注：本版功能范围包含 0.4.x 已落地的 git 证人、跨进程锁、备份清理；版本号按 v0.3 验收表回退为 0.3.0。

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
