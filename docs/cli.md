# IfaceForge CLI

Run commands in a Git working tree, or supply `--project <id|directory>`. The CLI uses the desktop app's registry and project data. With a source build, replace `ifg` below with `node /path/to/ifaceforge/dist/cli/main.js`, or run `npm link` from the built IfaceForge repository to register the command.

Download the CLI archive for Windows x64, Linux x64 or Apple Silicon macOS from [GitHub Releases](https://github.com/qq940500529/ifaceforge/releases). Extract it to a location you control and add the extracted `ifaceforge` directory to `PATH`. The archive includes its Node.js runtime. Git is an external dependency. Automation can start with `ifg guide cli --json`. [AI 调用指南](cli-agent.md)

## Discover the contract

```sh
ifg --help
ifg --version
ifg commands --json
ifg guide cli --json
ifg schema request
ifg schema profile
ifg schema case
ifg schema suite
```

`commands` lists the commands, options, write operations and examples. JSON input files accept `-` for standard input. MCP arguments also accept an inline JSON object. JSON mode emits one UTF-8 object followed by a newline. It contains `schemaVersion`, `ok`, `command`, `data` and `error`. Run failures retain their report in `data`. Exit status 0 means success, 1 an assertion failure, 2 invalid input, 3 an operation or target failure, and 4 a canceled, interrupted or unknown result.

## Inspect a project

```sh
ifg project add ./path-to-worktree --json
ifg project list --json
ifg project inspect ./path-to-worktree --json
ifg project select <project-id> --json
ifg project relocate <project-id> --directory ./moved-worktree --json
ifg project hide <project-id> --json
ifg project delete <project-id> --confirm --json
ifg preferences get --json
ifg preferences set --lang zh-CN --json
ifg update check --json
ifg status --project <project-id> --json
ifg config show --json
ifg config validate --file .ifaceforge.json --json
ifg config apply --file settings.json --json
ifg scan --include-untracked --require-complete --json
ifg scan list --json
ifg scan diff --from old-id --to new-id --json
ifg catalog search task --kind api --limit 20 --json
ifg catalog show capability-id --json
ifg skill search summary --json
ifg skill show skill-id --json
ifg source show --path openapi.yml --json
```

The initial scan uses tracked files. Add `--include-untracked` for new, unignored files. Use `--full` to bypass scan caching. Source reads accept UTF-8 project paths. `config apply` writes only to the local SQLite settings. For example, `{"schemaVersion":1,"locale":"zh-CN","scan":{"includeUntracked":true}}`.

`project add --exact` checks that the supplied directory is the Git worktree root. `project hide` preserves its local data. Add the same root to show it again. `project relocate` checks the worktree identity. `project delete` removes the application's records and leaves project files in place.

## Background tasks

```sh
ifg scan start --project <project-id> --json
ifg task list --all --json
ifg task show <task-id> --json
ifg task watch <task-id> --stream
ifg task cancel <task-id> --json
```

`api send`, MCP test commands, `test run`, `compare` and `git browse` accept `--async`. A started operation returns its task or run ID. Use `--project` when looking up a completed HTTP or MCP run. The desktop and CLI share the local workspace service; closing the window lets active work finish. `service status` reports availability. `service stop` stops the idle service. `--force` also ends active tasks and sessions.

## Browse and compare Git versions

```sh
ifg git branches --query release --limit 30 --json
ifg git log --ref release/2 --offset 0 --limit 24 --json
ifg git log --ref release/1 --ref release/2 --format graph
ifg git log --ref release/2 --query 'add endpoint' --limit 10 --json
ifg git commit HEAD --json
ifg git browse --ref release/2 --json
ifg catalog list --kind mcp --ref release/2 --json
ifg skill list --ref release/2 --json
ifg compare --mode branches --base release/1 --target release/2 --json
ifg compare --mode commits --base HEAD~3 --target HEAD --ancestor auto --json
ifg compare --base HEAD~3 --target HEAD --kind mcp --format markdown --out comparison.md --json
ifg compare file --base HEAD~3 --target HEAD --path openapi.yaml --json
```

`git branches` and `git log` read metadata. Historical catalog commands and comparisons scan the selected commit trees only. `--ancestor auto` uses a single common ancestor if available. Supply its SHA explicitly when Git reports multiple common ancestors. `git browse` without a ref restores the working-tree view. Commands that accept `--snapshot` can use the `snapshot` ID from `git browse` or `compare`; source reads also accept `--ref`.

## Developer guide

```sh
ifg guide show --lang en
ifg guide show --lang zh-CN --json
ifg guide validate --ref HEAD --json
ifg guide serve
```

`guide serve` exposes the two language editions, compatibility matrix and AI CLI reference as MCP resources over stdio. See the [developer guide](developer-guide.en.md) for the declarations and diagnostic rules.

## HTTP

A profile file for the Express example can contain the following document. From the IfaceForge repository, launch the fixture with `node fixtures/express/app.mjs`.

```json
{
  "schemaVersion": 1,
  "id": "demo",
  "name": "Task service",
  "variables": {},
  "http": { "baseUrl": "http://127.0.0.1:4300" }
}
```

Use `{"env":"MY_API_TOKEN"}` in a profile variable or credential field. Bind scalar variables with `{{name}}`. The workbench records a bounded preview and masks resolved secrets. For cURL, authentication headers are omitted.

```sh
ifg profile put --file demo.json --json
ifg profile list --json
ifg profile show demo --json
ifg api import --file openapi.yml --service tasks --json
ifg api import --url http://127.0.0.1:4300/contract --service tasks --json
ifg api draft capability-id --json
ifg api preview --file request.json --profile demo --json
ifg api send --file request.json --profile demo --assertions checks.json --json
ifg api curl --file request.json --profile demo --json
ifg api export capability-id --format yaml --json
```

A request file can be `{"method":"GET","path":"/tasks/42"}`. Use a path and profile, or an absolute HTTP(S) URL. Send query and header pairs in separate arrays. For a body use `{"type":"json","content":{"title":"Sample"}}`.

## MCP

Create a profile with `mcp` set to `{"transport":"stdio","command":"node","args":["fixtures/express/mcp.mjs","stdio"]}` when the current project is the IfaceForge repository. For Streamable HTTP, start `node fixtures/express/mcp.mjs http modern` and use `{"transport":"streamableHttp","url":"http://127.0.0.1:4301/mcp"}`. The optional final argument to the server chooses its listening port. Use `legacy` in place of `modern` to exercise the 2025 protocol.

```sh
ifg mcp discover --profile sample-stdio --json
ifg mcp connect --profile sample-stdio --json
ifg mcp status --json
ifg mcp discover --connection <connection-id> --json
ifg mcp disconnect <connection-id> --json
ifg mcp call echo --profile sample-stdio --args echo-args.json --json
ifg mcp read task://42 --profile sample-stdio --json
ifg mcp template 'task://{id}' --profile sample-stdio --args template-args.json --assertions assertions.json --json
ifg mcp prompt task-summary --profile sample-stdio --args prompt-args.json --json
ifg mcp batch --profile sample-stdio --file sequence.json --json
```

Echo parameters are `{"value":"example"}`. Template parameters are `{"id":42}`. Prompt parameters are `{"title":"Sample task"}`. Pass an optional JSON assertion array such as `[{"type":"textContains","pointer":"/contents/0/text","text":"Task"}]` to `--assertions` on any of these four actions. See the [MCP guide](https://qq940500529.github.io/ifaceforge/mcp.html) for test details.

A batch has `schemaVersion: 1` and named steps with type `discover`, `call`, `read`, `template` or `prompt`. Steps accept `assertions`. A step with `"extract":{"text":"/value"}` can supply `{{text}}` to a later step. Use batches or suites to reuse a connection.

## Cases and reports

```json
{
  "schemaVersion": 1,
  "id": "get-task",
  "name": "Read a task",
  "kind": "http",
  "profile": "demo",
  "request": { "method": "GET", "path": "/tasks/42" },
  "assertions": [
    { "type": "status", "equals": 200 },
    { "type": "jsonEquals", "pointer": "/id", "equals": 42 }
  ],
  "extract": { "taskId": "/id" }
}
```

```sh
ifg case put --file get-task.json --json
ifg case show get-task --json
ifg case export get-task
ifg suite put --file suite.json --json
ifg test run --case get-task --json
ifg test run --suite suite-id --profile demo --json
ifg run list --json
ifg run show run-id --json
ifg run cancel run-id --json
ifg run export run-id
```

Update a record with `--replace --version N` using the current version returned by `show`. To run a suite in order, supply `{"schemaVersion":1,"id":"suite-id","name":"Task checks","caseIds":["get-task"]}`. A sent MCP call can become unknown after an interruption. Inspect that same run ID.

## Wiki and data

```sh
ifg wiki preview --lang en --json
ifg wiki note-put capability-id --file note.md --json
ifg wiki build --lang zh-CN --out ./wiki-export --json
ifg wiki list --json
ifg wiki show export-id --page README.md --json
ifg wiki show export-id --page README.md --out wiki-preview.md --json
ifg wiki open export-id --json
ifg data backup --out ./backup.json --json
ifg data restore --file ./backup.json --replace --json
ifg data prune --before 2026-01-01 --json
ifg data prune --before 2026-01-01 --apply --json
```

Backups contain SQLite data and manual notes. Restore replaces local records when authorized with `--replace`. Regenerate the Wiki from the restored snapshots. Exported Wiki pages in user selected directories are managed by their manifests. Data pruning defaults to preview.

## Desktop actions and CLI equivalents

| Desktop operation                                      | CLI entry points                                                                    |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| Add, select, locate, hide or delete projects           | `project inspect/add/select/relocate/hide/delete`                                   |
| Language and update checks                             | `preferences get/set`, `update check`, `update open`                                |
| Scan progress and task center                          | `scan start`, `task list/show/watch/cancel`                                         |
| Git branches, graph, selection, and comparison         | `git branches/log/commit/select/browse`, `compare`, `compare file`                  |
| Catalog, source, and skill details                     | `catalog list/search/show`, `source show`, `skill list/search/show`                 |
| HTTP requests, assertions, source contracts and export | `api import/draft/preview/send/curl/export`                                         |
| MCP sessions, capability types and test actions        | `mcp connect/status/discover/call/read/template/prompt/disconnect/batch`            |
| Cases, suites and their results                        | `case`, `suite`, `test run`, `run`                                                  |
| Wiki and local data                                    | `wiki preview/build/list/show/open/note-show/note-put`, `data backup/restore/prune` |
| Developer guide and rules                              | `guide show/cli/validate/serve`, `commands`, `schema`                               |

A terminal graph lists commit lanes and parents. Native folder pickers and save dialogs correspond to explicit paths or `--out`. Text that the desktop can copy is available on stdout or in JSON fields.
