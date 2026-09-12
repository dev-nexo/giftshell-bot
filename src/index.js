import http from 'node:http';

const BOT_TOKEN = process.env.BOT_TOKEN?.trim();
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET?.trim();
const PORT = Number(process.env.PORT || 10000);

const PUBLIC_URL = (
  process.env.PUBLIC_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  ''
)
  .trim()
  .replace(/\/$/, '');

const IS_RENDER = process.env.RENDER === 'true';
const USE_WEBHOOK = Boolean(PUBLIC_URL);
const KNOWN_CONNECTION_IDS = (process.env.KNOWN_BUSINESS_CONNECTION_IDS || '')
  .split(',')
  .map(x => x.trim())
  .filter(Boolean);

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
const activeConnectionByUser = new Map();

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

function rememberConnection(connection) {
  connectionCache.set(connection.id, connection);

  const userId = connection.user?.id;
  if (!userId) return;

  if (connection.is_enabled) {
    activeConnectionByUser.set(userId, connection.id);
  } else if (activeConnectionByUser.get(userId) === connection.id) {
    activeConnectionByUser.delete(userId);
  }
}

async function getConnection(id, forceRefresh = false) {
  if (!forceRefresh && connectionCache.has(id)) {
    return connectionCache.get(id);
  }

  const connection = await api('getBusinessConnection', {
    business_connection_id: id
  });

  rememberConnection(connection);
  return connection;
}

async function bootstrapKnownConnections() {
  if (!KNOWN_CONNECTION_IDS.length) return;

  for (const id of KNOWN_CONNECTION_IDS) {
    try {
      const connection = await getConnection(id, true);
      console.log('[known business connection]', {
        id: connection.id,
        user_id: connection.user?.id,
        is_enabled: connection.is_enabled
      });
    } catch (error) {
      console.warn('[known business connection failed]', {
        id,
        error: error.message
      });
    }
  }
}

function rightsSummary(rights = {}) {
  const rows = [
    ['Читать сообщения', rights.can_read_messages],
    ['Отвечать', rights.can_reply],
    ['Удалять свои сообщения бота', rights.can_delete_sent_messages],
    ['Удалять команды пользователя', rights.can_delete_all_messages],
    ['Смотреть Gifts и Stars', rights.can_view_gifts_and_stars],
    ['Передавать/улучшать Gifts', rights.can_transfer_and_upgrade_gifts],
    ['Передавать Stars', rights.can_transfer_stars]
  ];

  return rows
    .map(([name, enabled]) => `${enabled ? '✅' : '❌'} ${name}`)
    .join('\n');
}

async function sendBusinessMessage(connectionId, chatId, text, extra = {}) {
  return api('sendMessage', {
    business_connection_id: connectionId,
    chat_id: chatId,
    text,
    ...extra
  });
}

async function deleteBusinessCommand(connectionId, messageId) {
  return api('deleteBusinessMessages', {
    business_connection_id: connectionId,
    message_ids: [messageId]
  });
}

function parseDotCommand(text) {
  if (!text.startsWith('.')) return null;

  const raw = text.slice(1).trim();
  if (!raw) return null;

  const firstSpace = raw.search(/\s/);
  const name = (firstSpace === -1 ? raw : raw.slice(0, firstSpace)).toLowerCase();
  const args = firstSpace === -1 ? '' : raw.slice(firstSpace).trim();

  return { name, args };
}

async function resolveUserConnection(userId) {
  const connectionId = activeConnectionByUser.get(userId);
  if (!connectionId) return null;

  try {
    const connection = await getConnection(connectionId, true);
    if (!connection.is_enabled) {
      activeConnectionByUser.delete(userId);
      return null;
    }
    return connection;
  } catch (error) {
    console.warn('[resolveUserConnection]', error.message);
    activeConnectionByUser.delete(userId);
    return null;
  }
}

async function handleStart(message) {
  const userId = message.from?.id;
  const me = await api('getMe');

  const connection = userId
    ? await resolveUserConnection(userId)
    : null;

  if (!connection) {
    await api('sendMessage', {
      chat_id: message.chat.id,
      text:
        `🎁 GiftShell\n\n` +
        `❌ GiftShell пока не видит активное подключение к «Автоматизации чатов».\n\n` +
        `Как подключить:\n` +
        `1. Telegram → Настройки → Автоматизация чатов\n` +
        `2. Добавь @${me.username}\n` +
        `3. Выдай права на чтение, ответы, удаление сообщений и Gifts/Stars\n` +
        `4. Выбери нужные личные чаты\n` +
        `5. Вернись сюда и снова отправь /start`
    });
    return;
  }

  await api('sendMessage', {
    chat_id: message.chat.id,
    text:
      `🎁 GiftShell\n\n` +
      `✅ Автоматизация подключена.\n\n` +
      `${rightsSummary(connection.rights)}\n\n` +
      `Команды в личных чатах начинаются с точки:\n` +
      `.help\n` +
      `.ping\n` +
      `.status\n` +
      `.gift test\n\n` +
      `Верная команда выполняется, после чего её сообщение удаляется из чата.`
  });
}

async function handleNormalMessage(message) {
  const text = message.text?.trim();
  if (!text) return;

  if (text === '/start' || text.startsWith('/start ')) {
    await handleStart(message);
    return;
  }

  if (text === '/status') {
    const connection = message.from?.id
      ? await resolveUserConnection(message.from.id)
      : null;

    await api('sendMessage', {
      chat_id: message.chat.id,
      text: connection
        ? `✅ Automation подключена.\n\n${rightsSummary(connection.rights)}`
        : `❌ Активное Automation-подключение не найдено. Отправь /start для инструкции.`
    });
  }
}

async function handleBusinessConnection(connection) {
  rememberConnection(connection);

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
        `${connection.is_enabled ? '✅' : '⛔'} GiftShell: автоматизация ` +
        `${connection.is_enabled ? 'подключена' : 'отключена'}.\n\n` +
        `${rightsSummary(connection.rights)}`
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

  const ownerId = connection.user?.id;
  if (!ownerId || message.from?.id !== ownerId) return;

  activeConnectionByUser.set(ownerId, connectionId);

  const command = parseDotCommand(text);
  if (!command) return;

  console.log('[owner dot command]', {
    update_chat_id: message.chat.id,
    from_id: message.from?.id,
    command: command.name,
    args: command.args,
    connection_id: connectionId
  });

  let action = null;

  if (command.name === 'ping' && !command.args) {
    action = async () => {
      await sendBusinessMessage(
        connectionId,
        message.chat.id,
        '✅ GiftShell работает.'
      );
    };
  }

  if (command.name === 'status' && !command.args) {
    action = async () => {
      connection = await getConnection(connectionId, true);

      await sendBusinessMessage(
        connectionId,
        message.chat.id,
        `✅ Automation активна.\n\n${rightsSummary(connection.rights)}`
      );
    };
  }

  if (command.name === 'help' && !command.args) {
    action = async () => {
      await sendBusinessMessage(
        connectionId,
        message.chat.id,
        `🎁 GiftShell команды\n\n` +
        `.ping — проверить работу\n` +
        `.status — проверить права Automation\n` +
        `.gift test — тест механики подарка без списания Stars`
      );
    };
  }

  if (command.name === 'gift' && command.args.toLowerCase() === 'test') {
    action = async () => {
      await sendBusinessMessage(
        connectionId,
        message.chat.id,
        '🎁 .gift работает. Это тест: Stars не списываются и подарок не покупается.'
      );
    };
  }

  // Unknown or malformed dot commands stay untouched.
  if (!action) return;

  try {
    await action();
  } catch (error) {
    console.error('[dot command action error]', {
      command: command.name,
      error: error.message
    });
    return;
  }

  // Delete only after successful execution.
  try {
    await deleteBusinessCommand(connectionId, message.message_id);
  } catch (error) {
    console.error('[delete command error]', error.message);

    // Never repeat the action here. Future commands may spend Stars.
    try {
      await sendBusinessMessage(
        connectionId,
        message.chat.id,
        '⚠️ Действие выполнено, но команда не удалилась. Проверь право «Удалять все сообщения» в Автоматизации чатов.'
      );
    } catch {}
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
            version: '0.3.1',
            mode: USE_WEBHOOK ? 'webhook' : 'polling',
            render: IS_RENDER,
            known_active_connections: activeConnectionByUser.size
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

  await bootstrapKnownConnections();

  await api('setMyCommands', {
    commands: [
      { command: 'start', description: 'Открыть GiftShell' },
      { command: 'status', description: 'Проверить Automation' }
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
