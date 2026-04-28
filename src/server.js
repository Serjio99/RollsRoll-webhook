'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const LOG_DIR = path.join(ROOT_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'webhook-events.log');
const MAX_MOCK_EVENTS = 30;

loadEnv(path.join(ROOT_DIR, '.env'));

const config = {
  port: parseInteger(process.env.PORT, 3000),
  webhookSecret: process.env.WEBHOOK_SECRET || '',
  suvvyApiUrl: process.env.SUVVY_API_URL || '',
  suvvyApiToken: process.env.SUVVY_API_TOKEN || '',
  suvvyTimeoutMs: parseInteger(process.env.SUVVY_REQUEST_TIMEOUT_MS, 10000),
  mockSuvvyEnabled: String(process.env.MOCK_SUVVY_ENABLED || '').toLowerCase() === 'true',
  maxApiUrl: process.env.MAX_API_URL || '',
  maxBotToken: process.env.MAX_BOT_TOKEN || '',
};

const requiredFields = [
  'order_id',
  'order_number',
  'status_id',
  'status_name',
  'client_phone',
  'client_name',
];

const defaultStatusMessages = {
  '1': 'Заказ #{order_number} принят.',
  '2': 'Заказ #{order_number} готовится.',
  '3': 'Заказ #{order_number} принят.',
  '4': 'Заказ #{order_number} готовится.',
  '5': 'Заказ #{order_number} передан курьеру.',
  '6': 'Заказ #{order_number} доставлен. Спасибо за заказ!',
  '7': 'Заказ #{order_number} отменен.',
  accepted: 'Заказ #{order_number} принят.',
  cooking: 'Заказ #{order_number} готовится.',
  courier: 'Заказ #{order_number} передан курьеру.',
  delivered: 'Заказ #{order_number} доставлен. Спасибо за заказ!',
  cancelled: 'Заказ #{order_number} отменен.',
};

const statusMessages = {
  ...defaultStatusMessages,
  ...parseStatusMessages(process.env.STATUS_MESSAGES_JSON),
};

const mockSuvvyEvents = [];

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/') {
      return sendHtml(res, 200, renderTestPanel());
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, {
        ok: true,
        service: 'rollsroll-webhook-service',
        mock_suvvy_enabled: config.mockSuvvyEnabled,
        suvvy_api_url: config.suvvyApiUrl,
      });
    }

    if (req.method === 'GET' && url.pathname === '/mock-suvvy/events') {
      return sendJson(res, 200, { ok: true, events: mockSuvvyEvents });
    }

    if (req.method === 'POST' && url.pathname === '/mock-suvvy') {
      return await handleMockSuvvy(req, res);
    }

    if (req.method === 'POST' && url.pathname === '/webhook/frontpad/order-status') {
      return await handleFrontpadWebhook(req, res);
    }

    return sendJson(res, 404, { ok: false, error: 'Not found' });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    const clientMessage = statusCode === 400 ? error.message : 'Internal server error';

    logEvent('error', 'Request processing failed', {
      message: error.message,
      stack: error.stack,
      statusCode,
    });

    return sendJson(res, statusCode, { ok: false, error: clientMessage });
  }
});

if (require.main === module) {
  server.listen(config.port, () => {
    ensureLogDir();
    console.log(`RollsRoll webhook service listening on http://localhost:${config.port}`);
    console.log(`Customer test panel: http://localhost:${config.port}/`);
  });
}

async function handleFrontpadWebhook(req, res) {
  if (!isValidSecret(req.headers['x-webhook-secret'], config.webhookSecret)) {
    logEvent('warn', 'Webhook rejected: invalid secret', { ip: req.socket.remoteAddress });
    return sendJson(res, 401, { ok: false, error: 'Invalid webhook secret' });
  }

  const body = await readJsonBody(req);
  const validationErrors = validatePayload(body);

  if (validationErrors.length > 0) {
    logEvent('warn', 'Webhook rejected: invalid payload', { errors: validationErrors, payload: body });
    return sendJson(res, 400, { ok: false, error: 'Invalid payload', details: validationErrors });
  }

  logEvent('info', 'Frontpad order status event received', sanitizeForLog(body));

  const messageText = buildOrderStatusMessage(body);
  const suvvyPayload = buildSuvvyPayload(body, messageText);
  const suvvyResponse = await sendToSuvvy(suvvyPayload);

  logEvent('info', 'Event forwarded to Suvvy', {
    order_id: body.order_id,
    order_number: body.order_number,
    suvvy_status: suvvyResponse.status,
  });

  return sendJson(res, 200, {
    ok: true,
    message: 'Webhook processed',
    order_id: body.order_id,
    order_number: body.order_number,
  });
}

async function handleMockSuvvy(req, res) {
  if (!config.mockSuvvyEnabled) {
    return sendJson(res, 404, { ok: false, error: 'Mock Suvvy is disabled' });
  }

  const payload = await readJsonBody(req);
  const event = {
    ts: new Date().toISOString(),
    payload,
  };

  mockSuvvyEvents.unshift(event);
  mockSuvvyEvents.splice(MAX_MOCK_EVENTS);

  logEvent('info', 'Mock Suvvy received payload', {
    order_id: payload && payload.order ? payload.order.id : undefined,
    order_number: payload && payload.order ? payload.order.number : undefined,
    message: payload && payload.message ? payload.message.text : undefined,
  });

  return sendJson(res, 200, { ok: true, mock: true, received_at: event.ts });
}

function validatePayload(payload) {
  const errors = [];

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return ['Payload must be a JSON object'];
  }

  for (const field of requiredFields) {
    if (payload[field] === undefined || payload[field] === null || String(payload[field]).trim() === '') {
      errors.push(`${field} is required`);
    }
  }

  if (payload.items !== undefined && !Array.isArray(payload.items)) {
    errors.push('items must be an array when provided');
  }

  return errors;
}

function buildOrderStatusMessage(order) {
  const statusKey = getStatusKey(order.status_id, order.status_name);
  const template = statusMessages[String(order.status_id)] || statusMessages[statusKey] || 'Статус заказа #{order_number}: #{status_name}.';
  const lines = [
    renderTemplate(template, order),
    order.delivery_time ? `Время доставки: ${order.delivery_time}` : null,
    order.delivery_address ? `Адрес: ${order.delivery_address}` : null,
    order.order_sum ? `Сумма: ${order.order_sum} руб.` : null,
  ].filter(Boolean);

  return lines.join('\n');
}

function getStatusKey(statusId, statusName) {
  const normalized = String(statusName || '').trim().toLowerCase();

  if (normalized.includes('прин')) return 'accepted';
  if (normalized.includes('готов') || normalized.includes('готовит')) return 'cooking';
  if (normalized.includes('курьер')) return 'courier';
  if (normalized.includes('достав')) return 'delivered';
  if (normalized.includes('отмен')) return 'cancelled';

  const byId = {
    '1': 'accepted',
    '2': 'cooking',
    '3': 'accepted',
    '4': 'cooking',
    '5': 'courier',
    '6': 'delivered',
    '7': 'cancelled',
  };

  return byId[String(statusId)] || 'unknown';
}

function buildSuvvyPayload(order, messageText) {
  return {
    event: 'rollsroll_order_status_changed',
    source: 'frontpad',
    channel: 'max',
    recipient: {
      phone: normalizePhone(order.client_phone),
      max_user_id: order.max_user_id || null,
      name: order.client_name,
    },
    order: {
      id: String(order.order_id),
      number: String(order.order_number),
      status_id: String(order.status_id),
      status_name: String(order.status_name),
      delivery_time: order.delivery_time || null,
      delivery_address: order.delivery_address || null,
      sum: order.order_sum || null,
      items: Array.isArray(order.items) ? order.items : [],
      comment: order.comment || null,
      payment_type: order.payment_type || null,
      created_at: order.created_at || null,
    },
    message: {
      text: messageText,
    },
  };
}

async function sendToSuvvy(payload) {
  if (!config.suvvyApiUrl) {
    const error = new Error('SUVVY_API_URL is not configured');
    error.statusCode = 500;
    throw error;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.suvvyTimeoutMs);

  try {
    const response = await fetch(config.suvvyApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.suvvyApiToken ? { Authorization: `Bearer ${config.suvvyApiToken}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const responseText = await response.text();

    if (!response.ok) {
      const error = new Error(`Suvvy API returned ${response.status}: ${responseText}`);
      error.statusCode = 500;
      throw error;
    }

    return {
      status: response.status,
      body: responseText,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function renderTestPanel() {
  const defaultPayload = {
    event: 'order_status_changed',
    order_id: '12345678',
    order_number: '000123',
    status_id: '3',
    status_name: 'Принят',
    client_name: 'Иван',
    client_phone: '79000000000',
    delivery_time: '18:40',
    delivery_address: 'ул. Ленина, 10',
    order_sum: '1450',
    items: [
      {
        name: 'Филадельфия',
        quantity: 1,
        price: 590,
      },
    ],
    comment: 'Без васаби',
    payment_type: 'Картой',
    max_user_id: 'optional',
    created_at: '2026-04-28 14:30:00',
  };

  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>RollsRoll webhook demo</title>
  <style>
    :root { color-scheme: light; --bg:#f6f3ed; --ink:#202124; --muted:#667085; --line:#d8d2c7; --accent:#b3261e; --accent2:#1f7a5a; --panel:#fffaf2; --code:#111827; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: Arial, sans-serif; color: var(--ink); background: var(--bg); }
    header { padding: 28px 34px 18px; border-bottom: 1px solid var(--line); background: #fffaf2; }
    h1 { margin: 0 0 8px; font-size: 28px; letter-spacing: 0; }
    p { margin: 0; color: var(--muted); line-height: 1.45; }
    main { display: grid; grid-template-columns: minmax(420px, 1.1fr) minmax(360px, .9fr); gap: 18px; padding: 22px 34px 34px; }
    section { min-width: 0; }
    .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 18px; box-shadow: 0 8px 24px rgba(32,33,36,.06); }
    .stack { display: grid; gap: 14px; }
    .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    label { display: block; font-weight: 700; margin-bottom: 8px; }
    input, textarea { width: 100%; border: 1px solid var(--line); border-radius: 6px; padding: 11px 12px; font: 14px/1.45 Consolas, 'Courier New', monospace; background: #fff; color: var(--code); }
    textarea { min-height: 430px; resize: vertical; }
    button { border: 0; border-radius: 6px; padding: 11px 14px; font-weight: 700; cursor: pointer; background: var(--accent); color: white; }
    button.secondary { background: #343741; }
    button.ghost { color: var(--ink); background: transparent; border: 1px solid var(--line); }
    pre { margin: 0; white-space: pre-wrap; word-break: break-word; background: #111827; color: #e5e7eb; border-radius: 8px; padding: 14px; min-height: 120px; max-height: 430px; overflow: auto; }
    .status { display: inline-flex; align-items: center; gap: 7px; border: 1px solid var(--line); border-radius: 999px; padding: 7px 10px; background: #fff; color: var(--muted); font-size: 13px; }
    .dot { width: 8px; height: 8px; border-radius: 999px; background: #9ca3af; }
    .ok .dot { background: var(--accent2); }
    .bad .dot { background: var(--accent); }
    .hint { font-size: 13px; color: var(--muted); }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .mini { padding: 12px; background: #fff; border: 1px solid var(--line); border-radius: 8px; }
    .mini b { display: block; margin-bottom: 5px; }
    @media (max-width: 980px) { main { grid-template-columns: 1fr; padding: 18px; } header { padding: 22px 18px 14px; } textarea { min-height: 330px; } }
  </style>
</head>
<body>
  <header>
    <h1>RollsRoll webhook demo</h1>
    <p>Тестовая панель для презентации: вставьте JSON события Frontpad, отправьте webhook и посмотрите, какой payload сервис передал в Suvvy.</p>
  </header>
  <main>
    <section class="panel stack">
      <div class="row">
        <span id="health" class="status"><span class="dot"></span><span>Проверяем сервис...</span></span>
        <button class="ghost" type="button" onclick="checkHealth()">Обновить статус</button>
      </div>
      <div>
        <label for="secret">X-Webhook-Secret</label>
        <input id="secret" value="${escapeHtml(config.webhookSecret || 'test-secret-123')}">
        <p class="hint">Значение должно совпадать с WEBHOOK_SECRET в файле .env.</p>
      </div>
      <div>
        <label for="payload">Тестовый JSON от Frontpad</label>
        <textarea id="payload" spellcheck="false">${escapeHtml(JSON.stringify(defaultPayload, null, 2))}</textarea>
      </div>
      <div class="row">
        <button type="button" onclick="sendWebhook()">Отправить webhook</button>
        <button class="secondary" type="button" onclick="loadSample('courier')">Статус: курьер</button>
        <button class="secondary" type="button" onclick="loadSample('delivered')">Статус: доставлен</button>
        <button class="ghost" type="button" onclick="formatJson()">Отформатировать JSON</button>
      </div>
    </section>

    <section class="stack">
      <div class="panel stack">
        <div class="grid2">
          <div class="mini"><b>Webhook endpoint</b><span class="hint">POST /webhook/frontpad/order-status</span></div>
          <div class="mini"><b>Suvvy URL сейчас</b><span class="hint">${escapeHtml(config.suvvyApiUrl || 'не задан')}</span></div>
        </div>
        <div>
          <label>Ответ webhook-сервиса</label>
          <pre id="response">Пока запрос не отправлялся.</pre>
        </div>
      </div>

      <div class="panel stack">
        <div class="row">
          <div style="flex:1">
            <label>Последний payload, полученный Suvvy</label>
            <p class="hint">В demo-mode это принимает встроенный mock Suvvy: POST /mock-suvvy.</p>
          </div>
          <button class="ghost" type="button" onclick="loadSuvvyEvents()">Обновить</button>
        </div>
        <pre id="suvvy">Пока Suvvy ничего не получал.</pre>
      </div>

      <div class="panel stack">
        <label>Куда вставлять API</label>
        <div class="mini"><b>Suvvy-бот</b><span class="hint">.env -> SUVVY_API_URL и SUVVY_API_TOKEN. Это основной путь интеграции.</span></div>
        <div class="mini"><b>MAX-бот</b><span class="hint">Если отправляем напрямую в MAX, добавить .env -> MAX_API_URL и MAX_BOT_TOKEN, затем заменить sendToSuvvy на отправку в MAX или оставить MAX внутри Suvvy.</span></div>
      </div>
    </section>
  </main>
<script>
const samples = {
  courier: { status_id: '5', status_name: 'Передан курьеру' },
  delivered: { status_id: '6', status_name: 'Доставлен' }
};

async function checkHealth() {
  const el = document.getElementById('health');
  try {
    const res = await fetch('/health');
    const data = await res.json();
    el.className = 'status ok';
    el.lastElementChild.textContent = data.ok ? 'Сервис работает' : 'Сервис отвечает с ошибкой';
  } catch (error) {
    el.className = 'status bad';
    el.lastElementChild.textContent = 'Сервис недоступен';
  }
}

async function sendWebhook() {
  const out = document.getElementById('response');
  out.textContent = 'Отправляем...';
  try {
    const payload = JSON.parse(document.getElementById('payload').value);
    const response = await fetch('/webhook/frontpad/order-status', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Secret': document.getElementById('secret').value
      },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    out.textContent = JSON.stringify({ http_status: response.status, body: data }, null, 2);
    await loadSuvvyEvents();
  } catch (error) {
    out.textContent = error.message;
  }
}

function loadSample(name) {
  const current = JSON.parse(document.getElementById('payload').value);
  document.getElementById('payload').value = JSON.stringify({ ...current, ...samples[name] }, null, 2);
}

function formatJson() {
  const field = document.getElementById('payload');
  field.value = JSON.stringify(JSON.parse(field.value), null, 2);
}

async function loadSuvvyEvents() {
  const out = document.getElementById('suvvy');
  const response = await fetch('/mock-suvvy/events');
  const data = await response.json();
  out.textContent = data.events && data.events.length ? JSON.stringify(data.events[0], null, 2) : 'Пока Suvvy ничего не получал.';
}

checkHealth();
loadSuvvyEvents();
</script>
</body>
</html>`;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';

    req.setEncoding('utf8');

    req.on('data', (chunk) => {
      raw += chunk;

      if (raw.length > 1024 * 1024) {
        const error = new Error('Payload is too large');
        error.statusCode = 400;
        reject(error);
        req.destroy();
      }
    });

    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch (error) {
        const parseError = new Error('Request body must be valid JSON');
        parseError.statusCode = 400;
        reject(parseError);
      }
    });

    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function isValidSecret(receivedSecret, expectedSecret) {
  if (!expectedSecret) return false;
  return String(receivedSecret || '') === expectedSecret;
}

function logEvent(level, message, data = {}) {
  ensureLogDir();

  const entry = {
    ts: new Date().toISOString(),
    level,
    message,
    data,
  };

  const line = JSON.stringify(entry) + '\n';
  fs.appendFileSync(LOG_FILE, line, 'utf8');

  const consoleMessage = `[${entry.ts}] ${level.toUpperCase()} ${message}`;
  if (level === 'error') {
    console.error(consoleMessage, data);
  } else {
    console.log(consoleMessage, data);
  }
}

function sanitizeForLog(payload) {
  return {
    ...payload,
    client_phone: maskPhone(payload.client_phone),
  };
}

function maskPhone(phone) {
  const value = String(phone || '');
  if (value.length <= 4) return '****';
  return `${'*'.repeat(Math.max(0, value.length - 4))}${value.slice(-4)}`;
}

function normalizePhone(phone) {
  return String(phone || '').replace(/[^0-9]/g, '');
}

function renderTemplate(template, order) {
  return String(template).replace(/#\{([a-zA-Z0-9_]+)\}/g, (_, key) => {
    return order[key] === undefined || order[key] === null ? '' : String(order[key]);
  });
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseStatusMessages(value) {
  if (!value) return {};

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    console.warn('STATUS_MESSAGES_JSON is not valid JSON and will be ignored');
    return {};
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

module.exports = {
  server,
  buildOrderStatusMessage,
  buildSuvvyPayload,
  sendToSuvvy,
  validatePayload,
};

