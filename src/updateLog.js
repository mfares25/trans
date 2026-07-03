import { appendFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_PATH = join(__dirname, '..', 'update.log');

export function logUpdate(added, translated) {
  if (!added && !translated) return;
  const line = `${new Date().toISOString()} — ${added} transfer(s) added, ${translated} translated\n`;
  appendFileSync(LOG_PATH, line);
}
