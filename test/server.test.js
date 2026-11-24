import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMockOpenRouter, TINY_PNG_BASE64 } from '../scripts/mock-openrouter.js';
import { loadConfig, startServer } from '../server.js';

// 16x16 WebP (68 bytes). OpenRouter image models return WebP even when PNG is
// requested, so the URL-only synthesis path must decode it.
const TINY_WEBP_BASE64 = 'UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoQABAAAUAiJaACdLoB+AADsAD+8MQL/wq3DENdX/5Af8gP+QH/8eQAAAA=';

let mock;
let mcp;
let imageServer;
let imageUrl;
let webpImageUrl;
let config;

before(async () => {
  mock = await createMockOpenRouter({ port: 0, expectedKey: 'test-key' });
  config = loadConfig({
    HOST: '127.0.0.1',
    PORT: '0',
    OPENROUTER_API_BASE_URL: `http://127.0.0.1:${mock.port}/api/v1`,
    DEFAULT_IMAGE_MODEL: 'recraft/recraft-v4.1-flash-v2:free',
    OPENROUTER_TIMEOUT_MS: '5000',
    MAX_BODY_BYTES: '1000000',
    CORS_ORIGIN: 'https://librechat.example.com',
    LOG_REQUESTS: 'false',
  });
  mcp = await startServer(config);

  const pngBuffer = Buffer.from(TINY_PNG_BASE64, 'base64');
  const webpBuffer = Buffer.from(TINY_WEBP_BASE64, 'base64');
  imageServer = createServer((req, res) => {
    if ((req.url || '').endsWith('.webp')) {
      res.writeHead(200, { 'Content-Type': 'image/webp' });
      res.end(webpBuffer);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(pngBuffer);
  });
  await new Promise((resolve) => imageServer.listen(0, '127.0.0.1', resolve));
  const address = imageServer.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  imageUrl = `http://127.0.0.1:${port}/image.png`;
  webpImageUrl = `http://127.0.0.1:${port}/image.webp`;
});

after(async () => {
  await mcp?.close();
  await mock?.close();
  await new Promise((resolve) => imageServer?.close(resolve));
});

async function connect(apiKey) {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcp.port}/mcp`), {
    requestInit: apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : undefined,
  });
  await client.connect(transport);
  return { client, transport };
}

test('health endpoint responds', async () => {
  const response = await fetch(`http://127.0.0.1:${mcp.port}/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.name, 'openrouter-image-mcp');
});

test('root endpoint advertises the MCP endpoint', async () => {
  const response = await fetch(`http://127.0.0.1:${mcp.port}/`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mcp, '/mcp');
});

test('unknown path returns 404', async () => {
  const response = await fetch(`http://127.0.0.1:${mcp.port}/nope`);
  assert.equal(response.status, 404);
});

test('GET /mcp returns 405', async () => {
  const response = await fetch(`http://127.0.0.1:${mcp.port}/mcp`);
  assert.equal(response.status, 405);
});

test('OPTIONS /mcp returns CORS headers', async () => {
  const response = await fetch(`http://127.0.0.1:${mcp.port}/mcp`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://librechat.example.com' },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://librechat.example.com');
});

test('tools/list exposes only generate_image', async () => {
  const { client } = await connect('test-key');
  try {
    const result = await client.listTools();
    assert.equal(result.tools.length, 1);
    assert.equal(result.tools[0].name, 'generate_image');
  } finally {
    await client.close();
  }
});

test('generate_image returns b64 image content and forwards the per-request key', async () => {
  mock.requests.length = 0;
  const { client } = await connect('test-key');
  try {
    const result = await client.callTool({
      name: 'generate_image',
      arguments: { prompt: 'A red panda', n: 1 },
    });
    assert.equal(result.isError, undefined);
    const image = result.content.find((item) => item.type === 'image');
    assert.ok(image);
    assert.equal(image.mimeType, 'image/png');
    assert.ok(image.data.length > 0);
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.requests[0].authorization, 'Bearer test-key');
    assert.equal(mock.requests[0].body.model, 'recraft/recraft-v4.1-flash-v2:free');
    assert.equal(mock.requests[0].body.prompt, 'A red panda');
    assert.equal(mock.requests[0].body.response_format, 'url');
    assert.ok(
      result.content.some(
        (item) => item.type === 'text' && item.text.includes('https://example.com/generated-image.png')
      ),
      'expected URL text in content when OpenRouter returns both fields'
    );
  } finally {
    await client.close();
  }
});

test('different requests use different API keys', async () => {
  mock.setExpectedKey('');
  mock.requests.length = 0;
  const first = await connect('key-one');
  const second = await connect('key-two');
  try {
    await first.client.callTool({ name: 'generate_image', arguments: { prompt: 'one' } });
    await second.client.callTool({ name: 'generate_image', arguments: { prompt: 'two' } });
    assert.deepEqual(
      mock.requests.map((request) => request.authorization),
      ['Bearer key-one', 'Bearer key-two']
    );
  } finally {
    await first.client.close();
    await second.client.close();
    mock.setExpectedKey('test-key');
  }
});

test('missing API key returns a tool error', async () => {
  const { client } = await connect('');
  try {
    const result = await client.callTool({ name: 'generate_image', arguments: { prompt: 'No key' } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /No OpenRouter API key/);
  } finally {
    await client.close();
  }
});

test('arbitrary model slugs are passed through to OpenRouter', async () => {
  mock.requests.length = 0;
  const { client } = await connect('test-key');
  try {
    const result = await client.callTool({
      name: 'generate_image',
      arguments: { prompt: 'x', model: 'openai/gpt-image-2.6' },
    });
    assert.equal(result.isError, undefined);
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.requests[0].body.model, 'openai/gpt-image-2.6');
  } finally {
    await client.close();
  }
});

test('unknown arguments are rejected', async () => {
  const { client } = await connect('test-key');
  try {
    const result = await client.callTool({
      name: 'generate_image',
      arguments: { prompt: 'x', width: 1024 },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unknown argument: width/);
  } finally {
    await client.close();
  }
});

test('size and aspect_ratio cannot be combined', async () => {
  const { client } = await connect('test-key');
  try {
    const result = await client.callTool({
      name: 'generate_image',
      arguments: { prompt: 'x', size: '2K', aspect_ratio: '1:1' },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /either size or aspect_ratio/);
  } finally {
    await client.close();
  }
});

test('OpenRouter errors are surfaced as tool errors', async () => {
  mock.setResponse(() => ({ status: 402, body: { error: { message: 'Insufficient credits' } } }));
  const { client } = await connect('test-key');
  try {
    const result = await client.callTool({ name: 'generate_image', arguments: { prompt: 'x' } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /402/);
    assert.match(result.content[0].text, /Insufficient credits/);
  } finally {
    await client.close();
    mock.setResponse(undefined);
  }
});

test('synthesizes base64 preview when OpenRouter returns url-only', async () => {
  mock.setResponse(() => ({
    status: 200,
    body: {
      created: Math.floor(Date.now() / 1000),
      data: [{ url: imageUrl, media_type: 'image/png' }],
      usage: { cost: 0.001 },
    },
  }));
  mock.requests.length = 0;
  const { client } = await connect('test-key');
  try {
    const result = await client.callTool({
      name: 'generate_image',
      arguments: { prompt: 'x', n: 1 },
    });
    assert.equal(result.isError, undefined);
    const image = result.content.find((item) => item.type === 'image');
    assert.ok(image, 'expected synthesized image block from URL');
    assert.equal(image.mimeType, 'image/webp');
    assert.ok(image.data.length > 0);
    assert.ok(
      result.content.some((item) => item.type === 'text' && item.text.includes(imageUrl)),
      'expected URL text in content'
    );
    assert.equal(mock.requests[0].body.response_format, 'url');
  } finally {
    await client.close();
    mock.setResponse(undefined);
  }
});

test('synthesizes preview when the URL serves WebP (as OpenRouter models do)', async () => {
  mock.setResponse(() => ({
    status: 200,
    body: {
      created: Math.floor(Date.now() / 1000),
      data: [{ url: webpImageUrl, media_type: 'image/webp' }],
      usage: { cost: 0.001 },
    },
  }));
  mock.requests.length = 0;
  const { client } = await connect('test-key');
  try {
    const result = await client.callTool({
      name: 'generate_image',
      arguments: { prompt: 'x', n: 1 },
    });
    assert.equal(result.isError, undefined);
    const image = result.content.find((item) => item.type === 'image');
    assert.ok(image, 'expected synthesized image block from a WebP URL');
    assert.match(image.mimeType, /^image\/webp$/);
    assert.ok(image.data.length > 0);
    assert.ok(
      result.content.some((item) => item.type === 'text' && item.text.includes(webpImageUrl)),
      'expected URL text in content'
    );
  } finally {
    await client.close();
    mock.setResponse(undefined);
  }
});

test('returns image block only when OpenRouter returns b64_json without url', async () => {
  mock.setResponse(() => ({
    status: 200,
    body: {
      created: Math.floor(Date.now() / 1000),
      data: [{ b64_json: TINY_PNG_BASE64, media_type: 'image/png' }],
      usage: { cost: 0.001 },
    },
  }));
  mock.requests.length = 0;
  const { client } = await connect('test-key');
  try {
    const result = await client.callTool({
      name: 'generate_image',
      arguments: { prompt: 'x' },
    });
    assert.equal(result.isError, undefined);
    const image = result.content.find((item) => item.type === 'image');
    assert.ok(image);
    assert.equal(image.mimeType, 'image/png');
    assert.ok(
      result.content.every((item) => item.type !== 'text' || !item.text.includes('http')),
      'expected no URL text when OpenRouter returns b64_json only'
    );
  } finally {
    await client.close();
    mock.setResponse(undefined);
  }
});

test('returns tool error when OpenRouter returns neither b64_json nor url', async () => {
  mock.setResponse(() => ({
    status: 200,
    body: {
      created: Math.floor(Date.now() / 1000),
      data: [{}],
      usage: { cost: 0.001 },
    },
  }));
  const { client } = await connect('test-key');
  try {
    const result = await client.callTool({ name: 'generate_image', arguments: { prompt: 'x' } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /no b64_json or url/);
  } finally {
    await client.close();
    mock.setResponse(undefined);
  }
});

test('response_format argument is rejected as unknown', async () => {
  const { client } = await connect('test-key');
  try {
    const result = await client.callTool({
      name: 'generate_image',
      arguments: { prompt: 'x', response_format: 'url' },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unknown argument: response_format/);
  } finally {
    await client.close();
  }
});
