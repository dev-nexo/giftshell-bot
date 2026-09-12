import http from 'node:http';
import {
  closeGiftEngine,
  getGiftCatalog,
  giftEngineStatus,
  isGiftEngineConfigured,
  primeGiftEngine,
  sendGiftFromBusiness
} from './gifts.js';

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
const catalogSnapshots = new Map();
const paymentLocks = new Set();
const successfulPayments = new Set();

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
    ['Удалять команды', rights.can_delete_all_messages],
    ['Смотреть Gifts и Stars', rights.can_view_gifts_and_stars],
    ['Передавать/улучшать Gifts', rights.can_transfer_and_upgrade_gifts],
    ['Тратить/передавать Stars', rights.can_transfer_stars]
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

function giftEngineLine() {
  const status = giftEngineStatus();

  return status.configured
    ? `✅ Реальная отправка Gifts включена${status.sessionPersisted ? '' : ' (временная MTProto-сессия)'}`
    : '⚠️ Каталог доступен, но для покупки Gifts нужны TG_API_ID и TG_API_HASH';
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
        `3. Выдай все права, особенно чтение, ответы, удаление и Gifts/Stars\n` +
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
      `${giftEngineLine()}\n\n` +
      `Команды:\n` +
      `.help\n` +
      `.ping\n` +
      `.status\n` +
      `.balance\n` +
      `.gifts\n` +
      `.gift <номер или название>\n\n` +
      `Сначала .gifts, потом .gift. После успешного действия команда исчезает.`
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
        ? `✅ Automation подключена.\n\n${rightsSummary(connection.rights)}\n\n${giftEngineLine()}`
        : `❌ Активное Automation-подключение не найдено. Отправь /start для инструкции.`
    });
  }
}

async function handleBusinessConnection(connection) {
  rememberConnection(connection);
  catalogSnapshots.delete(connection.id);

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

function normalizeSearch(value) {
  return value
    .toLocaleLowerCase('ru-RU')
    .replace(/[ё]/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function isSendableGift(gift) {
  if (gift.soldOut || gift.auction) return false;

  if (
    typeof gift.availabilityRemains === 'number' &&
    gift.availabilityRemains <= 0
  ) {
    return false;
  }

  return true;
}

function formatGift(gift, index) {
  const title = gift.title || `Gift ${gift.id}`;
  const flags = [];

  if (gift.requirePremium) {
    flags.push('Premium');
  }

  if (
    typeof gift.availabilityRemains === 'number' &&
    typeof gift.availabilityTotal === 'number'
  ) {
    flags.push(`${gift.availabilityRemains}/${gift.availabilityTotal}`);
  }

  if (
    typeof gift.lockedUntilDate === 'number' &&
    gift.lockedUntilDate * 1000 > Date.now()
  ) {
    flags.push('🔒');
  }

  return `${index + 1}. ${title} — ${gift.stars} ⭐${flags.length ? ` • ${flags.join(' • ')}` : ''}`;
}

function pageNumber(value) {
  if (!value) return 1;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return null;

  return parsed;
}

async function getBotApiCatalog() {
  const result = await api('getAvailableGifts');

  return (result?.gifts || []).map(gift => ({
    id: gift.id,
    title: gift.sticker?.emoji
      ? `${gift.sticker.emoji} Gift`
      : null,
    stars: gift.star_count,
    soldOut: false,
    auction: false,
    limited: false,
    availabilityRemains: null,
    availabilityTotal: null,
    requirePremium: Boolean(gift.is_premium),
    lockedUntilDate: null
  }));
}

async function loadCatalogForDisplay() {
  if (isGiftEngineConfigured()) {
    return getGiftCatalog({ force: true });
  }

  return getBotApiCatalog();
}

async function showGiftCatalog(connectionId, chatId, args) {
  const page = pageNumber(args);

  if (!page) {
    throw new Error('INVALID_GIFTS_PAGE');
  }

  const all = await loadCatalogForDisplay();
  const gifts = all.filter(isSendableGift);

  if (!gifts.length) {
    throw new Error('NO_AVAILABLE_GIFTS');
  }

  catalogSnapshots.set(connectionId, {
    createdAt: Date.now(),
    gifts: gifts.map(gift => ({ ...gift }))
  });

  const pageSize = 12;
  const pages = Math.max(1, Math.ceil(gifts.length / pageSize));

  if (page > pages) {
    throw new Error(`INVALID_GIFTS_PAGE:${pages}`);
  }

  const start = (page - 1) * pageSize;
  const slice = gifts.slice(start, start + pageSize);

  const lines = slice.map(
    (gift, offset) => formatGift(gift, start + offset)
  );

  await sendBusinessMessage(
    connectionId,
    chatId,
    `🎁 Доступные Telegram Gifts\n` +
      `Страница ${page}/${pages}\n\n` +
      `${lines.join('\n')}\n\n` +
      `Отправить: .gift <номер или название>` +
      `${pages > 1 ? `\nСледующая: .gifts ${Math.min(page + 1, pages)}` : ''}` +
      `${isGiftEngineConfigured() ? '' : '\n\n⚠️ Для реальной покупки добавь TG_API_ID и TG_API_HASH на Render.'}`
  );
}

async function showBusinessBalance(connectionId, chatId) {
  const balance = await api('getBusinessAccountStarBalance', {
    business_connection_id: connectionId
  });

  const nanos = Number(balance.nanostar_amount || 0);
  const decimal = nanos
    ? String(Math.abs(nanos)).padStart(9, '0').replace(/0+$/, '')
    : '';

  await sendBusinessMessage(
    connectionId,
    chatId,
    `⭐ Баланс: ${balance.amount}${decimal ? `.${decimal}` : ''} Stars`
  );
}

function resolveSnapshotGift(connectionId, selector) {
  const snapshot = catalogSnapshots.get(connectionId);

  if (!snapshot || Date.now() - snapshot.createdAt > 5 * 60_000) {
    throw new Error('CATALOG_SNAPSHOT_REQUIRED');
  }

  const query = selector.trim();

  if (!query) {
    throw new Error('GIFT_SELECTOR_REQUIRED');
  }

  if (/^\d+$/.test(query)) {
    const numeric = Number(query);

    if (
      Number.isSafeInteger(numeric) &&
      numeric >= 1 &&
      numeric <= snapshot.gifts.length
    ) {
      return snapshot.gifts[numeric - 1];
    }

    const byId = snapshot.gifts.find(gift => gift.id === query);
    if (byId) return byId;
  }

  const normalized = normalizeSearch(query);

  const exact = snapshot.gifts.filter(
    gift => gift.title && normalizeSearch(gift.title) === normalized
  );

  if (exact.length === 1) {
    return exact[0];
  }

  const contains = snapshot.gifts.filter(
    gift =>
      gift.title &&
      normalizeSearch(gift.title).includes(normalized)
  );

  if (contains.length === 1) {
    return contains[0];
  }

  if (contains.length > 1 || exact.length > 1) {
    const matches = (exact.length ? exact : contains)
      .slice(0, 5)
      .map(gift => gift.title)
      .join(', ');

    throw new Error(`GIFT_AMBIGUOUS:${matches}`);
  }

  throw new Error('GIFT_NOT_FOUND');
}

async function buyGift({
  connection,
  message,
  selector
}) {
  if (!isGiftEngineConfigured()) {
    throw new Error('GIFTS_ENGINE_NOT_CONFIGURED');
  }

  if (!connection.rights?.can_view_gifts_and_stars) {
    throw new Error('RIGHT_VIEW_GIFTS_REQUIRED');
  }

  if (!connection.rights?.can_transfer_stars) {
    throw new Error('RIGHT_TRANSFER_STARS_REQUIRED');
  }

  const selected = resolveSnapshotGift(
    connection.id,
    selector
  );

  const freshCatalog = await getGiftCatalog({ force: true });
  const fresh = freshCatalog.find(gift => gift.id === selected.id);

  if (!fresh || !isSendableGift(fresh)) {
    throw new Error('GIFT_NO_LONGER_AVAILABLE');
  }

  if (fresh.stars !== selected.stars) {
    throw new Error(
      `PRICE_CHANGED:${selected.stars}:${fresh.stars}`
    );
  }

  if (
    typeof fresh.lockedUntilDate === 'number' &&
    fresh.lockedUntilDate * 1000 > Date.now()
  ) {
    throw new Error('GIFT_LOCKED');
  }

  const balance = await api('getBusinessAccountStarBalance', {
    business_connection_id: connection.id
  });

  if (Number(balance.amount) < fresh.stars) {
    throw new Error(
      `BALANCE_TOO_LOW:${balance.amount}:${fresh.stars}`
    );
  }

  await sendGiftFromBusiness({
    connectionId: connection.id,
    chatId: message.chat.id,
    chatUsername: message.chat.username || null,
    messageId: message.message_id,
    gift: fresh
  });

  return fresh;
}

function friendlyGiftError(error) {
  const raw = String(
    error?.telegram?.description ||
    error?.errorMessage ||
    error?.message ||
    error
  );

  if (raw.startsWith('CATALOG_SNAPSHOT_REQUIRED')) {
    return 'Сначала отправь .gifts, чтобы увидеть актуальные Gifts и цены.';
  }

  if (raw.startsWith('GIFT_SELECTOR_REQUIRED')) {
    return 'Формат: .gift <номер или название>. Сначала посмотри .gifts.';
  }

  if (raw.startsWith('GIFT_NOT_FOUND')) {
    return 'Такого Gift нет в показанном каталоге. Обнови список командой .gifts.';
  }

  if (raw.startsWith('GIFT_AMBIGUOUS:')) {
    return `Название неоднозначное: ${raw.slice('GIFT_AMBIGUOUS:'.length)}. Используй номер из .gifts.`;
  }

  if (raw.startsWith('GIFTS_ENGINE_NOT_CONFIGURED')) {
    return 'Реальная отправка Gifts ещё не включена на сервере: нужны TG_API_ID и TG_API_HASH.';
  }

  if (raw.startsWith('RIGHT_VIEW_GIFTS_REQUIRED')) {
    return 'GiftShell не выдано право смотреть Gifts и Stars. Включи его в Автоматизации чатов.';
  }

  if (raw.startsWith('RIGHT_TRANSFER_STARS_REQUIRED')) {
    return 'GiftShell не выдано право использовать Stars. Включи передачу Stars в Автоматизации чатов.';
  }

  if (
    raw.includes('BALANCE_TOO_LOW') ||
    raw.startsWith('BALANCE_TOO_LOW:')
  ) {
    const parts = raw.split(':');

    if (parts.length >= 3 && Number.isFinite(Number(parts[1]))) {
      return `Не хватает Stars. Баланс: ${parts[1]} ⭐, Gift стоит ${parts[2]} ⭐.`;
    }

    return 'Не хватает Telegram Stars для этого Gift.';
  }

  if (
    raw.includes('STARGIFT_USAGE_LIMITED') ||
    raw.startsWith('GIFT_NO_LONGER_AVAILABLE')
  ) {
    return 'Этот Gift уже закончился или больше недоступен. Обнови .gifts.';
  }

  if (raw.includes('STARGIFT_USER_USAGE_LIMITED')) {
    return 'Telegram не даёт купить ещё один такой Gift: достигнут лимит на пользователя.';
  }

  if (raw.includes('USER_DISALLOWED_STARGIFTS')) {
    return 'Получатель запретил этот тип Gifts в настройках.';
  }

  if (
    raw.includes('PREMIUM_ACCOUNT_REQUIRED') ||
    raw.includes('PREMIUM_REQUIRED')
  ) {
    return 'Этот Gift доступен только аккаунтам Telegram Premium.';
  }

  if (raw.startsWith('GIFT_LOCKED')) {
    return 'Этот Gift пока заблокирован Telegram и ещё не продаётся.';
  }

  if (
    raw.includes('STARS_FORM_AMOUNT_MISMATCH') ||
    raw.startsWith('PRICE_CHANGED:')
  ) {
    return 'Цена Gift изменилась. Обнови .gifts перед покупкой.';
  }

  if (raw.includes('TARGET_PEER_NOT_RESOLVED')) {
    return 'Не смог получить MTProto-пир получателя. Напиши обычное сообщение в этот чат и повтори .gifts → .gift.';
  }

  if (
    raw.includes('BUSINESS_CONNECTION_INVALID') ||
    raw.includes('BUSINESS_CONNECTION_DISABLED')
  ) {
    return 'Automation-подключение изменилось. Переподключи GiftShell в «Автоматизации чатов».';
  }

  if (
    raw.includes('FORM_EXPIRED') ||
    raw.includes('FORM_UNSUPPORTED') ||
    raw.includes('API_GIFT_RESTRICTED_UPDATE_APP')
  ) {
    return 'Telegram отклонил платёжную форму Gift. Обнови .gifts и повтори.';
  }

  return `Не удалось отправить Gift: ${raw.slice(0, 220)}`;
}

function rememberSuccessfulPayment(key) {
  successfulPayments.add(key);

  if (successfulPayments.size > 1000) {
    const oldest = successfulPayments.values().next().value;
    successfulPayments.delete(oldest);
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
  let financial = false;

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
        `✅ Automation активна.\n\n${rightsSummary(connection.rights)}\n\n${giftEngineLine()}`
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
        `.status — проверить Automation\n` +
        `.balance — баланс Stars\n` +
        `.gifts [страница] — актуальные Telegram Gifts\n` +
        `.gift <номер|название> — купить Gift текущему собеседнику\n` +
        `.gift test — тест без списания Stars\n\n` +
        `Перед покупкой сначала используй .gifts: GiftShell сверяет ID и цену повторно прямо перед оплатой.`
      );
    };
  }

  if (command.name === 'balance' && !command.args) {
    action = async () => {
      await showBusinessBalance(
        connectionId,
        message.chat.id
      );
    };
  }

  if (command.name === 'gifts') {
    action = async () => {
      await showGiftCatalog(
        connectionId,
        message.chat.id,
        command.args
      );
    };
  }

  if (command.name === 'gift' && command.args.toLowerCase() === 'test') {
    action = async () => {
      await sendBusinessMessage(
        connectionId,
        message.chat.id,
        '🎁 .gift работает. Это test: Stars не списываются.'
      );
    };
  } else if (command.name === 'gift') {
    financial = true;

    action = async () => {
      await buyGift({
        connection,
        message,
        selector: command.args
      });
    };
  }

  if (!action) return;

  const paymentKey = `${connectionId}:${message.chat.id}:${message.message_id}`;

  if (financial) {
    if (
      successfulPayments.has(paymentKey) ||
      paymentLocks.has(paymentKey)
    ) {
      return;
    }

    paymentLocks.add(paymentKey);
  }

  try {
    await action();

    if (financial) {
      rememberSuccessfulPayment(paymentKey);
    }
  } catch (error) {
    console.error('[dot command action error]', {
      command: command.name,
      error: error?.errorMessage || error?.message
    });

    try {
      await sendBusinessMessage(
        connectionId,
        message.chat.id,
        `⚠️ ${friendlyGiftError(error)}`
      );
    } catch {}

    return;
  } finally {
    if (financial) {
      paymentLocks.delete(paymentKey);
    }
  }

  try {
    await deleteBusinessCommand(
      connectionId,
      message.message_id
    );
  } catch (error) {
    console.error('[delete command error]', error.message);

    try {
      await sendBusinessMessage(
        connectionId,
        message.chat.id,
        '⚠️ Действие выполнено, но команда не удалилась. Проверь право «Удалять все сообщения».'
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
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8'
        });

        res.end(
          JSON.stringify({
            ok: true,
            service: 'GiftShell',
            version: '0.4.0',
            mode: USE_WEBHOOK ? 'webhook' : 'polling',
            render: IS_RENDER,
            known_active_connections: activeConnectionByUser.size,
            real_gifts_enabled: isGiftEngineConfigured()
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

          res.writeHead(200, {
            'content-type': 'text/plain; charset=utf-8'
          });
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

      res.writeHead(404, {
        'content-type': 'text/plain; charset=utf-8'
      });
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
  await api('deleteWebhook', {
    drop_pending_updates: false
  });

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

  try {
    await closeGiftEngine();
  } catch {}

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
  console.log(`real_gifts_enabled = ${isGiftEngineConfigured()}`);

  await bootstrapKnownConnections();

  try {
    await primeGiftEngine(KNOWN_CONNECTION_IDS);
  } catch (error) {
    console.warn(
      '[gift engine startup failed]',
      error?.errorMessage || error?.message
    );
  }

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
