<div align="center">
  <img src="https://raw.githubusercontent.com/qq940500529/ifaceforge/main/build/icons/icon.png" width="76" height="76" alt="IfaceForge">
  <h1>IfaceForge</h1>
  <p><strong>An interface and skills workbench for AI application projects</strong></p>
  <p>Browse APIs, MCP, and Skills at the same Git revision. Review changes and save interface checks as repeatable tests.</p>
  <p><a href="https://github.com/qq940500529/ifaceforge/releases/latest">Download</a> · <a href="https://qq940500529.github.io/ifaceforge/">Documentation</a> · <a href="https://github.com/qq940500529/ifaceforge#readme">简体中文</a></p>
</div>

## Quick start

1. Download the desktop package from the [latest stable release](https://github.com/qq940500529/ifaceforge/releases/latest) and make Git available on `PATH`.
2. Open IfaceForge and choose **Add project**. Pick a local Git worktree or a directory within it. Clone remote repositories locally first.
3. Select **Scan project** to browse API, MCP, and Skills definitions, their sources, and scan diagnostics.

| Platform        | Installation and validation                                                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Windows x64** | Run the EXE to select an installation folder and shortcuts. Interactive and silent installs both include the matching `ifg`. Verified locally. |
| **macOS ARM64** | Open the DMG and drag the app to a writable folder. Builds available, with hands-on validation pending.                                        |
| **Linux x64**   | Run the AppImage or install a DEB or RPM. Builds available, with hands-on validation pending.                                                  |

> [!TIP]
> Run `ifg --version --json` in a new Windows terminal after installation. Independent CLI packages are available for all three platforms. [CLI installation and reference](cli.md)

## What you can do

- **Scan and review.** Read OpenAPI, Swagger, MCP capability manifests, and `SKILL.md`. Trace supported source registrations to their files and lines, then compare branches or commits. Historical scans run for the selected revisions. [Developer guide and compatibility](developer-guide.en.md)
- **Verify APIs and MCP.** Send HTTP requests and check responses with assertions. Read MCP declarations offline or start a temporary service to discover and test tools, resources, resource templates, and prompts. Save checks as cases, run suites, and review their results. [MCP test guide](mcp.md)
- **Produce documentation and reports.** Generate a local Wiki, keep handwritten notes, and export Markdown, the catalog JSON, or comparison reports. [Desktop user guide](workbench.md)

The desktop app manages multiple local Git projects with separate SQLite data. The desktop and `ifg` share project registrations, scans, and test records. [Desktop and CLI coverage](cli.md#desktop-actions-and-cli-equivalents)

<details>
<summary>View the MCP workbench</summary>

![MCP capability directory, isolated discovery result, and tool test form](assets/mcp-workbench.png)

</details>

<details>
<summary>View Git history and version comparison</summary>

![Git network graph and changes to API, MCP, and Skills definitions](assets/version-comparison.png)

</details>

## Documentation and contributions

| Task                                            | Documentation                                                                                                                                                                                         |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Install and use the desktop app                 | [User guide](workbench.md)                                                                                                                                                                            |
| Run scripts or connect an AI agent              | [CLI reference](cli.md) · [AI calling guide](cli-agent.md)                                                                                                                                            |
| Develop scannable APIs, MCP servers, and Skills | [Developer guide](developer-guide.en.md)                                                                                                                                                              |
| Read release changes and contribute             | [Changelog](https://github.com/qq940500529/ifaceforge/blob/main/CHANGELOG.md) · [Build and release](release.md) · [Contributing](https://github.com/qq940500529/ifaceforge/blob/main/CONTRIBUTING.md) |

<details>
<summary>Build from source</summary>
<pre><code>npm ci
npm run build
npm start</code></pre>
<p>See the <a href="https://qq940500529.github.io/ifaceforge/release.html">release guide</a> for desktop packaging and validation commands.</p>
</details>

[Discussions](https://github.com/qq940500529/ifaceforge/discussions) · [Report an issue or share platform test results](https://github.com/qq940500529/ifaceforge/issues/new/choose) · [Security policy](https://github.com/qq940500529/ifaceforge/blob/main/SECURITY.md)

[MIT](https://github.com/qq940500529/ifaceforge/blob/main/LICENSE) · Copyright (c) 2026 数链创元（天津）信息技术有限责任公司
