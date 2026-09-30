# ZCode 3.14.3 实时会话索引补丁

本项目修复已进入持久会话库的外部 CLI 会话，在有效摘要送达 Desktop Host 后，未能建立本地任务索引归属、分组位置和列表变更通知的问题。它提供一份上游源码补丁，以及针对一个精确 Windows 构建的可移植 Apply/Rollback 工具。

**把文件夹复制进安装目录不会自动生效。** 可移植路径需要执行 Apply，原子替换匹配的 `resources/app.asar`，然后重新启动 ZCode。源码路径则需要对精确上游基线应用补丁并构建。

## 两条使用路径

| 路径 | 用途与修改范围 | 前置条件 |
| --- | --- | --- |
| 可移植冻结 Host 补丁 | 面向已有 Windows 安装；只替换 `resources/app.asar` 中的 Host 索引入口。EXE、CLI 与旁边的 unpacked 资源保持原样 | 下文列出的精确 3.14.3.7762 构建；Node.js 24.14.0 或更新版本；Windows PowerShell |
| 上游源码补丁 | 面向开发者；10 文件补丁覆盖 CLI 外部 SQLite 索引失效与 v4 投影/发布、Desktop TaskIndexSyncer 和测试 | ZCode v3.14.3 的精确 Git 提交；Git、pnpm 10.33.2、Node.js 与上游构建依赖 |

可移植工具不需要 npm install、源码 checkout 或自动下载。它不会把源码补丁现场编译成任意安装版本，也不会修改安装里的 `resources/glm/zcode.cjs`。两条路径分别验证：源码代码和冻结编译产物的接口不同，不能互相替代验收结果。

## 快速使用可移植补丁

1. 准备 Node.js **24.14.0 或更新版本**，确认 `node.exe` 在 PATH 中。工具使用 Node 内置模块和系统 Windows PowerShell；它不下载 Node 或任何依赖。
2. 解压完整补丁包，把 **zcode-patch 文件夹**放在 ZCode 安装根目录，与 `ZCode.exe`、`resources` 并列。
3. 关闭该安装的 Desktop 和 CLI。双击 `zcode-patch/Apply.cmd`；成功后重新启动 ZCode。工具发现进程仍运行会拒绝操作，不会强制结束进程。
4. 需要还原时关闭同一安装的进程，双击 `zcode-patch/Rollback.cmd`。

目录应为：

```text
<ZCode 安装根目录>/
  ZCode.exe
  resources/
    app.asar
    app.asar.unpacked/
    glm/zcode.cjs
  zcode-patch/
    Apply.cmd
    Rollback.cmd
    Invoke-ZCodePatch.ps1
    portable/
    verification/
    ...其余发布文件
```

中文和空格路径已在独占临时安装中验证；不依赖调用者当前目录。只支持普通本地盘路径；拒绝链接、junction、reparse point 和 device/UNC 路径。

执行前可做无写预检，把示例根目录替换成实际位置：

```powershell
$InstallRoot = 'C:\Apps\ZCode'
$PatchScript = Join-Path $InstallRoot 'zcode-patch/Invoke-ZCodePatch.ps1'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PatchScript -Mode Apply -CheckOnly
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PatchScript -Mode Rollback -CheckOnly
```

CheckOnly 不创建备份、stage、锁或日志。cmd 入口的执行策略只作用于子 PowerShell 进程，不修改系统或用户全局策略。Apply/Rollback 在目标状态已满足时保持幂等。

### 备份与回滚

Apply 首次运行时，把经过验证的原件保存在 `resources/.zcode-patch-backup/original.asar`，不覆盖已有备份。工具在同一卷生成 stage，核对候选、进程、输入和备份后调用 `File.Replace`，再验证最终哈希。替换后的验证失败会原子恢复本次操作前已验证的 archive；临时 stage 会清理。

旁边的 `app.asar.unpacked` 保持原样。若运行在清理前被中断，可能留下 stage 或锁；先检查原因，不要把这些文件当成 verified original backup。

**如果安装已是精确 Review7，但没有本工具的原件备份：** Apply 会准确报告已应用，不会把 candidate 保存成“原件”。Rollback 及其 CheckOnly 会拒绝。只有用户显式把另行保留、哈希为下表 D836… 的正确原件放到上述 backup 路径，才能恢复。工具不搜索历史机器上的备份目录；不能从 Review7 candidate 推导或恢复原件。

## 精确版本与哈希门禁

可移植路径只接受一个冻结的 Windows x64 ZCode **3.14.3.7762** 构建。同版本号的另一 build 也不兼容。原 archive、Host、EXE、CLI、伴随索引/schema/worker/build metadata 和两个 byte-span payload 都有固定门禁。

| 文件/产物 | 字节数 | SHA-256 |
| --- | ---: | --- |
| 原始 app.asar | 326,915,059 | D8367E6391EBA78892330BEF7F04866C3CF495FAECB884DCA852D437706FCF4C |
| 原始 out/host/index.js | 1,497,917 | A339D8142ED19ABFBAB75AF6F8464D98C95042CA87C0B129D2E6300F12D39899 |
| Review7 Host | 1,499,553 | 54DEFA873C82EC6CDEF229760B57F5448EA08365C922ACD977F0C1E52C6B0EA2 |
| Review7 app.asar | 328,414,612 | 6DC53E173881742BDD86EF9E8565D131568B13F78DB72E1C0B338F16C9E139FD |
| ZCode.exe | 精确哈希校验 | A21B8D878F7B969C34AEE965A31070A7AE234866A46F953C8317C8C5A86CB6B0 |
| resources/glm/zcode.cjs | 精确哈希校验 | DDAD7BD6AE4A2239FDAB8E54484E803AFCE8D3DDCFA94C23BB32DDAB11147175 |

未知哈希会停止；工具不会猜测偏移、放宽版本或下载另一份应用。原 archive、EXE、完整编译 Host、用户会话和部署日志都不随包发布。

## 处理链与已修复问题

源码路径的数据链是：SQLite session store 的外部写入失效信号 → CLI sessions-index 投影/发布 → workspace v4 summary → Desktop Host TaskIndexSyncer → 现有 TaskIndexRepo 与 grouped order → workspace task-list 通知。UI 消费已有状态和通知，不增加另一套持久状态权威。

本次针对这些边界修复并添加回归：

- 新 store-only 会话的有效标题摘要可通过现有 insert-if-missing 建立索引和归属；不需要依靠当前 Desktop runtime 的 active SessionRecord 才能补齐缺行。
- 使用 `inFlight/pending/admitted` 防止并发重复，并在成功 seed 后 grouping 或读取失败时保留进度。下一帧可重试，连重试的初次读取再次失败也不会把自己的已插入行误认为“原有本地行”而永远漏掉分组/通知。
- 同一帧同时发生终态迁移和首个有效标题时，terminal 分支也补齐 membership；标题变化时仍允许恢复 pending admission。
- 已有本地 title override、status、model、mode、unread 和 pin/archive/tombstone 状态由 Repo 保持权威，不把旧摘要整行写回，不复活已删除任务，不重复改变已存在的分组顺序。
- lint reproducer 传播实际子进程退出码；安装工具增加精确门禁、无写预检、正确原件备份、幂等和原子失败恢复。

源码通过 TaskIndexRepo **公开 API**工作，不调用私有 `getTaskRow`，也不假设 `ZCodeTaskMeta` 包含 SQL raw flags。源码 pin race 中，新插入任务并发被 pin 后仍在公开任务列表里可见，并广播一次 task_created；冻结 Review7 helper 则保留其编译 Repo 的 raw-row pin/archive eligibility 裁决。这是两条接口路径各自验证的行为，不是把编译 helper 直接复制进源码。

冻结 archive 的重建使用两个小文本 byte spans 和内置 ASAR parser；保留非 Host header、30,165 个 entries、既有 packed payload 和 unpacked 引用，仅追加精确 Review7 Host 并更新其 header/integrity。独立 ASAR verifier 对这些不变量再次核对。

## 当前验证与不足

已实际验证：源码精确 base apply/10 文件对照、真实 TaskIndexRepo 与 provider-free v4 的 9 个测试、相关 TypeScript 目标、两个独立进程的合成 SQLite 失效传播、冻结 Host 的 17 项检查、ASAR 独立 gate，以及 Temp 安装的 12 项 Apply/Rollback/拒绝/故障恢复/CMD 测试。fresh Git checkout 测试覆盖 raw index bytes、SHA 清单和行尾策略，`core.autocrlf=true` 下仍保持原始字节。

仍有这些边界：

- **未运行真实安装 Apply/Rollback、真实 Desktop GUI/provider 或完整端到端侧栏时序。** 安装操作和 CMD 回归在复制到 Temp 的独占安装中执行；合成测试不证明每种真实 provider、网络路径或 GUI 刷新时序。用户 Apply 后仍需实际启动核对自己的运行环境。
- 外部摘要已送达 Host 后的 membership 修复，不等于证明任意 CLI/runtime 的写库时机与 Desktop delivery 都已通过真实端到端验证。可移植路径不修改 CLI 文件。
- 可选 isolated Host smoke 需要 PowerShell 7、精确 product inputs、匹配 unpacked 资源与官方 Electron 41.0.3 Windows x64 ZIP。工具的 JavaScript API guards 是进程内 instrumentation，不是 OS 级隔离，不能证明 native/OS 网络完全被阻断。本交付没有把 optional Host boot 标记为已通过；完整准备与同一 RunId 的 Preflight→Host 命令见[英文说明](README.md#optional-isolated-runtime-smoke)。
- **上游 lint 诊断尚未清理：4 个 max-lines errors、7 个不必要 spread/fallback warnings；reproducer 内外退出码均为 1。** 当前未发现这些诊断对应已知功能或明显性能问题；核心文件拆分范围较大，留作后续维护重构。本项目没有宣称 lint 全部通过，也没有用重构混入本次行为修复。
- 只支持一个冻结 build；不提供其它版本自动适配、依赖下载或没有原件时的回滚。权限不足、文件占用或进程检查失败会拒绝。

## 开发者复现源码路径

上游：[zai-org/ZCode](https://github.com/zai-org/ZCode)。精确 base：`29628c9acdb81b703bbd4080c207a0e7ce5e276e`。准备 Node.js 24.14.0 或更新版本、Git、pnpm 10.33.2 和上游依赖。以下路径都由使用者指定；在可丢弃 checkout 中执行：

```powershell
$Package = '<补丁包绝对路径>'
$Source = '<临时ZCode源码目录>'
git clone https://github.com/zai-org/ZCode.git $Source
git -C $Source checkout --detach 29628c9acdb81b703bbd4080c207a0e7ce5e276e
$SourcePatch = Join-Path $Package 'zcode-v3.14.3-live-session-index.patch'
git -C $Source apply --unidiff-zero --check $SourcePatch
git -C $Source apply --unidiff-zero $SourcePatch
node (Join-Path $Package 'verification/upstream/verify-zcode-patch-against-base.mjs') --source-root $Source
Set-Location $Source
pnpm install --frozen-lockfile
pnpm run build:bootstrap
pnpm --dir apps/zcode-cli build
node --import tsx --test packages/services/test/zcodeTaskIndexSyncerLiveMembership.test.ts
node node_modules/typescript/bin/tsc -b packages/shared packages/rpc packages/services --pretty false
node (Join-Path $Package 'verification/repro/repro-sessions-index-cross-process.mjs') --source-root $Source
node (Join-Path $Package 'verification/repro/repro-oxlint-cli-scope.mjs') --source-root $Source
# 上一条的已知 lint 基线退出码为 1；不要当成全通过。
```

冻结 Host 的 AST patcher/独立 ASAR 复现还需要源码环境中的 TypeScript 6.0.2 和 @electron/asar 3.4.1，以及只读冻结输入。便携 Apply 自身不需要这两个 npm 包；详见[英文精确输入与复现步骤](README.md#reproducing-the-review7-host-candidate)。

## 包完整性与专项回归

`package-files.sha256` 对除它自身以外的发布文件记录原始字节 SHA。包内 `.gitattributes` 保留 `* -text`：普通文本 LF、cmd CRLF，cmd 使用 `whitespace=cr-at-eol`。**不要编辑、格式化或转换 payload、发布文件的编码/行尾**；`portable/review7-spans.json` 还受固定哈希门禁约束。

以下两个检查会把输入复制到新 Temp 目录，不对输入 EXE/CLI 的真实安装执行 Apply。checkout 检查只在 Temp 创建 fixture Git commit，不修改补丁仓库或其它源码仓库的 Git 配置：

```powershell
$Package = '<补丁包绝对路径>'
$Original = '<D836原始app.asar的只读副本>'
$Exe = '<匹配的ZCode.exe>'
$Cli = '<匹配的resources/glm/zcode.cjs>'
node (Join-Path $Package 'portable/test-portable.mjs') --original $Original --exe $Exe --cli $Cli
node (Join-Path $Package 'portable/test-checkout-bytes.mjs') --original $Original --exe $Exe --cli $Cli
```

## 许可证

上游源码补丁和 ZCode 派生 patch material 使用随包的 `LICENSE-APACHE-2.0`。本项目原始打包、验证工具与文档使用 `LICENSE-MIT`（2026 Contributors）。混合文件内的 ZCode 派生部分仍适用 Apache-2.0；两份许可随包保留。
