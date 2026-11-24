import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// OpenRouter Image Generation MCP Server (Streamable HTTP)
// ---------------------------------------------------------------------------
// Exposes exactly one tool: generate_image. The OpenRouter API key is read
// from the Authorization: Bearer <key> header on every MCP request. LibreChat
// supplies that header per user through its apiKey/customUserVars support.
// No OAuth. No Fireworks. No key is persisted on disk.
//
// OpenRouter API reference: https://openrouter.ai/docs/api-reference/images
// ---------------------------------------------------------------------------

const TOOL_NAME = 'generate_image';
const DEFAULT_ASPECT_RATIO = 'auto';
const DEFAULT_OUTPUT_FORMAT = 'png';
const DEFAULT_IMAGE_MODEL = 'recraft/recraft-v4.1-flash-v2:free';
const MAX_ERROR_TEXT = 800;

const ASPECT_RATIOS = [
  'auto',
  '1:1',
  '1:2',
  '2:1',
  '2:3',
  '3:2',
  '3:4',
  '4:3',
  '4:5',
  '5:4',
  '9:16',
  '16:9',
  '9:21',
  '21:9',
];
const RESOLUTIONS = ['1K', '1.5K', '2K', '4K'];
const OUTPUT_FORMATS = ['png', 'jpeg', 'webp', 'svg', 'gif'];
const BACKGROUNDS = ['auto', 'transparent', 'opaque'];
const ALLOWED_ARG_KEYS = new Set([
  'prompt',
  'model',
  'aspect_ratio',
  'resolution',
  'size',
  'n',
  'output_format',
  'background',
  'seed',
]);

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function parseInteger(value, fallback, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

/**
 * Load and validate configuration from an environment-like object.
 * Exported so tests can pass a plain object instead of mutating process.env.
 */
export function loadConfig(env = process.env) {
  const port = parseInteger(env.PORT, 3333, 'PORT', { min: 0, max: 65535 });
  const host = env.HOST === undefined || String(env.HOST).trim() === '' ? '0.0.0.0' : String(env.HOST).trim();
  const openRouterApiBaseUrl =
    env.OPENROUTER_API_BASE_URL === undefined || String(env.OPENROUTER_API_BASE_URL).trim() === ''
      ? 'https://openrouter.ai/api/v1'
      : String(env.OPENROUTER_API_BASE_URL).trim();

  let parsedBaseUrl;
  try {
    parsedBaseUrl = new URL(openRouterApiBaseUrl);
  } catch {
    throw new Error('OPENROUTER_API_BASE_URL must be a valid URL');
  }
  if (!['http:', 'https:'].includes(parsedBaseUrl.protocol)) {
    throw new Error('OPENROUTER_API_BASE_URL must use http or https');
  }

  const defaultModel =
    env.DEFAULT_IMAGE_MODEL === undefined || String(env.DEFAULT_IMAGE_MODEL).trim() === ''
      ? DEFAULT_IMAGE_MODEL
      : String(env.DEFAULT_IMAGE_MODEL).trim();

  const corsOrigin = env.CORS_ORIGIN === undefined ? '' : String(env.CORS_ORIGIN).trim();

  return {
    host,
    port,
    openRouterApiBaseUrl,
    openRouterApiKey: env.OPENROUTER_API_KEY ? String(env.OPENROUTER_API_KEY).trim() : '',
    defaultModel,
    openRouterTimeoutMs: parseInteger(env.OPENROUTER_TIMEOUT_MS, 120000, 'OPENROUTER_TIMEOUT_MS', {
      min: 1000,
      max: 600000,
    }),
    maxBodyBytes: parseInteger(env.MAX_BODY_BYTES, 1_000_000, 'MAX_BODY_BYTES', {
      min: 1024,
      max: 10_000_000,
    }),
    corsOrigin,
    logRequests: parseBoolean(env.LOG_REQUESTS, true),
    appTitle: env.OPENROUTER_APP_TITLE ? String(env.OPENROUTER_APP_TITLE).trim() : 'openrouter-image-mcp',
    appReferer: env.OPENROUTER_APP_REFERER ? String(env.OPENROUTER_APP_REFERER).trim() : '',
  };
}

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------

function truncate(value, max = MAX_ERROR_TEXT) {
  const text = String(value ?? '').trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/**
 * Validate and normalize generate_image arguments. Returns the request body
 * sent to OpenRouter. Throws on invalid input so the tool can return a
 * structured error without calling OpenRouter.
 */
export function validateGenerateArgs(args, config) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new Error('arguments must be an object');
  }

  for (const key of Object.keys(args)) {
    if (!ALLOWED_ARG_KEYS.has(key)) {
      throw new Error(`Unknown argument: ${key}`);
    }
  }

  if (typeof args.prompt !== 'string' || args.prompt.trim() === '') {
    throw new Error('prompt is required and must be a non-empty string');
  }

  const model = args.model === undefined ? config.defaultModel : args.model;
  if (typeof model !== 'string' || model.trim() === '') {
    throw new Error('model must be a non-empty string');
  }

  const hasSize = args.size !== undefined;
  if (hasSize && (typeof args.size !== 'string' || args.size.trim() === '')) {
    throw new Error('size must be a non-empty string');
  }
  if (hasSize && (args.aspect_ratio !== undefined || args.resolution !== undefined)) {
    throw new Error('Use either size or aspect_ratio/resolution, not both');
  }

  const aspectRatio = hasSize ? undefined : args.aspect_ratio === undefined ? DEFAULT_ASPECT_RATIO : args.aspect_ratio;
  if (aspectRatio !== undefined && !ASPECT_RATIOS.includes(aspectRatio)) {
    throw new Error(`aspect_ratio must be one of: ${ASPECT_RATIOS.join(', ')}`);
  }

  const resolution = hasSize ? undefined : args.resolution;
  if (resolution !== undefined && !RESOLUTIONS.includes(resolution)) {
    throw new Error(`resolution must be one of: ${RESOLUTIONS.join(', ')}`);
  }

  const n = args.n === undefined ? 1 : args.n;
  if (!Number.isInteger(n) || n < 1 || n > 10) {
    throw new Error('n must be an integer between 1 and 10');
  }

  const outputFormat = args.output_format === undefined ? DEFAULT_OUTPUT_FORMAT : args.output_format;
  if (!OUTPUT_FORMATS.includes(outputFormat)) {
    throw new Error(`output_format must be one of: ${OUTPUT_FORMATS.join(', ')}`);
  }

  const background = args.background;
  if (background !== undefined && !BACKGROUNDS.includes(background)) {
    throw new Error(`background must be one of: ${BACKGROUNDS.join(', ')}`);
  }

  const seed = args.seed;
  if (seed !== undefined && !Number.isInteger(seed)) {
    throw new Error('seed must be an integer');
  }

  const request = {
    model: model.trim(),
    prompt: args.prompt.trim(),
    n,
    output_format: outputFormat,
    response_format: 'url',
  };
  if (aspectRatio !== undefined) request.aspect_ratio = aspectRatio;
  if (resolution !== undefined) request.resolution = resolution;
  if (hasSize) request.size = args.size.trim();
  if (background !== undefined) request.background = background;
  if (seed !== undefined) request.seed = seed;
  return request;
}

// ---------------------------------------------------------------------------
// API key extraction
// ---------------------------------------------------------------------------

/**
 * Extract the OpenRouter API key from an incoming request. The Authorization
 * header wins; the optional OPENROUTER_API_KEY environment value is only a
 * fallback for single-key deployments.
 */
export function extractApiKey(req, config = {}) {
  const header = req.headers.authorization;
  if (typeof header === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) return match[1].trim();
  }

  const custom = req.headers['x-openrouter-api-key'];
  if (typeof custom === 'string' && custom.trim()) return custom.trim();

  return config.openRouterApiKey || '';
}

// ---------------------------------------------------------------------------
// OpenRouter client
// ---------------------------------------------------------------------------

class OpenRouterError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'OpenRouterError';
    this.status = status;
  }
}

async function callOpenRouter({ apiKey, body, config }) {
  const base = config.openRouterApiBaseUrl.endsWith('/')
    ? config.openRouterApiBaseUrl
    : `${config.openRouterApiBaseUrl}/`;
  const url = new URL('images', base);

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  if (config.appTitle) headers['X-Title'] = config.appTitle;
  if (config.appReferer) headers['HTTP-Referer'] = config.appReferer;

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.openRouterTimeoutMs),
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    const message = data?.error?.message || data?.message || truncate(text) || response.statusText || 'Unknown error';
    throw new OpenRouterError(response.status, message);
  }

  if (!data || typeof data !== 'object') {
    throw new OpenRouterError(response.status, 'OpenRouter returned an empty or invalid JSON response');
  }

  if (data.error) {
    const message = typeof data.error === 'string' ? data.error : data.error.message || 'OpenRouter returned an error';
    throw new OpenRouterError(response.status, message);
  }

  return data;
}

function errorResult(message) {
  return {
    isError: true,
    content: [{ type: 'text', text: message }],
  };
}

function logInfo(config, message) {
  if (config.logRequests) console.log(`[generate_image] ${message}`);
}

/**
 * Format the OpenRouter response as text URLs only. Any inline b64_json is
 * intentionally discarded so image bytes never enter the conversation.
 */
function formatResult(data, { model, config }) {
  const images = Array.isArray(data.data) ? data.data : [];
  const urls = [];

  images.forEach((image, index) => {
    const valid = image && typeof image === 'object' && !Array.isArray(image);
    const hasUrl = valid && typeof image.url === 'string' && image.url.length > 0;
    const hasB64 = valid && typeof image.b64_json === 'string' && image.b64_json.length > 0;
    logInfo(
      config,
      `image ${index + 1}: url=${hasUrl ? 'yes' : 'no'} b64=${hasB64 ? 'yes' : 'no'}${hasB64 ? ' (discarded)' : ''}`
    );
    if (hasUrl) urls.push(image.url);
  });

  if (urls.length === 0) {
    return errorResult('OpenRouter returned no image URL.');
  }

  const summary = {
    model,
    images: images.length,
    created: data.created,
    expires_at: data.expires_at,
    usage: data.usage,
  };

  const urlLines = urls.map((url, index) => `${index + 1}. ${url}\n   ![generated image](${url})`);
  const text = [
    `Generated ${urls.length} image URL(s) with ${model}.`,
    '',
    'Show each image to the user as a Markdown image (renders a preview) and keep the plain URL visible:',
    '',
    ...urlLines,
    '',
    JSON.stringify(summary, null, 2),
  ].join('\n');

  return { content: [{ type: 'text', text }] };
}

async function handleGenerateImage(args, { apiKey, config }) {
  if (!apiKey) {
    logInfo(config, 'rejected: missing OpenRouter API key');
    return errorResult(
      'No OpenRouter API key was provided. Configure this MCP server in LibreChat with ' +
        'customUserVars for OPENROUTER_API_KEY so each request carries ' +
        'Authorization: Bearer <OPENROUTER_API_KEY>.'
    );
  }

  let request;
  try {
    request = validateGenerateArgs(args, config);
  } catch (error) {
    logInfo(config, `rejected: ${error.message}`);
    return errorResult(error.message);
  }

  const startedAt = Date.now();
  const target = request.size
    ? `size=${request.size}`
    : `aspect_ratio=${request.aspect_ratio ?? 'auto'}${request.resolution ? ` resolution=${request.resolution}` : ''}`;
  logInfo(config, `received: model=${request.model} n=${request.n} ${target} promptChars=${request.prompt.length}`);

  try {
    const openRouterStarted = Date.now();
    const data = await callOpenRouter({ apiKey, body: request, config });
    const imageCount = Array.isArray(data.data) ? data.data.length : 0;
    logInfo(config, `openrouter responded in ${Date.now() - openRouterStarted}ms: ${imageCount} image(s)`);
    const result = formatResult(data, { model: request.model, config });
    logInfo(config, `completed in ${Date.now() - startedAt}ms`);
    return result;
  } catch (error) {
    let failure;
    if (error instanceof OpenRouterError) {
      let hint = '';
      if (error.status === 401) {
        hint = ' The OpenRouter API key was rejected; check the key configured for this user in LibreChat.';
      } else if (error.status === 402) {
        hint = ' The OpenRouter account has insufficient credits.';
      } else if (error.status === 429) {
        hint = ' OpenRouter rate limit reached; retry later.';
      }
      failure = errorResult(`OpenRouter API error (${error.status}): ${error.message}${hint}`);
    } else if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      failure = errorResult(`OpenRouter request timed out after ${config.openRouterTimeoutMs} ms.`);
    } else {
      failure = errorResult(`Failed to reach OpenRouter: ${error?.message || String(error)}`);
    }
    logInfo(config, `failed in ${Date.now() - startedAt}ms: ${failure.content[0].text}`);
    return failure;
  }
}

// ---------------------------------------------------------------------------
// MCP server and tool definition
// ---------------------------------------------------------------------------

export function buildTool(config) {
  return {
    name: TOOL_NAME,
    title: 'Generate image',
    description:
      'Generate an image from a text prompt using OpenRouter image models. ' +
      'Returns the full-quality image URL(s) as text only (image data is never embedded). ' +
      'Present each result as a Markdown image (![generated image](URL)) plus the plain URL.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'Text description of the image to generate.',
          minLength: 1,
        },
        model: {
          type: 'string',
          description: `OpenRouter image model slug. Defaults to ${config.defaultModel}.`,
          default: config.defaultModel,
        },
        aspect_ratio: {
          type: 'string',
          description: 'Aspect ratio of the generated image. Ignored when size is provided.',
          enum: ASPECT_RATIOS,
          default: DEFAULT_ASPECT_RATIO,
        },
        resolution: {
          type: 'string',
          description: 'Output resolution tier. Ignored when size is provided.',
          enum: RESOLUTIONS,
        },
        size: {
          type: 'string',
          description:
            'Explicit size as a tier (for example 2K) or pixels (for example 2048x2048). ' +
            'Do not combine with aspect_ratio or resolution.',
        },
        n: {
          type: 'integer',
          description: 'Number of images to generate (1-10). Provider limits may be lower.',
          minimum: 1,
          maximum: 10,
          default: 1,
        },
        output_format: {
          type: 'string',
          description: 'Output image format.',
          enum: OUTPUT_FORMATS,
          default: DEFAULT_OUTPUT_FORMAT,
        },
        background: {
          type: 'string',
          description: 'Background handling for models that support it.',
          enum: BACKGROUNDS,
        },
        seed: {
          type: 'integer',
          description: 'Optional seed for reproducibility, when supported by the model.',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  };
}

export function createMcpServer({ apiKey, config }) {
  const server = new Server(
    { name: pkg.name, version: pkg.version },
    {
      capabilities: { tools: {} },
      instructions:
        'Use generate_image to create images with OpenRouter image models. ' +
        'The tool returns image URLs as text; present each image to the user as a Markdown image ' +
        '(![generated image](URL)) plus the plain URL. ' +
        'The OpenRouter API key is supplied per request through the Authorization header.',
    }
  );

  server.onerror = (error) => console.error('[mcp] server error:', error?.message || error);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [buildTool(config)] }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (name !== TOOL_NAME) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name}`);
    }
    return handleGenerateImage(args, { apiKey, config });
  });

  return server;
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function commonHeaders(config, req) {
  const headers = { 'X-Content-Type-Options': 'nosniff' };
  if (!config.corsOrigin) return headers;

  const origin = req.headers.origin;
  if (config.corsOrigin === '*') {
    headers['Access-Control-Allow-Origin'] = '*';
  } else {
    const allowed = config.corsOrigin
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
    if (origin && allowed.includes(origin)) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers.Vary = 'Origin';
    }
  }
  headers['Access-Control-Expose-Headers'] = 'mcp-session-id';
  return headers;
}

async function handleHttpRequest(req, res, config) {
  const started = Date.now();
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const headers = commonHeaders(config, req);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      ...headers,
      'Access-Control-Allow-Headers':
        'authorization, content-type, mcp-session-id, mcp-protocol-version, last-event-id',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Max-Age': '600',
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', name: pkg.name, version: pkg.version }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { ...headers, 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        name: pkg.name,
        version: pkg.version,
        mcp: '/mcp',
        health: '/health',
        tool: TOOL_NAME,
      })
    );
    return;
  }

  if (url.pathname !== '/mcp') {
    res.writeHead(404, { ...headers, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { ...headers, 'Content-Type': 'application/json', Allow: 'POST' });
    res.end(JSON.stringify({ error: 'Method Not Allowed' }));
    return;
  }

  const apiKey = extractApiKey(req, config);
  for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  const mcpServer = createMcpServer({ apiKey, config });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: config.maxBodyBytes,
  });
  transport.onerror = (error) => console.error('[mcp] transport error:', error?.message || error);

  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error('[mcp] request failed:', error?.message || error);
    if (!res.headersSent) {
      res.writeHead(500, { ...headers, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal Server Error' }, id: null }));
    } else if (!res.writableEnded) {
      res.end();
    }
  } finally {
    await mcpServer.close().catch(() => {});
    if (config.logRequests) {
      console.log(`[http] ${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
    }
  }
}

export function createHttpServer(config) {
  const server = createServer((req, res) => {
    handleHttpRequest(req, res, config).catch((error) => {
      console.error('[http] unhandled request error:', error?.message || error);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json', ...commonHeaders(config, req) });
      }
      if (!res.writableEnded) res.end(JSON.stringify({ error: 'Internal Server Error' }));
    });
  });

  server.on('clientError', (error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  server.requestTimeout = config.openRouterTimeoutMs + 30000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  return server;
}

/**
 * Start the HTTP server. Resolves with the server, its actual port, and a
 * close function. Pass PORT=0 to let the OS choose a free port.
 */
export async function startServer(config = loadConfig()) {
  const server = createHttpServer(config);
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(config.port, config.host);
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;
  console.log(`[openrouter-image-mcp] listening on http://${config.host}:${port} (MCP endpoint: /mcp)`);

  let closed = false;
  const close = () =>
    new Promise((resolve, reject) => {
      if (closed) {
        resolve();
        return;
      }
      closed = true;
      server.close((error) => {
        server.closeAllConnections?.();
        if (error) reject(error);
        else resolve();
      });
      server.closeAllConnections?.();
    });

  return { server, port, close };
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const config = loadConfig();
  const { close } = await startServer(config);

  const shutdown = async (signal) => {
    console.log(`[openrouter-image-mcp] received ${signal}, shutting down`);
    try {
      await close();
      process.exit(0);
    } catch (error) {
      console.error('[openrouter-image-mcp] shutdown failed:', error?.message || error);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
