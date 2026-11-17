# 更新日志 · Changelog

## v1.0.1

- Windows EXE 同步安装和升级桌面与 CLI。交互和静默安装登记同版本 `ifg`，处理旧独立包的用户 PATH，并继续提供独立 CLI 压缩包。
- CLI 增加版本与致谢查询、扫描诊断筛选与导出、Git 对比选择读取、MCP 资源模板预览以及 Wiki JSON 直接导出。
- `guide validate` 和扫描诊断报告 `SKILL.md` 缺失的本地引用，包含文件、行号和目标。
- Wiki 导出记录刷新时保留章节跳转后的键盘焦点。

## v1.0.0

- 首个正式版整合自 v0.3.0-preview.2 以来的桌面、CLI 和扫描改进，包含 Git 版本对比、MCP 源码扫描和临时运行、Wiki 分类浏览，以及 Windows 安装与扫描诊断。
- Windows x64 完成本机验收。提供 macOS ARM64 和 Linux x64 构建，欢迎在 [GitHub Issues](https://github.com/qq940500529/ifaceforge/issues/new/choose) 反馈实机测试结果。

以下 v0.3.0-preview.3 至 v0.3.0-preview.8 条目记录本机预览迭代，均并入 v1.0.0。

## v0.3.0-preview.8

- MCP 本机运行启动失败时明确显示本机进程的退出码，并保留启动输出和可复制的错误详情。

## v0.3.0-preview.7

- Wiki 按 HTTP API、MCP 和技能生成可跳转的索引。桌面预览支持搜索和筛选，详情分节展示来源、定义、命令与笔记。
- MCP 通过一个入口选择运行环境和查看启动计划，已发现的能力在独立区域中切换查看。
- 扫描浮窗根据结果突出诊断、目录或重试操作。

## v0.3.0-preview.6

- MCP 扩展仓库源码识别与运行时发现。桌面与 CLI 支持经确认的本机临时进程，可对照源码证据、协议版本与实际能力。
- Python HTTP 扫描扩展路由分发识别、跨文件常量和源码定位，动态目标保留诊断。

## v0.3.0-preview.5

- MCP 启动预检能指出 Windows 启动器、缺失的工作目录和入口文件。启动失败后可查看并复制脱敏输出、退出码和清理结果。
- MCP 注册扫描只分析可追溯至服务端 SDK 的调用。Python HTTP 扫描按实际路由分支给出源码证据、动态路径提示和契约缺口。

## v0.3.0-preview.4

- Windows 向导默认显示安装进度、写入文件的相对路径和快捷方式操作，结束后可以继续查看并复制记录。
- 扫描状态和任务页支持筛选、查看与复制警告和错误。
- 目录、API、MCP、Skills、测试和 Wiki 的长列表支持独立滚动及方便的详情定位。
- 使用 MIT 许可的 `remark-gfm` 扩展 GitHub Markdown 格式，偏好设置加入版本、许可和致谢。
- MCP 通过临时隔离容器发现和测试四类能力，支持仓库目标、已保存的启动配置、桌面操作和 CLI。运行记录包含提交、镜像和清理结果。

## v0.3.0-preview.3

- Windows 安装向导增加开始菜单和桌面快捷方式选项，默认仅创建开始菜单快捷方式。同一个 EXE 支持静默安装和两个快捷方式参数。

## v0.3.0-preview.2

- 顶栏支持切换分支和提交。Git 网络图显示提交时间、分支、标签和关系，可按需翻页或定位提交。
- 支持比较 API、MCP、技能及文件。同一项目的历史扫描按选中的提交读取，复用已完成的快照。
- 扩展 Swagger、OpenAPI、MCP 和 Agent Skills 声明支持。MCP 能力清单可在离线扫描中读取，服务实测可用连接验证。
- 区分 Express 服务端注册与客户端调用证据。API 目录明确报告自定义 HTTP 分发和其他静态覆盖缺口。
- CLI 增加项目管理、后台任务、MCP 会话、终端图和报告导出。桌面与 CLI 共用工作区服务。三平台 CLI 包附带运行时和 AI 调用指南。

[桌面使用手册](docs/workbench.md) · [CLI 与 AI](docs/cli-agent.md) · [开发规范](docs/developer-guide.md)

## v0.2.0-preview.3

- 目录使用紧凑标签区分接口类型和来源。「HTTP API」「MCP」「技能」各有独立色调，来源使用中性色，多标签可在窄窗换行。

## v0.2.0-preview.2

- MCP 工作台新增可搜索的服务目录、参数与 Schema 详情、资源预览、模板变量和提示词消息。
- 工具、资源、模板和提示词均可配置断言、保存为用例并随套件重跑。CLI 支持模板和单次断言文件。
- 文档采用中英文 GitHub 首页、实测界面和独立的 MCP 指南。

[MCP 使用指南](docs/mcp.md) · [下载与验证](https://github.com/qq940500529/ifaceforge/releases)

## v0.2.0-preview.1

独立安装的多项目桌面版、页内扫描进度、HTTP 和 MCP 调试、项目测试与 Wiki。[发行记录](https://github.com/qq940500529/ifaceforge/releases/tag/v0.2.0-preview.1)
