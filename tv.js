import { adjustBalance, BizError, NOW, notify, tx } from './db.js';

export const TV_SUBSCRIPTION_PRICE = 3000;

const nextMonth = "(now() at time zone 'utc') + interval '1 month'";

export async function assertTvAccess(db, user) {
  if (user.role === 'admin') return;
  const active = await db.get(
    `SELECT id FROM users WHERE id = ? AND tv_subscription_until > ${NOW}`,
    user.id,
  );
  if (!active) throw new BizError('Un abonnement TV actif est nécessaire pour regarder les flux.', 402);
}

export async function subscribeTv(db, userId) {
  return tx(db, async (t) => {
    const user = await t.get('SELECT id, role, balance FROM users WHERE id = ? FOR UPDATE', userId);
    if (!user) throw new BizError('Compte introuvable', 404);
    if (user.role === 'admin') return { unlimited: true, balance: user.balance };

    const active = await t.get(
      `SELECT id FROM users WHERE id = ? AND tv_subscription_until > ${NOW}`,
      userId,
    );
    if (active) throw new BizError('Votre abonnement TV est déjà actif.', 409);

    await adjustBalance(t, userId, -TV_SUBSCRIPTION_PRICE, 'tv_subscription', `tv:${userId}`);
    const result = await t.get(
      `UPDATE users
       SET tv_subscription_until = to_char(${nextMonth}, 'YYYY-MM-DD HH24:MI:SS')
       WHERE id = ? RETURNING tv_subscription_until`,
      userId,
    );
    await notify(
      t,
      userId,
      '📺 Abonnement TV activé',
      `Votre abonnement est actif jusqu’au ${result.tv_subscription_until} UTC. Il sera renouvelé chaque mois pour ${TV_SUBSCRIPTION_PRICE} CDF si votre solde est suffisant.`,
    );
    return {
      unlimited: false,
      balance: user.balance - TV_SUBSCRIPTION_PRICE,
      tvSubscriptionUntil: result.tv_subscription_until,
    };
  });
}

export async function renewDueTvSubscriptions(db) {
  const dueUsers = await db.all(
    `SELECT id FROM users
     WHERE role = 'user' AND tv_subscription_until IS NOT NULL
       AND tv_subscription_until <= ${NOW}
     ORDER BY id LIMIT 200`,
  );
  let renewed = 0;
  for (const { id } of dueUsers) {
    const wasRenewed = await tx(db, async (t) => {
      const user = await t.get('SELECT id, balance FROM users WHERE id = ? FOR UPDATE', id);
      if (!user || user.balance < TV_SUBSCRIPTION_PRICE) return false;
      const due = await t.get(
        `SELECT tv_subscription_until FROM users
         WHERE id = ? AND role = 'user' AND tv_subscription_until IS NOT NULL
           AND tv_subscription_until <= ${NOW}`,
        id,
      );
      if (!due) return false;

      await adjustBalance(
        t,
        id,
        -TV_SUBSCRIPTION_PRICE,
        'tv_subscription_renewal',
        `tv:${id}:${due.tv_subscription_until}`,
      );
      const result = await t.get(
        `UPDATE users
         SET tv_subscription_until = to_char(${nextMonth}, 'YYYY-MM-DD HH24:MI:SS')
         WHERE id = ? RETURNING tv_subscription_until`,
        id,
      );
      await notify(
        t,
        id,
        '📺 Abonnement TV renouvelé',
        `Votre abonnement TV est renouvelé jusqu’au ${result.tv_subscription_until} UTC. ${TV_SUBSCRIPTION_PRICE} CDF ont été débités de votre solde.`,
      );
      return true;
    });
    if (wasRenewed) renewed += 1;
  }
  return renewed;
}

export function startTvSubscriptionLoop(db, log = console) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await renewDueTvSubscriptions(db);
    } catch (error) {
      log.error('[tv subscriptions]', error.message);
    } finally {
      running = false;
    }
  };
  void run();
  return setInterval(run, 60_000);
}
