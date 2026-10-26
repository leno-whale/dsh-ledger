# dsh-leno-ledger（账房）v0.5

给 DeepSeek Harness 用的本地账本插件：**改文件前先备份、下判断前先给依据、收工对账**。
零依赖、零网络、只写本地文件。

> **名字说明**：npm 上的 `dsh-ledger` 是另一个人的包（纯文本记账，2026-08 占的名），跟这个不是一回事。
> 本包发布名是 **`dsh-leno-ledger`**；仓库仍叫 `dsh-ledger`。

> ## ⚠️ 升级后请先重启一次 DSH
>
> 插件的工具、备份闸、收工闸是在 **DSH 加载插件时** 注册的。已经开着的会话不会热挂这些能力——
> 在这条旧会话里改文件，账本仍然不会动。**重启 DSH 后新会话才受保护。**
>
> 装完先跑自检（不需要模型）：
>
> ```powershell
> node plugin/tools/status.mjs
> ```
>
> 看到 `segments: tools=ok guard=ok injection=ok turnStopping=ok postExecute=ok` 才算真的加载了；
> 任何一段 `FAIL`，状态文件 `~/.dsh/ledger-state.json` 和 `~/.dsh/ledger-errors.jsonl` 里都有原因。
> 退出码：全 ok 为 0，否则为 1，可直接进脚本/CI。

## 它做什么

| 功能 | 行为 |
|---|---|
| 备份闸 | 模型调用 `write`/`edit` 改**已存在且非空**的文件前，先复制一份到 `~/.dsh/backup/<YYYY-MM-DD>/<名>.bak`，并在 `ledger-manifest.jsonl` 记 `change` + `backup` |
| 记账 | `change` / `backup` / `create` / `judge` / `error` / `conflict` 各记一行；只追加，不覆盖 |
| 收工闸 | 回合将结束时检查「**今天账上一笔都没有**」（改/备/判断/错误/冲突任一即算有）；没有就用 `agent.steer()` 塞一条下一步提醒，同一轮最多一次、两次之间默认隔 1 小时 |
| 判断依据 | `ledger_judge` 强制四问（谁在收/几个人在看/报坐标还是接论点/原话还是复述）并显式写规矩 id，计入引用率 |
| 每轮注入 | 系统提示尾部一段（order 10300）≤5 行：今日改/备、未做、0 引用规矩；没有内容时返回空串，整段消失 |
| 离线对账 | 三个 CLI，不依赖模型上下文，工具挂了也能算账、补账 |

## 安装 / 升级

要求：Node.js ≥ 22（用 DSH 自带的 Node 也行），Windows / macOS / Linux。

```powershell
# 从本地目录安装（开发/自用）
dsh plugin --profile desktop add "link:F:\path\to\dsh-ledger\plugin"

# 或从 npm
dsh plugin --profile desktop add dsh-leno-ledger
```

装完 **重启 DSH**，再跑 `node plugin/tools/status.mjs` 自检。

升级 = 覆盖安装后重启；数据文件不迁移、不删除。v0.3 起旧 `whale-*` 账名会在启动时自动改名为
`ledger-*`（只改插件自己的账；`whale-beliefs.md` / `whale-beliefs-log.jsonl` / `whale-undone.jsonl`
是你自己的本子，保持原名）。

### 配置（可选）

在 DSH 的插件配置里传对象；都有缺省值：

```jsonc
{
  "dshHome": "C:\\Users\\<你>\\.dsh",   // 默认 ~/.dsh（或环境变量 DSH_HOME）
  "dataDir": "",                         // 默认 ~/.dsh/ledger；已有老账时留在 ~/.dsh 根上
  "workspaceRoot": "",                   // 给了才推导 <root>/接口/说、<root>/接口/规矩
  "sayDir": "",                          // 发帖记录目录；空＝不提示、不检查
  "rulesDir": "",                        // 规矩目录；空＝规矩全集只含用过的 id
  "autoBackup": true,                    // true=先备份再放行；false=无备份就硬拒绝
  "maxSkipsPerDay": 3,                   // ledger_error skip_check 每日上限
  "minIntervalMs": 3600000,              // 收工闸两次提醒的最小间隔
  "timeZone": null,                      // null=系统时区；如 "Asia/Shanghai"
  "inject": true,                        // 关掉后只能用 ledger_today / today.mjs 手动查
  "watchRepos": [],                      // git 仓库根列表，供 ledger_today 的「改N」和 backfill 用
  "maxBackupBytes": 10485760,
  "backupKeepDays": 30,
  "backupMaxTotalMb": 500,
  "ignore": [".git", "node_modules", ".env", "*.pem", "*.key"]
}
```

## 三个离线 CLI

都在 `plugin/tools/` 下，只用 node 内置模块；`--home` 可指向别的账本目录（测试/多份账本），
`--workspace` 覆盖 workspaceRoot，`--now <ISO>` 可按指定时刻复算。

### `status.mjs` — 能不能用

```powershell
node plugin/tools/status.mjs
node plugin/tools/status.mjs --json
```

打印：①模块能否 import ②`ledger-state.json` 是否存在及五段状态 ③最近一条账 ④备份文件数
⑤今日「改N 备M …」。全 ok 退出 0，否则 1。

### `today.mjs` — 纯文件复算今天那一行

```powershell
node plugin/tools/today.mjs
# 改3 备3 | 判断1 记0 | 冲突0 | 今日事件：无
```

与 `ledger_today` 工具首行走同一个函数（`lib/today.js`），不会两处口径漂移。

### `backfill.mjs` — 补「改了但没备份」

扫 `watchRepos` 里今天 git 看得见的改动（未提交的 `status` + 今天提交过的文件），
挑出**已存在、今天没有对应备份**的文件，补 `backup` + `change(source:"backfill")`。

```powershell
node plugin/tools/backfill.mjs --repo F:\work\proj            # 默认 dry-run，只打印将补清单
node plugin/tools/backfill.mjs --repo F:\work\proj --apply    # 真写
```

幂等：同 path + 同 sha256 + 同一天已备过就跳过。新建/未跟踪文件没有原件，不补。
`git` 不在 PATH、目录不是仓库时只提示并跳过，不算失败。

## 数据格式

默认 `~/.dsh/ledger/`（已有老账则留在 `~/.dsh/` 根上）；备份固定放在 `~/.dsh/backup/`：

| 文件 | 内容 |
|---|---|
| `ledger-manifest.jsonl` | 每行 `{t, kind, path, sha256?, size?, mtime?, backup?, source?, imported?}`；kind ∈ `change`/`backup`/`create`/`retired` |
| `ledger-errors.jsonl` | `{t, type, text, source, level, ref}`；type ∈ `error`/`skipped-check`/`corrupt`/`load`/`migration` |
| `ledger-conflicts.jsonl` | `{t, topic, a, b, ...}` 分歧账，只追加 |
| `ledger-criteria-log.jsonl` | 每次判断/新增/退休一行；`event` 缺省=judge |
| `ledger-rule-usage.json` | `{ "<规矩id>": { n, last } }`，显式引用计数 |
| `ledger-criteria/<id>.md` | 判据正文；退休写 `- retired: true` + `- successor:` |
| `ledger-inject-state.json` | 注入去重（文本 hash → 最后注入时间） |
| `ledger-state.json` | **加载状态**：`{version, loadedAt, pid, segments:{tools,guard,injection,turnStopping,postExecute}}` |
| `backup/<日期>/<名>.bak` | 明文备份；同名内容不同依次 `-2.bak`、`-3.bak` |

所有写入都是「同目录 tmp → fsync → rename」；坏行跳过并记一条 `corrupt`，不会让整个文件读不出来。

## 已知限制（诚实清单）

- **只拦模型级 `write`/`edit`**。`pwsh`、`Set-Content`、node 脚本、`multi_edit`（本版本没有这个工具）
  这类写入不经过备份闸；`backfill.mjs` 只能事后补，拦不住当场。
- **旧会话不热挂**。必须重启 DSH；这是宿主生命周期决定的，插件无法在已存在的会话里补注册工具。
- **收工闸的 steer 行为只在 mock 里验证**：源码上 turn-stopping 监听者 `steer()` 会让回合再走一步，
  但没在每一条真实会话里逐一实测；若宿主行为变化，闸可能不响。响了也只提醒，不阻止回合结束。
- **判断四问是「填了没有」，不是「填得对不对」**。它不判断内容对错（这是设计边界）。
- **错误账不会自动结清**：`type:"error"` 的行永远计入 `⚠错误N`，需要人工处理/清理。
- **引用率只统计显式写规矩 id 的判断**，不写 `rule` 的判断不算引用；不能当「这条规矩有没有用」的唯一证据。
- **注入可能打断上游缓存**：段在尾部（order 10300）且内容每轮可能变，是否影响缓存未实测。
- **备份不加密、不清理旧内容**（默认按 30 天 / 500MB 清理，可关）；密钥类文件默认在 `ignore` 里。
- **git 只是证人，不是保险**：`backfill` 依赖系统 git，仓库外/未提交历史之外的改动它看不见。
- **`ledger_today` 的「改N」包含 git 看见的改动**；没配 `watchRepos` 时只数账本自己记的。

## 卸载

```powershell
dsh plugin --profile desktop remove dsh-leno-ledger
```

卸载只移除插件注册，**不删数据**；要清账自己删 `~/.dsh/ledger/`（或根上的 `ledger-*`）与 `~/.dsh/backup/`。

## 目录

```
plugin/          发布物（lib/、tools/、cordis.patch.yml、package.json）
plugin/tools/    三个离线 CLI
docs/            先读这三份：设计说明 / 验收标准 / 验收结论（索引在 docs/README.md）
_probe/          开发期一次性探针（不发布，不进 git）
```

许可：[MIT](plugin/LICENSE)
