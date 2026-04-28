'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');
const LOG_DIR = path.join(ROOT_DIR, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'webhook-events.log');
const MAX_MOCK_EVENTS = 30;
const MAX_CHAT_MESSAGES = 50;

loadEnv(path.join(ROOT_DIR, '.env'));

const config = {
  port: parseInteger(process.env.PORT, 3000),
  webhookSecret: process.env.WEBHOOK_SECRET || '',
  deliveryTargets: parseList(process.env.DELIVERY_TARGETS || 'suvvy'),
  mockSuvvyEnabled: parseBoolean(process.env.MOCK_SUVVY_ENABLED),

  suvvyApiUrl: process.env.SUVVY_API_URL || '',
  suvvyApiToken: process.env.SUVVY_API_TOKEN || '',
  suvvyDeliveryMode: process.env.SUVVY_DELIVERY_MODE || 'widget',
  suvvyTelegramWebhookUrl: process.env.SUVVY_TELEGRAM_WEBHOOK_URL || '',
  suvvyChatIdField: process.env.SUVVY_CHAT_ID_FIELD || 'client_phone',
  suvvyWidgetOriginUrl: process.env.SUVVY_WIDGET_ORIGIN_URL || 'https://webhook.prom-logic.ru',
  suvvyWidgetSessionPrefix: process.env.SUVVY_WIDGET_SESSION_PREFIX || '',
  suvvyTimeoutMs: parseInteger(process.env.SUVVY_REQUEST_TIMEOUT_MS, 10000),

  telegramEnabled: parseBoolean(process.env.TELEGRAM_ENABLED),
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',

  maxEnabled: parseBoolean(process.env.MAX_ENABLED),
  maxApiUrl: process.env.MAX_API_URL || '',
  maxBotToken: process.env.MAX_BOT_TOKEN || '',

  websiteChatEnabled: parseBoolean(process.env.WEBSITE_CHAT_ENABLED),
  websiteChatProvider: process.env.WEBSITE_CHAT_PROVIDER || 'suvvy',
  suvvyWidgetId: process.env.SUVVY_WIDGET_ID || '',
  jivoWidgetId: process.env.JIVO_WIDGET_ID || '',
  showChatPlaceholder: parseBoolean(process.env.SHOW_CHAT_PLACEHOLDER || 'true'),
  localSiteChatEnabled: parseBoolean(process.env.LOCAL_SITE_CHAT_ENABLED || 'true'),
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
  '1': 'Ваш заказ #{order_number} принят и оформляется.',
  '2': 'Заказ #{order_number} готовится.',
  '3': 'Ваш заказ #{order_number} принят и оформляется.',
  '4': 'Заказ #{order_number} готовится.',
  '5': 'Ваш заказ #{order_number} доставляется.',
  '6': 'Заказ #{order_number} доставлен. Спасибо за заказ!',
  '7': 'Заказ #{order_number} отменен.',
  '8': 'Заказ #{order_number} задерживается. Мы сообщим обновленное время доставки.',
  '9': 'Заказ #{order_number} готов к выдаче.',
  '10': 'Заказ #{order_number} ожидает оплаты.',
  accepted: 'Ваш заказ #{order_number} принят и оформляется.',
  cooking: 'Заказ #{order_number} готовится.',
  courier: 'Ваш заказ #{order_number} доставляется.',
  delivered: 'Заказ #{order_number} доставлен. Спасибо за заказ!',
  cancelled: 'Заказ #{order_number} отменен.',
};

const statusMessages = {
  ...defaultStatusMessages,
  ...parseStatusMessages(process.env.STATUS_MESSAGES_JSON),
};

const mockSuvvyEvents = [];
const siteChatMessages = [];
const channelDeliveries = [];
const mockTelegramMessages = [];
const mockMaxMessages = [];

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/') {
      return sendHtml(res, 200, renderTestPanel());
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, buildHealthPayload());
    }

    if (req.method === 'GET' && url.pathname === '/mock-suvvy/events') {
      return sendJson(res, 200, { ok: true, events: mockSuvvyEvents });
    }

    if (req.method === 'GET' && url.pathname === '/channels/messages') {
      return sendJson(res, 200, {
        ok: true,
        telegram: mockTelegramMessages,
        max: mockMaxMessages,
        site_chat: siteChatMessages,
        deliveries: channelDeliveries,
      });
    }

    if (req.method === 'GET' && url.pathname === '/site-chat/messages') {
      return sendJson(res, 200, { ok: true, messages: siteChatMessages });
    }

    if (req.method === 'POST' && url.pathname === '/site-chat/message') {
      return await handleSiteChatMessage(req, res);
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
  const notificationPayload = buildNotificationPayload(body, messageText);
  const deliveryResults = await deliverNotification(notificationPayload);

  logEvent('info', 'Event delivered', {
    order_id: body.order_id,
    order_number: body.order_number,
    results: deliveryResults.map((result) => ({ target: result.target, status: result.status })),
  });

  return sendJson(res, 200, {
    ok: true,
    message: 'Webhook processed',
    order_id: body.order_id,
    order_number: body.order_number,
    deliveries: deliveryResults.map((result) => ({ target: result.target, status: result.status, body: result.body || null })),
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

  const fanout = simulateSuvvyFanout(payload);

  logEvent('info', 'Mock Suvvy received trigger and delivered channel messages', {
    order_id: payload && payload.order ? payload.order.id : undefined,
    order_number: payload && payload.order ? payload.order.number : undefined,
    message: payload && payload.message ? payload.message.text : undefined,
    channels: fanout.map((item) => item.channel),
  });

  return sendJson(res, 200, { ok: true, mock: true, received_at: event.ts, fanout });
}

function simulateSuvvyFanout(payload) {
  const text = payload && payload.message ? payload.message.text : 'Статус заказа обновлён.';
  const orderNumber = payload && payload.order ? payload.order.number : '—';
  const clientName = payload && payload.recipient ? payload.recipient.name : 'Клиент';
  const ts = new Date().toISOString();
  const messages = [
    { channel: 'telegram', title: 'Telegram bot', text, ts, order_number: orderNumber, recipient: clientName },
    { channel: 'max', title: 'MAX bot', text, ts, order_number: orderNumber, recipient: clientName },
    { channel: 'site_chat', title: 'Site chat', text, ts, order_number: orderNumber, recipient: clientName },
  ];

  mockTelegramMessages.unshift(messages[0]);
  mockMaxMessages.unshift(messages[1]);
  siteChatMessages.push({
    id: `msg_${Date.now()}_suvvy_order`,
    ts,
    role: 'assistant',
    text,
  });
  channelDeliveries.unshift(...messages);

  while (mockTelegramMessages.length > MAX_CHAT_MESSAGES) mockTelegramMessages.pop();
  while (mockMaxMessages.length > MAX_CHAT_MESSAGES) mockMaxMessages.pop();
  while (siteChatMessages.length > MAX_CHAT_MESSAGES) siteChatMessages.shift();
  while (channelDeliveries.length > MAX_CHAT_MESSAGES) channelDeliveries.pop();

  return messages;
}

async function handleSiteChatMessage(req, res) {
  if (!config.websiteChatEnabled || !config.localSiteChatEnabled || config.suvvyWidgetId) {
    return sendJson(res, 404, { ok: false, error: 'Site chat is disabled' });
  }

  const body = await readJsonBody(req);
  const text = String(body.message || '').trim();

  if (!text) {
    return sendJson(res, 400, { ok: false, error: 'Message is required' });
  }

  const userMessage = {
    id: `msg_${Date.now()}_user`,
    ts: new Date().toISOString(),
    role: 'user',
    text,
  };
  const botMessage = {
    id: `msg_${Date.now()}_assistant`,
    ts: new Date().toISOString(),
    role: 'assistant',
    text: buildSiteChatReply(text),
  };

  siteChatMessages.push(userMessage, botMessage);
  while (siteChatMessages.length > MAX_CHAT_MESSAGES) siteChatMessages.shift();

  logEvent('info', 'Site chat message processed', {
    message: text,
    reply: botMessage.text,
  });

  return sendJson(res, 200, { ok: true, reply: botMessage, messages: siteChatMessages });
}

function buildSiteChatReply(text) {
  const normalized = text.toLowerCase();

  if (normalized.includes('статус') || normalized.includes('заказ')) {
    return 'Я вижу последние события заказа в чате сайта. Выберите актуальный статус и отправьте событие: Suvvy обработает trigger и доставит клиентское уведомление в подключенные каналы.';
  }

  if (normalized.includes('достав')) {
    return 'По доставке доступны несколько сценариев: заказ доставляется, задерживается или уже доставлен. Выберите нужный статус и отправьте событие.';
  }

  if (normalized.includes('привет') || normalized.includes('здрав')) {
    return 'Здравствуйте. Это чат RollsRoll. Здесь отображаются уведомления, которые Suvvy отправляет клиенту по статусам заказа.';
  }

  return 'Сообщение принято. Для отправки клиентского уведомления выберите статус заказа и нажмите Отправить событие.';
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
  if (normalized.includes('задерж')) return 'delayed';
  if (normalized.includes('выдач')) return 'ready';
  if (normalized.includes('оплат')) return 'payment';
  if (normalized.includes('курьер') || normalized.includes('доставляется')) return 'courier';
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

function buildNotificationPayload(order, messageText) {
  return {
    event: 'rollsroll_order_status_changed',
    source: 'frontpad',
    channel: 'max',
    recipient: {
      phone: normalizePhone(order.client_phone),
      max_user_id: order.max_user_id || null,
      telegram_chat_id: order.telegram_chat_id || null,
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
    suvvy_custom_message: buildSuvvyCustomMessagePayload(order, messageText),
  };
}

function buildSuvvyPayload(order, messageText) {
  return buildNotificationPayload(order, messageText);
}

function buildSuvvyCustomMessagePayload(order, messageText) {
  const chatIdValue = order[config.suvvyChatIdField] || order.client_phone || order.order_id;

  return {
    api_version: 1,
    message_id: `frontpad_${order.order_id}_${order.status_id}_${Date.now()}`,
    chat_id: String(chatIdValue),
    text: messageText,
    source: 'RollsRoll Frontpad',
    message_sender: 'customer',
    client_name: order.client_name,
      client_phone: order.client_phone,
      telegram_chat_id: order.telegram_chat_id || '',
      suvvy_chat_id: order.suvvy_chat_id || '',
      suvvy_session_id: order.suvvy_session_id || '',
      suvvy_external_id: order.suvvy_external_id || '',
    placeholders: {
      event: order.event || 'order_status_changed',
      order_id: order.order_id,
      order_number: order.order_number,
      status_id: order.status_id,
      status_name: order.status_name,
      delivery_time: order.delivery_time || '',
      delivery_address: order.delivery_address || '',
      order_sum: order.order_sum || '',
      payment_type: order.payment_type || '',
      comment: order.comment || '',
      created_at: order.created_at || '',
    },
  };
}

async function deliverNotification(payload) {
  const targets = config.deliveryTargets.length > 0 ? config.deliveryTargets : ['suvvy'];
  const results = [];

  for (const target of targets) {
    if (target === 'suvvy') {
      results.push(await sendToSuvvy(payload));
      continue;
    }

    if (target === 'telegram') {
      results.push(await sendToTelegram(payload));
      continue;
    }

    if (target === 'max') {
      results.push(await sendToMax(payload));
      continue;
    }

    const error = new Error(`Unknown delivery target: ${target}`);
    error.statusCode = 500;
    throw error;
  }

  return results;
}

async function sendToSuvvy(payload) {
  if (config.suvvyDeliveryMode === 'telegram_webhook') {
    return await sendToSuvvyTelegramWebhook(payload);
  }

  if (config.suvvyDeliveryMode === 'widget') {
    return await sendToSuvvyWidget(payload);
  }

  if (!config.suvvyApiUrl) {
    const error = new Error('SUVVY_API_URL is not configured');
    error.statusCode = 500;
    throw error;
  }

  const requestBody = isSuvvyCustomMessageUrl(config.suvvyApiUrl)
    ? payload.suvvy_custom_message
    : payload;

  const response = await postJson(config.suvvyApiUrl, requestBody, {
    ...(config.suvvyApiToken ? { Authorization: `Bearer ${config.suvvyApiToken}` } : {}),
  });

  return { target: 'suvvy', status: response.status, body: response.body };
}

async function sendToSuvvyTelegramWebhook(payload) {
  if (!config.suvvyTelegramWebhookUrl) {
    const error = new Error('SUVVY_TELEGRAM_WEBHOOK_URL is not configured');
    error.statusCode = 500;
    throw error;
  }

  const chatId = payload.recipient.telegram_chat_id || config.telegramChatId;
  if (!chatId || String(chatId).toLowerCase() === 'optional') {
    const error = new Error('telegram_chat_id is required for Suvvy Telegram webhook delivery');
    error.statusCode = 400;
    throw error;
  }

  const now = Math.floor(Date.now() / 1000);
  const update = {
    update_id: Number(String(Date.now()).slice(-9)),
    message: {
      message_id: Number(String(Date.now()).slice(-6)),
      from: {
        id: Number(chatId),
        is_bot: false,
        first_name: payload.recipient.name || 'RollsRoll',
        language_code: 'ru',
      },
      chat: {
        id: Number(chatId),
        first_name: payload.recipient.name || 'RollsRoll',
        type: 'private',
      },
      date: now,
      text: payload.message.text,
    },
  };

  const response = await postJson(config.suvvyTelegramWebhookUrl, update);

  channelDeliveries.unshift({
    channel: 'suvvy_telegram_webhook',
    title: 'Suvvy Telegram webhook',
    text: payload.message.text,
    ts: new Date().toISOString(),
    order_number: payload.order.number,
    recipient: payload.recipient.name,
    telegram_chat_id: String(chatId),
  });
  while (channelDeliveries.length > MAX_CHAT_MESSAGES) channelDeliveries.pop();

  return {
    target: 'suvvy',
    status: response.status,
    body: {
      mode: 'telegram_webhook',
      telegram_chat_id: String(chatId),
      response: response.body,
    },
  };
}

function isSuvvyCustomMessageUrl(value) {
  return String(value || '').includes('/api/webhook/custom/message');
}

async function sendToSuvvyWidget(payload) {
  if (!config.suvvyWidgetId) {
    const error = new Error('SUVVY_WIDGET_ID is not configured');
    error.statusCode = 500;
    throw error;
  }

  if (typeof WebSocket === 'undefined') {
    const error = new Error('Node.js WebSocket API is not available. Use Node.js 22+ or set SUVVY_DELIVERY_MODE=custom_api');
    error.statusCode = 500;
    throw error;
  }

  const body = payload.suvvy_custom_message || {};
  const sessionBase = body.chat_id || payload.recipient.phone || payload.order.id;
  const sessionId = `${config.suvvyWidgetSessionPrefix}${sessionBase}`;
  const tokenResponse = await fetch('https://api.suvvy.ai/api/webhook/widget/get_token', {
    method: 'GET',
    headers: {
      'x-widget-id': config.suvvyWidgetId,
      'x-origin-url': config.suvvyWidgetOriginUrl,
      'x-session_id': sessionId,
    },
  });

  const tokenText = await tokenResponse.text();

  if (!tokenResponse.ok) {
    const error = new Error(`Suvvy widget token request returned ${tokenResponse.status}: ${tokenText}`);
    error.statusCode = 500;
    throw error;
  }

  const widgetMessage = {
    id: body.message_id || `frontpad_${Date.now()}`,
    widget_id: config.suvvyWidgetId,
    session_id: sessionId,
    text: body.text || payload.message.text,
    ...(body.placeholders || {}),
  };

  await emitSuvvyWidgetMessage(tokenText, widgetMessage);

  channelDeliveries.unshift({
    channel: 'suvvy_widget',
    title: 'Suvvy bot',
    text: widgetMessage.text,
    ts: new Date().toISOString(),
    order_number: payload.order.number,
    recipient: payload.recipient.name,
    session_id: sessionId,
  });
  while (channelDeliveries.length > MAX_CHAT_MESSAGES) channelDeliveries.pop();

  return {
    target: 'suvvy',
    status: 200,
    body: {
      mode: 'widget',
      origin_url: config.suvvyWidgetOriginUrl,
      session_id: sessionId,
      message_id: widgetMessage.id,
    },
  };
}

function emitSuvvyWidgetMessage(widgetToken, widgetMessage) {
  return new Promise((resolve, reject) => {
    const wsUrl = `wss://api.suvvy.ai/socket.io/widget?widget_token=${encodeURIComponent(widgetToken)}&EIO=4&transport=websocket`;
    const socket = new WebSocket(wsUrl);
    let sent = false;

    const timeout = setTimeout(() => {
      tryCloseSocket(socket);
      reject(new Error('Suvvy widget socket timeout'));
    }, config.suvvyTimeoutMs);

    socket.onopen = () => {};

    socket.onerror = () => {
      clearTimeout(timeout);
      reject(new Error('Suvvy widget socket connection error'));
    };

    socket.onmessage = (event) => {
      const data = String(event.data || '');

      if (data.startsWith('0')) {
        socket.send('40');
        return;
      }

      if (data === '2') {
        socket.send('3');
        return;
      }

      if (!sent && data.startsWith('40')) {
        sent = true;
        socket.send(`42${JSON.stringify(['widget_incoming_messages', widgetMessage])}`);
        clearTimeout(timeout);
        setTimeout(() => tryCloseSocket(socket), 300);
        resolve();
      }
    };

    socket.onclose = () => {
      if (!sent) {
        clearTimeout(timeout);
        reject(new Error('Suvvy widget socket closed before message was sent'));
      }
    };
  });
}

function tryCloseSocket(socket) {
  try {
    socket.close();
  } catch (error) {
    // Ignore close errors after the message has already been sent.
  }
}

async function sendToTelegram(payload) {
  if (!config.telegramEnabled) {
    return { target: 'telegram', status: 'skipped', body: 'TELEGRAM_ENABLED=false' };
  }

  if (!config.telegramBotToken || !config.telegramChatId) {
    return { target: 'telegram', status: 'not_configured', body: 'Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env' };
  }

  const response = await postJson(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
    chat_id: payload.recipient.telegram_chat_id || config.telegramChatId,
    text: payload.message.text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });

  return { target: 'telegram', status: response.status, body: response.body };
}

async function sendToMax(payload) {
  if (!config.maxEnabled) {
    return { target: 'max', status: 'skipped', body: 'MAX_ENABLED=false' };
  }

  if (!config.maxApiUrl || !config.maxBotToken) {
    const error = new Error('MAX is enabled but MAX_API_URL or MAX_BOT_TOKEN is not configured');
    error.statusCode = 500;
    throw error;
  }

  const response = await postJson(config.maxApiUrl, {
    recipient: payload.recipient,
    order: payload.order,
    message: payload.message,
    source: payload.source,
    event: payload.event,
  }, {
    Authorization: `Bearer ${config.maxBotToken}`,
  });

  return { target: 'max', status: response.status, body: response.body };
}

async function postJson(url, payload, extraHeaders = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.suvvyTimeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...extraHeaders,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const responseText = await response.text();

    if (!response.ok) {
      const error = new Error(`POST ${url} returned ${response.status}: ${responseText}`);
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

function buildHealthPayload() {
  const integrations = {
    suvvy: {
      target_enabled: config.deliveryTargets.includes('suvvy'),
      mock_enabled: config.mockSuvvyEnabled,
      delivery_mode: config.suvvyDeliveryMode,
      configured: config.suvvyDeliveryMode === 'telegram_webhook'
        ? Boolean(config.suvvyTelegramWebhookUrl)
        : config.suvvyDeliveryMode === 'widget'
          ? Boolean(config.suvvyWidgetId)
          : Boolean(config.suvvyApiUrl),
      url: config.suvvyApiUrl || null,
      telegram_webhook_url_configured: Boolean(config.suvvyTelegramWebhookUrl),
      widget_origin_url: config.suvvyWidgetOriginUrl,
      widget_session_prefix: config.suvvyWidgetSessionPrefix,
      token_configured: Boolean(config.suvvyApiToken),
      production_url_configured: config.suvvyDeliveryMode === 'telegram_webhook' || config.suvvyDeliveryMode === 'widget' || (Boolean(config.suvvyApiUrl) && !isLocalMockUrl(config.suvvyApiUrl)),
      production_token_configured: config.suvvyDeliveryMode === 'telegram_webhook' || config.suvvyDeliveryMode === 'widget' || (Boolean(config.suvvyApiToken) && !isPlaceholderValue(config.suvvyApiToken)),
    },
    telegram: {
      target_enabled: config.deliveryTargets.includes('telegram'),
      configured: config.telegramEnabled && Boolean(config.telegramBotToken) && Boolean(config.telegramChatId),
      enabled: config.telegramEnabled,
      chat_id_configured: Boolean(config.telegramChatId),
      token_configured: Boolean(config.telegramBotToken),
    },
    max: {
      target_enabled: config.deliveryTargets.includes('max'),
      configured: config.maxEnabled && Boolean(config.maxApiUrl) && Boolean(config.maxBotToken),
      enabled: config.maxEnabled,
      url_configured: Boolean(config.maxApiUrl),
      token_configured: Boolean(config.maxBotToken),
    },
    website_chat: {
      enabled: config.websiteChatEnabled,
      provider: config.websiteChatProvider,
      configured: config.websiteChatEnabled && (
        (config.websiteChatProvider === 'suvvy' && Boolean(config.suvvyWidgetId)) ||
        (config.websiteChatProvider === 'jivo' && Boolean(config.jivoWidgetId))
      ),
      suvvy_widget_id_configured: Boolean(config.suvvyWidgetId),
      jivo_widget_id_configured: Boolean(config.jivoWidgetId),
      placeholder_visible: config.showChatPlaceholder && !config.suvvyWidgetId && !config.jivoWidgetId,
    },
  };

  return {
    ok: true,
    service: 'rollsroll-webhook-service',
    presentation_ready: config.mockSuvvyEnabled && Boolean(config.suvvyApiUrl),
    production_ready: !config.mockSuvvyEnabled && integrations.suvvy.configured && integrations.suvvy.production_url_configured && integrations.suvvy.production_token_configured,
    delivery_targets: config.deliveryTargets,
    integrations,
    missing_for_production: buildMissingProductionItems(integrations),
  };
}

function buildMissingProductionItems(integrations) {
  const missing = [];

  if (config.mockSuvvyEnabled) missing.push('Disable MOCK_SUVVY_ENABLED for production');
  if (!integrations.suvvy.production_url_configured) missing.push('Set real SUVVY_API_URL instead of local mock URL');
  if (!integrations.suvvy.production_token_configured) missing.push('Set real SUVVY_API_TOKEN or set SUVVY_DELIVERY_MODE=widget');
  if (config.deliveryTargets.includes('telegram') && !integrations.telegram.configured) missing.push('Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID or remove telegram from DELIVERY_TARGETS');
  if (config.deliveryTargets.includes('max') && !integrations.max.configured) missing.push('Set MAX_API_URL and MAX_BOT_TOKEN or remove max from DELIVERY_TARGETS');
  if (config.websiteChatEnabled && !integrations.website_chat.configured) missing.push('Set SUVVY_WIDGET_ID to activate Suvvy website chat widget');

  return missing;
}

function isLocalMockUrl(value) {
  const normalized = String(value || '').toLowerCase();
  return normalized.includes('/mock-suvvy') || normalized.includes('localhost') || normalized.includes('127.0.0.1');
}

function isPlaceholderValue(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return !normalized || normalized.includes('test') || normalized.includes('change-me') || normalized.includes('real_') || normalized.includes('your-');
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
    telegram_chat_id: '1310305591',
    suvvy_session_id: '69f0da4cc6625338cd0f057b',
    suvvy_external_id: 'telegram_bot_8605219309_1310305591',
    suvvy_chat_id: 'telegram_bot_8605219309_1310305591',
    created_at: '2026-04-28 14:30:00',
  };

  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>RollsRoll Webhook Gateway</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5f7fb;
      --surface: #ffffff;
      --surface-2: #f9fafc;
      --ink: #172033;
      --muted: #667085;
      --line: #d9dee8;
      --line-strong: #c6cedb;
      --brand: #b42318;
      --brand-dark: #8f1c13;
      --success: #167d5b;
      --warning: #b7791f;
      --code: #101828;
      --shadow: 0 18px 45px rgba(23, 32, 51, .08);
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      font-family: Arial, sans-serif;
      color: var(--ink);
      background: var(--bg);
    }

    .topbar {
      background: var(--surface);
      border-bottom: 1px solid var(--line);
    }

    .topbar-inner {
      max-width: 1280px;
      margin: 0 auto;
      padding: 18px 28px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 260px;
    }

    .brand-mark {
      width: 42px;
      height: 42px;
      border-radius: 8px;
      background: var(--brand);
      color: #fff;
      display: grid;
      place-items: center;
      font-weight: 700;
      letter-spacing: .5px;
    }

    .brand-title {
      display: grid;
      gap: 2px;
    }

    .brand-title strong {
      font-size: 17px;
      line-height: 1.2;
    }

    .brand-title span {
      font-size: 13px;
      color: var(--muted);
    }

    .endpoint {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface-2);
      color: var(--muted);
      font-size: 13px;
      white-space: nowrap;
    }

    .page {
      max-width: 1280px;
      margin: 0 auto;
      padding: 26px 28px 96px;
      display: grid;
      gap: 18px;
    }

    .hero {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 320px;
      gap: 18px;
      align-items: stretch;
    }

    .hero-main, .panel {
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
    }

    .hero-main {
      padding: 26px;
      display: grid;
      align-content: center;
      gap: 12px;
    }

    h1 {
      margin: 0;
      font-size: 30px;
      line-height: 1.18;
      letter-spacing: 0;
    }

    .lead {
      margin: 0;
      max-width: 780px;
      color: var(--muted);
      line-height: 1.55;
      font-size: 15px;
    }

    .hero-side {
      padding: 20px;
      display: grid;
      gap: 12px;
    }

    .status-line {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface-2);
    }

    .status-label {
      display: grid;
      gap: 3px;
    }

    .status-label b { font-size: 13px; }
    .status-label span { color: var(--muted); font-size: 12px; }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      min-height: 30px;
      padding: 7px 10px;
      border-radius: 999px;
      background: #eef7f3;
      color: var(--success);
      font-size: 12px;
      font-weight: 700;
      white-space: nowrap;
    }

    .badge.warn { background: #fff7e6; color: var(--warning); }
    .badge.err { background: #fff0ee; color: var(--brand); }
    .dot { width: 8px; height: 8px; border-radius: 999px; background: currentColor; }

    .layout {
      display: grid;
      grid-template-columns: minmax(500px, 1.05fr) minmax(380px, .95fr);
      gap: 18px;
      align-items: start;
    }

    .panel {
      padding: 18px;
      display: grid;
      gap: 16px;
      min-width: 0;
    }

    .panel-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 14px;
      border-bottom: 1px solid var(--line);
      padding-bottom: 14px;
    }

    .panel-title {
      display: grid;
      gap: 4px;
    }

    .panel-title h2 {
      margin: 0;
      font-size: 18px;
      line-height: 1.25;
    }

    .panel-title p {
      margin: 0;
      color: var(--muted);
      line-height: 1.45;
      font-size: 13px;
    }

    .form-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 14px;
    }

    label {
      display: block;
      margin-bottom: 7px;
      color: #344054;
      font-size: 13px;
      font-weight: 700;
    }

    input, textarea {
      width: 100%;
      border: 1px solid var(--line-strong);
      border-radius: 7px;
      background: #fff;
      color: var(--code);
      padding: 11px 12px;
      font: 14px/1.5 Consolas, 'Courier New', monospace;
      outline: none;
    }

    input:focus, textarea:focus {
      border-color: var(--brand);
      box-shadow: 0 0 0 3px rgba(180, 35, 24, .12);
    }

    textarea {
      min-height: 430px;
      resize: vertical;
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
    }

    button {
      min-height: 40px;
      border: 0;
      border-radius: 7px;
      padding: 10px 14px;
      font-weight: 700;
      cursor: pointer;
      background: var(--brand);
      color: #fff;
    }

    button:hover { background: var(--brand-dark); }
    button.secondary { background: #344054; }
    button.secondary:hover { background: #1d2939; }
    button.ghost { color: #344054; background: #fff; border: 1px solid var(--line-strong); }
    button.ghost:hover { background: var(--surface-2); }

    pre {
      margin: 0;
      min-height: 132px;
      max-height: 360px;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      border-radius: 8px;
      background: #101828;
      color: #f2f4f7;
      padding: 14px;
      font: 13px/1.55 Consolas, 'Courier New', monospace;
    }

    .metrics {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }

    .metric {
      padding: 13px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface-2);
      display: grid;
      gap: 5px;
    }

    .metric b { font-size: 13px; }
    .metric span { color: var(--muted); font-size: 12px; line-height: 1.4; }

    .chat-launcher {
      position: fixed;
      right: 22px;
      bottom: 22px;
      z-index: 40;
      display: inline-flex;
      align-items: center;
      gap: 10px;
      min-height: 52px;
      padding: 0 18px;
      border-radius: 999px;
      border: 0;
      background: var(--brand);
      color: #fff;
      box-shadow: 0 16px 42px rgba(180, 35, 24, .28);
    }

    .chat-panel {
      position: fixed;
      right: 22px;
      bottom: 86px;
      width: 340px;
      z-index: 39;
      display: none;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #fff;
      box-shadow: 0 20px 60px rgba(23, 32, 51, .18);
    }

    .chat-panel.open { display: block; }
    .chat-head { padding: 15px 16px; background: var(--brand); color: #fff; }
    .chat-head strong { display: block; font-size: 15px; }
    .chat-head span { display: block; margin-top: 3px; font-size: 12px; opacity: .9; }
    .chat-body { padding: 14px; display: grid; gap: 11px; }
    .chat-log { display: grid; gap: 9px; max-height: 280px; overflow: auto; padding-right: 2px; }
    .chat-message { max-width: 88%; padding: 10px 11px; border-radius: 8px; background: #f2f4f7; line-height: 1.45; font-size: 14px; }
    .chat-message.user { justify-self: end; background: #fee4e2; color: #7a271a; }
    .chat-message.assistant { justify-self: start; background: #f2f4f7; }
    .chat-form { display: grid; grid-template-columns: 1fr auto; gap: 8px; }
    .chat-form input { font-family: Arial, sans-serif; }
    .chat-form button { min-height: 40px; padding: 8px 12px; }
    .chat-status { min-height: 16px; color: var(--muted); font-size: 12px; }

    @media (max-width: 980px) {
      .topbar-inner, .page { padding-left: 16px; padding-right: 16px; }
      .hero, .layout { grid-template-columns: 1fr; }
      .endpoint { white-space: normal; }
      textarea { min-height: 320px; }
      .chat-panel { left: 14px; right: 14px; width: auto; }
      .chat-launcher { right: 14px; bottom: 14px; }
    }
  </style>
</head>
<body>
  <div class="topbar">
    <div class="topbar-inner">
      <div class="brand">
        <div class="brand-mark">RR</div>
        <div class="brand-title">
          <strong>RollsRoll Webhook Gateway</strong>
          <span>Интеграция Frontpad, Suvvy и MAX</span>
        </div>
      </div>
      <div class="endpoint">POST /webhook/frontpad/order-status</div>
    </div>
  </div>

  <main class="page">
    <section class="hero">
      <div class="hero-main">
        <h1>Сервис обработки статусов заказов</h1>
        <p class="lead">Шлюз принимает события Frontpad, проверяет структуру данных, формирует уведомление по статусу заказа и передает trigger в Suvvy для доставки клиенту.</p>
      </div>
      <div class="hero-side panel">
        <div class="status-line">
          <div class="status-label"><b>Состояние сервиса</b><span>Проверяется автоматически</span></div>
          <span id="serviceBadge" class="badge warn"><span class="dot"></span><span>Проверка</span></span>
        </div>
        <div class="status-line">
          <div class="status-label"><b>Режим работы</b><span>Suvvy / MAX / Telegram</span></div>
          <span id="modeBadge" class="badge warn"><span class="dot"></span><span>Загрузка</span></span>
        </div>
      </div>
    </section>

    <section class="layout">
      <div class="panel">
        <div class="panel-header">
          <div class="panel-title">
            <h2>Контроль входящего события</h2>
            <p>Форма отправляет событие в webhook endpoint так же, как это делает Frontpad после изменения статуса заказа.</p>
          </div>
        </div>

        <div class="form-grid">
          <div>
            <label for="secret">Webhook secret</label>
            <input id="secret" value="${escapeHtml(config.webhookSecret || 'test-secret-123')}">
          </div>
          <div>
            <label for="payload">JSON события Frontpad</label>
            <textarea id="payload" spellcheck="false">${escapeHtml(JSON.stringify(defaultPayload, null, 2))}</textarea>
          </div>
          <div class="actions">
            <button type="button" onclick="sendWebhook()">Отправить сообщение</button>
            <button class="secondary" type="button" onclick="loadSample('accepted')">Принят</button>
            <button class="secondary" type="button" onclick="loadSample('cooking')">Готовится</button>
            <button class="secondary" type="button" onclick="loadSample('courier')">Доставляется</button>
            <button class="secondary" type="button" onclick="loadSample('delayed')">Задерживается</button>
            <button class="secondary" type="button" onclick="loadSample('ready')">Готов к выдаче</button>
            <button class="secondary" type="button" onclick="loadSample('payment')">Ожидает оплаты</button>
            <button class="secondary" type="button" onclick="loadSample('delivered')">Доставлен</button>
            <button class="secondary" type="button" onclick="loadSample('cancelled')">Отменён</button>
            <button class="ghost" type="button" onclick="formatJson()">Форматировать JSON</button>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-header">
          <div class="panel-title">
            <h2>Результат обработки</h2>
            <p>Ответ сервиса и клиентские уведомления, обработанные через Suvvy.</p>
          </div>
          <button class="ghost" type="button" onclick="loadSuvvyEvents()">Обновить</button>
        </div>

        <div class="metrics">
          <div class="metric"><b>Webhook</b><span id="webhookMetric">Ожидает события</span></div>
          <div class="metric"><b>Каналы Suvvy</b><span id="deliveryMetric">Ожидает события</span></div>
        </div>

        <div>
          <label>Ответ webhook-сервиса</label>
          <pre id="response">Запросы ещё не отправлялись.</pre>
        </div>
        <div>
          <label>Отправленные trigger-сообщения в Suvvy</label>
          <pre id="suvvy">Данные появятся после успешной обработки события.</pre>
        </div>
        <div>
          <label>Готовность интеграций</label>
          <pre id="ready">Загрузка статуса...</pre>
        </div>
      </div>
    </section>
  </main>
${renderWebsiteChatHtml()}
${renderWebsiteChatScript()}
<script>
const samples = {
  accepted: { status_id: '3', status_name: 'Принят' },
  cooking: { status_id: '4', status_name: 'Готовится' },
  courier: { status_id: '5', status_name: 'Доставляется' },
  delivered: { status_id: '6', status_name: 'Доставлен' },
  cancelled: { status_id: '7', status_name: 'Отменён' },
  delayed: { status_id: '8', status_name: 'Заказ задерживается' },
  ready: { status_id: '9', status_name: 'Готов к выдаче' },
  payment: { status_id: '10', status_name: 'Ожидает оплаты' }
};

async function checkHealth() {
  const serviceBadge = document.getElementById('serviceBadge');
  const modeBadge = document.getElementById('modeBadge');
  const ready = document.getElementById('ready');
  try {
    const res = await fetch('/health');
    const data = await res.json();
    serviceBadge.className = 'badge';
    serviceBadge.lastElementChild.textContent = 'Работает';
    modeBadge.className = data.production_ready ? 'badge' : 'badge warn';
    modeBadge.lastElementChild.textContent = data.production_ready ? 'Боевой' : 'Интеграционный';
    ready.textContent = JSON.stringify(data, null, 2);
  } catch (error) {
    serviceBadge.className = 'badge err';
    serviceBadge.lastElementChild.textContent = 'Недоступен';
    ready.textContent = error.message;
  }
}

async function sendWebhook() {
  const out = document.getElementById('response');
  const webhookMetric = document.getElementById('webhookMetric');
  const deliveryMetric = document.getElementById('deliveryMetric');
  out.textContent = 'Сообщение отправляется в Suvvy...';
  webhookMetric.textContent = 'Отправка';
  deliveryMetric.textContent = 'Ожидание';
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
    webhookMetric.textContent = response.status === 200 ? 'Принято' : 'Ошибка ' + response.status;
    deliveryMetric.textContent = data.deliveries && data.deliveries.length ? 'Suvvy получил trigger' : 'Нет данных';
    await loadSuvvyEvents();
    await checkHealth();
  } catch (error) {
    out.textContent = error.message;
    webhookMetric.textContent = 'Ошибка';
    deliveryMetric.textContent = 'Не выполнено';
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
  const response = await fetch('/channels/messages');
  const data = await response.json();
  const view = {
    last_telegram_message: data.telegram && data.telegram[0] ? data.telegram[0] : null,
    last_max_message: data.max && data.max[0] ? data.max[0] : null,
    last_site_chat_message: data.site_chat && data.site_chat.length ? data.site_chat[data.site_chat.length - 1] : null,
    deliveries: data.deliveries || []
  };
  out.textContent = view.deliveries.length ? JSON.stringify({ last_suvvy_trigger: view.deliveries[0], deliveries: view.deliveries }, null, 2) : 'Данные появятся после успешной отправки сообщения в Suvvy.';
}

function toggleChat() {
  const panel = document.getElementById('siteChatPanel');
  if (panel) {
    panel.classList.toggle('open');
    loadSiteChatMessages();
  }
}

function renderChatMessages(messages) {
  const log = document.getElementById('siteChatLog');
  if (!log) return;
  const safeMessages = messages && messages.length ? messages : [{ role: 'assistant', text: 'Здравствуйте. Напишите сообщение, чтобы связаться с RollsRoll.' }];
  log.innerHTML = safeMessages.map((message) => '<div class="chat-message ' + message.role + '">' + escapeHtmlText(message.text) + '</div>').join('');
  log.scrollTop = log.scrollHeight;
}

async function loadSiteChatMessages() {
  try {
    const response = await fetch('/site-chat/messages');
    const data = await response.json();
    renderChatMessages(data.messages || []);
  } catch (error) {
    renderChatMessages([{ role: 'assistant', text: 'Чат временно недоступен.' }]);
  }
}

async function sendSiteChatMessage(event) {
  event.preventDefault();
  const input = document.getElementById('siteChatInput');
  const submit = document.getElementById('siteChatSubmit');
  const status = document.getElementById('siteChatStatus');
  const text = input.value.trim();
  if (!text) {
    input.focus();
    return;
  }

  const currentMessages = window.siteChatMessages || [];
  window.siteChatMessages = [...currentMessages, { role: 'user', text }, { role: 'assistant', text: 'Печатаю ответ...' }];
  renderChatMessages(window.siteChatMessages);
  input.value = '';
  input.disabled = true;
  submit.disabled = true;
  status.textContent = 'Отправка сообщения...';

  try {
    const response = await fetch('/site-chat/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text })
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data.error || 'Ошибка отправки сообщения');
    }
    window.siteChatMessages = data.messages || [];
    renderChatMessages(window.siteChatMessages);
    status.textContent = 'Сообщение отправлено';
  } catch (error) {
    window.siteChatMessages = [...currentMessages, { role: 'user', text }, { role: 'assistant', text: 'Ошибка отправки: ' + error.message }];
    renderChatMessages(window.siteChatMessages);
    status.textContent = 'Ошибка отправки';
  } finally {
    input.disabled = false;
    submit.disabled = false;
    input.focus();
  }
}

function escapeHtmlText(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
}

checkHealth();
loadSuvvyEvents();
loadSiteChatMessages();
</script>
</body>
</html>`;
}

function renderWebsiteChatHtml() {
  if (!config.websiteChatEnabled || config.suvvyWidgetId || config.jivoWidgetId || !config.showChatPlaceholder) return '';

  return `<section id="siteChatPanel" class="chat-panel" aria-label="Чат сайта">
    <div class="chat-head"><strong>Чат RollsRoll</strong><span>Канал Suvvy.ai</span></div>
    <div class="chat-body">
      <div id="siteChatLog" class="chat-log">
        <div class="chat-message assistant">Здравствуйте. Напишите сообщение, чтобы связаться с RollsRoll.</div>
      </div>
      <form id="siteChatForm" class="chat-form" onsubmit="sendSiteChatMessage(event)">
        <input id="siteChatInput" autocomplete="off" placeholder="Введите сообщение">
        <button id="siteChatSubmit" type="submit">Отправить сообщение</button>
      </form>
      <div id="siteChatStatus" class="chat-status"></div>
    </div>
  </section>
  <button class="chat-launcher" type="button" onclick="toggleChat()" aria-controls="siteChatPanel">Чат</button>`;
}

function renderWebsiteChatScript() {
  if (!config.websiteChatEnabled) return '';

  if (config.websiteChatProvider === 'suvvy' && config.suvvyWidgetId) {
    return `<script src="https://storage1.suvvy.ai/widget/loader.js"
  data-widget-id="${escapeHtml(config.suvvyWidgetId)}"
  data-lang="ru"
  async
></script>`;
  }

  if (config.websiteChatProvider !== 'jivo' || !config.jivoWidgetId) return '';

  const widgetId = JSON.stringify(config.jivoWidgetId);
  return `<script>
(function(){
  var widget_id = ${widgetId};
  var d = document;
  var w = window;
  function loadWidget(){
    var s = d.createElement('script');
    s.type = 'text/javascript';
    s.async = true;
    s.src = 'https://code.jivo.ru/widget/' + widget_id;
    var first = d.getElementsByTagName('script')[0];
    first.parentNode.insertBefore(s, first);
  }
  if (d.readyState === 'complete') loadWidget();
  else if (w.attachEvent) w.attachEvent('onload', loadWidget);
  else w.addEventListener('load', loadWidget, false);
})();
</script>`;
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
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
  });
  res.end(JSON.stringify(payload));
}

function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
  });
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

function parseBoolean(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function parseList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
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
  buildNotificationPayload,
  buildSuvvyPayload,
  sendToSuvvy,
  sendToTelegram,
  sendToMax,
  validatePayload,
};



