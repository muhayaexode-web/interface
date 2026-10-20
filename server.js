import { config } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { makeSaspay, startPaymentsLoop } from './wallet.js';
import { startSyncLoop } from './sportapi.js';

if (!config.saspayKey || !config.sportApiKey) {
  console.warn('Attention : SASPAY_API_KEY ou SPORTAPI_KEY manquante dans backend/.env');
}

const db = await openDb();
const sas = makeSaspay();
startSyncLoop(db);
startPaymentsLoop(db, sas);

createApp(db, sas).listen(config.port, () => {
  console.log(`BerFoot prêt sur http://localhost:${config.port}`);
});
