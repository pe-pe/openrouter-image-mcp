# OpenRouter Image Generation MCP Server

Minimal [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http)
MCP server for LibreChat. It exposes exactly one tool, `generate_image`, and
talks only to OpenRouter. There is no OAuth flow and no Fireworks provider.

The OpenRouter API key is read from the `Authorization: Bearer <key>` header on
every MCP request. LibreChat supplies that header per user, so each generation
bills to that user's own OpenRouter account. The key is never written to disk.

## Requirements

| Requirement                    | Implementation                                            |
| ------------------------------ | --------------------------------------------------------- |
| OpenRouter image generation    | `generate_image` forwards to `POST /api/v1/images`        |
| MCP over Streamable HTTP       | `@modelcontextprotocol/sdk` stateless transport at `/mcp` |
| Only selected tools            | Only `generate_image` is registered                       |
| Per-user API key on every call | Read from `Authorization: Bearer` per request             |
| Docker deployable              | Multi-stage `Dockerfile`, non-root runtime                |
| Local testing without credits  | Mock OpenRouter API and smoke test                        |

## How it works

1. LibreChat calls `POST /mcp` with `Authorization: Bearer <user OpenRouter key>`.
2. The server extracts the key for that request only and never logs it.
3. `generate_image` validates the arguments and forwards them to OpenRouter's
   Images API.

The server is stateless: each MCP request creates its own server and transport
instance. That keeps per-user keys isolated and makes horizontal scaling simple.

## Files

| File                                            | Purpose                                    |
| ----------------------------------------------- | ------------------------------------------ |
| `server.js`                                     | MCP server, OpenRouter client, HTTP server |
| `scripts/mock-openrouter.js`                    | Local OpenRouter Images API mock           |
| `scripts/smoke.js`                              | End-to-end smoke test through MCP          |
| `test/server.test.js`                           | Unit and integration tests                 |
| `Dockerfile`                                    | Multi-stage production image               |
| `docker-compose.yml`                            | Optional local/Compose deployment          |
| `librechat.yaml`                                | LibreChat MCP server configuration snippet |
| `.env.example`                                  | Environment variable reference             |
| `.github/workflows/cicd.yml`                    | Lint, test, build, smoke test, and publish |
| `.github/workflows/release.yml`                 | Publish tagged images to GHCR              |
| `.github/dependabot.yml`                        | npm, Docker, and GitHub Actions updates    |
| `.github/workflows/dependabot-auto-approve.yml` | Approve Dependabot PRs after checks pass   |

## Quick start (Node.js)

Requires Node.js 20.19 or newer.

```bash
npm ci
cp .env.example .env
npm start
```

The server listens on `http://localhost:3333/mcp`. Health check:
`http://localhost:3333/health`.

## Docker

Build and run:

```bash
docker build -t openrouter-image-mcp:local .
docker run --rm -p 3333:3333 \
  -e OPENROUTER_API_BASE_URL=https://openrouter.ai/api/v1 \
  openrouter-image-mcp:local
```

Or with Compose:

```bash
docker compose up --build
```

The image runs as the unprivileged `node` user and includes a `HEALTHCHECK`
against `/health`. No API key is baked into the image. Per-user keys arrive from
LibreChat on each request.

## LibreChat configuration

Add this under the top-level `mcpServers` key in `librechat.yaml`:

```yaml
mcpServers:
  openrouter-image:
    type: streamable-http
    url: http://openrouter-image-mcp:3333/mcp
    title: Image Generation
    customUserVars:
      OPENROUTER_API_KEY:
        title: OpenRouter API key
        description: Enter your own OpenRouter API key (sk-or-v1-...).
        sensitive: true
    headers:
      Authorization: 'Bearer {{OPENROUTER_API_KEY}}'
```

`customUserVars` makes LibreChat prompt each user for their own OpenRouter key
and send it as `Authorization: Bearer <key>` on every MCP request, so each
user's generations bill to their own account.

The URL above assumes LibreChat and this server share a Docker network. For a
LibreChat process running on the host, use `http://localhost:3333/mcp`.

If LibreChat's SSRF protection is enabled, allow the server address:

```yaml
mcpSettings:
  allowedAddresses:
    - 'openrouter-image-mcp:3333'
```

Entries are `host:port` without a scheme, matching the server URL.

### Admin key (single key for all users)

If you prefer one shared key, set `OPENROUTER_API_KEY` in the server process
environment. The server uses it only when no `Authorization` header is present:

```bash
docker run --rm -p 3333:3333 \
  -e OPENROUTER_API_KEY=sk-or-v1-... \
  openrouter-image-mcp:local
```

Per-user headers always take precedence over the environment fallback.

## Tool schema

`generate_image` accepts:

| Parameter       | Type    | Default                              | Notes                                                                                                 |
| --------------- | ------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `prompt`        | string  | required                             | Text description of the image                                                                         |
| `model`         | string  | `recraft/recraft-v4.1-flash-v2:free` | Any OpenRouter image model slug                                                                       |
| `aspect_ratio`  | string  | `auto`                               | `auto`, `1:1`, `1:2`, `2:1`, `2:3`, `3:2`, `3:4`, `4:3`, `4:5`, `5:4`, `9:16`, `16:9`, `9:21`, `21:9` |
| `resolution`    | string  | unset                                | `1K`, `1.5K`, `2K`, `4K`                                                                              |
| `size`          | string  | unset                                | Tier such as `2K` or pixels such as `2048x2048`; do not combine with `aspect_ratio` or `resolution`   |
| `n`             | integer | `1`                                  | 1-10; provider limits may be lower                                                                    |
| `output_format` | string  | `png`                                | `png`, `jpeg`, `webp`, `svg`, `gif`                                                                   |
| `background`    | string  | unset                                | `auto`, `transparent`, `opaque`                                                                       |
| `seed`          | integer | unset                                | Reproducibility where the model supports it                                                           |

Example call from an MCP client:

```json
{
  "name": "generate_image",
  "arguments": {
    "prompt": "A red panda wearing a tiny astronaut helmet, studio lighting",
    "aspect_ratio": "16:9"
  }
}
```

The server always requests `response_format: url` from OpenRouter so the direct full-quality URL is available. The tool result is structured so a model can tell the preview from the real image:

- a leading text block listing every full-quality URL as `Full-quality URL N: <url>`, plus the usage summary;
- then, per image, a labeled `image` block: OpenRouter's `b64_json` is shown as `Inline image N (as returned by OpenRouter)` when present; when OpenRouter only returns a URL, the server fetches it (bounded to 30s) and shows `Preview N (downsized, not the full-quality image)` — a WebP downsized to ~768px on the shorter side (aspect preserved; WebP decoded via WASM, re-encoded at quality 82, PNG fallback).

If OpenRouter returns neither field, the tool returns an error.

## Models

Any OpenRouter image model slug is accepted. The default model is
`recraft/recraft-v4.1-flash-v2:free`.

```bash
curl -sS "https://openrouter.ai/api/v1/images/models" | jq
```

Known model IDs at the time of writing:

| Model ID                             | Notes                      |
| ------------------------------------ | -------------------------- |
| `recraft/recraft-v4.1-flash-v2:free` | Default; free tier variant |
| `bytedance-seed/seedream-4.5`        | Supports 1K-4K tiers       |

Pass any model ID in the `model` argument. The server does not restrict the
list; OpenRouter validates the model and its parameters.

## Configuration

| Variable                  | Default                              | Purpose                                                                                 |
| ------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------- |
| `HOST`                    | `0.0.0.0`                            | Listen address                                                                          |
| `PORT`                    | `3333`                               | Listen port                                                                             |
| `OPENROUTER_API_BASE_URL` | `https://openrouter.ai/api/v1`       | API base; point at the mock for tests                                                   |
| `OPENROUTER_API_KEY`      | empty                                | Optional admin fallback key                                                             |
| `DEFAULT_IMAGE_MODEL`     | `recraft/recraft-v4.1-flash-v2:free` | Model used when `model` is omitted                                                      |
| `OPENROUTER_TIMEOUT_MS`   | `120000`                             | OpenRouter request timeout                                                              |
| `MAX_BODY_BYTES`          | `1000000`                            | Maximum MCP request body size                                                           |
| `CORS_ORIGIN`             | empty                                | Comma-separated origins or `*`; empty disables CORS                                     |
| `LOG_REQUESTS`            | `true`                               | Log HTTP requests and `generate_image` steps (timing, url/b64 presence, preview result) |
| `OPENROUTER_APP_TITLE`    | `openrouter-image-mcp`               | OpenRouter `X-Title` header                                                             |
| `OPENROUTER_APP_REFERER`  | empty                                | Optional OpenRouter `HTTP-Referer` header                                               |

## Testing

Unit and integration tests use the mock OpenRouter API. No credits are spent.

```bash
npm ci
npm test
npm run lint
npm run format:check
```

The test suite covers:

- health and root endpoints
- CORS preflight and unknown paths
- `tools/list` exposing only `generate_image`
- base64 image content and URL responses
- per-request API key forwarding and isolation between users
- missing key rejection
- arbitrary model slug passthrough
- unknown argument rejection
- `size` versus `aspect_ratio`/`resolution` conflicts
- OpenRouter error propagation

### Manual mock and smoke test

Terminal 1, start the mock:

```bash
npm run mock:openrouter
```

Terminal 2, start the server against the mock:

```bash
OPENROUTER_API_BASE_URL=http://127.0.0.1:4010/api/v1 PORT=3333 npm start
```

Terminal 3, run the smoke test:

```bash
MCP_URL=http://127.0.0.1:3333/mcp OPENROUTER_API_KEY=test-key npm run smoke
```

The smoke test checks the health endpoint, `tools/list`, base64 image content,
URL responses, and missing-key rejection. It also proves the per-request
`Authorization` header reaches OpenRouter.

## GitHub Actions

The workflows mirror the `openai-ocr-server` project:

- **CI/CD** (`.github/workflows/cicd.yml`): runs lint and formatting, unit and
  integration tests, builds the Docker image, runs the container against the
  mock OpenRouter API, and publishes `ghcr.io/<owner>/<repo>` on pushes to
  `main`.
- **Release** (`.github/workflows/release.yml`): on a `v*` tag, publishes
  `ghcr.io/<owner>/<repo>` images with semver tags and `latest`.
- **Dependabot** (`.github/dependabot.yml`): weekly npm, Docker, and GitHub
  Actions updates.
- **Dependabot auto-approve**: approves Dependabot PRs after checks pass.

The container smoke test uses host networking so the container can reach the
mock on `127.0.0.1:4010`. No real OpenRouter key is used in CI.

## Security notes

- API keys are read per request and never persisted. The server does not log
  prompts, keys, or response bodies.
- The container runs as the unprivileged `node` user.
- Request bodies are capped by `MAX_BODY_BYTES`.
- OpenRouter calls are bounded by `OPENROUTER_TIMEOUT_MS`.
- CORS is disabled by default. Set `CORS_ORIGIN` only if a browser client needs
  to call the server directly. LibreChat's server-to-server calls do not need it.
- Put the server behind TLS and a reverse proxy in production. Do not expose it
  to the public internet without authentication at the proxy layer.
- If you use the admin fallback key, remember that every user without a personal
  key will bill to that shared account.

## Troubleshooting

| Symptom                              | Fix                                                                                                                                                  |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `No OpenRouter API key was provided` | Configure `customUserVars` for `OPENROUTER_API_KEY` in LibreChat (see LibreChat configuration) or send `Authorization: Bearer <key>`                 |
| `401` from OpenRouter                | The user's key is invalid or revoked                                                                                                                 |
| `402` from OpenRouter                | The user's OpenRouter account has insufficient credits                                                                                               |
| `429` from OpenRouter                | Rate limit reached; retry later                                                                                                                      |
| LibreChat cannot reach the server    | Use the Docker service name and allow the address in `mcpSettings.allowedAddresses`                                                                  |
| `size` and `aspect_ratio` conflict   | Use either `size` or `aspect_ratio`/`resolution`, not both                                                                                           |
| Inline preview is small/low quality  | The inline `image` block is a deliberate ~768px shorter-side downsized preview for chat display; the accompanying URL text is the full-quality image |

## License

MIT. See `LICENSE`.
