# 用 `ifg` 查看契约、比较版本和执行验证

[CLI 命令参考](cli.md) · [API、MCP 与 Skills 开发指南](developer-guide.md) · [兼容矩阵](compatibility.json)

IfaceForge 用同一套桌面和 CLI 数据查找实际定义。开发时可以核对代码、接口声明和 MCP 能力；计划与审核时可以把结论对应到具体项目、提交、证据文件和测试结果。

## 探索命令和选定项目

```text
ifg --version --json
ifg commands --json
ifg project list --json
ifg schema request --json
ifg schema profile --json
```

优先使用命令清单的 `items[].name`、`parameters` 和 `writes` 生成调用。用进程参数列表传递命令和路径，每个路径占一个参数。用 `--project` 明确指定列表中的项目 ID 或绝对目录。首次登记先运行 `ifg project inspect "目录" --json` 核对 `data.root`，再运行 `ifg project add "工作树根目录" --exact --json`。

## 读取定义与变更证据

```text
ifg catalog list --project PROJECT --kind api --ref HEAD --limit 20 --json
ifg catalog list --project PROJECT --kind mcp --ref HEAD --limit 20 --json
ifg skill list --project PROJECT --ref HEAD --json
ifg git log --project PROJECT --ref BASE --ref TARGET --limit 24 --json
ifg compare --project PROJECT --base BASE --target TARGET --json
ifg source show --project PROJECT --ref TARGET --path "openapi.yaml" --json
```

用 `data.items[]` 获取条目 ID，再用 `catalog show` 或 `skill show` 获取定义。保留 Git SHA、来源路径、行号和诊断。对比前后都使用同一项目 ID。初始化、刷新和翻页只读取 Git 元数据。扫描只处理当前选择的提交。MCP 离线清单可提供声明，运行时能力用 `mcp discover` 确认。

阅读 API 目录时，核对 `data.coverage.unresolved` 和 `guide validate --ref TARGET --json` 的覆盖诊断。`call-site` 表示客户端调用，可用于溯源。自定义 Python HTTP 分发和动态注册可以通过 OpenAPI 声明补齐。

## 执行和跟踪测试

```text
ifg scan start --project PROJECT --json
ifg task watch TASK_ID --project PROJECT --stream
ifg mcp connect --project PROJECT --profile PROFILE --json
ifg mcp discover --project PROJECT --connection CONNECTION_ID --json
ifg mcp disconnect CONNECTION_ID --project PROJECT --json
ifg test run --project PROJECT --suite SUITE_ID --json
```

先核对目标和环境，再执行对外请求或修改本机状态的命令。敏感值用环境变量引用。读取 `ok`、`error.code` 和进程退出码。退出码 `1` 表示测试断言失败，可从 `data` 查看运行记录。后台命令返回任务 ID；轮询、跟踪或取消时复用该 ID。请求状态不明时先查运行记录，避免重复执行会改变目标状态的调用。

`--json` 输出一条结构化结果。`task watch --stream` 每行输出一个任务事件，最后一条含终态。使用 `ifg guide cli --json` 获取本文和命令数据。MCP 客户端可通过 `ifg guide serve` 的 stdio 资源读取 `ifaceforge://guides/cli-agent` 和 `ifaceforge://guides/cli-commands`。
