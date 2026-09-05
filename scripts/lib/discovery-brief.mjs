import fs from 'node:fs';
import path from 'node:path';

const cell = value => String(value ?? '미확인').replaceAll('|', '/').replaceAll('\n', ' ');

// A compact company index for the first pass; every role remains in a linked file.
export function writeDiscoveryBrief(queue, output) {
  const base = output.replace(/\.json$/i, '');
  const directory = `${base}.companies`;
  fs.mkdirSync(directory, { recursive: true });
  const groups = new Map();
  for (const candidate of queue.candidates) {
    if (!groups.has(candidate.company)) groups.set(candidate.company, []);
    groups.get(candidate.company).push(candidate);
  }
  const companyByName = new Map((queue.companyChecks ?? []).map(company => [company.company, company]));
  for (const company of companyByName.keys()) if (!groups.has(company)) groups.set(company, []);
  const rows = [];
  for (const [company, candidates] of groups) {
    const check = companyByName.get(company);
    const filename = `${candidates[0]?.id ?? check.id}.md`;
    const exampleTitles = [...new Set(candidates.length ? candidates.map(c => c.title) : check.postings.flatMap(p => p.roleTitles))];
    const preview = exampleTitles.slice(0, 6).map(cell).join(', ');
    const remaining = exampleTitles.length > 6 ? ` 외 ${exampleTitles.length - 6}개 직무명 — 상세 확인` : '';
    rows.push(`| ${cell(company)} | ${candidates.length} | ${preview}${remaining} | [모든 직무](${path.basename(directory)}/${filename}) |`);
    const detail = [`# ${company}: 포털 후보, 공식 자격 미확정`, '',
      `- 기업 확인: ${check?.reason ?? '공식 공고 확인 필요'}`, '',
      ...(check?.postings ?? []).map(p => `- 공식 확인 출발 URL(포털 제공): ${p.employmentPageUrl || p.url}; 현재 공고 판정: ${p.currentPostingDisposition}`), '',
      '| 후보 ID | 세부 직무 | 신입/경력 | 마감(포털) | 확인 필요 | 공식 확인 출발 URL |', '|---|---|---|---|---|---|',
      ...candidates.map(c => `| ${c.id} | ${cell(c.title)} | ${cell(c.careerTypes.join(', '))} | ${cell(c.deadline.raw)} | ${cell(c.unknowns.join(', '))} | ${cell(c.portalEvidence[0]?.rawEvidence?.employmentPageUrl || c.portalUrl)} |`)];
    fs.writeFileSync(path.join(directory, filename), detail.join('\n') + '\n');
  }
  const brief = ['# 기업별 후보 인덱스', '', `- 관측 공고: ${queue.stats.postingRows}행 / 후보 직무: ${queue.candidates.length} / 기업: ${groups.size}`,
    `- 목록 수집: ${queue.coverage.partial ? '부분 — 미수집 범위 확인 필요' : '기록된 검색 범위 수집 완료'}`,
    '- 아래 직무명은 미리보기입니다. 키워드 일치만으로 적합도나 지원 가능 여부를 확정하지 마세요.',
    '- 관련 업무가 있거나 판단이 모호한 기업의 연결 파일을 읽어 세부 직무를 선택하세요. 후보 수 0은 그 기업에 적합한 공고가 없다는 뜻이 아닙니다. 공식 사이트의 다른 신입/경력 공고를 확인하세요.', '',
    '| 기업 | 후보 수 | 직무 미리보기 | 상세 |', '|---|---:|---|---|', ...rows];
  const briefPath = `${base}.brief.md`;
  fs.writeFileSync(briefPath, brief.join('\n') + '\n');
  return { briefPath, companies: groups.size, roles: queue.candidates.length };
}
