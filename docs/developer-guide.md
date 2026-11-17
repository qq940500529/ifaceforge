# 让 API、MCP 和 Skills 可被 IfaceForge 扫描

[English](developer-guide.en.md) · [兼容矩阵](compatibility.json) · [CLI](cli.md)

开发语言由项目自行选择。扫描优先使用标准声明与服务返回的定义，源码适配器提供补充线索。声明文件和代码应一起提交，便于按 Git 版本比较。可用 `ifg guide validate --json` 验证当前工作区，或加 `--ref <提交>` 验证历史版本。

## HTTP API

- 在仓库提交 OpenAPI YAML 或 JSON。命名为 `openapi.yaml`、`openapi.json` 或在 `.ifaceforge.json` 中指定路径。按业务版本分别维护文档，使用 `info.version` 标记业务版本。
- 为操作提供稳定的 `operationId`、HTTP 方法、路径、参数、请求体和成功及错误响应。给分页、缺少参数、无权限等情况加入可验证示例。
- 让相对 `$ref` 指向同仓库、同提交的文件。维护不同分支时，声明和引用一并提交。对于 Swagger 历史格式，保留原始资源列表和资源声明。
- 服务提供 OpenAPI 地址时，可在 API 面板直接导入。Express 与 FastAPI 源码识别适合校对路由位置。任意语言都可以通过 OpenAPI 声明提供完整定义。
- Express 扫描从框架创建的应用、路由器与路由链确认服务端注册。可识别的 `fetch`、Axios 和客户端工厂调用作为调用证据，能匹配接口时附在对应条目的来源里；未匹配的调用可在扫描诊断中查看。
- 自定义 Python HTTP 扫描可读取标准库处理器、固定字符串、仓库内导入的字符串常量及可静态解析的 `re.fullmatch()` 路由。它结合提前返回和字面量分发表确认方法，并与同服务的 OpenAPI 合并。正则来源保留原始表达式，测试目录中的自定义 HTTP 服务跳过源码识别。动态路径会指出具体表达式，缺少契约的已识别路由会指出方法和路径。`catalog list --kind api --json` 的 `coverage` 给出数量及示例。

[HTTP 测试项目](https://github.com/qq940500529/ifaceforge/tree/main/fixtures/express) · [OpenAPI 版本索引](https://spec.openapis.org/oas/)

## MCP

- 服务应发布稳定的工具名、资源 URI、资源模板和提示词名。填写描述、输入／输出 Schema，标明参数是否必需，给响应提供可测试示例。
- 离线清单可命名为 `mcp-capabilities.json`，填写 `schemaVersion: 1`、`service`，以及适用的 `protocolVersion`、`serverVersion`。用 `tools`、`resources`、`resourceTemplates` 和 `prompts` 数组发布能力。资源条目提供 `uri`，模板提供 `uriTemplate`。清单适用于所有语言。
- JavaScript／TypeScript 中可用常量和明确定义的常见 SDK 注册方法，帮助源码扫描定位。用隔离发现核对运行时注册的能力与离线清单。
- 在提交中提供容器内启动命令，必要时指定含依赖的镜像。项目配置只引用凭据环境变量。选择协议版本和传输，测试工具、资源、模板及提示词。

[MCP 隔离运行指南](mcp.md) · [MCP 规范](https://modelcontextprotocol.io/specification/2026-07-28)

可直接提交以下 `mcp-capabilities.json`，再将能力和参数替换为服务的实际定义。

```json
{
  "schemaVersion": 1,
  "service": "tasks",
  "serverVersion": "1.0.0",
  "tools": [{ "name": "list-tasks", "inputSchema": { "type": "object", "properties": {} } }],
  "resources": [{ "name": "status", "uri": "task://status" }],
  "resourceTemplates": [{ "name": "task-by-id", "uriTemplate": "task://items/{id}" }],
  "prompts": [{ "name": "summarize-task", "arguments": [{ "name": "id", "required": true }] }]
}
```

## Skills

- 一个技能目录放一个 `SKILL.md`，用 YAML 页首声明 `name` 和 `description`。名称与目录相同，描述说明技能适用的任务。
- 在正文写清输入、输出、使用步骤与验收条件。较长材料放在 `references/`，脚本和资源放在 `scripts/`、`assets/`，引用用相对路径。
- 可在 `metadata.version` 标记技能版本，Git 提交记录版本变更。在测试里同时验证技能正文以及每个本地引用能否从对应提交读取。
- 引用脚本时写明前置环境和执行条件。扫描只读取并检查声明与路径，脚本由使用者按需运行。

[技能测试样例](https://github.com/qq940500529/ifaceforge/tree/main/fixtures/express/skills/read-tasks) · [Agent Skills 规范](https://agentskills.io/specification)

## 阅读和验证

- 客户端「开发指南」内置同一份 Markdown、兼容矩阵与扫描诊断。
- `ifg guide show --lang zh-CN --json` 输出正文、兼容矩阵和诊断规则。使用 `--lang en` 获取英文。
- `ifg guide serve` 通过 stdio 提供只读 MCP 文档资源。客户端可发现中英文指南和兼容矩阵。
- CI 可运行 `ifg guide validate --json` 并按规则代码、位置及严重程度处理。建议类条目与规范问题分开标明。
