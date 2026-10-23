import { config } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { makePawapay, startPaymentsLoop } from './pawapay-wallet.js';
import { startSyncLoop } from './sportapi.js';

if (!config.pawapayToken) {
  console.warn('Attention : PAWAPAY_API_TOKEN manquante dans la configuration Render');
}
if (!config.sportApiKey) {
  console.warn('Attention : SPORTAPI_KEY manquante dans la configuration Render');
}

const db = await openDb({ schema: config.databaseSchema || undefined });
const pawapay = makePawapay();
startSyncLoop(db);
startPaymentsLoop(db, pawapay);

createApp(db, pawapay).listen(config.port, () => {
  console.log(`BerFoot prêt sur http://localhost:${config.port}`);
});
