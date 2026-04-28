# RollsRoll Frontpad -> Suvvy webhook service

Промежуточный HTTP-сервис принимает webhook-события Frontpad по уже созданным заказам RollsRoll, валидирует их, формирует текст уведомления и передает payload дальше в Suvvy API для отправки клиенту через MAX.

Важно: сервис не создает заказ во Frontpad. Frontpad используется только как источник события по уже созданному заказу.

## Как показать заказчику без PowerShell

1. Откройте папку `D:\__JOB___\_SUVVY\rollsroll-webhook-service`.
2. Дважды нажмите `1 - Запустить демо.cmd`.
3. Дважды нажмите `2 - Открыть тест-панель.cmd`.
4. В браузере откроется тестовая панель `http://localhost:3010/`.
5. В поле `Тестовый JSON от Frontpad` можно вставить реальный или тестовый JSON.
6. Нажмите `Отправить webhook`.
7. Справа будет видно:
   - ответ webhook-сервиса;
   - payload, который ушел бы в Suvvy.

Для презентации включен demo-mode: `SUVVY_API_URL=http://localhost:3010/mock-suvvy`. Это встроенный mock Suvvy, чтобы тест возвращал `200 OK` без реального Suvvy API.

## Куда вставлять API Suvvy-бота и MAX-бота

Все значения вставляются в файл `.env`.

### Suvvy-бот

Это основной путь текущей архитектуры: Frontpad -> этот сервис -> Suvvy -> MAX.

В `.env` заменить demo-значения:

```env
MOCK_SUVVY_ENABLED=false
SUVVY_API_URL=https://REAL-SUVVY-BOT-URL/api/frontpad/order-status
SUVVY_API_TOKEN=REAL_SUVVY_TOKEN
```

`SUVVY_API_URL` - endpoint Suvvy-бота, который принимает подготовленный payload.

`SUVVY_API_TOKEN` - токен Suvvy-бота. Сервис отправляет его как `Authorization: Bearer ...`.

### MAX-бот

По текущему ТЗ этот сервис не должен напрямую писать в MAX: уведомление отправляет Suvvy-бот. Поэтому данные MAX обычно вставляются в соседнем проекте MAX/Suvvy-бота.

Если позже решим отправлять напрямую в MAX из этого сервиса, в `.env` уже оставлены места:

```env
MAX_API_URL=https://botapi.max.ru/...
MAX_BOT_TOKEN=REAL_MAX_BOT_TOKEN
```

После этого надо будет отдельно добавить функцию `sendToMax(payload)` или заменить маршрут отправки внутри `sendToSuvvy`.

## Что нужно для боевого подключения

- Реальный `SUVVY_API_URL`: куда Suvvy-бот хочет получать событие.
- Реальный `SUVVY_API_TOKEN` или другой способ авторизации, если у Suvvy не Bearer-токен.
- Точная схема payload, которую ожидает Suvvy-бот. Сейчас сервис отправляет подготовленную универсальную структуру.
- Реальные `status_id` из Frontpad для RollsRoll. Сейчас есть базовая карта `1..7`, но ее лучше сверить с фактическими статусами.
- Публичный URL сервиса для Frontpad, например через сервер/VPS/reverse proxy/HTTPS.
- Как Frontpad настраивает секретный заголовок `X-Webhook-Secret`. Если Frontpad не умеет кастомный заголовок, нужно заменить защиту на query secret или подпись.
- Тестовый номер/аккаунт MAX, на который можно безопасно отправить первое уведомление.

## Endpoint

```http
POST /webhook/frontpad/order-status
```

Обязательный заголовок:

```http
X-Webhook-Secret: значение-из-WEBHOOK_SECRET
```

## Переменные окружения

| Переменная | Описание |
| --- | --- |
| `PORT` | Порт HTTP-сервера. По умолчанию `3000`. |
| `WEBHOOK_SECRET` | Секрет, который должен прийти в заголовке `X-Webhook-Secret`. |
| `MOCK_SUVVY_ENABLED` | `true` для презентации с mock Suvvy, `false` для боевого Suvvy. |
| `SUVVY_API_URL` | URL Suvvy API, куда сервис отправляет подготовленный payload. |
| `SUVVY_API_TOKEN` | Bearer-токен для Suvvy API. |
| `SUVVY_REQUEST_TIMEOUT_MS` | Таймаут запроса в Suvvy. По умолчанию `10000`. |
| `MAX_API_URL` | Placeholder для прямой интеграции с MAX, если она понадобится позже. |
| `MAX_BOT_TOKEN` | Placeholder для токена MAX-бота, если прямую отправку добавим в этот сервис. |
| `STATUS_MESSAGES_JSON` | Необязательный JSON-объект для переопределения текстов по `status_id`. |

## Обязательные поля payload

- `order_id`
- `order_number`
- `status_id`
- `status_name`
- `client_phone`
- `client_name`

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

- `200 OK` - событие принято, обработано и передано в Suvvy.
- `400 Bad Request` - тело запроса не JSON или не хватает обязательных полей.
- `401 Unauthorized` - неверный или отсутствующий `X-Webhook-Secret`.
- `500 Internal Server Error` - ошибка конфигурации или ошибка при отправке в Suvvy.

## Логи

Входящие события и ошибки пишутся в консоль и файл:

```text
logs/webhook-events.log
```

Телефон клиента в логах маскируется.

