#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { buildDiscoveryQueue } from './lib/discovery.mjs';
import { writeDiscoveryBrief } from './lib/discovery-brief.mjs';

function usage() {
  return [
    '사용법:',
    '  node scripts/discovery-plan.mjs --snapshot <json> --criteria <json> [--previous <queue.json>] --out <queue.json> [--now <ISO>]',
    '',
    '포털 수집 스냅샷을 공식 검증 순서 큐로 변환합니다. 실제 웹 수집이나 공식 검증은 수행하지 않습니다.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') return { help: true };
    if (!token.startsWith('--')) throw new Error(`알 수 없는 인자: ${token}`);
    const name = token.slice(2);
    if (!['snapshot', 'criteria', 'previous', 'out', 'now'].includes(name)) {
      throw new Error(`알 수 없는 옵션: ${token}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${token} 값이 필요합니다.`);
    args[name] = value;
    index += 1;
  }
  for (const required of ['snapshot', 'criteria', 'out']) {
    if (!args[required]) throw new Error(`--${required} 옵션이 필요합니다.`);
  }
  return args;
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} JSON을 읽을 수 없습니다 (${filePath}): ${error.message}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const snapshotPath = path.resolve(args.snapshot);
  const criteriaPath = path.resolve(args.criteria);
  const previousPath = args.previous ? path.resolve(args.previous) : null;
  const outPath = path.resolve(args.out);
  const result = buildDiscoveryQueue(
    readJson(snapshotPath, 'snapshot'),
    readJson(criteriaPath, 'criteria'),
    {
      previous: previousPath ? readJson(previousPath, 'previous') : undefined,
      now: args.now,
    },
  );

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  const brief = writeDiscoveryBrief(result, outPath);
  const partialLabel = result.coverage.partial ? '부분 수집' : '수집 완료 표시';
  console.log(`공식 검증 추천 큐 생성: ${result.queue.firstBatch.length}개 1차, ${result.queue.remaining.length}개 잔여 (${partialLabel})`);
  console.log(`원본 ${result.stats.postingRows}행 → retained ${result.stats.retained}, deferred ${result.stats.deferred}, excluded ${result.stats.excluded}`);
  console.log(`출력: ${outPath}`);
  console.log(`1차 비교용 요약: ${brief.briefPath} (${brief.companies}개 기업, 모든 직무는 연결 파일에 보존)`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  console.error(usage());
  process.exitCode = 1;
}
