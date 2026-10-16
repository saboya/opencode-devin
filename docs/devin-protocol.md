# Devin integration notes

## Goal and architecture

Reuse a Devin CLI subscription for model inference, with OpenCode retaining
conversation history, permissions, and local tool execution. A Devin Cloud
session/MCP handoff would delegate the agent loop and does not meet this goal.

Unlike Factory's proxy, Devin's CLI backend is a protobuf/Connect service.
The plugin registers an AI SDK `LanguageModelV3` through the V2 beta's
`aisdk.sdk` and `aisdk.language` hooks. There is no OpenAI HTTP translation server.

## Sources inspected (2026-10-16)

- Sibling `opencode-droid` implementation, especially its V2 beta API discoveries.
- [OpenCode V2 plugin docs](https://opencode.ai/v2/docs/build/plugins) and the
  installed `@opencode/plugin@0.0.0-beta-19507` type definitions. The docs describe
  a newer plugin API than this machine's beta-19242 binary.
- [Devin CLI quickstart](https://docs.devin.ai/cli/index.md),
  [model docs](https://docs.devin.ai/cli/models), and
  [Cloud API authentication](https://docs.devin.ai/api-reference/authentication).
- Official `@cognition-ai/ai-sdk@0.0.1-beta.7` and SDK packages: session/UI-stream
  adapters, rather than raw inference providers.
- `ns-devin-core@0.3.0` public TypeScript source/types (pinned runtime dependency).
- `@magpie-community/opencode-devin-auth@0.1.20` published source/README as a
  cross-check for login, model discovery, and the Connect transport. It targets
  the V1 plugin API and cannot directly replace this V2 plugin.

Local fixtures validate our adapter and OpenCode integration. Live checks below
also establish basic inference and local tool interoperability with Devin.

## Protocol paths implemented by the dependency

Default origin: `https://server.codeium.com`.

| Operation | Path | Purpose |
| --- | --- | --- |
| Discovery | `/exa.api_server_pb.ApiServerService/GetCliModelConfigs` | Account model inventory, capabilities, limits, costs, efforts |
| Auth | `/exa.auth_pb.AuthService/GetUserJwt` | CLI session credential → user JWT and optional custom server |
| Inference | `/exa.api_server_pb.ApiServerService/GetChatMessage` | Connect server-streaming protobuf |

Credentials are carried in protobuf metadata; the dependency also supplies the
CLI identity. Framing, gzip, tool schemas, model-effort UID mapping, and tool-call
correlation are owned by the protocol library. All requests use its in-process
implementation, avoiding the optional sidecar path.

The browser sign-in script uses PKCE through
`https://app.devin.ai/auth/cli/continue` with a loopback `/callback`, state,
S256 challenge, and `cli_pkce_marker=1`. It exchanges the code at
`/exa.seat_management_pb.SeatManagementService/ExchangeDevinCLIPKCECode`.
The library's exported OAuth helper still uses the older
`https://api.devin.ai/auth/cli/token`; the script therefore implements the newer
exchange identified in the reference plugin. This exchange needs live validation.

## Verified locally

- TypeScript compiles against the pinned OpenCode and AI SDK interfaces.
- A loopback service decodes outbound protobuf metadata, user JWT, and effort UID.
- Streamed reasoning/text and incremental tool-call JSON become valid SDK parts.
- A following turn carries the local tool result back into protobuf history.
- Cache-read/cache-write usage maps into SDK totals.
- Auth/quota/invalid-argument trailer errors map to 401/429/400; cancellation
  aborts the protocol request.
- The actual `opencode2` beta-19242 binary loads the provider in a temporary
  project, routes its model calls through the custom adapter, and prints `pong`
  from the loopback fixture (two inference requests, including auxiliary work).

## Verified live (2026-10-16)

- User-supplied `DEVIN_SESSION_TOKEN` authenticated discovery of 26 models.
- `npm run probe -- swe-1-6` returned `pong` with a normal stop.
- `opencode2 run --standalone -m devin/swe-1-6` invoked the local shell tool's
  `pwd` command, received its output, and reported the correct project directory.
- `opencode2 run --standalone -m 'devin/claude-haiku-5-5#low'` returned `pong`.
  This verifies that an effort-variant selection works through OpenCode.

The short SWE probe reported zeros for all token usage fields. Fixture usage
mapping passes, but live usage reporting needs investigation before treating
OpenCode's token/cost display as accurate.

## Remaining live verification

1. Browser sign-in through `npm run login` (testing used an existing session token).
2. Image input on an account model that supports it.
3. Token/cache usage accounting on responses that carry usage.
4. Explicit auxiliary title-generation and compaction verification.

The provider contract may drift independently of the pinned OpenCode API and
protocol library.

`factory-droid-behavior.md` and `reverse-engineering-playbook.md` were supplied as
reference material; their Factory-specific endpoint/header behavior is not used
by this plugin.
