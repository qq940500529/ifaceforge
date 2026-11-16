# 0.1.0 release record

## Acceptance on Windows

Verified on 2026-11-16 (Hong Kong time), Windows 11 Pro x64 build 26200. Node 26.13.1 and Node 24.22.3 each passed 11 unit tests and 8 real integration tests. The three Chromium 159.0.8154.6 browser tests passed on Node 26. Rechecks covered the changed MCP paths and the tool form.

| Checks   | Windows evidence                                                                                                                                                                                                                                   |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A01, A12 | Clean lockfile install and build. Start, status, explicit port conflict, stop and archive startup against working trees with spaces and Chinese characters. The fixture's tracked source files remain intact.                                      |
| A02, A11 | Independent project databases, backup and restore, optimistic version checks, and shared UI and CLI records. A restored case runs against the original fixture.                                                                                    |
| A03, A07 | Express and FastAPI source and contract evidence, a live import of the dynamic Express route, incomplete scan retention, bilingual skill search, missing references, and source reads.                                                             |
| A04      | Real 200 and expected 404 responses with passing schema assertions, and a deliberately failing case with the actual status retained.                                                                                                               |
| A05, A06 | Both stdio and Streamable HTTP negotiated 2025-11-25 and 2026-07-28. The stdio batch reused a child and reaped it. Tests covered pagination, a resource, a prompt, a tool error and cancellation with an unknown result under the original run ID. |
| A08, A09 | English and Simplified Chinese browser flows, persisted language selection, Wiki output, manual notes and protection of pre-existing files in export directories.                                                                                  |
| A10      | CLI-only scans, requests, cases, reports and exports, schema discovery, JSON on standard output and nonzero assertion and cancellation exit codes.                                                                                                 |

The local console reports are under `.devtools/ifaceforge/evidence/`. The public verification workflow covers Windows, macOS arm64 and Linux x64. Consult the workflow results for platforms beyond this Windows session.

## Runtime and dependency selection

Node.js 26.13.1 (Lithium) is the primary runtime. Node.js 24.22.3 (Krypton) is the compatibility baseline for v1.1. Both include SQLite 3.54.1. The Windows development run used npm 12.2.2 and Git for Windows 2.56.1.windows.1 in project local directories. The application itself requires Node.js and Git. [Official Node.js release index](https://nodejs.org/dist/index.json)

The npm lockfile records the exact stable versions in the build. Main components include TypeScript 7.0.2, Vite 8.3.8, React 19.3.1, Ant Design 6.7.1, Express 5.3.0 and MCP TypeScript SDK 2.4.0. Type declarations stay on the Node 24 line to keep the compatibility baseline enforceable. ESLint checks executable JavaScript and TypeScript is checked by its compiler. The TypeScript ESLint parser currently requires TypeScript below 6.1. The FastAPI fixture uses FastAPI 0.163.1 and Uvicorn 0.54.0.

## Reproduce

```sh
npm ci
npm run check
npm run build
npm run test:unit
npm run test:integration
npx playwright install chromium
npm run test:e2e
npm run package
node scripts/check-package.mjs release/ifaceforge-0.1.0.tar.gz
```

Set `IFG_TEST_PYTHON` to a Python executable with the dependencies in `fixtures/fastapi/requirements.txt` installed to include the live FastAPI test. The verification workflow runs it on each runner. Playwright writes an HTML report to `playwright-report/` and retains failure traces in `test-results/`.

Test projects contain synthetic data and use names with spaces and Chinese characters. Run tests in the source checkout. The package check extracts the archive to a temporary directory and runs its own bundled application against a new Git working tree. Use `SHA256SUMS.txt` from the release to check the downloaded archive.

## Static discovery

Express recognizes single line method calls with literal route strings, including colon path parameters. FastAPI recognizes single line decorators with literal route paths. The MCP TypeScript adapter recognizes single line `tool` and `registerTool` calls with literal names. Dynamic registrations and composed routers can be examined from their runtime inventory. Source observations retain project relative file names and lines. The Express and FastAPI fixtures show standalone project configurations. File references in OpenAPI resolve inside the active working tree.

## Name review

On 2026-11-16 (Hong Kong time), the GitHub public repository search for `ifaceforge` returned no matching repository before publication. npm returned 404 for both `ifaceforge` and `iface-forge`. Public web searches did not identify a same-name competing API and MCP workbench. [GitHub search](https://github.com/search?q=ifaceforge&type=repositories)

Formal trademark review is incomplete. WIPO returned a verification challenge, the China National Intellectual Property Administration endpoint returned HTTP 403, and this review obtained no verifiable search record from the Hong Kong or United States databases. IfaceForge and 接口工坊 are provisional project names. The MIT license applies to the code. [WIPO](https://branddb.wipo.int/) · [CNIPA](https://sbj.cnipa.gov.cn/sbj/sbcx/) · [Hong Kong IPD](https://www.ipd.gov.hk/en/online-services/online-search/index.html) · [USPTO](https://tmsearch.uspto.gov/)

MIT · Copyright (c) 2026 数链创元（天津）信息技术有限责任公司.
