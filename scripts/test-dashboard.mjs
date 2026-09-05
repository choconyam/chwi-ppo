import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const htmlPath = path.resolve(root, process.argv[2] ?? 'career-dashboard.html');
const dateSourcePath = path.join(root, 'dashboard', 'src', 'date.ts');
const dateBuildDir = path.join(root, '.tmp', 'dashboard-date-test');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function loadDateModule() {
  const allowedRoot = `${path.join(root, '.tmp')}${path.sep}`;
  assert(dateBuildDir.startsWith(allowedRoot), `임시 빌드 경로가 작업공간을 벗어났습니다: ${dateBuildDir}`);
  fs.rmSync(dateBuildDir, { recursive: true, force: true });

  const tscEntry = path.join(root, 'dashboard', 'node_modules', 'typescript', 'bin', 'tsc');
  const result = spawnSync(
    process.execPath,
    [
      tscEntry, dateSourcePath,
      '--outDir', dateBuildDir, '--target', 'ES2022', '--module', 'ES2022', '--skipLibCheck',
    ],
    { cwd: root, encoding: 'utf8' },
  );
  assert(
    result.status === 0,
    `날짜 모듈 테스트 빌드 실패\n${result.error?.message ?? ''}\n${result.stdout ?? ''}\n${result.stderr ?? ''}`,
  );

  const compiledPath = path.join(dateBuildDir, 'date.js');
  assert(fs.existsSync(compiledPath), `날짜 모듈 산출물을 찾지 못했습니다: ${compiledPath}`);
  return import(`${pathToFileURL(compiledPath).href}?test=${Date.now()}`);
}

async function testCalendarBoundaries() {
  const { calendarDates, toIsoDate } = await loadDateModule();

  for (let month = 0; month < 12; month += 1) {
    const dates = calendarDates(new Date(2026, month, 1));
    assert(dates.length === 42, `${month + 1}월 달력이 42칸이 아닙니다.`);
    assert(dates[0].getDay() === 1, `${month + 1}월 달력이 월요일부터 시작하지 않습니다.`);

    dates.slice(1).forEach((date, index) => {
      const previous = dates[index];
      const expected = new Date(previous.getFullYear(), previous.getMonth(), previous.getDate() + 1);
      assert(toIsoDate(date) === toIsoDate(expected), `${month + 1}월 날짜가 연속되지 않습니다.`);
    });
  }

  const september = calendarDates(new Date(2026, 8, 1)).map(toIsoDate);
  assert(september[0] === '2026-08-31', `9월 첫 칸이 잘못되었습니다: ${september[0]}`);
  ['2026-09-10', '2026-09-13', '2026-09-21'].forEach((deadline) => {
    assert(september.includes(deadline), `9월 달력에서 마감일 ${deadline}을 찾지 못했습니다.`);
  });
}

function testGeneratorCreatesOutputDirectory() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'chwi-dashboard-output-'));
  try {
    const output = path.join(temporary, 'not-yet-created', 'nested', 'dashboard.html');
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'generate-dashboard.ps1'),
      '-InputFile', path.join(root, 'data', 'opportunities.example.json'), '-OutputFile', output,
    ], { cwd: root, encoding: 'utf8', windowsHide: true });
    assert(result.status === 0, `새 출력 폴더 생성 실패: ${result.stderr}`);
    assert(fs.readFileSync(output, 'utf8').includes('<div id="root"></div>'), '생성 HTML에 root가 없습니다.');
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function testStandaloneHtml() {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const doctypes = html.match(/<!doctype html>/gi) ?? [];
  const moduleScripts = html.match(/<script\s+type="module">/gi) ?? [];
  const dataMatch = html.match(/<script[^>]*id="opportunity-data"[^>]*>([\s\S]*?)<\/script>/i);

  assert(doctypes.length === 1, `HTML 문서가 ${doctypes.length}번 삽입되었습니다.`);
  assert(moduleScripts.length === 1, `모듈 스크립트가 ${moduleScripts.length}개입니다.`);
  assert(html.includes('<div id="root"></div>'), 'React root가 없습니다.');
  assert(!html.includes('/assets/index-'), '외부 빌드 자산 참조가 남아 있습니다.');
  assert(dataMatch, '인라인 공고 데이터가 없습니다.');

  const registry = JSON.parse(dataMatch[1]);
  assert(Array.isArray(registry.opportunities), '공고 데이터가 배열이 아닙니다.');
}

try {
  await testCalendarBoundaries();
  testStandaloneHtml();
  testGeneratorCreatesOutputDirectory();
  console.log('대시보드 회귀 검증 통과: 월 경계·단일 HTML·인라인 공고 데이터');
} finally {
  fs.rmSync(dateBuildDir, { recursive: true, force: true });
}
