# Make APIs, MCP capabilities and Skills discoverable

[简体中文](developer-guide.md) · [Compatibility matrix](compatibility.json) · [CLI](cli.md)

Use the programming language of your choice. The scanner reads standard descriptions and server discovery results. Source adapters supply additional evidence. Commit descriptions with the implementation so that historical comparisons see the same revision. Run `ifg guide validate --json` for the working tree, or add `--ref <commit>` for history.

## HTTP API

- Commit an OpenAPI YAML or JSON document. Name it `openapi.yaml` or `openapi.json`, or configure its path in `.ifaceforge.json`. Use `info.version` for the service contract version.
- Give operations stable IDs, methods and paths. Define parameters, request bodies, successes and errors. Include examples for pagination, invalid input and access failures.
- Keep relative references within the same repository revision. For early Swagger descriptions, commit both the resource listing and the referenced declarations.
- Import a running service's OpenAPI document from its HTTP URL. The Express and FastAPI source adapters add route locations. Standard descriptions work across languages.
- Express discovery follows bindings created by the framework's application and router factories. Recognized `fetch`, Axios and client factory calls appear as call evidence. Matching calls attach to the endpoint's sources; unmatched calls appear in diagnostics.
- Discovery reports coverage gaps for recognizable custom Python HTTP dispatch and dynamic registration. `catalog list --kind api --json` includes a `coverage` summary, and `guide validate --json` reports locations. Publish or import an OpenAPI definition for those routes.

[HTTP test project](https://github.com/qq940500529/ifaceforge/tree/main/fixtures/express) · [OpenAPI releases](https://spec.openapis.org/oas/)

## MCP

- Use stable names and URIs for tools, resources, templates and prompts. Give parameters clear descriptions and schemas, and include examples that can be executed in a test.
- Commit a `mcp-capabilities.json` file with `schemaVersion: 1`, `service`, optional `protocolVersion` and `serverVersion`, and arrays named `tools`, `resources`, `resourceTemplates`, and `prompts`. Supply `uri` for resources and `uriTemplate` for templates. Any language can publish this manifest.
- Constants and common SDK registration methods make JavaScript and TypeScript source easier to inspect. Confirm values determined at runtime by connecting to the server. Compare the offline definitions against what the server actually advertises.
- Store credentials through environment references. Exercise discovery, tool calls, resource reads, template expansion and prompt retrieval using the protocol revision and transport offered by the service.

[MCP test project](https://github.com/qq940500529/ifaceforge/tree/main/fixtures/express) · [MCP specification](https://modelcontextprotocol.io/specification/2026-07-28)

Start with this `mcp-capabilities.json` and describe the capabilities the service actually exposes.

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

- Give each skill its own directory and a `SKILL.md` with YAML frontmatter containing `name` and `description`. Match the name to the directory and describe when the skill applies.
- Describe inputs, results, steps and verification. Place longer references in `references/`, scripts in `scripts/` and static files in `assets/`. Use relative links.
- Use `metadata.version` if you need a skill version label. Commit changes and verify the instructions and their local references in the same Git revision.
- Document dependencies and conditions for running any script. Scanning reads descriptions and checks paths. Script execution remains a user action.

[Skill test example](https://github.com/qq940500529/ifaceforge/tree/main/fixtures/express/skills/read-tasks) · [Agent Skills specification](https://agentskills.io/specification)

## Read and validate

- The desktop Developer guide displays the same Markdown, compatibility data and scan diagnostics.
- `ifg guide show --lang en --json` returns the Markdown, compatibility matrix and rule data. Set `--lang zh-CN` for Chinese.
- `ifg guide serve` exposes both guides and the compatibility matrix as read-only MCP resources over stdio.
- In CI, run `ifg guide validate --json` and inspect rule codes, locations and severity. Format requirements and recommendations have separate labels.
