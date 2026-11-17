<div align="center">
  <img src="https://raw.githubusercontent.com/qq940500529/ifaceforge/main/build/icons/icon.png" width="76" height="76" alt="IfaceForge">
  <h1>IfaceForge</h1>
  <p><strong>A desktop interface and testing workbench for local Git projects</strong></p>
  <p><a href="https://github.com/qq940500529/ifaceforge/releases">Download</a> · <a href="https://qq940500529.github.io/ifaceforge/mcp.html">MCP guide</a> · <a href="https://qq940500529.github.io/ifaceforge/">简体中文</a> · <a href="https://qq940500529.github.io/ifaceforge/cli.html">CLI reference</a></p>
</div>

![The IfaceForge MCP workbench showing an isolated discovery, capability directory, and tool test form](assets/mcp-workbench.png)

## Quick start

1. Install the desktop package for your system from [GitHub Releases](https://github.com/qq940500529/ifaceforge/releases) and make Git available on `PATH`.
2. Open IfaceForge and choose **Add project**. Pick a local Git worktree or a folder within it.
3. Select **Scan project** to browse declarations, source observations and repository skills. In **MCP**, choose a service and **Docker · Linux**, then select **Review launch plan**. Docker needs the service image locally.

Windows x64 was verified on a local machine. Builds are available for macOS ARM64 and Linux x64. These platforms have no hands-on validation for this release. Community testing is welcome. Include your OS version, architecture, package format, and reproduction steps in a [GitHub issue](https://github.com/qq940500529/ifaceforge/issues/new/choose).

## Inspect and test MCP

The server directory shows tools, resources, resource templates, and prompts discovered from a temporary sandbox. Choose an item and use the **Details**, **Test**, and **History** tabs. Fill tool or prompt arguments, read a resource, or expand a template into a URI. Each test records the result and sandbox cleanup.

Use **Save as case** to replay a check through the Tests page or the CLI. Save checks for all four types and run them together in a suite. You can also import OpenAPI, test HTTP requests, browse skills, and export a local Wiki.

## Compare branches and commits

Use the top bar to browse a branch, or open **Versions and comparison** to select two commits in the Git network. Review changes to API, MCP, and Skills definitions alongside file patches and sources. History pages load as requested. File scans run for the selected endpoints and reuse completed snapshots.

> [!TIP]
> See the [developer guide](developer-guide.en.md) for language-independent declarations, working examples, and the compatibility matrix.

<details>
<summary>Build from source</summary>
<pre><code>npm ci
npm run build
npm start</code></pre>
<p>See the <a href="https://qq940500529.github.io/ifaceforge/release.html">release guide</a> for desktop packaging and validation commands.</p>
</details>

[CLI reference](cli.md) · [Contributing](https://github.com/qq940500529/ifaceforge/blob/main/CONTRIBUTING.md) · [Discussions](https://github.com/qq940500529/ifaceforge/discussions) · [Report an issue](https://github.com/qq940500529/ifaceforge/issues/new/choose)

[MIT](https://github.com/qq940500529/ifaceforge/blob/main/LICENSE) · Copyright (c) 2026 数链创元（天津）信息技术有限责任公司
