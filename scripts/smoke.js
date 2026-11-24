import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const baseUrl = process.env.MCP_URL || 'http://127.0.0.1:3333/mcp';
const apiKey = process.env.OPENROUTER_API_KEY || 'test-key';

function ok(message) {
  console.log(`[smoke] ok: ${message}`);
}

async function connect(key) {
  const client = new Client({ name: 'openrouter-image-mcp-smoke', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
    requestInit: key ? { headers: { Authorization: `Bearer ${key}` } } : undefined,
  });
  await client.connect(transport);
  return { client, transport };
}

const healthUrl = new URL('/health', baseUrl);
const health = await fetch(healthUrl);
if (!health.ok) throw new Error(`health check failed: ${health.status}`);
const healthBody = await health.json();
if (healthBody.status !== 'ok') throw new Error(`unexpected health body: ${JSON.stringify(healthBody)}`);
ok('health endpoint');

const { client } = await connect(apiKey);
try {
  const tools = await client.listTools();
  if (tools.tools.length !== 1 || tools.tools[0].name !== 'generate_image') {
    throw new Error(`unexpected tools: ${JSON.stringify(tools.tools.map((tool) => tool.name))}`);
  }
  ok('tools/list exposes only generate_image');

  const result = await client.callTool({
    name: 'generate_image',
    arguments: { prompt: 'A tiny red square' },
  });
  if (result.isError) throw new Error(`generate_image returned an error: ${result.content?.[0]?.text}`);
  const image = result.content?.find((item) => item.type === 'image');
  if (!image?.data) throw new Error('generate_image did not return image content');
  if (!result.content?.some((item) => item.type === 'text' && item.text.includes('https://'))) {
    throw new Error('generate_image did not return a URL');
  }
  ok('generate_image returned base64 image content and URL text');

  const urlResult = await client.callTool({
    name: 'generate_image',
    arguments: { prompt: 'A tiny blue square' },
  });
  if (urlResult.isError) throw new Error(`generate_image returned an error: ${urlResult.content?.[0]?.text}`);
  if (!urlResult.content?.some((item) => item.type === 'text' && item.text.includes('https://'))) {
    throw new Error('generate_image did not return a URL');
  }
  ok('generate_image returned URL text');
} finally {
  await client.close();
}

const { client: noKeyClient } = await connect('');
try {
  const result = await noKeyClient.callTool({ name: 'generate_image', arguments: { prompt: 'No key' } });
  if (!result.isError) throw new Error('generate_image without an API key should fail');
  ok('missing API key is rejected');
} finally {
  await noKeyClient.close();
}

console.log('[smoke] all checks passed');
