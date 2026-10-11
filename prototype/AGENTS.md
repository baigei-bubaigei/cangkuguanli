# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

## Standalone Preview

The user requires a self-contained HTML file that opens by double-clicking without a local service. Keep CSS and JavaScript inline, avoid external fonts/assets and runtime network requests, and regenerate the repository-root `仓库管理系统_双击打开.html` with `npm run build:standalone` after source changes. Treat the prototype as local-only unless the user explicitly asks to publish it.

The user requires native HTML, CSS and JavaScript with no React. Keep the standalone output framework-free. Render the entrance HTML into the file itself so content is visible before JavaScript starts. Validate startup and the main interactions with `npm run test:standalone`; syntax checks alone cannot confirm that the page works.

Do not provide a separate manual inventory initialization menu, page or stock-setting action. First-time manual stock entry uses the ordinary inbound flow. Keep the administrator-only initial Excel import and its completion control on the import page; closing initial import must not disable ordinary inbound operations.

Administrators can view both employee and administrator system operation logs, with source-system and actor filters. Keep the originating system, actor, account and time on each log. The employee log view remains restricted to employee-system records.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.
