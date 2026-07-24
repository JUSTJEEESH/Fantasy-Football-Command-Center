import { loadEnv } from '../scripts/load-env';

// Integration tests need DATABASE_URL. Next.js loads .env itself; Vitest does
// not, so load it here. Tests that need the DB skip themselves when it is
// absent, so this never makes the suite fail on a machine without Postgres.
loadEnv();
