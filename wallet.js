import { randomUUID } from 'node:crypto';
import { adjustBalance, AGO, BizError, NOW, tx } from './db.js';
import { config } from './config.js';

const BASE = 'https://api.saspay.me/api/v1';

export class SaspayError extends Error {
  constructor(message, status, definitive) {
    super(message);
    this.status = status;
    // definitive = SasPay a clairement refusé la requête (rien n'a été débité/envoyé)
    this.definitive = definitive;
  }
}

export function makeSaspay(fetchImpl = fetch) {
  async function call(method, path, body, idempotencyKey) {
    let res;
    try {
      res = await fetchImpl(`${BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${config.saspayKey}`,
          'Content-Type': 'application/json',
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(25_000),
      });
    } catch (err) {
      throw new SaspayError(`Réseau SasPay indisponible: ${err.message}`, 0, false);
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = json.error;
      const msg = (typeof e === 'object' && e?.message) || json.message || `Erreur SasPay ${res.status}`;
      const definitive = res.status >= 400 && res.status < 500 && ![408, 409, 429].includes(res.status);
      throw new SaspayError(msg, res.status, definitive);
    }
    return json.data ?? json;
  }

  return {
    softpay: (p, key) => call('POST', '/payments/softpay/', p, key),
    verifyPayment: (id) => call('GET', `/payments/${encodeURIComponent(id)}/verify/`),
    payout: (p, key) => call('POST', '/payouts/initialize/', p, key),
    verifyPayout: (id) => call('GET', `/payouts/${encodeURIComponent(id)}/verify/`),
  };
}

// Numéro RDC -> { local: '812345678', intl: '+243812345678' }
export function normalizePhone(input) {
  let d = String(input ?? '').replace(/[\s().-]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('243')) d = d.slice(3);
  else if (d.startsWith('0')) d = d.slice(1);
  if (!/^[89]\d{8}$/.test(d)) throw new BizError('Numéro de téléphone RDC invalide (ex: 0812345678)');
  return { local: d, intl: `+243${d}` };
}

function checkAmountNetwork(amount, network, min) {
  if (!Number.isSafeInteger(amount) || amount < min) throw new BizError(`Montant minimum : ${min} CDF`);
  if (amount > 10_000_000) throw new BizError('Montant trop élevé');
  if (!Object.hasOwn(config.networks, network)) throw new BizError('Réseau mobile money invalide');
}

const money = (n) => `${n}.00`;

function customerOf(user) {
  const local = user.email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '') || 'Joueur';
  return { email: user.email, first_name: local.slice(0, 30), last_name: 'BerFoot' };
}

async function markFailed(db, payment, refund) {
  await tx(db, async (t) => {
    const r = await t.run(
      `UPDATE payments SET status = 'failed', updated_at = ${NOW} WHERE id = ? AND status = 'pending'`,
      payment.id,
    );
    if (r.changes === 1 && refund) await adjustBalance(t, payment.user_id, payment.amount, 'withdrawal_refund', payment.id);
  });
}

async function markSuccess(db, payment) {
  await tx(db, async (t) => {
    const r = await t.run(
      `UPDATE payments SET status = 'success', updated_at = ${NOW} WHERE id = ? AND status = 'pending'`,
      payment.id,
    );
    if (r.changes === 1 && payment.kind === 'deposit') {
      await adjustBalance(t, payment.user_id, payment.amount, 'deposit', payment.id);
    }
  });
}

async function initiate(db, sas, payment, user) {
  const key = payment.id;
  if (payment.kind === 'deposit') {
    const d = await sas.softpay(
      {
        amount: money(payment.amount),
        currency: config.currency,
        country: config.country,
        description: 'Recharge porte-monnaie BerFoot',
        customer: { ...customerOf(user), phone: payment.phone },
        network: payment.network,
        metadata: { payment_id: payment.id, user_id: user.id },
      },
      key,
    );
    await db.run(
      `UPDATE payments SET saspay_id = ?, checkout_url = ?, updated_at = ${NOW} WHERE id = ?`,
      d.id ?? null,
      d.checkout_url || null,
      payment.id,
    );
    return d;
  }
  const d = await sas.payout(
    {
      amount: money(payment.amount),
      currency: config.currency,
      country: config.country,
      description: 'Retrait BerFoot',
      customer: { ...customerOf(user), phone: payment.phone },
      method: payment.network,
      recipient: { msisdn: payment.phone.replace('+243', '') },
      metadata: { payment_id: payment.id, user_id: user.id },
    },
    key,
  );
  await db.run(`UPDATE payments SET saspay_id = ?, updated_at = ${NOW} WHERE id = ?`, d.id ?? null, payment.id);
  return d;
}

async function safeInitiate(db, sas, payment, user) {
  try {
    return await initiate(db, sas, payment, user);
  } catch (err) {
    if (err instanceof SaspayError && err.definitive) {
      await markFailed(db, payment, payment.kind === 'withdrawal');
      throw new BizError(err.message, 502);
    }
    // Incertain (réseau/5xx) : la tâche de fond rejouera avec la même Idempotency-Key.
    return null;
  }
}

export async function startDeposit(db, sas, user, { amount, network, phone }) {
  checkAmountNetwork(amount, network, config.minDeposit);
  const p = normalizePhone(phone);
  const id = randomUUID();
  const { rows } = await db.run(
    "INSERT INTO payments (id, user_id, kind, amount, network, phone) VALUES (?, ?, 'deposit', ?, ?, ?) RETURNING *",
    id, user.id, amount, network, p.intl,
  );
  await safeInitiate(db, sas, rows[0], user);
  return db.get('SELECT * FROM payments WHERE id = ?', id);
}

export async function startWithdrawal(db, sas, user, { amount, network, phone }) {
  checkAmountNetwork(amount, network, config.minWithdrawal);
  const p = normalizePhone(phone);
  const id = randomUUID();
  const payment = await tx(db, async (t) => {
    const { rows } = await t.run(
      "INSERT INTO payments (id, user_id, kind, amount, network, phone) VALUES (?, ?, 'withdrawal', ?, ?, ?) RETURNING *",
      id, user.id, amount, network, p.intl,
    );
    await adjustBalance(t, user.id, -amount, 'withdrawal', id);
    return rows[0];
  });
  await safeInitiate(db, sas, payment, user);
  return db.get('SELECT * FROM payments WHERE id = ?', id);
}

const FAIL = new Set(['FAILED', 'CANCELLED', 'CANCELED', 'EXPIRED', 'REJECTED']);

// Vérifie auprès de SasPay et applique le résultat (crédit/remboursement une seule fois).
export async function reconcile(db, sas, payment) {
  if (payment.status !== 'pending') return payment;
  try {
    const user = await db.get('SELECT * FROM users WHERE id = ?', payment.user_id);
    if (!payment.saspay_id) {
      await safeInitiate(db, sas, payment, user);
      return await db.get('SELECT * FROM payments WHERE id = ?', payment.id);
    }
    const d =
      payment.kind === 'deposit' ? await sas.verifyPayment(payment.saspay_id) : await sas.verifyPayout(payment.saspay_id);
    const status = String(d.status ?? '').toUpperCase();
    if (status === 'SUCCESS') await markSuccess(db, payment);
    else if (FAIL.has(status)) await markFailed(db, payment, payment.kind === 'withdrawal');
    else if (payment.kind === 'deposit' && Date.now() - Date.parse(`${payment.created_at.replace(' ', 'T')}Z`) > 24 * 3600_000) {
      await markFailed(db, payment, false);
    }
  } catch {
    // erreur transitoire : nouvel essai au prochain passage
  }
  return db.get('SELECT * FROM payments WHERE id = ?', payment.id);
}

export function startPaymentsLoop(db, sas, log = console) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const rows = await db.all(`SELECT * FROM payments WHERE status = 'pending' AND created_at > ${AGO('3 days')}`);
      for (const p of rows) await reconcile(db, sas, p);
    } catch (err) {
      log.error('[payments]', err.message);
    } finally {
      running = false;
    }
  }, 15_000);
  return timer;
}
