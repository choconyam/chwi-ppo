import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ORIGIN = 'https://jasoseol.com';
const TYPES = { 1: 'new', 2: 'experienced', 3: 'intern', 4: 'contract' };
const SIZES = { big_business: 'large', middle_market: 'mid', public_institution: 'public' };
const fail = message => { throw new Error(message); };

// Public search-page payload, observed together with the rendered UI on 2026-09-05.
// No login, private endpoint, cookie or profile data is used.
export function parseSearchPage(html, url) {
  const script = html.match(/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!script) fail('공개 검색 데이터 형식이 바뀌었거나 접근이 차단되었습니다. 브라우저 목록으로 전환하세요.');
  const props = JSON.parse(script[1])?.props?.pageProps;
  const query = props?.dehydratedState?.queries?.find(q => q.queryKey?.[0] === 'jobSearch');
  const data = query?.state?.data;
  if (!Array.isArray(data?.data) || !Number.isInteger(data.page) || !Number.isInteger(data.perPage)
      || data.page < 1 || data.perPage < 1 || !Number.isInteger(data.totalCount) || data.totalCount < 0) {
    fail('공개 목록의 행·페이지·총수를 확인할 수 없습니다. 빈 결과로 처리하지 않습니다.');
  }
  const request = new URL(url);
  const filters = props.initialFilters;
  if (data.page !== Number(request.searchParams.get('page') || 1)
      || filters?.excludeClosed !== (request.searchParams.get('excludeClosed') === 'true')) {
    fail('요청한 페이지/마감 필터가 실제 응답에 적용되지 않았습니다.');
  }
  const postings = data.data.map(row => {
    if (!Number.isInteger(row.id) || !row.name || !row.title || !Array.isArray(row.employments)) fail('공고 필수 항목이 변경되었습니다.');
    const relative = `/recruit/${row.id}`;
    if (!html.includes(`href="${relative}"`) && !html.includes(`href="${ORIGIN}${relative}"`)) fail('공고 상세 링크를 원문에서 확인할 수 없습니다.');
    const roles = row.employments.map(role => {
      if (!role.id || !role.field) fail('공고 세부 직무 항목이 변경되었습니다.');
      return { id: String(role.id), title: role.field,
        careerTypes: (role.division ?? []).map(code => TYPES[code] ?? `unknown-division:${code}`),
        deadline: role.end_time ? { at: role.end_time, confirmed: true } : undefined };
    });
    return { sourceId: 'jasoseol-search', sourceRowId: String(row.id), company: row.name, title: row.title,
      url: `${ORIGIN}${relative}`, size: SIZES[row.company_group?.business_size] ?? null,
      careerTypes: [...new Set(roles.flatMap(role => role.careerTypes))], roles,
      deadline: row.end_time ? { at: row.end_time, confirmed: true } : null,
      rawEvidence: { employmentPageUrl: row.employment_page_url ?? null, startTime: row.start_time ?? null,
        businessSizeCode: row.company_group?.business_size ?? null, sourceKind: 'portal-not-official' } };
  });
  return { postings, page: data.page, perPage: data.perPage, totalCount: data.totalCount, filters };
}

async function fetchHtml(url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(12000), redirect: 'error' });
      if ([401, 403, 429].includes(response.status)) fail(`HTTP ${response.status}: 접근 제한. 우회하지 않고 브라우저/다른 출처로 전환하세요.`);
      if (!response.ok) fail(`HTTP ${response.status}`);
      return await response.text();
    } catch (error) {
      if (attempt || /401|403|429|redirect/.test(error.message)) throw error;
    }
  }
}

export async function collect({ output, resume, maxPages = 20, fetchPage = fetchHtml, now = () => new Date().toISOString() }) {
  if (!Number.isInteger(maxPages) || maxPages < 1) fail('maxPages는 양의 정수여야 합니다.');
  const baseUrl = `${ORIGIN}/search?excludeClosed=true`;
  let snapshot = { schemaVersion: 1, sources: [], postings: [], collection: { url: baseUrl, pages: [], nextPage: 1, errors: [] } };
  if (resume) {
    snapshot = JSON.parse(fs.readFileSync(resume, 'utf8'));
    if (snapshot.collection?.url !== baseUrl || !Array.isArray(snapshot.collection.pages)) fail('같은 수집기의 snapshot만 재개할 수 있습니다.');
    const age = Date.parse(now()) - Date.parse(snapshot.sources[0]?.checkedAt);
    if (!Number.isFinite(age) || age < 0 || age >= 86400000) fail('오래된 목록입니다. resume 없이 새로 수집하세요.');
    snapshot.collection.errors = [];
  }
  const save = () => {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(snapshot, null, 2) + '\n');
  };
  for (let step = 0; step < maxPages; step++) {
    const pageNumber = snapshot.collection.nextPage;
    if (pageNumber === null) break;
    const url = new URL(baseUrl); url.searchParams.set('page', pageNumber);
    try {
      const page = parseSearchPage(await fetchPage(url.href), url.href);
      const checkedAt = now();
      snapshot.postings.push(...page.postings);
      snapshot.collection.pages.push({ page: page.page, count: page.postings.length, totalCount: page.totalCount, url: url.href, checkedAt });
      const expectedPages = Math.max(1, Math.ceil(page.totalCount / page.perPage));
      const uniqueRows = new Set(snapshot.postings.map(row => row.sourceRowId)).size;
      const totals = new Set(snapshot.collection.pages.map(p => p.totalCount));
      const reachedEnd = page.page >= expectedPages;
      snapshot.sources = [{ id: 'jasoseol-search', url: baseUrl, checkedAt,
        filters: page.filters, accessStatus: 'ok', pagesVisited: snapshot.collection.pages.length,
        expectedPages, expectedCount: page.totalCount, listedCount: snapshot.postings.length,
        complete: reachedEnd && totals.size === 1 && uniqueRows === page.totalCount }];
      snapshot.collection.nextPage = reachedEnd ? null : page.page + 1;
      if (reachedEnd && !snapshot.sources[0].complete) snapshot.collection.errors.push('수집 중 목록 변경/중복이 관측되었습니다. 누락 확인 후 새 목록을 수집하세요.');
      save();
      if (reachedEnd) break;
    } catch (error) {
      snapshot.collection.errors.push({ page: pageNumber, url: url.href, message: error.message });
      snapshot.sources = [{ ...(snapshot.sources[0] ?? { id: 'jasoseol-search', url: baseUrl, pagesVisited: 0, listedCount: 0 }),
        checkedAt: now(), complete: false, accessStatus: 'access-failed' }];
      save();
      break;
    }
  }
  return snapshot;
}

async function main() {
  const options = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--out', '--resume', '--max-pages'].includes(argv[i]) || !argv[i + 1]) fail('사용법: collect-jasoseol.mjs --out snapshot.json [--resume snapshot.json] [--max-pages 20]');
    options[argv[i].slice(2)] = argv[i + 1];
  }
  if (!options.out) fail('--out 경로가 필요합니다.');
  const result = await collect({ output: path.resolve(options.out), resume: options.resume && path.resolve(options.resume), maxPages: Number(options['max-pages'] ?? 20) });
  console.log(`포털 목록 ${result.postings.length}행, ${result.sources[0]?.pagesVisited ?? 0}페이지, ${result.sources[0]?.complete ? '해당 필터 범위 수집 완료' : '부분 수집'}. 다음 페이지: ${result.collection.nextPage ?? '없음'}`);
  if (result.collection.errors.length) console.error(JSON.stringify(result.collection.errors));
  console.log('공식 지원 자격·접수 상태는 아직 검증하지 않았습니다.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
