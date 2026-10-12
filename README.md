# Codex Idle Compact：闲置上下文自动压缩

Windows Codex 桌面端的闲置上下文压缩插件。

当聊天**上下文超过 30,000 token**，且**回合结束后闲置超过 25 分钟**时，通过桌面原生接口请求压缩。等待和检查由本地进程执行，不调用模型；压缩本身使用 Codex 的模型服务。

## 功能

- 使用 Codex 插件结构：MCP 服务与生命周期钩子。
- 每 5 秒检查一次；任务运行中不触发，用户发消息后重新计时。
- 同一回合只尝试一次，多个 MCP 实例共用监控锁。
- 直接调用原生压缩，无需模拟键盘、专用启动器或调试端口。
- 本地状态区分“请求已受理”和“会话日志已确认压缩完成”。

## 环境要求

- Windows、Node.js 22+，以及可在 PowerShell 中运行的 `codex` 命令。
- 支持插件、MCP 和生命周期钩子的 Codex 桌面端；开发时使用版本 `26.1007.2314.0`。
- Codex 应用保持运行，目标聊天已登记且仍由桌面端持有。

本插件使用内部 `codex-ipc` 接口，桌面版本更新可能需要适配。25 分钟是触发条件，不代表缓存保留时间，也不保证节省额度。

## 安装

下载仓库源码并解压，或将仓库克隆到一个长期保留的目录。在该目录打开 PowerShell：

```powershell
.\Install.ps1
```

脚本优先使用 `CODEX_HOME` 环境变量；未设置时使用用户目录下的 `.codex`。如果桌面端使用其他数据目录，显式指定，例如：

```powershell
.\Install.ps1 -CodexHome "$env:USERPROFILE\.codex-official"
```

安装目录必须与桌面端实际使用的 Codex 数据目录一致。脚本生成本机 `.mcp.json`，注册本地插件市场并安装 `idle-compact@local-idle-compact`。仓库内的 `.mcp.example.json` 仅作结构示例；请通过安装脚本生成实际配置。

在 Codex 插件页面启用“闲置自动压缩”，然后在 `Ctrl+,` → **钩子（Hooks）** → **来自插件（From Plugins）** 中审阅并信任它的四个钩子。安装不代表已信任钩子。

安装或升级后，正常退出并重新打开 Codex，以加载新的 MCP 进程。重新打开目标聊天；旧聊天也可以通过插件工具 `idle_compact_watch` 登记，`idle_compact_status` 查看状态。

本地插件市场使用此源码目录，安装后请保留目录。生成的 `.mcp.json` 含本机路径，已加入 `.gitignore`，不要强制提交。

## 触发规则

必须同时满足：

1. 已登记聊天，且确认当前回合已结束。
2. 最近一次输入上下文严格大于 `30,000` token，不使用历史累计 token。
3. 自最后活动起严格超过 `25` 分钟。
4. 本回合尚未尝试压缩，且仍能找到原生桌面控制端。

`SessionStart`、`Stop` 登记聊天，`UserPromptSubmit` 刷新活动时间，`SessionEnd` 取消监控。压缩前再次检查活动状态，避免新消息与计时器竞争。

## 配置与日志

在桌面端实际使用的 Codex 数据目录下创建 `plugin-data/idle-compact/settings.json`：

```json
{
  "idleMinutes": 25,
  "minContextTokens": 30000,
  "dryRun": false
}
```

- `idleMinutes`：1–1440 的整数。
- `minContextTokens`：非负整数；`0` 表示允许任何已知正 token 用量的上下文。
- `dryRun`：为 `true` 时只检测，不发起压缩。

没有配置文件时使用上述默认值，修改后在下一次检查时生效。

同目录下，`status/` 保存检测结果，`attempts/` 保存去重及请求状态，`events.jsonl` 保存事件。`dispatched` 表示原生接口已受理；`compacted` 表示请求之后出现了真实压缩标记。日志记录聊天 ID、时间、token 用量和错误信息，不保存聊天正文。

禁用插件并关闭它的 MCP 连接后，监控随进程结束。不安装系统服务、计划任务或开机启动项。睡眠和应用退出期间不触发压缩。

## 测试

无第三方运行依赖，也无需安装 npm 包：

```powershell
npm test
```

现有 16 项测试覆盖时间与 token 边界、运行中不触发、重复请求、并发监控、用户活动竞争、IPC 分帧、日志解析和临时测试条件到期恢复。GitHub Actions 配置在 Windows 上使用 Node.js 22、24 运行这些测试。

只读检测原生控制端：

```powershell
node scripts/ipc-client.cjs <聊天ID>
```

单次真实测试，先将 `CODEX_HOME` 指向桌面端使用的数据目录：

```powershell
New-Item -ItemType Directory -Force verification-results | Out-Null
node scripts/verify-once.cjs <聊天ID> "$PWD\verification-results\result.json"
```

观察进程需要保持运行。它只为指定聊天的当前回合启用 **1 分钟、0 token** 的临时条件，实际压缩仍由已加载的插件完成。回合结束后保持闲置；新回合会取消测试。临时条件最长 15 分钟失效，测试完成或失败后恢复为 25 分钟、30,000 token。此命令会把正式配置重置为上述默认值。

结果文件中的 `passed` 表示原生请求发出后，会话日志出现了新的压缩标记；`restored: true` 表示已恢复正式条件。检查器不会把旧压缩记录当作成功。

自动化测试与本地控制端探测已通过。真实闲置触发应以使用环境产生的结果文件为准，本仓库不附带个人聊天的测试记录。

## 源码结构

```text
.codex-plugin/       插件清单
.agents/plugins/     本地市场清单
.github/workflows/   Windows 测试工作流
hooks/               生命周期钩子定义
scripts/             MCP、监控器、元数据解析和原生 IPC
assets/              插件图标
tests/               Node.js 测试
.mcp.example.json    MCP 配置结构示例
Install.ps1          生成本机配置并安装插件
```

## 来源与许可

基于 [Codex Native Auto Compact](https://github.com/liekkasfc/codex-native-auto-compact) 的原生压缩思路改造，上游参考提交：`0e7c6e8246561d23e5a7448b02fb7d34f406d49d`。

上游是界面用户脚本；本项目将计时迁入插件 MCP 进程，将界面点击改成 Windows 原生 IPC 请求。采用 MIT 许可证并保留上游版权声明，见 [许可证文件](LICENSE)。本项目为独立社区插件，与 OpenAI 无隶属关系。
