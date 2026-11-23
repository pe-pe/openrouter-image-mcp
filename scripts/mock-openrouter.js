import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

// A 1x1 transparent PNG. Enough for MCP image content in tests without a real
// OpenRouter call.
export const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function readJsonBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function defaultResponse(body) {
  const useUrl = body?.response_format === 'url';
  const image = useUrl
    ? { url: 'https://example.com/generated-image.png', expires_at: Math.floor(Date.now() / 1000) + 86400 }
    : { b64_json: TINY_PNG_BASE64, media_type: 'image/png' };

  return {
    status: 200,
    body: {
      created: Math.floor(Date.now() / 1000),
      data: [image],
      usage: { cost: 0.001 },
    },
  };
}

/**
 * Start a local OpenRouter Images API mock. Returns the server, its port, the
 * captured requests, and helpers to change the expected key or response.
 */
export async function createMockOpenRouter({
  host = '127.0.0.1',
  port = 0,
  expectedKey = '',
  response,
  maxBodyBytes = 1_000_000,
} = {}) {
  const requests = [];
  let overrideResponse = response;
  let expected = expectedKey;

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

      if (req.method === 'GET' && url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/v1/images/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            data: [
              { id: 'bytedance-seed/seedream-4.5', name: 'ByteDance Seed: Seedream 4.5' },
              { id: 'recraft/recraft-v4.1-flash-v2', name: 'Recraft: Recraft V4.1 Flash V2' },
            ],
          })
        );
        return;
      }

      if (req.method !== 'POST' || url.pathname !== '/api/v1/images') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Not Found' } }));
        return;
      }

      const body = await readJsonBody(req, maxBodyBytes);
      const authorization = req.headers.authorization || '';
      requests.push({ method: req.method, path: url.pathname, authorization, body });

      if (expected && authorization !== `Bearer ${expected}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
        return;
      }

      const result = overrideResponse ? await overrideResponse(body, req) : defaultResponse(body);
      res.writeHead(result.status || 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.body));
    } catch (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: error?.message || 'Bad Request' } }));
    }
  });

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
    server.listen(port, host);
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;

  return {
    server,
    host,
    port: actualPort,
    requests,
    setResponse(value) {
      overrideResponse = value;
    },
    setExpectedKey(value) {
      expected = value;
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close((error) => {
          server.closeAllConnections?.();
          if (error) reject(error);
          else resolve();
        });
        server.closeAllConnections?.();
      });
    },
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const host = process.env.MOCK_HOST || '127.0.0.1';
  const port = Number(process.env.MOCK_PORT || 4010);
  const expectedKey = process.env.MOCK_EXPECTED_KEY || '';
  const mock = await createMockOpenRouter({ host, port, expectedKey });
  console.log(`[mock-openrouter] listening on http://${host}:${mock.port}/api/v1/images`);

  const shutdown = async () => {
    await mock.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
