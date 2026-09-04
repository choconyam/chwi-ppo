import { useEffect, useMemo, useState } from 'react';
import { calendarDates, dDay, formatDate, parseLocalDate, toIsoDate, todayAtMidnight } from './date';
import type {
  ApplicationStatus,
  EligibilityStatus,
  FilterKey,
  FitLevel,
  Opportunity,
  OpportunityRegistry,
  VerificationStatus,
} from './types';

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: '전체' },
  { key: 'eligible', label: '지원 가능' },
  { key: 'high', label: '높은 적합도' },
  { key: 'needs-review', label: '확인 필요' },
];

const applicationLabels: Record<ApplicationStatus, string> = {
  discovered: '발견',
  analyzing: '분석 중',
  writing: '작성 중',
  review: '검수 중',
  ready: '제출 준비',
  submitted: '제출 완료 · 확인',
  closed: '마감',
};

const fitLabels: Record<FitLevel, string> = {
  high: '적합도 높음',
  medium: '적합도 보통',
  low: '적합도 낮음',
  unrated: '적합도 미평가',
};

const verificationLabels: Record<VerificationStatus, string> = {
  verified: '공식 확인',
  'needs-review': '공식 재확인 필요',
  sample: '예시 데이터',
};

const eligibilityLabels: Record<EligibilityStatus, string> = {
  eligible: '지원 가능',
  ineligible: '지원 불가',
  'needs-review': '자격 확인 필요',
};

function monthLabel(date: Date) {
  return new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long' }).format(date);
}

function isOpen(item: Opportunity) {
  if (!item.deadline.date) return true;
  return parseLocalDate(item.deadline.date).getTime() >= todayAtMidnight().getTime();
}

function matchesFilter(item: Opportunity, filter: FilterKey) {
  if (filter === 'eligible') return item.eligibility.status === 'eligible';
  if (filter === 'high') return item.fit.level === 'high';
  if (filter === 'needs-review') {
    return item.verification.status === 'needs-review' || item.eligibility.status === 'needs-review';
  }
  return true;
}

function StatusDot({ item }: { item: Opportunity }) {
  const kind = item.fit.level === 'high' ? 'high' : item.verification.status === 'needs-review' ? 'review' : 'default';
  return <span className={`status-dot ${kind}`} aria-hidden="true" />;
}

function DetailCard({ item }: { item: Opportunity }) {
  return (
    <article className="detail-card">
      <div className="detail-heading">
        <div>
          <p className="company-name">{item.company}</p>
          <h3>{item.role}</h3>
        </div>
        <span className={`d-day ${isOpen(item) ? '' : 'past'}`}>{dDay(item.deadline.date)}</span>
      </div>
      <div className="badge-row">
        <span className={`badge verify-${item.verification.status}`}>{verificationLabels[item.verification.status]}</span>
        <span className={`badge eligibility-${item.eligibility.status}`}>{eligibilityLabels[item.eligibility.status]}</span>
        <span className={`badge fit-${item.fit.level}`}>{fitLabels[item.fit.level]}</span>
        <span className={`badge status-${item.application.status}`}>{applicationLabels[item.application.status]}</span>
      </div>
      <dl className="detail-grid">
        <div>
          <dt>마감</dt>
          <dd>
            {formatDate(item.deadline.date)} ·{' '}
            {item.deadline.timeConfirmed && item.deadline.time ? item.deadline.time : '시간 확인 필요'}
          </dd>
        </div>
        <div>
          <dt>근무지</dt>
          <dd>{item.location || '확인 필요'}</dd>
        </div>
        <div>
          <dt>지원 판단</dt>
          <dd>{item.eligibility.reason}</dd>
        </div>
        <div>
          <dt>적합도 근거</dt>
          <dd>{item.fit.rationale}</dd>
        </div>
      </dl>
      <a className="official-link" href={item.officialUrl} target="_blank" rel="noreferrer">
        공식 공고 열기 <span aria-hidden="true">↗</span>
      </a>
    </article>
  );
}

export default function App() {
  const [registry, setRegistry] = useState<OpportunityRegistry | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FilterKey>('all');
  const [visibleMonth, setVisibleMonth] = useState(() => new Date());
  const [selectedDate, setSelectedDate] = useState(() => toIsoDate(new Date()));

  useEffect(() => {
    const inlineText = document.getElementById('opportunity-data')?.textContent?.trim();
    let inlineRegistry: OpportunityRegistry | null = null;
    try {
      inlineRegistry = inlineText ? JSON.parse(inlineText) as OpportunityRegistry : null;
    } catch {
      setError('HTML에 포함된 일정 데이터 형식이 올바르지 않습니다.');
      return;
    }

    const source = inlineRegistry
      ? Promise.resolve(inlineRegistry)
      : fetch('/opportunities.json').then((response) => {
          if (!response.ok) throw new Error('일정 데이터를 읽지 못했습니다.');
          return response.json() as Promise<OpportunityRegistry>;
        });

    source
      .then((data) => {
        setRegistry(data);
        const firstDate = data.opportunities.find((item) => item.deadline.date)?.deadline.date;
        if (firstDate) {
          setVisibleMonth(parseLocalDate(firstDate));
          setSelectedDate(firstDate);
        }
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : '알 수 없는 오류가 발생했습니다.'));
  }, []);

  const filtered = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('ko-KR');
    return (registry?.opportunities ?? []).filter((item) => {
      const searchable = `${item.company} ${item.role} ${item.location ?? ''}`.toLocaleLowerCase('ko-KR');
      return searchable.includes(normalizedQuery) && matchesFilter(item, filter);
    });
  }, [registry, query, filter]);

  const dated = useMemo(() => filtered.filter((item) => item.deadline.date), [filtered]);
  const undated = useMemo(() => filtered.filter((item) => !item.deadline.date), [filtered]);
  const dates = useMemo(() => calendarDates(visibleMonth), [visibleMonth]);
  const selectedItems = useMemo(
    () => dated.filter((item) => item.deadline.date === selectedDate),
    [dated, selectedDate],
  );
  const upcoming = useMemo(
    () =>
      dated
        .filter(isOpen)
        .sort((a, b) => (a.deadline.date ?? '').localeCompare(b.deadline.date ?? ''))
        .slice(0, 6),
    [dated],
  );
  const allSample = Boolean(registry?.opportunities.length) && registry?.opportunities.every((item) => item.verification.status === 'sample');
  const openCount = (registry?.opportunities ?? []).filter(isOpen).length;
  const readyCount = (registry?.opportunities ?? []).filter((item) => ['ready', 'submitted'].includes(item.application.status)).length;
  const reviewCount = (registry?.opportunities ?? []).filter(
    (item) => item.verification.status === 'needs-review' || item.eligibility.status === 'needs-review',
  ).length;

  const moveMonth = (amount: number) => {
    setVisibleMonth((current) => new Date(current.getFullYear(), current.getMonth() + amount, 1));
  };

  if (error) {
    return (
      <main className="loading-shell">
        <div className="error-box">
          <strong>대시보드를 열 수 없습니다.</strong>
          <p>{error}</p>
          <code>npm run dev</code>를 다시 실행해 주세요.
        </div>
      </main>
    );
  }

  if (!registry) {
    return <main className="loading-shell">지원 일정을 불러오는 중입니다…</main>;
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="지원 일정 워크벤치 홈">
          <span className="brand-mark">J</span>
          <span>
            <strong>Job Workbench</strong>
            <small>지원 일정과 판단 근거</small>
          </span>
        </a>
        <div className="updated-at">
          <span className="live-dot" /> 데이터 갱신 {new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(registry.updatedAt))}
        </div>
      </header>

      <main id="top">
        <section className="hero">
          <div>
            <p className="eyebrow">CAREER PIPELINE</p>
            <h1>지원할 곳과<br />지금 할 일을 한눈에.</h1>
            <p className="hero-copy">공식 공고 확인부터 직무 적합도, 작성 상태와 마감까지 하나의 흐름으로 관리합니다.</p>
          </div>
          <div className="summary-grid" aria-label="지원 현황 요약">
            <div className="summary-card"><span>진행 공고</span><strong>{openCount}</strong><small>마감 전 일정</small></div>
            <div className="summary-card accent"><span>제출 준비</span><strong>{readyCount}</strong><small>준비·제출 완료</small></div>
            <div className="summary-card warn"><span>확인 필요</span><strong>{reviewCount}</strong><small>공식 정보 재검토</small></div>
          </div>
        </section>

        {allSample && (
          <section className="sample-banner" role="status">
            <span>예시</span>
            현재 화면은 기능 확인용 가상 공고입니다. <code>/discover</code>를 실행하면 로컬 실제 일정으로 바뀝니다.
          </section>
        )}

        <section className="controls" aria-label="공고 검색 및 필터">
          <label className="search-box">
            <span aria-hidden="true">⌕</span>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="회사·직무·지역 검색" />
          </label>
          <div className="filter-tabs">
            {FILTERS.map((item) => (
              <button key={item.key} className={filter === item.key ? 'active' : ''} onClick={() => setFilter(item.key)}>
                {item.label}
              </button>
            ))}
          </div>
        </section>

        <section className="workspace-grid">
          <div className="calendar-panel">
            <div className="panel-heading">
              <div>
                <p className="section-kicker">DEADLINE CALENDAR</p>
                <h2>{monthLabel(visibleMonth)}</h2>
              </div>
              <div className="month-controls">
                <button onClick={() => moveMonth(-1)} aria-label="이전 달">←</button>
                <button onClick={() => { setVisibleMonth(new Date()); setSelectedDate(toIsoDate(new Date())); }}>오늘</button>
                <button onClick={() => moveMonth(1)} aria-label="다음 달">→</button>
              </div>
            </div>
            <div className="weekdays" aria-hidden="true">
              {['월', '화', '수', '목', '금', '토', '일'].map((day) => <span key={day}>{day}</span>)}
            </div>
            <div className="calendar-grid">
              {dates.map((date) => {
                const iso = toIsoDate(date);
                const dayItems = dated.filter((item) => item.deadline.date === iso);
                const isCurrentMonth = date.getMonth() === visibleMonth.getMonth();
                const isToday = iso === toIsoDate(new Date());
                return (
                  <button
                    key={iso}
                    className={`calendar-day ${isCurrentMonth ? '' : 'outside'} ${selectedDate === iso ? 'selected' : ''}`}
                    onClick={() => setSelectedDate(iso)}
                  >
                    <span className={isToday ? 'today-number' : ''}>{date.getDate()}</span>
                    <div className="day-items">
                      {dayItems.slice(0, 2).map((item) => (
                        <span className="day-event" key={item.id} title={`${item.company} ${item.role}`}>
                          <StatusDot item={item} /> {item.company}
                        </span>
                      ))}
                      {dayItems.length > 2 && <small>+{dayItems.length - 2}개</small>}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <aside className="upcoming-panel">
            <div className="panel-heading compact">
              <div>
                <p className="section-kicker">NEXT ACTION</p>
                <h2>다가오는 마감</h2>
              </div>
              <span className="count-pill">{upcoming.length}</span>
            </div>
            <div className="upcoming-list">
              {upcoming.length ? upcoming.map((item) => (
                <button
                  key={item.id}
                  className="upcoming-item"
                  onClick={() => {
                    if (!item.deadline.date) return;
                    setSelectedDate(item.deadline.date);
                    setVisibleMonth(parseLocalDate(item.deadline.date));
                  }}
                >
                  <div className="upcoming-date">
                    <strong>{parseLocalDate(item.deadline.date!).getDate()}</strong>
                    <span>{parseLocalDate(item.deadline.date!).getMonth() + 1}월</span>
                  </div>
                  <div className="upcoming-copy">
                    <strong>{item.company}</strong>
                    <span>{item.role}</span>
                    <small>{applicationLabels[item.application.status]} · {dDay(item.deadline.date)}</small>
                  </div>
                  <span className="chevron">›</span>
                </button>
              )) : <p className="empty-state">조건에 맞는 예정 공고가 없습니다.</p>}
            </div>
          </aside>
        </section>

        <section className="detail-section">
          <div className="section-heading-row">
            <div>
              <p className="section-kicker">SELECTED DATE</p>
              <h2>{formatDate(selectedDate)}</h2>
            </div>
            <span>{selectedItems.length}개 공고</span>
          </div>
          <div className="detail-list">
            {selectedItems.length ? selectedItems.map((item) => <DetailCard key={item.id} item={item} />) : (
              <div className="empty-detail">선택한 날짜에 마감하는 공고가 없습니다. 달력의 공고 표시를 눌러 보세요.</div>
            )}
          </div>
        </section>

        {undated.length > 0 && (
          <section className="undated-section">
            <div>
              <p className="section-kicker">DATE TO VERIFY</p>
              <h2>마감일 확인 필요</h2>
            </div>
            <div className="undated-list">
              {undated.map((item) => (
                <a href={item.officialUrl} target="_blank" rel="noreferrer" key={item.id}>
                  <strong>{item.company}</strong><span>{item.role}</span><small>공식 공고 확인 ↗</small>
                </a>
              ))}
            </div>
          </section>
        )}
      </main>

      <footer>
        <span>Job Workbench</span>
        <p>공식 공고와 검증된 본인 경험만 사용합니다.</p>
      </footer>
    </div>
  );
}
