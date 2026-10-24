import { config } from './config.js';
import {
  calculateDepositCharge,
  reconcile as reconcilePawapay,
  startDeposit as startPawapayDeposit,
  startWithdrawal as startPawapayWithdrawal,
  validatePawapayCallback,
} from './pawapay-wallet.js';
import {
  reconcile as reconcileSaspay,
  startDeposit as startSaspayDeposit,
  startWithdrawal as startSaspayWithdrawal,
} from './saspay-wallet.js';
import { AGO } from './db.js';

export function createPaymentService(db, clients, log = console) {
  const selectedProvider = config.apiCheckPaiement;
  const methods = {
    pawapay: {
      client: clients.pawapay,
      startDeposit: startPawapayDeposit,
      startWithdrawal: startPawapayWithdrawal,
      reconcile: reconcilePawapay,
    },
    saspay: {
      client: clients.saspay,
      startDeposit: startSaspayDeposit,
      startWithdrawal: startSaspayWithdrawal,
      reconcile: reconcileSaspay,
    },
  };

  const methodsFor = (provider) => {
    const selected = methods[provider];
    if (!selected) throw new Error(`Fournisseur de paiement invalide: ${provider}`);
    return selected;
  };

  async function reconcile(payment) {
    const provider = payment.payment_provider || selectedProvider;
    const method = methodsFor(provider);
    return method.reconcile(db, method.client, payment, log);
  }

  return {
    provider: selectedProvider,
    startDeposit: (user, input) => {
      const method = methodsFor(selectedProvider);
      return method.startDeposit(db, method.client, user, input);
    },
    startWithdrawal: (user, input) => {
      const method = methodsFor(selectedProvider);
      return method.startWithdrawal(db, method.client, user, input);
    },
    reconcile,
    chargeAmount: (payment) =>
      (payment.payment_provider || selectedProvider) === 'pawapay'
        && payment.kind === 'deposit'
        ? calculateDepositCharge(payment.amount)
        : undefined,
    validatePawapayCallback,
    reconcilePawapayCallback: async (callbackItems) => {
      for (const item of callbackItems) {
        const id = item.depositId ?? item.payoutId;
        const payment = await db.get(
          'SELECT * FROM payments WHERE saspay_id = ? AND payment_provider = ?',
          id,
          'pawapay',
        );
        if (payment) await reconcilePawapay(db, clients.pawapay, payment, log);
      }
    },
    startPaymentsLoop: () => {
      let running = false;
      return setInterval(async () => {
        if (running) return;
        running = true;
        try {
          const payments = await db.all(
            `SELECT * FROM payments WHERE status = 'pending' AND created_at > ${AGO('3 days')}`,
          );
          for (const payment of payments) await reconcile(payment);
        } catch (err) {
          log.error('[payments]', err.message);
        } finally {
          running = false;
        }
      }, 15_000);
    },
  };
}
