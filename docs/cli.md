# IfaceForge CLI

Run commands in a Git working tree, or supply `--project <id|directory>`. The CLI uses the desktop app's registry and project data. With a source build, replace `ifg` below with `node /path/to/ifaceforge/dist/cli/main.js`, or run `npm link` from the built IfaceForge repository to register the command.

## Discover the contract

```sh
ifg --help
ifg --version
ifg commands --json
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

## HTTP and MCP

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
ifg api send --file request.json --profile demo --json
ifg api curl --file request.json --profile demo --json
ifg api export capability-id --format yaml --json
```

A request file can be `{"method":"GET","path":"/tasks/42"}`. Use a path and profile, or an absolute HTTP(S) URL. Send query and header pairs in separate arrays. For a body use `{"type":"json","content":{"title":"Sample"}}`.

Create a profile with `mcp` set to `{"transport":"stdio","command":"node","args":["fixtures/express/mcp.mjs","stdio"]}` when the current project is the IfaceForge repository. For Streamable HTTP, start `node fixtures/express/mcp.mjs http modern` and use `{"transport":"streamableHttp","url":"http://127.0.0.1:4301/mcp"}`. The optional final argument to the server chooses its listening port. Use `legacy` in place of `modern` to exercise the 2025 protocol.

```sh
ifg mcp discover --profile sample-stdio --json
ifg mcp call echo --profile sample-stdio --args echo-args.json --json
ifg mcp read task://42 --profile sample-stdio --json
ifg mcp prompt task-summary --profile sample-stdio --args prompt-args.json --json
ifg mcp batch --profile sample-stdio --file sequence.json --json
```

Echo parameters are `{"value":"example"}`. Prompt parameters are `{"title":"Sample task"}`. For a batch, use a document with `schemaVersion: 1` and named steps with type `discover`, `call`, `read` or `prompt`. A step with `"extract":{"text":"/value"}` can supply `{{text}}` to a later step. Use batches or suites to reuse a connection.

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
ifg data backup --out ./backup.json --json
ifg data restore --file ./backup.json --replace --json
ifg data prune --before 2026-01-01 --json
ifg data prune --before 2026-01-01 --apply --json
```

Backups contain SQLite data and manual notes. Restore replaces local records when authorized with `--replace`. Regenerate the Wiki from the restored snapshots. Exported Wiki pages in user selected directories are managed by their manifests. Data pruning defaults to preview.
