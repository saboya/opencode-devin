# OpenCode Devin subscription plugin

Use models from your **Devin subscription** in OpenCode's own agent loop, with
OpenCode executing local tools. Provider ID: `devin`.

Targets **OpenCode V2 beta**, tested with `opencode2 v0.0.0-beta-19242` and
`@opencode/plugin@0.0.0-beta-19507`. These builds use `ctx.catalog` and AI SDK
hooks; newer V2 builds with `ctx.provider` require a plugin API migration.

## Setup

Requires Node.js 22.18+, npm, a compatible OpenCode V2 beta, and a Devin account
with access to CLI models. Clone this repository, then install its dependencies:

```sh
cd opencode-devin
npm ci
```

### 1. Authenticate

Use an existing Devin CLI session token through an environment variable:

```sh
export DEVIN_SESSION_TOKEN='devin-session-token$YOUR_TOKEN'
```

Keep the entire token value, including its prefix. Single quotes preserve the
literal `$`. On the machine where Devin CLI is signed in, find the value of
`windsurf_api_key` in its `credentials.toml` file. The plugin reads the standard
macOS/Linux location, `~/.local/share/devin/credentials.toml`, or
`$XDG_DATA_HOME/devin/credentials.toml`. On Windows, the official CLI stores it
under `%APPDATA%\devin\credentials.toml`; point `DEVIN_CREDENTIALS_PATH` there
to use that file with this plugin.

Alternatively, use an existing local `devin auth login`, or run the included
browser sign-in helper:

```sh
npm run login
```

`login` opens Devin's browser sign-in on macOS and prints the URL on all
platforms. Open it in a browser **on the machine running the command**, since it
returns to a loopback callback. It saves a CLI session token in
`~/.local/share/devin/credentials.toml` (or `$XDG_DATA_HOME/devin/credentials.toml`),
with permissions `0600`. The browser helper has not yet been verified live;
environment-token authentication has.

Do not commit tokens or put them in OpenCode configuration. `.env` files are
ignored by Git, but the plugin does not load them automatically: the OpenCode
server process must inherit the exported variable.

### 2. Verify access

```sh
npm run models
npm run probe -- <model-id-from-the-list>
```

The probe makes one short inference request using your subscription.

### 3. Load the plugin in OpenCode

The project-local `.opencode/plugins/devin.ts` loads the plugin automatically
when you work in this directory. To use it elsewhere, add its directory to your
OpenCode configuration, replacing `/absolute/path/to/opencode-devin` with your
checkout's actual path:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["file:///absolute/path/to/opencode-devin"]
}
```

For beta builds where external plugin directory loading is inactive, create
`.opencode/plugins/devin.ts` in the destination project instead:

```ts
export { default } from "/absolute/path/to/opencode-devin/src/index.ts";
```

Restart OpenCode after signing in. Pick `devin/<model-id>` using `/models`, or:

```sh
opencode2 run --standalone -m devin/<model-id> "Say pong"
```

For example, if your account lists SWE-2:

```sh
opencode2 run --standalone -m devin/swe-2 "Explain this project"
opencode2 run --standalone -m 'devin/swe-2#high' "Review this project's code"
```

## Authentication and options

Credential precedence:

1. `DEVIN_SESSION_TOKEN`
2. `WINDSURF_API_KEY`
3. The Devin CLI credential file (`DEVIN_CREDENTIALS_PATH` overrides its location)

These are **CLI inference credentials**. Devin Cloud API keys/PATs (`cog_`,
`apk_`) are for session management and are rejected here. Credentials are read
again for each inference call; restart OpenCode after switching accounts to
refresh the account's model catalog.

Server precedence: `DEVIN_API_SERVER_URL`, `WINDSURF_API_SERVER_URL`, the saved
credential's `api_server_url`, then `https://server.codeium.com`. Overrides accept
HTTPS or loopback HTTP for development. Browser sign-in targets the public Devin
deployment; for a dedicated deployment, authenticate through the official CLI.

The plugin fails to load with a clear error when credentials or account-specific
model discovery are unavailable. It does not invent a fallback model catalog.
Discovery runs at plugin setup; restart OpenCode to refresh models. Reasoning
efforts returned by Devin become OpenCode model variants.

## Model pricing and usage

The plugin loads account-specific input, output, and cached-input prices from
Devin's live model catalog and supplies them to OpenCode. These rate-card values
are cost estimates, not measurements of your subscription quota or additional
charges. Prices refresh when the plugin loads.

Session cost calculation also depends on the token usage returned by Devin.
The initial live SWE probe returned zero token counts, so live usage and cost
accounting are not yet fully verified. Cache-write pricing is currently reported
as zero by the protocol library rather than as a separate rate.

## Troubleshooting plugin loading

If the shared service reports `Cannot find package '@opencode/plugin'` even
though `npm install` completed and standalone runs work, restart the background
service from a terminal with `DEVIN_SESSION_TOKEN` exported:

```sh
opencode2 service restart
opencode2 service status
```

The running beta service can retain failed dependency resolution from when the
plugin first appeared before its dependencies were installed. Reloading a session
or editing the plugin does not clear that process-level state. Reconnect the UI
after restarting the service.

## Implementation

- `src/index.ts`: V2 beta provider registration and scoped AI SDK hooks.
- `src/language.ts`: `LanguageModelV3` adapter, streaming and non-streaming output,
  reasoning, tool calls, cancellation, usage, and error mapping.
- `src/messages.ts`: conversation, local tool results, and inline image conversion.
- `src/auth.ts`: CLI credentials and environment overrides.
- `src/catalog.ts`: live account-specific model discovery.

The pinned MIT-licensed [`ns-devin-core@0.3.0`](https://www.npmjs.com/package/ns-devin-core)
handles protobuf, Connect framing, authentication exchange, and model discovery.
Its **in-process** APIs are called explicitly; the Go sidecar is not launched.
The official Cognition SDK manages Devin agent sessions and doesn't provide the
raw model interface this integration needs.

Supported: text, reasoning, function tools, inline image input/tool results,
and reasoning-effort variants. Fusion and Adaptive entries are filtered out.
Forced tool selection, JSON-schema response format, provider-executed tools,
and non-image file parts are rejected explicitly. Optional unsupported sampling
settings produce SDK warnings.

## Verification

```sh
npm run typecheck
npm test
npm run test:opencode  # requires opencode2 on PATH; uses a loopback fixture
```

The protocol test exercises real protobuf/Connect framing over loopback, including
a streamed tool call and its result on the following turn. The OpenCode smoke test
loads the plugin in an isolated project and uses fake credentials against the same
kind of fixture. Neither spends subscription quota.

**Status:** typecheck, protocol tests, and the installed OpenCode beta smoke test
pass. Live testing on 2026-10-16 also passed: environment-token authentication,
discovery of 26 account models, SWE-1.6 inference, an OpenCode `pwd` tool round
trip, and Claude Haiku 5.5 with the `low` effort variant. The short SWE probe
reported zero token usage; live usage accounting still needs investigation.
Browser sign-in, image input, and compaction have not yet been verified live.
`probe` makes one short inference request against your subscription.

See [`docs/devin-protocol.md`](docs/devin-protocol.md) for research and remaining
verification work. This project is unaffiliated with Cognition/Devin.
