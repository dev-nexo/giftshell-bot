import http from 'node:http';

const BOT_TOKEN = process.env.BOT_TOKEN?.trim();
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET?.trim();
const PORT = Number(process.env.PORT || 10000);

// Render provides RENDER_EXTERNAL_URL automatically for web services.
// PUBLIC_URL is kept as an optional override for other hosts/custom testing.
const PUBLIC_URL = (
  process.env.PUBLIC_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  ''
)
  .trim()
  .replace(/\/$/, '');

const IS_RENDER = process.env.RENDER === 'true';
const USE_WEBHOOK = Boolean(PUBLIC_URL);

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is required.');
  process.exit(1);
}

if (USE_WEBHOOK && !WEBHOOK_SECRET) {
  console.error('WEBHOOK_SECRET is required in webhook mode.');
  process.exit(1);
}

const API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const connectionCache = new Map();
let httpServer;
let shuttingDown = false;

const ALLOWED_UPDATES = [
  'message',
  'business_connection',
  'business_message',
  'edited_business_message',
  'deleted_business_messages'
];

async function api(method, payload = {}) {
  const response = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000)
  });

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`${method}: Telegram returned invalid JSON (HTTP ${response.status})`);
  }

  if (!response.ok || !data.ok) {
    const error = new Error(`${method}: ${data.description || `HTTP ${response.status}`}`);
    error.telegram = data;
    throw error;
  }

  return data.result;
}

async function getConnection(id, forceRefresh = false) {
  if (!forceRefresh && connectionCache.has(id)) {
    return connectionCache.get(id);
  }

  const connection = await api('getBusinessConnection', {
    business_connection_id: id
  });

  connectionCache.set(id, connection);
  return connection;
}

function rightsSummary(rights = {}) {
  const enabled = Object.entries(rights)
    .filter(([, value]) => value === true)
    .map(([key]) => key);

  return enabled.length ? enabled.join(', ') : 'нет выданных прав';
}

async function sendBusinessMessage(connectionId, chatId, text) {
  return api('sendMessage', {
    business_connection_id: connectionId,
    chat_id: chatId,
    text
  });
}

async function handleNormalMessage(message) {
  const text = message.text?.trim();
  if (!text) return;

  if (text.startsWith('/start')) {
    const me = await api('getMe');
    const automationState = me.can_connect_to_business
      ? '✅ Бот готов к подключению через «Автоматизацию чатов».'
      : '❌ У бота не включён режим подключения к аккаунту. Проверь настройки в @BotFather.';

    await api('sendMessage', {
      chat_id: message.chat.id,
      text:
        `🎁 GiftShell\n\n` +
        `${automationState}\n\n` +
        `После подключения отправь /gs_ping в разрешённом личном чате.\n\n` +
        `Покупка Gifts и списание Stars пока отключены: этот билд проверяет только инфраструктуру и Business Connection.`
    });
    return;
  }

  if (text === '/status') {
    const me = await api('getMe');
    const webhook = await api('getWebhookInfo');

    await api('sendMessage', {
      chat_id: message.chat.id,
      text:
        `Bot: @${me.username}\n` +
        `can_connect_to_business: ${Boolean(me.can_connect_to_business)}\n` +
        `Режим: ${USE_WEBHOOK ? 'webhook' : 'long polling'}\n` +
        `Webhook: ${webhook.url || 'не установлен'}`
    });
  }
}

async function handleBusinessConnection(connection) {
  connectionCache.set(connection.id, connection);

  console.log('[business_connection]', {
    id: connection.id,
    user_id: connection.user?.id,
    username: connection.user?.username,
    user_chat_id: connection.user_chat_id,
    is_enabled: connection.is_enabled,
    rights: connection.rights
  });

  try {
    await api('sendMessage', {
      chat_id: connection.user_chat_id,
      text:
        `${connection.is_enabled ? '✅' : '⛔'} Автоматизация GiftShell ${connection.is_enabled ? 'подключена' : 'отключена'}.\n` +
        `Права: ${rightsSummary(connection.rights)}`
    });
  } catch (error) {
    console.warn('[connection notification skipped]', error.message);
  }
}

async function handleBusinessMessage(message) {
  const connectionId = message.business_connection_id;
  if (!connectionId || message.sender_business_bot) return;

  const text = message.text?.trim();
  if (!text) return;

  let connection;
  try {
    connection = await getConnection(connectionId);
  } catch (error) {
    console.error('[getBusinessConnection]', error.message);
    return;
  }

  // Only commands typed by the owner of the connected account are accepted.
  const ownerId = connection.user?.id;
  if (!ownerId || message.from?.id !== ownerId) return;

  console.log('[owner business command]', {
    update_chat_id: message.chat.id,
    from_id: message.from?.id,
    text,
    connection_id: connectionId
  });

  if (text === '/gs_ping') {
    await sendBusinessMessage(
      connectionId,
      message.chat.id,
      '✅ GiftShell видит команды через «Автоматизацию чатов». Render + webhook работают.'
    );
    return;
  }

  if (text === '/gs_status') {
    connection = await getConnection(connectionId, true);
    await sendBusinessMessage(
      connectionId,
      message.chat.id,
      `✅ Business Connection активен.\n` +
        `Connection: ${connectionId.slice(0, 12)}…\n` +
        `Права: ${rightsSummary(connection.rights)}`
    );
    return;
  }

  if (text === '/gift test') {
    await sendBusinessMessage(
      connectionId,
      message.chat.id,
      '🎁 Команда /gift поймана. Это dry-run: Stars не списываются и подарок не покупается.'
    );
  }
}

async function processUpdate(update) {
  try {
    if (update.business_connection) {
      await handleBusinessConnection(update.business_connection);
    }

    if (update.business_message) {
      await handleBusinessMessage(update.business_message);
    }

    if (update.message) {
      await handleNormalMessage(update.message);
    }
  } catch (error) {
    console.error('[update error]', error.stack || error.message);
  }
}

function readJsonBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let raw = '';

    req.setEncoding('utf8');
    req.on('data', chunk => {
      raw += chunk;
      if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });

    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        reject(new Error('invalid JSON'));
      }
    });

    req.on('error', reject);
  });
}

function startHttpServer() {
  return new Promise((resolve, reject) => {
    httpServer = http.createServer(async (req, res) => {
      if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            ok: true,
            service: 'GiftShell',
            mode: USE_WEBHOOK ? 'webhook' : 'polling',
            render: IS_RENDER
          })
        );
        return;
      }

      if (req.method === 'POST' && req.url === '/telegram') {
        if (!USE_WEBHOOK) {
          res.writeHead(404);
          res.end('webhook disabled');
          return;
        }

        const received = req.headers['x-telegram-bot-api-secret-token'];
        if (received !== WEBHOOK_SECRET) {
          res.writeHead(403);
          res.end('forbidden');
          return;
        }

        try {
          const update = await readJsonBody(req);

          // Acknowledge first so Telegram doesn't retry because one API call was slow.
          res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('ok');

          void processUpdate(update);
        } catch (error) {
          console.error('[webhook request]', error.message);
          if (!res.headersSent) {
            res.writeHead(400);
            res.end('bad request');
          }
        }
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
    });

    httpServer.once('error', reject);
    httpServer.listen(PORT, '0.0.0.0', () => {
      console.log(`HTTP server listening on 0.0.0.0:${PORT}`);
      resolve();
    });
  });
}

async function configureWebhook() {
  const webhookUrl = `${PUBLIC_URL}/telegram`;

  await api('setWebhook', {
    url: webhookUrl,
    secret_token: WEBHOOK_SECRET,
    allowed_updates: ALLOWED_UPDATES,
    drop_pending_updates: false
  });

  const info = await api('getWebhookInfo');
  console.log('[webhook ready]', {
    url: info.url,
    pending_update_count: info.pending_update_count,
    last_error_message: info.last_error_message || null
  });
}

async function startPolling() {
  await api('deleteWebhook', { drop_pending_updates: false });
  console.log('Long polling mode started.');

  let offset = 0;

  while (!shuttingDown) {
    try {
      const updates = await api('getUpdates', {
        offset,
        timeout: 50,
        allowed_updates: ALLOWED_UPDATES
      });

      for (const update of updates) {
        offset = Math.max(offset, update.update_id + 1);
        await processUpdate(update);
      }
    } catch (error) {
      if (shuttingDown) break;
      console.error('[polling]', error.message);
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }
}

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[shutdown] ${signal}`);

  if (httpServer) {
    await new Promise(resolve => httpServer.close(resolve));
  }

  process.exit(0);
}

async function bootstrap() {
  const me = await api('getMe');

  console.log(`Logged in as @${me.username}`);
  console.log(`can_connect_to_business = ${Boolean(me.can_connect_to_business)}`);
  console.log(`runtime = ${IS_RENDER ? 'Render' : 'local/other'}`);
  console.log(`mode = ${USE_WEBHOOK ? 'webhook' : 'long polling'}`);

  await api('setMyCommands', {
    commands: [
      { command: 'start', description: 'Открыть GiftShell' },
      { command: 'status', description: 'Проверить подключение' }
    ]
  });

  await startHttpServer();

  if (USE_WEBHOOK) {
    await configureWebhook();
  } else {
    await startPolling();
  }
}

process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => void gracefulShutdown('SIGINT'));

bootstrap().catch(error => {
  console.error('[fatal]', error.stack || error.message);
  process.exit(1);
});
