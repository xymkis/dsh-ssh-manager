# dsh-ssh-manager — build contract (read fully before writing code)

A persistent DeepSeek Harness (DSH) plugin bundle for the current Web/Desktop profile. It stores Linux SSH
server connection profiles, exposes a management UI inside the DSH **Settings** shell, and gives the agent
two tools so it can recognize the configured servers and run remote commands.

Package name: `@local/dsh-ssh-manager` · version `1.0.0` · `"type": "module"` · ESM only, plain JavaScript,
**no TypeScript, no JSX, no build step**. All files live under `plugins/dsh-ssh-manager/` in this workspace.

## Non-negotiable rules

1. The plugin is installed by the Lead with `plugin_manager install_bundle` on the absolute directory
   `D:\pyproject\运维工具\opschain\plugins\dsh-ssh-manager`. Do not install anything yourself, do not edit
   `~/.dsh`, do not run `pnpm` in the profile.
2. Host files may import only Node built-ins (`node:*`) and the bare package `ssh2` (already installed in
   `plugins/dsh-ssh-manager/node_modules`). **Never import any `@deepseek-ai/*` package.**
3. `client.js` may `require` only `react`. Never import/require `@deepseek-ai/dsh-client-ui-primitives` or any
   other Harness package; write your own controls and styles.
4. Never send, log, render, or include in an agent tool result any password / private key / passphrase.
   The server list views expose only `hasPassword` / `hasKey` booleans.
5. Only write the files listed under your ownership. Do not touch `package.json`, `cordis.patch.yml`,
   `locale/*.json`, `icon.svg`, `README.md`, `CONTRACT.md`.
6. Code style: readable ES2022, `const`/`let`, JSDoc on exported functions, comments in English. No external
   formatting tools required. Every file must pass `node --check <file>`.

## Ownership

| Owner | Files |
| --- | --- |
| host-dev | `index.js`, `host/store.js`, `host/ssh.js`, `host/api.js`, `host/tools.js`, `host/prompt.js`, `scripts/smoke-host.mjs` |
| client-dev | `client.js` (single self-contained file) |
| Lead | `package.json`, `cordis.patch.yml`, `locale/en.json`, `locale/zh.json`, `icon.svg`, `README.md`, `.gitignore`, `CONTRACT.md`, install + verification |

## Runtime facts verified for this DSH build (0.2.1-rc.3)

- Host plugin entry: `export function apply(ctx, config) {}` plus `export const inject = [...]`.
- `ctx.inject` names used here: `['tools', 'systemPrompt', 'webServer', 'connection']` (all present in the
  desktop profile).
- `ctx.effect(() => cleanup, 'label')` registers a resource owned by the plugin fiber.
- Web routes: `ctx.webServer.register({ kind: 'prefix', path: '/ssh-manager/api', handler })` where the
  handler is `(req: IncomingMessage, res: ServerResponse) => void | Promise<void>`. It returns a disposer.
  Browser-trust check: `ctx.connection.requestRejection(req) === undefined` (empty return means accepted).
- Tools: `ctx.tools.register(definition)` → disposer. Definition shape:
  `{ name, description, parameters /* JSON Schema object */, output: { schema /* JSON Schema */, render(args, value) => [{ type: 'text', text }] }, execute(args, exec) => Promise<jsonValue>, presentCall?(args) => ({ card: 'generic', title }), isConcurrencySafe?(args) => boolean }`.
- Prompt section: `ctx.systemPrompt.section({ name, order, text })` where `name` is unique, `order` is a
  finite number, `text` is `string | ((assembleContext) => string)`. Returns a disposer.
- Client slot registration: `ctx.slots.inject('settings.section', () => ctx.slots.register({...}, Component))`.
  Registration options: `{ name: 'settings.section', id: 'ssh-manager', order: 110, locale: 'sshManager', label: () => translate('nav') }`.
  Passing `locale` makes the slot hand the component a `t` prop (`t('key')`) bound to that namespace.
- Client module file format (exactly this wrapper; the id must equal the package name):
  ```js
  window.__ModuleLoader__.load({
    id: '@local/dsh-ssh-manager',
    factory(require) {
      const React = require('react')
      /* ... */
      return { inject: ['slots', 'locale'], apply(ctx) { /* ... */ } }
    },
  })
  ```
  The factory may also mutate `module.exports`-style, but returning `{ inject, apply }` is simplest.
- Client module needs React only; it has access to the page (`document`, `window`, `fetch`, `URL`).
- Theme tokens (always pass a fallback): `--dsw-alias-bg-base`, `--dsw-alias-bg-layer-1`,
  `--dsw-alias-bg-layer-2`, `--dsw-alias-bg-overlay`, `--dsw-alias-border-l1`, `--dsw-alias-border-l2`,
  `--dsw-alias-brand-primary`, `--dsw-alias-label-primary`, `--dsw-alias-label-secondary`,
  `--dsw-alias-state-error-primary`, `--dsw-alias-state-success-primary`, `--dsw-alias-state-warn-primary`,
  `--dsw-alias-state-idle-primary`. Richer aliases used by the host pages exist too
  (`--dsw-alias-label-tertiary`, `--dsw-alias-bg-layer-3`, `--dsw-alias-interactive-bg-hover`,
  `--dsw-alias-button-primary-fill`); use them only with a listed-token fallback, e.g.
  `var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, inherit))`.

## Persistence model (host/store.js)

Data dir resolution, first match wins:
1. `process.env.DSH_PROFILE_DIR` → `<dir>/data/ssh-manager`
2. `process.env.DSH_HOME` → `<home>/ssh-manager`
3. `path.join(os.homedir(), '.dsh', 'ssh-manager')`

File `<dataDir>/servers.json` — a JSON array of records. Directory created recursively; writes are atomic
(`servers.json.tmp` then `rename`) and serialized through a promise chain. File permissions: `0o600` on
POSIX (`chmod` best-effort, ignore failure).

Record (persisted, contains secrets):
```js
{
  id: string,                 // crypto.randomUUID()
  name: string,               // display name, unique (case-insensitive)
  host: string,
  port: number,               // 1..65535
  username: string,
  authType: 'password' | 'key',
  password?: string,          // only for authType 'password'
  privateKey?: string,        // only for authType 'key'
  passphrase?: string,        // optional
  note?: string,
  createdAt: string,          // ISO
  updatedAt: string,          // ISO
}
```

Public view (never contains secrets), used by API and tools:
```js
{ id, name, host, port, username, authType, hasPassword, hasKey, note, createdAt, updatedAt }
```

Store module API — `createStore(options = {})` returns:
- `dataDir(): string`
- `load(): void` — lazy read on first use; corrupt file backs up to `servers.json.corrupt-<ts>` and starts empty
- `list(): PublicServer[]` (sorted by name, `localeCompare`)
- `get(id): PublicServer | undefined`
- `find(query): PublicServer | undefined` — match id, then exact name (case-insensitive), then unique name prefix
- `getSecretRecord(id)` — internal full record or `undefined` (host-only; used by ssh module)
- `async create(draft): PublicServer`
- `async update(id, patch): PublicServer`
- `async remove(id): boolean`
- `async testDraft(draft): ServerInput` — merge with existing secret when `draft.id` is given and no new secret supplied; returns a full record for connection testing without persisting
- `toView(record)`

Create/update validation (throw `Error` with `error.code = 'invalid-input'`, Chinese message):
- `name`: optional on create (default `${username}@${host}`), trimmed; duplicates → `code:'conflict'`
- `host`: required, trimmed, no whitespace
- `port`: integer 1..65535, default 22
- `username`: required
- `authType`: required, `'password'` or `'key'`
- create: password required for `'password'`, privateKey required for `'key'`
- update: `undefined` or `''` secret input means "keep the stored secret"; a non-empty value replaces it;
  changing `authType` requires a matching new secret
- `note`: optional, max 500 chars

## SSH execution (host/ssh.js)

Use `ssh2` (`import ssh2 from 'ssh2'; const { Client } = ssh2`). Do not use the OpenSSH binary.

`createSshClient()` returns:
- `async exec(record, command, options = {})` → `{ exitCode: number | null, signal: string | null, stdout: string, stderr: string, durationMs: number, truncated: boolean }`
  - `options.timeoutMs` default 60000, clamp 1000..600000
  - `options.connectTimeoutMs` default min(15000, timeoutMs)
  - exec channel; collect both streams; cap stdout at 512 KiB and stderr at 256 KiB, set `truncated: true`
  - on timeout: end the client and throw an Error with `code:'timeout'`
  - always `client.end()` in `finally`
- `async probe(record, options = {})` → `{ success: true, latencyMs, output }` on success;
  throws a friendly `Error` (`code` one of `'timeout'`, `'network'`, `'auth'`, `'unknown'`, Chinese message)
  on failure. Probe runs `uname -srm; printf '\n'; id -un` (POSIX shell) and returns its stdout.
- Connection config: `{ host, port, username, readyTimeout, keepaliveInterval: 10000 }`, plus
  `password` or `privateKey` (+ `passphrase`). Host-key policy: accept (documented in README).
- Map ssh2 errors to friendly messages: `ECONNREFUSED`, `ENOTFOUND`/`EAI_AGAIN`, `ETIMEDOUT`, auth failures
  (`All configured authentication methods failed`, `Permission denied`). Never put secrets in messages.

## HTTP API (host/api.js)

Prefix route `/ssh-manager/api`; every call is `POST /ssh-manager/api/<method>` with a JSON body (max 1 MiB)
and a JSON response. Reject non-POST with 405, rejected trust with 403, bad JSON with 400.

Success: `200 { "ok": true, "data": <payload> }`
Failure: `200/400/404/409 { "ok": false, "error": { "code": "<code>", "message": "<Chinese message>" } }`

Methods:
| method | request body | data |
| --- | --- | --- |
| `list` | `{}` | `{ servers: PublicServer[] }` |
| `get` | `{ id }` | `{ server: PublicServer }` |
| `save` | `{ id?, name?, host, port?, username, authType, password?, privateKey?, passphrase?, note? }` | `{ server: PublicServer }` |
| `delete` | `{ id }` | `{ deleted: true }` |
| `test` | `{ id }` | `{ success: true, latencyMs, message, output }` |
| `test-draft` | same shape as `save` | same as `test` |

`test`/`test-draft`: a failed connection is a **successful API call** with
`data = { success: false, latencyMs?, message, output? }`; only invalid input / missing id / trust failures
produce `ok:false`. Handle request aborts (`req.on('close')`) without crashing.

## Agent tools (host/tools.js)

Register exactly two global tools (names are model-facing; keep them stable):

### `ssh_servers`
- description (English, tells the model what it does and when): list configured Linux SSH servers, or test
  connectivity to one of them.
- parameters:
  ```json
  {
    "type": "object",
    "properties": {
      "action": { "type": "string", "enum": ["list", "test"], "description": "list = show configured servers (no credentials); test = verify connectivity to one server" },
      "server": { "type": "string", "description": "Server id or name; required for action=test" },
      "timeout_seconds": { "type": "number", "description": "Connectivity test timeout in seconds (1-120, default 20)" }
    },
    "required": ["action"]
  }
  ```
- output schema: `{ type: 'object', properties: { servers: {...}, result: {...} } }` (keep JSON-safe).
- `execute`: for `list` returns `{ servers: PublicServer[] }`; for `test` resolves the server via
  `store.find`, runs `ssh.probe`, returns `{ result: { server: name, success, latencyMs, message, output? } }`.
  Never throw raw errors: return a JSON object with a `message` field on failure (the harness shows it).
- `render`: a readable text listing, e.g. one line per server with name, `user@host:port`, auth type.

### `ssh_exec`
- description: run a shell command over SSH on a configured Linux server and return stdout/stderr/exit code.
- parameters:
  ```json
  {
    "type": "object",
    "properties": {
      "server": { "type": "string", "description": "Server id or name from ssh_servers" },
      "command": { "type": "string", "description": "Shell command to run remotely" },
      "timeout_seconds": { "type": "number", "description": "Command timeout in seconds (1-600, default 60)" }
    },
    "required": ["server", "command"]
  }
  ```
- output schema: `{ type: 'object', properties: { server: {type:'string'}, exitCode: {type:'object'}... } }`
  — simplest acceptable shape: `{ type: 'object', properties: { server: { type: 'string' }, exitCode: { type: 'number' }, durationMs: { type: 'number' }, stdout: { type: 'string' }, stderr: { type: 'string' }, truncated: { type: 'boolean' }, message: { type: 'string' } } }`.
  If exec throws (auth/network/timeout), return `{ server, message, exitCode: null, stdout: '', stderr: '' }`
  instead of throwing.
- `render`: text block:
  `server: <name> (<user>@<host>:<port>)\nexit: <code> · <ms>ms\n--- stdout ---\n...\n--- stderr ---\n...`
  Prefix `[truncated]` markers when applicable.
- `isConcurrencySafe: () => true`.

Registered tools must return their disposer through the single `ctx.effect` gathered by `index.js`
(each register call returns a disposer).

## Prompt section (host/prompt.js)

`ctx.systemPrompt.section({ name: 'ssh-manager:servers', order: 40, text: () => string })`; text (English),
refreshed every assembly from the live store:
- when servers exist: a `## SSH servers` block telling the model it may use `ssh_servers` to list/test and
  `ssh_exec` to run commands, then one bullet per server: `- <name> — <user>@<host>:<port> (password|private key auth)`
- when none exist: one line saying no SSH servers are configured and the user can add them in Settings → SSH Servers.
- never secrets; server names come from user input so wrap them in the fixed text only (no markdown injection
  beyond the intended list).

## index.js

```js
import { createStore } from './host/store.js'
import { createSshClient } from './host/ssh.js'
import { registerApiRoutes } from './host/api.js'
import { registerTools } from './host/tools.js'
import { registerPromptSection } from './host/prompt.js'

export const inject = ['tools', 'systemPrompt', 'webServer', 'connection']
export function apply(ctx) { /* create store + ssh, one ctx.effect gathering every disposer */ }
```
Load the store eagerly inside `apply` (`store.load()`), swallow load errors into a warning (do not crash the
plugin tree). Each `register*` returns its disposer or an array of disposers.

## Client UI (client.js)

Destination: one **Settings section** (`settings.section`, id `ssh-manager`, order `110`,
label from the `sshManager` locale namespace). The host settings shell provides the scroll container and the
nav row; the section renders a content column (`max-width: 760px`) like the "Side card" plugin section.
Visual reference for the DSH settings recipes (cards, rows, inputs, buttons, tokens) — read it before styling:
`C:\Users\xym\.dsh\profiles\desktop\node_modules\dsh-better-sidebar\src\client\SideCardSection.module.css`
and the installed community setting section in
`C:\Users\xym\.dsh\profiles\desktop\node_modules\dsh-better-sidebar\src\client\SideCardSection.tsx`.

Required behaviour:
1. On mount, `POST` to `ssh-manager/api/list`; loading state; error banner with a retry button on failure.
2. Header: section intro line, a primary "add server" button, server count badge.
3. One card/row per server: name + `user@host:port` + auth-type badge + secret-configured indicator + note;
   actions: **Test** (per-row, shows inline success/failure + latency + remote uname output on success),
   **Edit**, **Delete** (two-step inline confirmation: first click shows 确认删除/取消).
4. Add/Edit dialog (custom overlay, no external primitives; `position: fixed` inset 0, `role="dialog"`,
   `aria-modal="true"`, focus first field on open, Escape closes, backdrop click closes, Tab stays usable,
   body scroll locked while open and restored on close). Fields: name (optional), host (required),
   port (default 22), username (required), auth type radio (`密码` / `私钥`), password input (type=password)
   or private-key textarea (monospace, placeholder "-----BEGIN OPENSSH PRIVATE KEY-----"), optional
   passphrase, optional note. When editing, existing secret fields start empty with a hint
   "留空表示保持不变" / "Leave empty to keep the saved credential". Save is async with disabled state and
   shows server-returned errors inline. "Test connection" button inside the dialog calls
   `ssh-manager/api/test-draft` with the current draft (id included when editing).
5. After save/delete/test/list, state stays consistent; no full-page reload.
6. All copy through the `t` prop; locale namespace `sshManager` with dictionaries `zh` and `en`
   (every key present in both). Register with `ctx.locale.register('sshManager', { zh, en })` inside
   `ctx.effect`; slot `label: () => translate('nav')` where `translate = ctx.locale.bind('sshManager')`.
7. Styles installed once by `ctx.effect(installStyles)` using a `<style id="dsh-ssh-manager-styles">`
   element (return a disposer). Class names must start with `dsh-ssh-`. Use only theme tokens (with
   fallbacks) — no hard-coded UI colors. Support light/dark automatically through tokens.
8. No secrets are ever rendered. Password/key input values stay in component state only.
9. Empty state: card with title/description and the add button.
10. Keep the code under ~900 lines, componentized (`Section`, `ServerCard`, `EditorDialog`, `ConfirmDelete`,
    small controls). No `eval`, no string-built HTML, no `dangerouslySetInnerHTML`.

API helper in client:
```js
async function call(method, body) {
  const url = new URL('ssh-manager/api/' + method, document.baseURI)
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
  const payload = await res.json().catch(() => null)
  if (!res.ok || payload === null || payload.ok !== true) {
    throw new Error(payload?.error?.message || `请求失败 (${res.status})`)
  }
  return payload.data
}
```

Minimum locale keys (both languages): `nav`, `intro`, `add`, `count`, `loading`, `retry`, `emptyTitle`,
`emptyDesc`, `colUser`, `authPassword`, `authKey`, `hasSecret`, `noSecret`, `test`, `testing`, `edit`,
`delete`, `confirmDelete`, `confirmDeleteDesc`, `cancel`, `save`, `saving`, `formAddTitle`, `formEditTitle`,
`fieldName`, `fieldNameHint`, `fieldHost`, `fieldPort`, `fieldUsername`, `fieldAuthType`, `fieldPassword`,
`fieldPrivateKey`, `fieldPassphrase`, `fieldNote`, `secretKeepHint`, `secretRequiredHint`, `testInDialog`,
`testOk`, `testFail`, `close`, `validationHost`, `validationPort`, `validationUsername`,
`validationPassword`, `validationKey`, `serverCountOne`, `serverCountMany`.
(The zh dictionary is authoritative; en mirrors it.)

## Verification each owner runs before reporting done

- host-dev: `node --check` on every file; then `node scripts/smoke-host.mjs` from the plugin directory.
  The script must (a) exercise store create/list/update/remove/duplicate-name/validation against a temporary
  dir under `plugins/dsh-ssh-manager/.smoke-tmp` (deleted afterwards), (b) call `ssh.probe` on a
  `127.0.0.1:1` record with `timeoutMs: 3000` and assert it rejects with a friendly non-secret message,
  (c) print `SMOKE OK`. Report the exact output.
- client-dev: `node --check client.js`; grep your own file for forbidden imports
  (`@deepseek-ai/`, `require('` lines must only require react) and report.
- Both: do not run install commands, do not write outside your ownership, keep the workspace clean.

## Integration after both halves are done (Lead)

1. Syntax-check, install with `plugin_manager`, confirm rows/tools/slot occupancy through inspection.
2. Exercise tools (`ssh_servers`, `ssh_exec` against an unreachable host for the error path) and the settings
   section presence; write the final report. Browser rendering may stay unverified if no browser control.
