import { config } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { makePawapay, startPaymentsLoop } from './pawapay-wallet.js';
import { startSyncLoop } from './sportapi.js';

if (!config.pawapayToken || !config.sportApiKey) {
  console.warn('Attention : PAWAPAY_API_TOKEN ou SPORTAPI_KEY manquante dans backend/.env');
}

const db = await openDb({ schema: config.databaseSchema || undefined });
const pawapay = makePawapay();
startSyncLoop(db);
startPaymentsLoop(db, pawapay);

createApp(db, pawapay).listen(config.port, () => {
  console.log(`BerFoot prêt sur http://localhost:${config.port}`);
});
