import { downloadDataset, bad } from './lib.mjs';
downloadDataset({ force: process.argv.includes('--force') }).catch((e) => { bad(e.message); process.exit(1); });
