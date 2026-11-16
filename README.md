# IfaceForge · 接口工坊

**在一个桌面窗口里浏览、调试和测试多个 Git 项目的接口。**

[![Verify](https://github.com/qq940500529/ifaceforge/actions/workflows/verify.yml/badge.svg)](https://github.com/qq940500529/ifaceforge/actions/workflows/verify.yml)
[![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

[下载安装包](https://github.com/qq940500529/ifaceforge/releases) · [English](docs/README.en.md) · [使用手册](docs/workbench.md) · [CLI](docs/cli.md) · [参与贡献](CONTRIBUTING.md)

## 三步开始

1. 从 [GitHub Releases](https://github.com/qq940500529/ifaceforge/releases) 下载与你的系统、架构对应的桌面预览包。Windows 安装向导支持选择安装目录。macOS 从 DMG 拖放应用。Linux 可选 AppImage、DEB 或 RPM。
2. 打开 IfaceForge，点击 **添加项目**，选择本机 Git 工作树中的文件夹。选择子目录时，界面会请你确认 Git 工作树根。先安装 Git，并确保应用能从 `PATH` 找到它。
3. 点击 **扫描项目**。页内浮窗显示阶段和进度。扫描时可以收起浮窗、取消任务或切换项目。打开 **目录** 查看发现的能力。

![IfaceForge 桌面工作台中的扫描结果](docs/assets/catalog.png)

## 工作台

| 界面       | 常用操作                                                                  |
| ---------- | ------------------------------------------------------------------------- |
| 目录和技能 | 搜索、筛选、查看来源和定义。技能可以阅读正文和本地引用。                  |
| HTTP API   | 导入 OpenAPI，编辑和发送请求，检查响应与断言，导出接口定义。              |
| MCP        | 使用环境配置连接 stdio 或 Streamable HTTP，发现并调用工具、资源和提示词。 |
| 测试       | 保存请求为用例，构建套件，执行、取消和导出运行报告。                      |
| Wiki       | 预览、添加人工说明，生成 Markdown 和 JSON。                               |
| 项目设置   | 配置扫描、环境、备份、恢复和历史清理。                                    |

每个项目拥有独立 SQLite 数据库，安装目录、应用数据目录和 Git 工作树可以分别管理。桌面应用随包提供运行时。需要在终端调用时，可用同一数据目录下的 [`ifg`](docs/cli.md)。

[系统和数据目录](docs/workbench.md) · [构建、测试和发行](docs/release.md) · [开发规格](docs/development-spec.md)

## 许可证

[MIT](LICENSE) · Copyright (c) 2026 数链创元（天津）信息技术有限责任公司
