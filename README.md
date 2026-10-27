# DSH Windows Distribution

为 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 构建可复现、可验证、可升级的 Windows 发行包。

> 状态：固定上游版本的 Windows x64 未签名安装包已可复现构建；版本锁定组件注入已端到端验证（2026-10-27 本地构建 + 静默安装冒烟全绿，含 app.asar 内 payload 摘要校验）。干净 VM 验证、configured-test 服务与签名发布仍未开始。当前仓库不包含 DSH 上游源码。

## 目标

- 将 DSH Desktop、锁定的运行时、内置插件、工作流和工具组合成一个版本化发行包。
- Windows x64 安装和运行不依赖用户预装 Node.js、Python 或 pnpm。
- 内置组件随发行版锁定；用户自定义插件、工作流、工具和配置独立保留。
- 在构建阶段验证精确版本、平台、依赖闭包和文件完整性。
- 复用上游 Electron Desktop 与更新机制，避免另造桌面壳或覆盖上游升级逻辑。

## 设计原则

1. **Single source of truth**：上游 `scripts/primary-runtime/lock.json` 锁定独立 Node.js、Python 和 Python wheels；`pnpm-lock.yaml` 锁定 JS 依赖；Electron 自带的 Node.js 由 Electron 版本决定。
2. **Immutable release**：发布版本的内置组件集合不可变，变更需要新发行版本。
3. **User data is not release data**：用户配置、密钥、工作数据和自定义扩展不放入发行版目录。
4. **Fail closed**：缺失锁文件、摘要不匹配、组件不兼容或目标平台不匹配时，构建/激活必须失败。
5. **No implicit network install**：发行版首次启动不应在线补装内置运行时或内置依赖。

## 固定的上游基线

当前基线固定为 DeepSeek Harness 最新已发布 GitHub Release（截至 2026-10-26）：**`v0.2.1-rc.3`**。这是预发布候选版本，不是稳定版。发布标签 `dsh-v0.2.1-rc.3` 指向不可变 commit `1f81c047fc48fa190a683e469daa699857e9afe8`。精确版本、关键源文件 Git blob SHA、运行时和 Electron 版本记录在 [`upstream.lock.json`](upstream.lock.json)。构建必须使用该 commit，不允许浮动使用 `master`。

官方发布记录：[v0.2.1-rc.3](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.3)。

## 初始范围

- Windows x64。
- 发行清单和锁文件的 schema 与校验器。
- 上游运行时锁文件的校验器。
- 以 GitHub Actions 运行的单元测试。
- 后续再接入上游 DSH 的实际打包脚本、签名、更新 Feed 和安装升级验收。

## 开发环境

- Node.js 24.21.0（项目开发工具链基线；与发行包中 Electron 自带的 Node.js 是不同概念）。
- Python 3.12.10（Windows 构建主机工具链；发行包中的独立 Python 仍按上游锁定为 3.12.14）。
- pnpm 11.28.5（如需使用 pnpm）。
- Windows x64 的真实安装包验收应在干净 Windows 虚拟机中进行。

## 本地检查

```powershell
npm test
npm run validate:example
```

## Windows 构建

当前已提供固定上游版本的 Windows x64 **未签名安装包**构建脚本和手动 GitHub Actions 工作流。没有登录、下载或更新服务时，可以使用默认的 `build-only` 模式验证打包与运行时；该产物明确不可分发、不能登录或自动更新。真实服务准备好后，再使用 `configured-test` 模式。版本锁定的内置组件（`@thneoly/dsh-distribution-bundle`）已随安装包注入并经安装后冒烟验证；注入机制见[架构文档](docs/architecture.md)。详见[Windows 构建指南](docs/windows-build.md)。

## 文档

- [架构与边界](docs/architecture.md)
- [Windows 构建指南](docs/windows-build.md)
- [MVP 路线图](docs/roadmap.md)

## 上游

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- [Primary runtime lock](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/scripts/primary-runtime/lock.json)
- [Desktop packaging guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/packaging/README.zh.md)

## License

当前项目尚处于初始化阶段。添加代码前应确认与 DSH 上游及随包组件的许可证兼容性；此仓库的许可证声明将在确认后补充。
