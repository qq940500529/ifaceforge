<div align="center">
  <img src="build/icons/icon.png" width="76" height="76" alt="IfaceForge">
  <h1>IfaceForge · 接口工坊</h1>
  <p><strong>本机 Git 项目的接口与测试工作台</strong></p>
  <p>浏览 MCP 服务的实际内容，调试 HTTP 接口，把验证保存为可复跑的用例。</p>
  <p>
    <a href="https://github.com/qq940500529/ifaceforge/releases"><img alt="下载桌面安装包" src="https://img.shields.io/github/v/release/qq940500529/ifaceforge?include_prereleases&amp;label=%E4%B8%8B%E8%BD%BD&amp;color=245fc4"></a>
    <a href="https://github.com/qq940500529/ifaceforge/actions/workflows/verify.yml"><img alt="三平台验证" src="https://github.com/qq940500529/ifaceforge/actions/workflows/verify.yml/badge.svg"></a>
    <a href="LICENSE"><img alt="MIT 许可证" src="https://img.shields.io/badge/License-MIT-28746a"></a>
  </p>
  <p><a href="https://qq940500529.github.io/ifaceforge/">文档站</a> · <a href="docs/README.en.md">English</a> · <a href="docs/mcp.md">MCP 指南</a> · <a href="docs/cli.md">CLI</a> · <a href="CHANGELOG.md">更新日志</a></p>
</div>

<a href="docs/mcp.md"><img src="docs/assets/mcp-workbench.png" alt="IfaceForge MCP 工作台，左侧为服务目录，右侧为参数、断言和测试结果"></a>

## 开始使用

| Windows x64                       | macOS Apple Silicon              | Linux x64                          |
| :-------------------------------- | :------------------------------- | :--------------------------------- |
| 运行 EXE 安装向导，可选择安装位置 | 打开 DMG，把应用拖到有权限的目录 | 运行 AppImage，或使用 DEB / RPM 包 |

1. 从 [GitHub Releases](https://github.com/qq940500529/ifaceforge/releases) 下载对应安装包，并确保 Git 可从 `PATH` 找到。
2. 打开 IfaceForge，点击 **添加项目**，选择本机 Git 工作树或其中的文件夹。
3. 点击 **扫描项目** 查看目录。进入 **MCP**，选择环境并连接，目录会加载该服务提供的能力。

> [!TIP]
> 选中 MCP 条目即可打开测试。在同一处查看定义、填写参数、检查返回内容并保存用例。

## 工作台

| 浏览                             | 测试                                         | 复用                             |
| :------------------------------- | :------------------------------------------- | :------------------------------- |
| MCP 工具、资源、资源模板和提示词 | HTTP 请求和 MCP 动作，含断言、耗时和错误明细 | 用例、顺序套件与 JSON 报告       |
| OpenAPI、部分源码定义和仓库技能  | 连续执行、取消、运行历史                     | 本地 Wiki、Markdown 和 JSON 导出 |

独立安装的桌面应用可同时管理多个本机项目。每个项目的数据存放在自己的 SQLite 数据库中。命令行工具 `ifg` 共用项目记录和用例。

<details>
<summary>从源码运行</summary>

使用 Git 和 Node.js LTS。

```sh
npm ci
npm run build
npm start
```

[开发与验证](CONTRIBUTING.md) · [构建和发行](docs/release.md)

</details>

## 文档与社区

[桌面使用手册](docs/workbench.md) · [MCP 测试指南](docs/mcp.md) · [CLI 参考](docs/cli.md) · [发行记录](https://github.com/qq940500529/ifaceforge/releases)

[Discussions](https://github.com/qq940500529/ifaceforge/discussions) · [提交问题](https://github.com/qq940500529/ifaceforge/issues/new/choose) · [贡献指南](CONTRIBUTING.md) · [安全报告](SECURITY.md)

[MIT](LICENSE) · Copyright (c) 2026 数链创元（天津）信息技术有限责任公司
