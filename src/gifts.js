import bigInt from 'big-integer';
import { Api, TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';

const BOT_TOKEN = process.env.BOT_TOKEN?.trim();
const TG_API_ID = Number(process.env.TG_API_ID || 0);
const TG_API_HASH = process.env.TG_API_HASH?.trim() || '';
const TG_MT_SESSION = process.env.TG_MT_SESSION?.trim() || '';

let clientPromise = null;
const mtBusinessCache = new Map();
let catalogCache = {
  fetchedAt: 0,
  gifts: []
};

export function isGiftEngineConfigured() {
  return Boolean(
    BOT_TOKEN &&
    Number.isInteger(TG_API_ID) &&
    TG_API_ID > 0 &&
    TG_API_HASH
  );
}

export function giftEngineStatus() {
  return {
    configured: isGiftEngineConfigured(),
    sessionPersisted: Boolean(TG_MT_SESSION)
  };
}

function requireConfigured() {
  if (!isGiftEngineConfigured()) {
    const error = new Error('GIFTS_ENGINE_NOT_CONFIGURED');
    error.code = 'GIFTS_ENGINE_NOT_CONFIGURED';
    throw error;
  }
}

async function getClient() {
  requireConfigured();

  if (!clientPromise) {
    clientPromise = (async () => {
      const session = new StringSession(TG_MT_SESSION);
      const client = new TelegramClient(
        session,
        TG_API_ID,
        TG_API_HASH,
        {
          connectionRetries: 5,
          floodSleepThreshold: 30
        }
      );

      await client.start({
        botToken: BOT_TOKEN
      });

      client.addEventHandler(update => {
        const className = update?.className || '';
        if (
          className === 'UpdateBotBusinessConnect' ||
          className === 'UpdateBotNewBusinessMessage'
        ) {
          console.log('[mtproto update]', className);
        }
      });

      const me = await client.getMe();
      console.log('[mtproto ready]', {
        id: me?.id?.toString?.() || null,
        bot: Boolean(me?.bot),
        session_persisted: Boolean(TG_MT_SESSION)
      });

      return client;
    })().catch(error => {
      clientPromise = null;
      throw error;
    });
  }

  return clientPromise;
}

function normalizeGift(gift) {
  return {
    id: gift.id.toString(),
    title: gift.title?.trim() || null,
    stars: Number(gift.stars.toString()),
    soldOut: Boolean(gift.soldOut),
    auction: Boolean(gift.auction),
    limited: Boolean(gift.limited),
    availabilityRemains:
      typeof gift.availabilityRemains === 'number'
        ? gift.availabilityRemains
        : null,
    availabilityTotal:
      typeof gift.availabilityTotal === 'number'
        ? gift.availabilityTotal
        : null,
    requirePremium: Boolean(gift.requirePremium),
    lockedUntilDate:
      typeof gift.lockedUntilDate === 'number'
        ? gift.lockedUntilDate
        : null
  };
}

export async function getGiftCatalog({ force = false } = {}) {
  const now = Date.now();

  if (
    !force &&
    catalogCache.gifts.length &&
    now - catalogCache.fetchedAt < 30_000
  ) {
    return catalogCache.gifts.map(gift => ({ ...gift }));
  }

  const client = await getClient();
  const result = await client.invoke(
    new Api.payments.GetStarGifts({ hash: 0 })
  );

  if (!Array.isArray(result?.gifts)) {
    throw new Error('TELEGRAM_GIFT_CATALOG_EMPTY');
  }

  const gifts = result.gifts
    .filter(gift => gift?.className === 'StarGift')
    .map(normalizeGift);

  catalogCache = {
    fetchedAt: now,
    gifts
  };

  return gifts.map(gift => ({ ...gift }));
}

async function getMtBusinessConnection(connectionId, { force = false } = {}) {
  const cached = mtBusinessCache.get(connectionId);

  if (!force && cached && Date.now() - cached.fetchedAt < 60_000) {
    return cached.connection;
  }

  const client = await getClient();
  const result = await client.invoke(
    new Api.account.GetBotBusinessConnection({
      connectionId
    })
  );

  const update = result?.updates?.find(
    item => item?.className === 'UpdateBotBusinessConnect'
  );

  const connection = update?.connection;

  if (!connection) {
    throw new Error('MT_BUSINESS_CONNECTION_NOT_FOUND');
  }

  if (connection.disabled) {
    throw new Error('BUSINESS_CONNECTION_DISABLED');
  }

  mtBusinessCache.set(connectionId, {
    fetchedAt: Date.now(),
    connection
  });

  return connection;
}

async function businessInvoke(connectionId, query) {
  const client = await getClient();
  const connection = await getMtBusinessConnection(connectionId);

  return client.invoke(
    new Api.InvokeWithBusinessConnection({
      connectionId,
      query
    }),
    connection.dcId
  );
}

async function trySeedTargetFromBusinessMessage(connectionId, messageId) {
  try {
    await businessInvoke(
      connectionId,
      new Api.messages.GetMessages({
        id: [
          new Api.InputMessageID({
            id: messageId
          })
        ]
      })
    );
  } catch (error) {
    console.log(
      '[mtproto peer seed skipped]',
      error?.errorMessage || error?.message
    );
  }
}

async function resolveTargetPeer({
  connectionId,
  chatId,
  chatUsername,
  messageId
}) {
  const client = await getClient();
  const id = bigInt(String(chatId));

  if (chatUsername) {
    try {
      return await client.getInputEntity(`@${chatUsername}`);
    } catch {}
  }

  try {
    return await client.getInputEntity(id);
  } catch {}

  await trySeedTargetFromBusinessMessage(
    connectionId,
    messageId
  );

  for (let index = 0; index < 8; index += 1) {
    try {
      return await client.getInputEntity(id);
    } catch {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }

  throw new Error('TARGET_PEER_NOT_RESOLVED');
}

function paymentFormTotal(form) {
  const invoice = form?.invoice;

  if (!invoice || invoice.currency !== 'XTR' || !Array.isArray(invoice.prices)) {
    throw new Error('INVALID_STAR_GIFT_PAYMENT_FORM');
  }

  return invoice.prices.reduce(
    (sum, price) => sum + Number(price.amount.toString()),
    0
  );
}

export async function sendGiftFromBusiness({
  connectionId,
  chatId,
  chatUsername,
  messageId,
  gift
}) {
  requireConfigured();

  const peer = await resolveTargetPeer({
    connectionId,
    chatId,
    chatUsername,
    messageId
  });

  const invoice = new Api.InputInvoiceStarGift({
    peer,
    giftId: bigInt(gift.id),
    hideName: false,
    includeUpgrade: false
  });

  const form = await businessInvoke(
    connectionId,
    new Api.payments.GetPaymentForm({
      invoice
    })
  );

  const formTotal = paymentFormTotal(form);

  if (formTotal !== gift.stars) {
    const error = new Error(
      `PRICE_CHANGED:${gift.stars}:${formTotal}`
    );
    error.code = 'PRICE_CHANGED';
    error.expected = gift.stars;
    error.actual = formTotal;
    throw error;
  }

  const result = await businessInvoke(
    connectionId,
    new Api.payments.SendStarsForm({
      formId: form.formId,
      invoice
    })
  );

  if (result?.className === 'PaymentVerificationNeeded') {
    throw new Error('PAYMENT_VERIFICATION_REQUIRED');
  }

  return result;
}

export async function primeGiftEngine(connectionIds = []) {
  if (!isGiftEngineConfigured()) {
    console.log('[mtproto disabled] TG_API_ID/TG_API_HASH are not configured');
    return;
  }

  const client = await getClient();

  for (const connectionId of connectionIds) {
    try {
      await getMtBusinessConnection(connectionId, { force: true });
    } catch (error) {
      console.warn('[mtproto business preload failed]', {
        connection_id: connectionId,
        error: error?.errorMessage || error?.message
      });
    }
  }

  try {
    await getGiftCatalog({ force: true });
    console.log('[gift catalog ready]', {
      count: catalogCache.gifts.length
    });
  } catch (error) {
    console.warn(
      '[gift catalog preload failed]',
      error?.errorMessage || error?.message
    );
  }

  return client;
}

export async function closeGiftEngine() {
  if (!clientPromise) return;

  try {
    const client = await clientPromise;
    await client.disconnect();
  } catch {}

  clientPromise = null;
}
