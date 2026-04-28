# RollsRoll Frontpad -> Suvvy webhook service

Промежуточный HTTP-сервис принимает webhook-события Frontpad по уже созданным заказам RollsRoll, валидирует их, формирует текст уведомления и передает payload дальше в Suvvy API для отправки клиенту через MAX.

Важно: сервис не создает заказ во Frontpad. Frontpad используется только как источник события по уже созданному заказу.

## Статус для презентации

Готово для показа заказчику:

- публичный домен `https://webhook.prom-logic.ru`;
- HTTPS через Let's Encrypt;
- тестовая панель в браузере;
- вставка тестового JSON от Frontpad;
- проверка обязательных полей;
- проверка `X-Webhook-Secret`;
- формирование текста уведомления по статусу заказа;
- demo/mock Suvvy, где видно payload, который уйдет дальше;
- health endpoint со статусом интеграций.

Для боевого теста с реальным клиентским уведомлением еще нужны реальные данные Suvvy/MAX/Telegram-ботов: URL, токены и точная схема payload, которую они ожидают.

## Как показать заказчику без PowerShell

1. Откройте папку `D:\__JOB___\_SUVVY\rollsroll-webhook-service`.
2. Дважды нажмите `1 - Запустить демо.cmd`.
3. Дважды нажмите `2 - Открыть тест-панель.cmd`.
4. В браузере откроется тестовая панель `http://localhost:3010/`.
5. В поле `Тестовый JSON от Frontpad` можно вставить реальный или тестовый JSON.
6. Нажмите `Отправить webhook`.
7. Справа будет видно ответ webhook-сервиса и payload, который ушел бы в Suvvy.

На сервере панель доступна здесь:

```text
https://webhook.prom-logic.ru/
```

## Endpoint для Frontpad

```http
POST https://webhook.prom-logic.ru/webhook/frontpad/order-status
```

Обязательный заголовок:

```http
X-Webhook-Secret: значение-из-WEBHOOK_SECRET
```

## Интеграции

Сервис поддерживает targets через переменную `DELIVERY_TARGETS`:

```env
DELIVERY_TARGETS=suvvy
```

Можно указать несколько targets через запятую:

```env
DELIVERY_TARGETS=suvvy,telegram,max
```

### Suvvy-бот

Основная архитектура: Frontpad -> webhook service -> Suvvy -> MAX.

Для демо:

```env
MOCK_SUVVY_ENABLED=true
SUVVY_API_URL=http://localhost:3010/mock-suvvy
SUVVY_API_TOKEN=test-suvvy-token
```

Для production:

```env
MOCK_SUVVY_ENABLED=false
DELIVERY_TARGETS=suvvy
SUVVY_API_URL=https://REAL-SUVVY-BOT-URL/api/frontpad/order-status
SUVVY_API_TOKEN=REAL_SUVVY_TOKEN
```

`SUVVY_API_TOKEN` отправляется как `Authorization: Bearer ...`.

### Telegram-бот

Telegram добавлен как опциональный mirror-target для внутреннего тестирования или админских уведомлений.

```env
DELIVERY_TARGETS=suvvy,telegram
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=REAL_TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID=REAL_TELEGRAM_CHAT_ID
```

Если в payload от Frontpad будет `telegram_chat_id`, сервис отправит сообщение туда. Иначе использует `TELEGRAM_CHAT_ID` из `.env`.

### MAX-бот

По предпочтительной архитектуре MAX остается за Suvvy, то есть этот сервис напрямую в MAX не пишет.

Но прямой target подготовлен:

```env
DELIVERY_TARGETS=max
MAX_ENABLED=true
MAX_API_URL=https://REAL-MAX-BOT-API-URL
MAX_BOT_TOKEN=REAL_MAX_BOT_TOKEN
```

MAX-target делает generic POST в `MAX_API_URL` с Bearer-токеном. Для полной боевой готовности нужно подтвердить точный endpoint и формат, который ожидает MAX-бот.


### Чат-бот Suvvy.ai на сайте

Suvvy website chat подключается через Jivo-виджет: в Suvvy создается/подключается канал Jivo, а на сайт ставится widget script Jivo.

Для презентации без реального Jivo ID включен placeholder в правом нижнем углу:

```env
WEBSITE_CHAT_ENABLED=true
WEBSITE_CHAT_PROVIDER=jivo
JIVO_WIDGET_ID=
SHOW_CHAT_PLACEHOLDER=true
```

Когда будет готов реальный виджет Jivo/Suvvy, нужно вставить ID:

```env
WEBSITE_CHAT_ENABLED=true
WEBSITE_CHAT_PROVIDER=jivo
JIVO_WIDGET_ID=REAL_JIVO_WIDGET_ID
SHOW_CHAT_PLACEHOLDER=false
```

После этого сайт сам подключит скрипт:

```text
https://code.jivo.ru/widget/REAL_JIVO_WIDGET_ID
```

Если Suvvy даст другой embed snippet, его нужно заменить в функции `renderWebsiteChatScript()`.
## Health

```http
GET /health
```

Ответ показывает:

- `presentation_ready` - готово ли для демонстрации;
- `production_ready` - готово ли для боевого режима Suvvy без mock;
- `delivery_targets`;
- какие токены/URL сконфигурированы;
- что еще не хватает для production.

## Обязательные поля payload

- `order_id`
- `order_number`
- `status_id`
- `status_name`
- `client_phone`
- `client_name`

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

## Payload, отправляемый дальше

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

## Статусы

По умолчанию сервис обрабатывает такие варианты:

| `status_id` | Сообщение |
| --- | --- |
| `1` | заказ принят |
| `2` | заказ готовится |
| `3` | заказ принят |
| `4` | заказ готовится |
| `5` | заказ передан курьеру |
| `6` | заказ доставлен |
| `7` | заказ отменен |

Если у Frontpad в проекте RollsRoll используются другие ID, задайте их через `STATUS_MESSAGES_JSON` в `.env`, например:

```env
STATUS_MESSAGES_JSON={"10":"Заказ #{order_number} принят.","20":"Заказ #{order_number} передан курьеру."}
```

## Ответы сервиса

- `200 OK` - событие принято, обработано и передано в настроенные targets.
- `400 Bad Request` - тело запроса не JSON или не хватает обязательных полей.
- `401 Unauthorized` - неверный или отсутствующий `X-Webhook-Secret`.
- `500 Internal Server Error` - ошибка конфигурации или ошибка при отправке в target.

## Логи

Входящие события и ошибки пишутся в консоль и файл:

```text
logs/webhook-events.log
```

Телефон клиента в логах маскируется.

## Чего не хватает для полной боевой готовности

- Реальный `SUVVY_API_URL` из Suvvy-бота.
- Реальный `SUVVY_API_TOKEN` или подтверждение другого способа авторизации.
- Точная схема, которую ожидает Suvvy-бот.
- Если нужен Telegram mirror: `TELEGRAM_BOT_TOKEN` и `TELEGRAM_CHAT_ID`.
- Если нужен прямой MAX target: `MAX_API_URL`, `MAX_BOT_TOKEN` и точный формат MAX API.
- Реальные `status_id` Frontpad для RollsRoll.
- Подтверждение, что Frontpad умеет отправлять `X-Webhook-Secret`. Если не умеет, надо заменить защиту на secret в query/body или подпись.

