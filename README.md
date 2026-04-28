# RollsRoll Webhook Gateway

Сервис принимает события Frontpad по уже созданным заказам RollsRoll, проверяет входящий payload, формирует текст уведомления по статусу заказа и передает данные в настроенные каналы доставки: Suvvy, Telegram или MAX.

Сервис не создает заказы во Frontpad. Frontpad используется только как источник событий по заказам.

## Рабочий контур

- Публичный домен: `https://webhook.prom-logic.ru`
- HTTPS: Let's Encrypt
- Основной endpoint: `POST /webhook/frontpad/order-status`
- Защита webhook: `X-Webhook-Secret`
- Канал доставки по умолчанию: `suvvy`
- Встроенная служебная панель: `/`
- Health endpoint: `/health`

## Endpoint для Frontpad

```http
POST https://webhook.prom-logic.ru/webhook/frontpad/order-status
```

Обязательный заголовок:

```http
X-Webhook-Secret: значение-из-WEBHOOK_SECRET
```

## Локальный запуск

1. Откройте папку проекта:

```text
D:\__JOB___\_SUVVY\rollsroll-webhook-service
```

2. Запустите файл:

```text
1 - Запустить сервис.cmd
```

3. Откройте интерфейс:

```text
2 - Открыть интерфейс.cmd
```

Локальный адрес:

```text
http://localhost:3010/
```

## Конфигурация

Все параметры задаются в `.env`.

```env
PORT=3010
NODE_ENV=production
WEBHOOK_SECRET=change-me
DELIVERY_TARGETS=suvvy
MOCK_SUVVY_ENABLED=false
SUVVY_API_URL=https://REAL-SUVVY-BOT-URL/api/frontpad/order-status
SUVVY_API_TOKEN=REAL_SUVVY_TOKEN
SUVVY_REQUEST_TIMEOUT_MS=10000
```

## Каналы доставки

`DELIVERY_TARGETS` задает активные направления доставки:

```env
DELIVERY_TARGETS=suvvy
```

Можно включить несколько направлений:

```env
DELIVERY_TARGETS=suvvy,telegram,max
```

### Suvvy

Основной сценарий интеграции:

```text
Frontpad -> RollsRoll Webhook Gateway -> Suvvy -> MAX
```

Параметры:

```env
SUVVY_API_URL=https://REAL-SUVVY-BOT-URL/api/frontpad/order-status
SUVVY_API_TOKEN=REAL_SUVVY_TOKEN
```

Токен отправляется как Bearer-токен:

```http
Authorization: Bearer REAL_SUVVY_TOKEN
```

### Telegram

Telegram может использоваться как дополнительный канал служебных уведомлений.

```env
DELIVERY_TARGETS=suvvy,telegram
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=REAL_TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID=REAL_TELEGRAM_CHAT_ID
```

Если во входящем payload есть `telegram_chat_id`, сервис отправит сообщение туда. Иначе используется `TELEGRAM_CHAT_ID` из `.env`. Без реальных `TELEGRAM_BOT_TOKEN` и `TELEGRAM_CHAT_ID` Telegram-сообщение не отправляется; в ответе webhook будет `telegram: not_configured`.

### MAX

Прямая отправка в MAX поддержана как отдельный target, но предпочтительный рабочий маршрут оставляет MAX за Suvvy.

```env
DELIVERY_TARGETS=max
MAX_ENABLED=true
MAX_API_URL=https://REAL-MAX-BOT-API-URL
MAX_BOT_TOKEN=REAL_MAX_BOT_TOKEN
```

Для production-режима нужно подтвердить точный endpoint и формат payload MAX-бота.

## Чат Suvvy.ai на сайте

Suvvy website chat подключается через Jivo-виджет: в Suvvy создается или подключается Jivo-канал, а на сайт устанавливается widget script.

Параметры:

```env
WEBSITE_CHAT_ENABLED=true
WEBSITE_CHAT_PROVIDER=jivo
JIVO_WIDGET_ID=REAL_JIVO_WIDGET_ID
SHOW_CHAT_PLACEHOLDER=false
```

После настройки `JIVO_WIDGET_ID` сайт подключает скрипт:

```text
https://code.jivo.ru/widget/REAL_JIVO_WIDGET_ID
```

Если `JIVO_WIDGET_ID` не задан, интерфейс использует локальный рабочий чат для проверки отправки и ответа на сайте. Полноценный Suvvy.ai/Jivo чат начнет работать после подключения реального Jivo/Suvvy канала.

## Payload от Frontpad

```json
{
  "event": "order_status_changed",
  "order_id": "12345678",
  "order_number": "000123",
  "status_id": "3",
  "status_name": "Принят",
  "client_name": "Иван",
  "client_phone": "79000000000",
  "delivery_time": "18:40",
  "delivery_address": "ул. Ленина, 10",
  "order_sum": "1450",
  "items": [
    {
      "name": "Филадельфия",
      "quantity": 1,
      "price": 590
    }
  ],
  "comment": "Без васаби",
  "payment_type": "Картой",
  "max_user_id": "optional",
  "telegram_chat_id": "optional",
  "created_at": "2026-04-28 14:30:00"
}
```

## Обязательные поля

- `order_id`
- `order_number`
- `status_id`
- `status_name`
- `client_phone`
- `client_name`

## Payload доставки

```json
{
  "event": "rollsroll_order_status_changed",
  "source": "frontpad",
  "channel": "max",
  "recipient": {
    "phone": "79000000000",
    "max_user_id": "optional",
    "telegram_chat_id": "optional",
    "name": "Иван"
  },
  "order": {
    "id": "12345678",
    "number": "000123",
    "status_id": "3",
    "status_name": "Принят"
  },
  "message": {
    "text": "Заказ 000123 принят."
  }
}
```

## Статусы заказов

| `status_id` | Сообщение |
| --- | --- |
| `1` | заказ принят |
| `2` | заказ готовится |
| `3` | заказ принят |
| `4` | заказ готовится |
| `5` | заказ передан курьеру |
| `6` | заказ доставлен |
| `7` | заказ отменен |

Если у Frontpad используются другие ID, задайте соответствия через `STATUS_MESSAGES_JSON`:

```env
STATUS_MESSAGES_JSON={"10":"Заказ #{order_number} принят.","20":"Заказ #{order_number} передан курьеру."}
```

## Ответы сервиса

- `200 OK` - событие принято и обработано.
- `400 Bad Request` - тело запроса не JSON или не хватает обязательных полей.
- `401 Unauthorized` - неверный или отсутствующий `X-Webhook-Secret`.
- `500 Internal Server Error` - ошибка конфигурации или ошибка отправки в канал доставки.

## Логи

Логи пишутся в консоль и файл:

```text
logs/webhook-events.log
```

Телефон клиента в логах маскируется.

## Production checklist

Для полного рабочего запуска нужны:

- реальный `SUVVY_API_URL`;
- реальный `SUVVY_API_TOKEN` или подтвержденный альтернативный способ авторизации;
- точная схема payload, которую ожидает Suvvy-бот;
- реальные `status_id` Frontpad для RollsRoll;
- подтверждение поддержки заголовка `X-Webhook-Secret` на стороне Frontpad;
- `JIVO_WIDGET_ID` для рабочего Suvvy.ai чата на сайте;
- при необходимости прямого MAX target: `MAX_API_URL`, `MAX_BOT_TOKEN` и формат MAX API.


