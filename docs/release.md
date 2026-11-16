# Build and release

[用户手册](workbench.md) · [开发规格](https://github.com/qq940500529/ifaceforge/blob/main/docs/development-spec.md) · [验证工作流](https://github.com/qq940500529/ifaceforge/actions/workflows/verify.yml) · [发行下载](https://github.com/qq940500529/ifaceforge/releases)

## Build on the target system

Use Git and Node.js 26 LTS. Node.js 24 LTS remains a CLI and development compatibility target. Desktop builds use the Electron stable line specified in the lockfile and include their runtime. [Node.js support schedule](https://nodejs.org/en/about/previous-releases) · [Electron support schedule](https://www.electronjs.org/docs/latest/tutorial/electron-timelines)

```sh
npm ci
npm run build
npm start
node node_modules/electron/install.js
npm run package -- --config.electronDist=node_modules/electron/dist
```

Build output is written to `artifacts/desktop`. Windows produces an NSIS installer, Apple Silicon macOS a DMG, and Linux x64 AppImage, DEB and RPM packages. Build on the same OS and architecture as the target. The optional CLI archive is built with `npm run package:cli`, and source installs can use `npm link`.

## Verify

```sh
npm run check
npm run test:unit
npm run test:integration
npx playwright install chromium
npm run test:e2e
npm run test:desktop
```

For the live FastAPI case, install `fixtures/fastapi/requirements.txt` with a supported Python and set `IFG_TEST_PYTHON` to its executable. For a Linux desktop runner, use `xvfb-run -a npm run test:desktop`. Set `IFG_DESKTOP_EXE` to the packaged program to verify the shipped executable. Desktop screenshots and the test report appear in `test-results` and `playwright-desktop-report`.

Use test projects, two separate worktrees, a custom install directory, and a fresh app data directory. Verify project isolation, scan cancellation and status, source and Wiki bounds, transport execution, visual layouts, and Windows install and uninstall. Check unit, integration and UI results for each release before publishing the corresponding assets. Refer to the release notes for the systems, architectures and scenarios actually tested.

## Publish a preview

1. Submit the changes through a pull request. Review build results, cross-platform checks, dependency review and the desktop test artifacts. Use test data in public changes and logs.
2. Create a version tag at the reviewed commit. Download the tested packages and dependency inventories. Compute SHA-256 over each delivered package and attach the checksum file to the release.
3. Publish a prerelease with installation steps, verification scope, changes and known issues. Verify the tag and the actual assets from the release page.

The previous technical preview and its acceptance record remain available in the [v0.1.0 tag](https://github.com/qq940500529/ifaceforge/tree/v0.1.0).

[MIT](https://github.com/qq940500529/ifaceforge/blob/main/LICENSE) · Copyright (c) 2026 数链创元（天津）信息技术有限责任公司
