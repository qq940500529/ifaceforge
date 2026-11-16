<div align="center">
  <img src="https://raw.githubusercontent.com/qq940500529/ifaceforge/main/build/icons/icon.png" width="76" height="76" alt="IfaceForge">
  <h1>IfaceForge</h1>
  <p><strong>A desktop interface and testing workbench for local Git projects</strong></p>
  <p><a href="https://github.com/qq940500529/ifaceforge/releases">Download</a> · <a href="https://qq940500529.github.io/ifaceforge/mcp.html">MCP guide</a> · <a href="https://qq940500529.github.io/ifaceforge/">简体中文</a> · <a href="https://qq940500529.github.io/ifaceforge/cli.html">CLI reference</a></p>
</div>

![The IfaceForge MCP workbench with a service directory and a test with assertions](assets/mcp-workbench.png)

## Quick start

1. Install the desktop package for your system from [GitHub Releases](https://github.com/qq940500529/ifaceforge/releases) and make Git available on `PATH`.
2. Open IfaceForge and choose **Add project**. Pick a local Git worktree or a folder within it.
3. Select **Scan project** to browse declarations, source observations and repository skills. To inspect a live MCP server, select a connection profile in **MCP** and click **Connect**.

## Inspect and test MCP

The server directory shows tools, resources, resource templates, and prompts exposed to the selected connection. Choose an item and use the **Details**, **Test**, and **History** tabs. Fill tool or prompt arguments, read a resource, or expand a template into a URI. Inspect the response and add assertions for the fields or content you expect.

Use **Save as case** to replay a check through the Tests page or the CLI. Save checks for all four types and run them together in a suite. You can also import OpenAPI, test HTTP requests, browse skills, and export a local Wiki.

<details>
<summary>Build from source</summary>
<pre><code>npm ci
npm run build
npm start</code></pre>
<p>See the <a href="https://qq940500529.github.io/ifaceforge/release.html">release guide</a> for desktop packaging and validation commands.</p>
</details>

[CLI reference](cli.md) · [Contributing](https://github.com/qq940500529/ifaceforge/blob/main/CONTRIBUTING.md) · [Discussions](https://github.com/qq940500529/ifaceforge/discussions) · [Report an issue](https://github.com/qq940500529/ifaceforge/issues/new/choose)

[MIT](https://github.com/qq940500529/ifaceforge/blob/main/LICENSE) · Copyright (c) 2026 数链创元（天津）信息技术有限责任公司
