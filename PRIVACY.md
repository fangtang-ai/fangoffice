# 方塘Office Privacy

Last updated: September 7, 2026

方塘Office opens, edits, and saves documents locally. Document editing does not
upload files to anyone. AI features require a network connection and send
requests only when you use them — and only to the model endpoint your
organization configured (or the provider you chose in Settings → AI Model).

## Usage analytics

This build ships without analytics credentials. The telemetry client is
compiled in but permanently inactive: no usage events are collected or sent.

## No account system

方塘Office has no sign-in and no account. Documents, settings, and AI
configuration stay on your machine (the app's `userData/` directory), and AI
requests are authenticated only by the API key your deployment configured.

## AI requests

When you use an AI feature, the relevant document context (for example the
current document's block outline or the selected cells) is sent to the
configured model endpoint together with your instruction. Use of that service
is subject to your organization's policies. Built-in web/image search tools
query public search backends with your search keywords. MCP tool calls are
sent only to the servers your administrators registered in
`fangtang-mcp.json`.

## Crash reports and auto-update

No crash reports are collected. When an update feed is configured
(`FANGTANG_UPDATE_URL`), the app contacts that feed to check for updates.
