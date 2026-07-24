import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Minimal .env loader for CLI scripts (Next.js loads .env.local itself).
 * Existing process env always wins, so CI/host config is never overridden.
 */
export function loadEnv(files = ['.env.local', '.env']): void {
  for (const file of files) {
    const path = join(process.cwd(), file);
    if (!existsSync(path)) continue;
    for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  }
}
