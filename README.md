# dsh-ledger

账房 —— 给 DeepSeek Harness 用的本地账本插件：**改文件前先备份、发帖前先给依据、收工对账**。

- 插件本体与使用说明：**[`plugin/README.md`](plugin/README.md)**
- 变更记录：[`plugin/CHANGELOG.md`](plugin/CHANGELOG.md)
- 许可：[MIT](plugin/LICENSE)

```
plugin/         发布物（npm 包 dsh-ledger，Node >= 22，零依赖零网络）
_probe/         开发期用的一次性探针（从宿主 asar 抽的接口样本、核对脚本）
.github/        CI（Windows + Ubuntu，Node 22/24）
*.md            设计与验收文档（技术报告、验收标准/结论、审核与复核意见）
```

## 一句话

它不判断对错，也不替你决定。它只做一件事：**让你事后能查「我到底改了什么、说过什么、又没做什么」**，并且在模型准备动一个已存在的文件之前，先留一份原件。

## 边界（重要）

只在模型级 `write` / `edit` 上拦；`pwsh`、`Set-Content`、node 脚本这类 shell 写入**不经过它**。备份是明文副本。零网络、零遥测。
