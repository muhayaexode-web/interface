import { config } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { makePawapay } from './pawapay-wallet.js';
import { makeSaspay } from './saspay-wallet.js';
import { createPaymentService } from './payment-service.js';
import { startSyncLoop } from './sportapi.js';

if (config.apiCheckPaiement === 'pawapay' && !config.pawapayToken) {
  console.warn('Attention : PAWAPAY_API_TOKEN manquante dans la configuration Render');
}
if (config.apiCheckPaiement === 'saspay' && !config.saspayKey) {
  console.warn('Attention : SASPAY_API_KEY manquante dans la configuration Render');
}
if (!config.sportApiKey) {
  console.warn('Attention : SPORTAPI_KEY manquante dans la configuration Render');
}

const db = await openDb({ schema: config.databaseSchema || undefined });
const payments = createPaymentService(db, {
  pawapay: makePawapay(),
  saspay: makeSaspay(),
});
startSyncLoop(db);
payments.startPaymentsLoop();

createApp(db, payments).listen(config.port, () => {
  console.log(`BerFoot prêt sur http://localhost:${config.port} (paiements: ${payments.provider})`);
});
