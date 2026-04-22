const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;

function loadEnvFile() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  content.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eq = trimmed.indexOf('=');
    if (eq === -1) return;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  });
}

loadEnvFile();

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const CLIENT_REGISTRY_URL = process.env.CLIENT_REGISTRY_URL || '';
const BASIC_AUTH_USER = process.env.BASIC_AUTH_USER || '';
const BASIC_AUTH_PASSWORD = process.env.BASIC_AUTH_PASSWORD || '';

function isBasicAuthEnabled() {
  return !!(BASIC_AUTH_USER && BASIC_AUTH_PASSWORD);
}

function decodeBasicAuthHeader(headerValue) {
  if (!headerValue || !headerValue.startsWith('Basic ')) return null;
  try {
    const decoded = Buffer.from(headerValue.slice(6), 'base64').toString('utf8');
    const separatorIndex = decoded.indexOf(':');
    if (separatorIndex === -1) return null;
    return {
      user: decoded.slice(0, separatorIndex),
      password: decoded.slice(separatorIndex + 1)
    };
  } catch (error) {
    return null;
  }
}

function isAuthorized(req) {
  if (!isBasicAuthEnabled()) return true;
  const credentials = decodeBasicAuthHeader(req.headers.authorization || '');
  return !!credentials && credentials.user === BASIC_AUTH_USER && credentials.password === BASIC_AUTH_PASSWORD;
}

function requestBasicAuth(res) {
  res.writeHead(401, {
    'Content-Type': 'text/plain; charset=utf-8',
    'WWW-Authenticate': 'Basic realm="Mapovani predluzeni", charset="UTF-8"',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  });
  res.end('Authentication required');
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  });
  res.end(payload);
}

function serveFile(res, filePath) {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  const stat = fs.statSync(filePath);
  if (!stat.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const typeMap = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
  };

  res.writeHead(200, {
    'Content-Type': typeMap[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=300',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer'
  });
  fs.createReadStream(filePath).pipe(res);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    const maxBytes = 50 * 1024 * 1024;
    req.on('data', chunk => {
      data += chunk;
      if (data.length > maxBytes) {
        reject(new Error('Request too large.'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function proxyGemini(payload) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      reject(new Error('V .env chybí GEMINI_API_KEY.'));
      return;
    }

    const body = JSON.stringify(payload);
    const request = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, response => {
      let data = '';
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Gemini API chyba (${response.statusCode}): ${data}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (error) {
          reject(new Error('Neplatná odpověď z Gemini API.'));
        }
      });
    });

    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

function fetchText(targetUrl, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const transport = parsed.protocol === 'https:' ? https : http;
    const request = transport.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: `${parsed.pathname}${parsed.search}`,
      method: 'GET'
    }, response => {
      let data = '';
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          if (redirectCount >= 5) {
            reject(new Error('Prilis mnoho presmerovani pri nacitani registru klientu.'));
            return;
          }
          const location = response.headers.location;
          if (!location) {
            reject(new Error(`Registr klientu vratil presmerovani (${response.statusCode}) bez adresy.`));
            return;
          }
          const redirectUrl = new URL(location, parsed).toString();
          fetchText(redirectUrl, redirectCount + 1).then(resolve).catch(reject);
          return;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Registr klientu vratil chybu (${response.statusCode}).`));
          return;
        }
        resolve(data);
      });
    });
    request.on('error', reject);
    request.end();
  });
}

function parseRegistryResponse(rawText, callbackName) {
  const text = String(rawText || '').trim();
  if (!text) return [];

  try {
    return JSON.parse(text);
  } catch (jsonError) {
    const prefix = `${callbackName}(`;
    if (text.startsWith(prefix) && text.endsWith(')')) {
      return JSON.parse(text.slice(prefix.length, -1));
    }
    if (text.startsWith(prefix) && text.endsWith(');')) {
      return JSON.parse(text.slice(prefix.length, -2));
    }
    throw new Error('Registr klientu nevratil platny JSON.');
  }
}

async function fetchClientRegistry() {
  if (!CLIENT_REGISTRY_URL) {
    throw new Error('V prostredi chybi CLIENT_REGISTRY_URL.');
  }

  const callbackName = '__serverRegistryCallback';
  const targetUrl = `${CLIENT_REGISTRY_URL}${CLIENT_REGISTRY_URL.includes('?') ? '&' : '?'}callback=${callbackName}&_=${Date.now()}`;
  const rawText = await fetchText(targetUrl);
  const items = parseRegistryResponse(rawText, callbackName);
  if (!Array.isArray(items)) {
    throw new Error('Registr klientu nevratil seznam.');
  }
  return items;
}

const server = http.createServer(async (req, res) => {
  try {
    if (!isAuthorized(req)) {
      requestBasicAuth(res);
      return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'POST' && url.pathname === '/api/gemini') {
      const rawBody = await readRequestBody(req);
      const payload = JSON.parse(rawBody || '{}');
      const result = await proxyGemini(payload);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/client-registry') {
      const items = await fetchClientRegistry();
      sendJson(res, 200, items);
      return;
    }

    if ((req.method === 'GET' || req.method === 'HEAD') && (url.pathname === '/' || url.pathname === '/index.html')) {
      serveFile(res, path.join(ROOT, 'index.html'));
      return;
    }

    const safePath = path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
    const filePath = path.join(ROOT, safePath);
    if (filePath.startsWith(ROOT)) {
      serveFile(res, filePath);
      return;
    }

    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
  } catch (error) {
    sendJson(res, 500, { error: error.message || 'Server error' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Mapování běží na http://localhost:${PORT}`);
});
