<div align="center">
  <img src="https://raw.githubusercontent.com/qq940500529/ifaceforge/main/build/icons/icon.png" width="76" height="76" alt="IfaceForge">
  <h1>IfaceForge</h1>
  <p><strong>A local capability workbench for AI applications, agent platforms, and AI integrations</strong></p>
  <p><a href="https://github.com/qq940500529/ifaceforge/releases">Download</a> · <a href="https://qq940500529.github.io/ifaceforge/mcp.html">MCP guide</a> · <a href="https://qq940500529.github.io/ifaceforge/">简体中文</a> · <a href="https://qq940500529.github.io/ifaceforge/cli.html">CLI reference</a></p>
</div>

## Which projects is IfaceForge for?

When applications and AI agents use the same business capabilities, teams often maintain three entry points. **APIs** let applications call a service. **MCP** lets agents discover tools and resources and interact with them. **Skills** tell agents when to use those capabilities and how to complete a task. IfaceForge lets teams review all three at the same Git revision and rerun interface tests when they change.

| Project type                                           | Why these capabilities need managing                                                                                                                                                                    |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AI applications and agent products**                 | Enterprise assistants, engineering copilots, and operations agents call business APIs, use MCP tools, and follow skills. Releases need coordinated review of endpoints, tool arguments, and procedures. |
| **Business systems and open platforms integrating AI** | Ticketing, data, and engineering platforms expose capabilities to first-party clients, third-party apps, and multiple agents. Teams need to track what changes across their entry points and releases.  |
| **Agent platforms and tool ecosystems**                | Shared tool libraries, plugin platforms, and workflow platforms combine services and skills from multiple teams. Maintainers need a versioned inventory, tool tests, and documentation for other teams. |

IfaceForge works with local Git worktrees. Clone remote repositories locally before adding them. It supports single-service repositories, monorepos, and workflows that manage just one capability type. OpenAPI, Swagger, MCP capability manifests, and `SKILL.md` can be scanned across languages. Source recognition varies by framework and registration pattern. [Developer guide and compatibility](developer-guide.en.md)

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
