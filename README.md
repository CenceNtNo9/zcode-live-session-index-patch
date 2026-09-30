# ZCode 实时会话索引补丁

用于修复 ZCode 的 store-backed 会话摘要已送达 Desktop Host 后，缺少本地任务索引归属、分组位置或列表变更通知的问题。项目提供精确上游基线的源码补丁，以及针对一个 Windows 构建的可移植 Apply/Rollback 工具。

[下载补丁 ZIP](downloads/zcode-patch.zip) · [完整中文说明](zcode-patch/README.zh-CN.md) · [English guide](zcode-patch/README.md)

## 下载和使用

1. 下载 `downloads/zcode-patch.zip`，解压完整内容。
2. 准备 Node.js **24.14.0 或更新版本**，确保 `node.exe` 在 PATH 中。
3. 把解压得到的 **zcode-patch 文件夹**复制进 ZCode 安装根目录，与 `ZCode.exe`、`resources` 并列。
4. 关闭该安装的 Desktop/CLI，双击 `zcode-patch/Apply.cmd`。成功后重新启动 ZCode。
5. 还原时再次关闭进程，双击 `zcode-patch/Rollback.cmd`。

**只复制文件夹不会自动生效。** 工具只接受精确的 Windows x64 **ZCode 3.14.3.7762** 冻结构建；同版本号的其它 build 也会因哈希不匹配而拒绝。可移植 Apply 只依赖 Node 内置模块和系统 Windows PowerShell，不需要 npm install、源码 checkout 或下载依赖。

无写预检可从任意目录执行，替换示例安装路径：

```powershell
$PatchScript = 'C:\Apps\ZCode\zcode-patch\Invoke-ZCodePatch.ps1'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PatchScript -Mode Apply -CheckOnly
powershell.exe -NoProfile -ExecutionPolicy Bypass -File $PatchScript -Mode Rollback -CheckOnly
```

Apply 在 `resources/.zcode-patch-backup/original.asar` 保存经过精确验证的原件，不覆盖已有备份；同卷生成候选，原子替换唯一目标 `resources/app.asar`，再核对最终哈希。旁边的 unpacked 资源保持原样。工具拒绝仍运行的相关进程及链接/junction/device 路径，不杀进程；执行策略只在子 PowerShell 进程生效。

已经是 Review7 但没有 verified original backup 的安装，Apply 幂等识别；**Rollback 不能执行**。必须显式提供正确 D836… 原件，不能把 candidate 当原件，也不能从 candidate 恢复原件。完整兼容哈希、备份条件与操作边界见中文说明。

## 简要设计

源码数据链是 SQLite 外部写入失效 → CLI sessions-index 投影/发布 → workspace v4 summary → Host TaskIndexSyncer → 现有 TaskIndexRepo/grouped order → task-list 通知。任务状态继续由已有 Repo 管理，UI 消费状态和通知。

两条路径分别验收：

- **源码补丁**基于上游 `zai-org/ZCode` 的 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`，覆盖 CLI 外部索引失效/v4 传播、源码 Host 和测试；开发者需单独准备依赖并构建。
- **冻结 Host 可移植补丁**使用两个小文本 byte spans 和 Node 内置 ASAR parser，精确生成 Review7，只改变 app.asar 中的 Host 入口，安装 EXE/CLI 不变。保留非 Host header、既有 packed payload、30,165 个 entries 与 unpacked 引用。

源码公开 Repo API 和冻结编译 Repo 的 raw-row eligibility 接口不同，pin race 的行为分别验证，不能直接把编译 helper 粘贴进源码。包不附应用二进制、完整编译 Host、用户会话、部署日志或机器专属路径。

## 已修复问题

- store-only 会话有效标题摘要可补齐缺失 membership，不依赖当前 Desktop 的 active runtime record。
- `inFlight/pending/admitted` 状态保留成功 seed 后的 grouping/read 进度；重试初读再失败也可继续恢复，并发帧不重复创建/广播。
- 首个有效标题与终态同帧出现时仍建立 membership；标题变化后也可继续 pending admission。
- 保留已有本地标题、status/model/mode/unread 和 pin/archive/tombstone 权威，不回写旧整行、不复活删除行。
- 安装过程增加无写 CheckOnly、精确门禁、正确备份、幂等和替换后失败恢复；lint wrapper 传播真实退出码。

## 实际验证和当前不足

已运行并通过：源码 exact-base apply/10文件对照、9个真实 TaskIndexRepo/provider-free v4 测试、相关 TypeScript 目标、两进程合成 SQLite 传播、冻结 Host 17项 gate、独立 ASAR 检查，以及复制到 Temp 安装的12项部署/CMD/拒绝/故障恢复测试。fresh Git checkout 校验原始 index 字节、清单和 LF/CRLF 策略，覆盖 `core.autocrlf=true`；ZIP 逐文件 SHA 校验。

当前限制明确保留：

- 未执行真实安装 Apply/Rollback、真实 Desktop GUI/provider 或完整端到端侧栏时序。模拟事件与 Temp 安装通过，不代表每种真实运行环境都已验证；Apply 后仍需实际启动核对。
- 可移植路径只修 Host 消费已到达摘要后的 membership，不修改安装 CLI，也不声称任意 CLI/runtime 写库、Desktop delivery 时机都已验证。
- 仅支持一个冻结 build；没有任意版本适配、自动下载或无原件回滚。
- 上游 lint 仍有 **4 个 max-lines errors、7 个不必要 spread/fallback warnings**，内外退出码均为1。当前未发现这些诊断对应已知功能或明显性能问题；核心文件拆分范围较大，作为后续维护重构处理。本项目没有宣称 lint 全通过。
- 可选 isolated Host smoke 需要额外的精确 Electron/product 输入。本交付未将真实 Host boot 标记为已通过；进程内 API guards 不能证明 OS/native 网络完全封锁。

## 许可证与完整性

上游补丁及 ZCode 派生内容适用 [Apache-2.0](zcode-patch/LICENSE-APACHE-2.0)；本项目原始打包、验证工具与文档适用 [MIT](zcode-patch/LICENSE-MIT)。详细范围见包内说明。

[zcode-patch/package-files.sha256](zcode-patch/package-files.sha256) 覆盖包内发布文件原始字节。普通文本使用 LF，cmd 使用 CRLF，局部 `.gitattributes` 防止 checkout 转换。不要编辑、格式化或转换 payload/发布文件的编码与行尾。
