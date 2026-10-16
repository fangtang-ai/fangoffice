# 方塘Office Privacy

Last updated: October 11, 2026

方塘Office opens, edits, and saves documents locally. Document editing does not
upload files to anyone. AI features require a network connection and send
requests when you use them — to the Fangtang account-managed service, the
model endpoint your organization configured, or the provider you chose in
Settings → AI Model.

## Usage analytics

Source builds without injected analytics credentials do not send usage
events. Packaged builds with credentials can report usage through Google
Analytics using a random installation identifier, application metadata, and
coarse usage events. These events do not include your Fangtang account
identity, document content, file names, or file paths. Reporting is enabled
by default when configured; you can disable it in Settings → General.

## Account and billing services

Managed AI and policy MCP services use your existing Fangtang account and
the configured Logto sign-in service. The configured Fangtang backend handles
account information, separate AI and MCP wallets, recharge orders, and
service consumption records; these records are not limited to your machine.
Company endpoints and BYOK providers use their own configured credentials.

Documents, application settings, and the persisted sign-in session are stored
in the app's local `userData/` directory. Session persistence uses Electron
safeStorage encryption when available. The current implementation falls back
to unencrypted session storage when encryption is unavailable; deployments
must account for that limitation before allowing sign-in on such systems.
Signing out clears the local persisted session.

## AI requests

When you use an AI feature, the relevant document context (for example the
current document's block outline or the selected cells), and any attachments
included in the request, are sent to the selected service together with your
instruction. Use of that service
is subject to your organization's policies. Built-in web/image search tools
query public search backends with your search keywords. MCP tool calls are
sent only to the servers your administrators registered in
`fangtang-mcp.json`, including account-managed policy MCP when enabled. Tool
arguments can contain your search terms or other context selected for that
tool. Managed service usage is recorded by the backend for billing.

## Crash reports and auto-update

No crash reports are collected. When an update feed is configured
(`FANGTANG_UPDATE_URL`), the app contacts that feed to check for updates.
