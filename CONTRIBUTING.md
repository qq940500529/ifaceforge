# Contributing

Use Node 26 LTS and Git. Node 24 LTS is also covered by the compatibility checks. Run `npm ci`, `npm run check` and the relevant tests before submitting a change.

- `src/app` holds the workbench operations shared by CLI and Web. Extend the public schemas in `src/schemas` as part of a contract change.
- Add static discovery rules under `src/scanner`, with a fixture and a test. An adapter returns observations with a stable ID, file path and line number when available. Keep scanning read only.
- Keep user interface messages in `src/web/i18n.ts`. Every string needs an English and Simplified Chinese entry with the same placeholders.
- Use synthetic sample data. Keep machine settings, credentials, databases, generated reports and node_modules out of Git.

The development specification defines first release scope. The CLI manual documents the public automation contract.
