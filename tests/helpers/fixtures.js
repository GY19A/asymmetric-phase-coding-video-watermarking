import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Oracle fixtures produced by tests/fixtures/make_fixtures.py (Python, CPU only). */
export const fixtures = JSON.parse(readFileSync(join(here, '..', 'fixtures', 'oracle.json'), 'utf8'));
