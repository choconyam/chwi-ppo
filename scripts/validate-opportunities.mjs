import fs from 'node:fs';
import path from 'node:path';

import { readRegistry, validateRegistry } from './lib/opportunities.mjs';

const requested = process.argv[2] ?? 'data/opportunities.json';
const fallback = 'data/opportunities.example.json';
const selected = fs.existsSync(path.resolve(requested)) ? requested : fallback;
const { absolute, value } = readRegistry(selected);
const errors = validateRegistry(value);

if (errors.length > 0) {
  console.error(`검증 실패: ${absolute}`);
  errors.forEach((error) => console.error(`- ${error}`));
  process.exit(1);
}

console.log(`검증 통과: ${absolute}`);
console.log(`공고 ${value.opportunities.length}건, 중복·필수 필드 오류 0건`);
