# GiftShell Bot

GiftShell — стартовый Telegram-бот под **«Автоматизацию чатов» / Business Connection**, уже подготовленный для хранения на GitHub и хостинга на Render.

Сейчас проект намеренно работает в безопасном режиме: он проверяет подключение к аккаунту и команды из личных чатов, но **не списывает Stars и не покупает/передаёт подарки**.

## Что уже готово

- `business_connection` и `business_message`;
- команды владельца аккаунта в разрешённых чатах;
- ответ через `business_connection_id`;
- webhook в production;
- long polling локально;
- `/health` для Render;
- автоматическая настройка webhook при каждом старте;
- `render.yaml`;
- GitHub Actions syntax check;
- PowerShell-скрипт для первой отправки проекта на GitHub;
- секреты не попадают в репозиторий.

## Название

- Display name: `GiftShell`
- Username: попробуй `GiftShellBot`
- запасные варианты: `GiftShellTGbot`, `GiftShellAppBot`

### Description

> Отправляй Telegram Gifts и коллекционные подарки командами прямо из личных чатов. Подключи GiftShell через «Автоматизацию чатов» и управляй подарками без перехода в отдельного бота.

### About / Bio

> Команды для Telegram Gifts прямо в чатах 🎁

---

## 1. Создай бота в @BotFather

1. `/newbot`
2. Name: `GiftShell`
3. Username: `GiftShellBot` или свободный вариант.
4. Сохрани токен.
5. В настройках бота включи возможность подключения к аккаунту / Secretary Mode.
6. Установи Description и About из текста выше.

После запуска проекта в логах должно быть:

```text
can_connect_to_business = true
```

Если там `false`, Render тут ни при чём: сначала исправь настройки бота в Telegram.

---

## 2. Локальный тест на Windows

Нужен Node.js 22.

```powershell
cd GiftShellBot
Copy-Item .env.example .env
notepad .env
```

В `.env`:

```env
BOT_TOKEN=ТВОЙ_ТОКЕН
WEBHOOK_SECRET=local_secret
PUBLIC_URL=
PORT=10000
```

Запуск:

```powershell
.\run-local.ps1
```

При пустом `PUBLIC_URL` используется long polling.

---

## 3. Залей на GitHub

Создай **пустой** репозиторий, например:

```text
giftshell-bot
```

Не добавляй на GitHub README/.gitignore при создании, они уже лежат в проекте.

Затем из папки проекта:

```powershell
.\push-github.ps1 -RepoUrl "https://github.com/ТВОЙ_ЛОГИН/giftshell-bot.git"
```

Либо обычными командами Git:

```powershell
git init
git add .
git commit -m "Initial GiftShell bot"
git branch -M main
git remote add origin https://github.com/ТВОЙ_ЛОГИН/giftshell-bot.git
git push -u origin main
```

**`.env` не коммить.** Он уже исключён через `.gitignore`.

---

## 4. Разверни на Render

### Вариант A — Blueprint, самый простой

1. Открой Render.
2. `New` → `Blueprint`.
3. Подключи GitHub-репозиторий `giftshell-bot`.
4. Render найдёт `render.yaml`.
5. Введи только `BOT_TOKEN`, когда Render попросит значение.
6. `WEBHOOK_SECRET` создаётся автоматически.
7. Запусти deploy.

Вручную указывать URL Render **не надо**. Код использует переменную `RENDER_EXTERNAL_URL`, которую Render сам предоставляет web service.

Ожидаемые логи:

```text
Logged in as @GiftShellBot
can_connect_to_business = true
runtime = Render
mode = webhook
HTTP server listening on 0.0.0.0:10000
[webhook ready] ...
```

Health check:

```text
https://ИМЯ-СЕРВИСА.onrender.com/health
```

Должен вернуть JSON с `"ok": true`.

### Вариант B — обычный Web Service

Если не хочешь Blueprint:

- Runtime: Node
- Build Command: `npm ci`
- Start Command: `npm start`
- Health Check: `/health`
- Environment:
  - `BOT_TOKEN` = токен BotFather
  - `WEBHOOK_SECRET` = длинная случайная строка

`PUBLIC_URL` на Render задавать не нужно.

---

## 5. Проверка Telegram Automation

Подключи GiftShell через **Настройки Telegram → Автоматизация чатов** и дай доступ хотя бы к одному тестовому личному чату.

В этом чате от своего аккаунта отправь:

```text
/gs_ping
```

При нормальной работе бот ответит через Business Connection:

```text
✅ GiftShell видит команды через «Автоматизацию чатов». Render + webhook работают.
```

Ещё есть:

```text
/gs_status
/gift test
```

`/gift test` — dry-run. Никакие Stars не списываются.

---

## Структура

```text
GiftShellBot/
├─ .github/
│  └─ workflows/
│     └─ ci.yml
├─ src/
│  └─ index.js
├─ .env.example
├─ .gitignore
├─ .nvmrc
├─ package.json
├─ package-lock.json
├─ render.yaml
├─ run-local.ps1
├─ push-github.ps1
└─ README.md
```

## Дальше

После успешного `/gs_ping` можно подключать динамический каталог Telegram Gifts, `/gift`, transfer collectible gifts/NFT и работу со Stars. Для реальных денежных операций понадобится отдельная защита от повторной обработки update, проверка прав и подтверждение цены перед списанием.
