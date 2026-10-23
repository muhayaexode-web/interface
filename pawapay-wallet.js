import { randomUUID } from 'node:crypto';
import { adjustBalance, AGO, BizError, NOW, tx } from './db.js';
import { config } from './config.js';

const PROVIDERS = {
  airtel_cd: 'AIRTEL_COD',
  orange_cd: 'ORANGE_COD',
  vodacom_cd: 'VODACOM_MPESA_COD',
};

export const DEPOSIT_FEE_BASIS_POINTS = 320;
export const DEPOSIT_NET_BONUS = 10;
const BASIS_POINTS = 10_000;

export function calculateDepositCharge(amount) {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new BizError('Montant de recharge invalide');
  }
  const targetNet = amount + DEPOSIT_NET_BONUS;
  const denominator = BASIS_POINTS - DEPOSIT_FEE_BASIS_POINTS;
  return Math.floor((targetNet * BASIS_POINTS + denominator - 1) / denominator);
}

export class PawapayError extends Error {
  constructor(message, status, definitive) {
    super(message);
    this.status = status;
    this.definitive = definitive;
  }
}

export function makePawapay(fetchImpl = fetch) {
  async function call(method, path, body) {
    if (!config.pawapayToken) {
      throw new PawapayError('PAWAPAY_API_TOKEN manquante dans la configuration', 0, true);
    }
    let res;
    try {
      res = await fetchImpl(`${config.pawapayBaseUrl}/v2${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${config.pawapayToken}`,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(25_000),
      });
    } catch (err) {
      throw new PawapayError(`Réseau PawaPay indisponible: ${err.message}`, 0, false);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = data.failureReason?.failureMessage || data.message;
      const definitive = res.status >= 400 && res.status < 500 && ![408, 409, 429].includes(res.status);
      throw new PawapayError(reason || `Erreur PawaPay ${res.status}`, res.status, definitive);
    }
    if (data.status === 'REJECTED') {
      throw new PawapayError(
        data.failureReason?.failureMessage || 'La demande a été refusée par PawaPay',
        400,
        true,
      );
    }
    return data;
  }

  return {
    deposit: (body) => call('POST', '/deposits', body),
    payout: (body) => call('POST', '/payouts', body),
    verifyDeposit: async (id) => {
      const result = await call('GET', `/deposits/${encodeURIComponent(id)}`);
      return result.status === 'FOUND' ? result.data : result;
    },
    verifyPayout: async (id) => {
      const result = await call('GET', `/payouts/${encodeURIComponent(id)}`);
      return result.status === 'FOUND' ? result.data : result;
    },
  };
}

export function normalizePhone(input) {
  let digits = String(input ?? '').replace(/[\s().-]/g, '');
  if (digits.startsWith('+')) digits = digits.slice(1);
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.startsWith('243')) digits = digits.slice(3);
  else if (digits.startsWith('0')) digits = digits.slice(1);
  if (!/^[89]\d{8}$/.test(digits)) throw new BizError('Numéro de téléphone RDC invalide (ex: 0812345678)');
  return { local: digits, intl: `+243${digits}` };
}

function checkAmountNetwork(amount, network, min) {
  if (!Number.isSafeInteger(amount) || amount < min) throw new BizError(`Montant minimum : ${min} CDF`);
  if (amount > 10_000_000) throw new BizError('Montant trop élevé');
  if (!Object.hasOwn(PROVIDERS, network)) throw new BizError('Réseau mobile money invalide');
}

const money = (amount) => `${amount}.00`;
const msisdn = (phone) => phone.replace(/\D/g, '');

async function markFailed(db, payment, refund) {
  await tx(db, async (t) => {
    const result = await t.run(
      `UPDATE payments SET status = 'failed', updated_at = ${NOW} WHERE id = ? AND status = 'pending'`,
      payment.id,
    );
    if (result.changes === 1 && refund) {
      await adjustBalance(t, payment.user_id, payment.amount, 'withdrawal_refund', payment.id);
    }
  });
}

async function markSuccess(db, payment) {
  await tx(db, async (t) => {
    const result = await t.run(
      `UPDATE payments SET status = 'success', updated_at = ${NOW} WHERE id = ? AND status = 'pending'`,
      payment.id,
    );
    if (result.changes === 1 && payment.kind === 'deposit') {
      await adjustBalance(t, payment.user_id, payment.amount, 'deposit', payment.id);
    }
  });
}

async function initiate(db, pawa, payment) {
  const provider = PROVIDERS[payment.network];
  const amount = money(
    payment.kind === 'deposit' ? calculateDepositCharge(payment.amount) : payment.amount,
  );
  const phoneNumber = msisdn(payment.phone);

  await db.run(
    `UPDATE payments SET saspay_id = ?, updated_at = ${NOW} WHERE id = ?`,
    payment.id,
    payment.id,
  );

  if (payment.kind === 'deposit') {
    return pawa.deposit({
      depositId: payment.id,
      amount,
      currency: config.currency,
      payer: { type: 'MMO', accountDetails: { phoneNumber, provider } },
    });
  }
  return pawa.payout({
    payoutId: payment.id,
    amount,
    currency: config.currency,
    recipient: { type: 'MMO', accountDetails: { phoneNumber, provider } },
  });
}

async function safeInitiate(db, pawa, payment) {
  try {
    const result = await initiate(db, pawa, payment);
    const expectedId = payment.kind === 'deposit' ? result.depositId : result.payoutId;
    if (result.status === 'REJECTED') {
      throw new PawapayError(
        result.failureReason?.failureMessage || 'La demande a été refusée par PawaPay',
        400,
        true,
      );
    }
    if (!['ACCEPTED', 'DUPLICATE_IGNORED'].includes(result.status)) {
      throw new PawapayError('Réponse d’initiation PawaPay inattendue', 502, false);
    }
    await db.run(
      `UPDATE payments SET saspay_id = ?, checkout_url = NULL, updated_at = ${NOW} WHERE id = ?`,
      expectedId || payment.id,
      payment.id,
    );
    return result;
  } catch (err) {
    if (err instanceof PawapayError && err.definitive) {
      await markFailed(db, payment, payment.kind === 'withdrawal');
      throw new BizError(err.message, 502);
    }
    return null;
  }
}

export async function startDeposit(db, pawa, user, { amount, network, phone }) {
  checkAmountNetwork(amount, network, config.minDeposit);
  if (calculateDepositCharge(amount) > 10_000_000) {
    throw new BizError('Montant trop élevé après frais estimés');
  }
  const parsed = normalizePhone(phone);
  const id = randomUUID();
  const { rows } = await db.run(
    "INSERT INTO payments (id, user_id, kind, amount, network, phone) VALUES (?, ?, 'deposit', ?, ?, ?) RETURNING *",
    id, user.id, amount, network, parsed.intl,
  );
  await safeInitiate(db, pawa, rows[0]);
  return db.get('SELECT * FROM payments WHERE id = ?', id);
}

export async function startWithdrawal(db, pawa, user, { amount, network, phone }) {
  checkAmountNetwork(amount, network, config.minWithdrawal);
  const parsed = normalizePhone(phone);
  const id = randomUUID();
  const payment = await tx(db, async (t) => {
    const { rows } = await t.run(
      "INSERT INTO payments (id, user_id, kind, amount, network, phone) VALUES (?, ?, 'withdrawal', ?, ?, ?) RETURNING *",
      id, user.id, amount, network, parsed.intl,
    );
    await adjustBalance(t, user.id, -amount, 'withdrawal', id);
    return rows[0];
  });
  await safeInitiate(db, pawa, payment);
  return db.get('SELECT * FROM payments WHERE id = ?', id);
}

const FAIL = new Set(['FAILED', 'CANCELLED', 'CANCELED', 'EXPIRED', 'REJECTED']);

export async function reconcile(db, pawa, payment, log = console) {
  if (payment.status !== 'pending') return payment;
  try {
    if (!payment.saspay_id) {
      await safeInitiate(db, pawa, payment);
      return await db.get('SELECT * FROM payments WHERE id = ?', payment.id);
    }

    const result = payment.kind === 'deposit'
      ? await pawa.verifyDeposit(payment.saspay_id)
      : await pawa.verifyPayout(payment.saspay_id);
    const status = String(result.status ?? '').toUpperCase();
    if (['COMPLETED', 'SUCCESS'].includes(status)) await markSuccess(db, payment);
    else if (FAIL.has(status)) await markFailed(db, payment, payment.kind === 'withdrawal');
    else if (status === 'NOT_FOUND') await safeInitiate(db, pawa, payment);
    else if (
      payment.kind === 'deposit'
      && Date.now() - Date.parse(`${payment.created_at.replace(' ', 'T')}Z`) > 24 * 3600_000
    ) {
      await markFailed(db, payment, false);
    }
  } catch (err) {
    log.warn('[PawaPay reconciliation]', err.message);
  }
  return db.get('SELECT * FROM payments WHERE id = ?', payment.id);
}

export function validatePawapayCallback(callback) {
  const items = Array.isArray(callback) ? callback : [callback];
  if (items.length === 0 || items.length > 20) {
    throw new BizError('Callback PawaPay invalide');
  }

  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new BizError('Callback PawaPay invalide');
    }
    const id = item.depositId ?? item.payoutId;
    if (typeof id !== 'string' || !id) {
      throw new BizError('Identifiant de paiement PawaPay manquant');
    }
  }
  return items;
}

export async function reconcileCallback(db, pawa, callback, log = console) {
  const items = validatePawapayCallback(callback);
  for (const item of items) {
    const id = item.depositId ?? item.payoutId;
    const payment = await db.get(
      "SELECT * FROM payments WHERE saspay_id = ? AND status = 'pending'",
      id,
    );
    if (!payment) continue;

    const expectedKind = item.depositId ? 'deposit' : 'withdrawal';
    if (payment.kind !== expectedKind) {
      log.warn(`[PawaPay callback] Type de paiement incohérent pour ${id}`);
      continue;
    }
    await reconcile(db, pawa, payment, log);
  }
}

export function startPaymentsLoop(db, pawa, log = console) {
  let running = false;
  return setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const rows = await db.all(`SELECT * FROM payments WHERE status = 'pending' AND created_at > ${AGO('3 days')}`);
      for (const payment of rows) await reconcile(db, pawa, payment, log);
    } catch (err) {
      log.error('[payments]', err.message);
    } finally {
      running = false;
    }
  }, 15_000);
}
