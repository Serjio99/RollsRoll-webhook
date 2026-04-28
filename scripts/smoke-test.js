'use strict';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3010';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'test-secret-123';

async function main() {
  const payload = {
    event: 'order_status_changed',
    order_id: '12345678',
    order_number: '000123',
    status_id: '5',
    status_name: 'Доставляется',
    client_name: 'Иван',
    client_phone: '79000000000',
    delivery_time: '18:40',
    delivery_address: 'ул. Ленина, 10',
    order_sum: '1450',
    items: [{ name: 'Филадельфия', quantity: 1, price: 590 }],
    comment: 'Без васаби',
    payment_type: 'Картой',
    created_at: '2026-04-28 14:30:00',
  };

  const health = await request('/health');
  console.log('1. Сервис:', health.ok ? 'работает' : 'ошибка');

  const webhook = await request('/webhook/frontpad/order-status', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Webhook-Secret': WEBHOOK_SECRET,
    },
    body: JSON.stringify(payload),
  });
  console.log('2. Webhook:', webhook.ok ? 'сообщение принято' : 'ошибка');
  console.log('3. Доставка:', JSON.stringify(webhook.deliveries || []));

  const channels = await request('/channels/messages');
  console.log('4. Suvvy trigger:', channels.deliveries && channels.deliveries[0] ? channels.deliveries[0].text : 'нет сообщения');

  const html = await requestText('/');
  console.log('5. Suvvy widget:', html.includes('https://storage1.suvvy.ai/widget/loader.js') ? 'подключен' : 'не найден');
  console.log('6. Widget ID:', html.includes('6986f6d7e613891db708a4f469f0efc4235d3e5c9db2da88') ? 'актуальный' : 'не совпадает');
}

async function request(path, options) {
  const response = await fetch(`${BASE_URL}${path}`, options);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`${path}: HTTP ${response.status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function requestText(path, options) {
  const response = await fetch(`${BASE_URL}${path}`, options);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${path}: HTTP ${response.status} ${text}`);
  }
  return text;
}

main().catch((error) => {
  console.error('Проверка не выполнена:', error.message);
  process.exitCode = 1;
});
