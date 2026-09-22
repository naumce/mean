# night-shift-mcp

An [MCP](https://modelcontextprotocol.io) server that lets Claude Desktop, Cursor, or any other MCP-capable tool
watch a load, check on the agent, or nudge it — using your own Night Shift API key. It is a thin, stateless
wrapper: every tool call is one or two HTTP calls straight to your Night Shift dispatcher API, nothing more.

**No tool here can put a policy live, or change a policy's `shadow` setting at all.** Going live is a deliberate
click on the Night Shift page, with its own confirmation sentence — never something a chat window can do on your
behalf.

## Install

```bash
npm install -g night-shift-mcp
```

or run it without installing, via `npx` (see the config snippets below).

## Configure

Get a key from your Night Shift page: **Settings → API keys → New key**. Name it after whatever will use it
("Claude Desktop", "Cursor") — the raw key is shown once, so copy it immediately.

Set two environment variables:

| Variable | Example | What it is |
|---|---|---|
| `NIGHT_SHIFT_URL` | `https://your-fleet.example.com/api` | Your Night Shift API's base URL (no trailing slash). |
| `NIGHT_SHIFT_API_KEY` | `ns_live_...` | The key from Settings → API keys. |

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "night-shift": {
      "command": "npx",
      "args": ["-y", "night-shift-mcp"],
      "env": {
        "NIGHT_SHIFT_URL": "https://your-fleet.example.com/api",
        "NIGHT_SHIFT_API_KEY": "ns_live_..."
      }
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` (project) or Cursor's global MCP settings:

```json
{
  "mcpServers": {
    "night-shift": {
      "command": "npx",
      "args": ["-y", "night-shift-mcp"],
      "env": {
        "NIGHT_SHIFT_URL": "https://your-fleet.example.com/api",
        "NIGHT_SHIFT_API_KEY": "ns_live_..."
      }
    }
  }
}
```

## Tools

Every `loadRef` argument is the board's LOAD# or your TMS's order reference — never a uuid; the server resolves
it for you (`GET /dispatcher/loads/lookup`).

| Tool | What it does |
|---|---|
| `list_watched_loads()` | Every load the agent is currently watching, with its pill and latest line. |
| `load_status(loadRef)` | Full status and timeline for one load. |
| `watch_load(loadRef, policy?)` | Turns the agent on for a load. Defaults to whatever policy the load already has, or Standard. |
| `stop(loadRef)` | Turns the agent off for a load. |
| `call_now(loadRef)` | Has the agent call the driver right now. |
| `takeover(loadRef)` | Takes supervision away from the agent — you have it now. |
| `handback(loadRef)` | Hands a load you took over back to the agent. |
| `reply(loadRef, text)` | Sends a free-text reply into the load's timeline. |
| `correct(loadRef, key)` | Corrects the agent's read of the driver's last reply. |
| `list_policies()` | Lists this org's policies and how many loads run under each. |
| `set_policy(name, patch)` | Edits a policy by name. **Refuses if `patch` contains `shadow`** — live mode is changed on the Night Shift page, not from a tool. |
| `usage(range?)` | This org's usage summary (the wallet ledger is still being built — currently always empty). |

## Development

```bash
npm install
npm run dev       # tsx src/index.ts, reads NIGHT_SHIFT_URL / NIGHT_SHIFT_API_KEY from the environment
npm test          # vitest — mocks fetch, asserts each tool's exact HTTP call(s)
npm run typecheck # tsc --noEmit
npm run build     # tsc -p tsconfig.build.json -> dist/
```
