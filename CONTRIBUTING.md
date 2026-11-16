# Contributing to IfaceForge

[简体中文 README](README.md) · [Development specification](docs/development-spec.md) · [Build and release](docs/release.md)

Use GitHub Issues for reproducible problems and feature requests. Use Discussions for questions or design proposals. Handle security reports through [private reporting](SECURITY.md).

## Develop locally

Install Git and the current Node.js LTS supported by `package.json`. Clone the repository, then run the commands below.

```sh
npm ci
npm run build
npm start
```

Use a Git test worktree when reproducing issues. Test desktop changes in a real app window. Include screenshots for visible UI changes, and exercise details, individual buttons, grouped actions and narrower windows.

```sh
npm run check
npm run test:unit
npm run test:integration
npx playwright install chromium
npm run test:e2e
npm run test:desktop
```

The integration suite can run FastAPI against Python and the fixture requirements in `fixtures/fastapi/requirements.txt`. For Linux desktop tests, run within a desktop session or use `xvfb-run -a npm run test:desktop`.

## Open a pull request

Describe the behavior, the expected project scope and what you tested. Keep real repository paths, credentials and service outputs out of reports. For a new feature, add targeted regression coverage and update the relevant user guide. Wait for the required checks before merging.
