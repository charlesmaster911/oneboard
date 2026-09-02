const KOREAN_WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

function ymd(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  if (date.getFullYear() !== Number(year)
    || date.getMonth() !== Number(month) - 1
    || date.getDate() !== Number(day)) return null;
  return { year, month, day, date, key: `${year}-${month}-${day}` };
}

export function formatBoardDate(value) {
  const parsed = ymd(value);
  if (!parsed) return '날짜 없음';
  return `${parsed.year}. ${parsed.month}. ${parsed.day}. (${KOREAN_WEEKDAYS[parsed.date.getDay()]})`;
}

export function normalizeTaskStatus(value) {
  const status = String(value || '').replace(/\s+/g, '');
  if (status === '진행' || status === '진행중') return '진행';
  if (status === '예정' || status === '대기' || !status) return '예정';
  if (status === '완료' || status === '종료') return '완료';
  return String(value || '').trim() || '예정';
}

export function summarizeTasks(tasks = []) {
  const summary = { total: tasks.length, planned: 0, progress: 0, done: 0 };
  for (const task of tasks) {
    const status = normalizeTaskStatus(task?.status);
    if (status === '예정') summary.planned += 1;
    if (status === '진행') summary.progress += 1;
    if (status === '완료') summary.done += 1;
  }
  return summary;
}

function newestFirst(left, right) {
  const byDate = String(right?.date || '').localeCompare(String(left?.date || ''));
  if (byDate) return byDate;
  return String(right?.updated_at || right?.created_at || '')
    .localeCompare(String(left?.updated_at || left?.created_at || ''));
}

export function filterTasks(tasks = [], filters = {}) {
  const query = String(filters.query || '').trim().toLocaleLowerCase('ko-KR');
  const status = String(filters.status || '전체');
  const assignee = String(filters.assignee || '전체');
  return tasks.filter((task) => {
    const normalizedStatus = normalizeTaskStatus(task?.status);
    if (status !== '전체' && normalizedStatus !== status) return false;
    if (assignee !== '전체' && String(task?.assignee || task?.who || '') !== assignee) return false;
    if (!query) return true;
    return [task?.date, task?.assignee, task?.who, task?.task, task?.memo, normalizedStatus]
      .some((value) => String(value || '').toLocaleLowerCase('ko-KR').includes(query));
  }).sort(newestFirst);
}

export function filterMinutes(minutes = [], queryValue = '') {
  const query = String(queryValue || '').trim().toLocaleLowerCase('ko-KR');
  return minutes.filter((minute) => {
    if (!query) return true;
    return [minute?.date, minute?.title, minute?.summary, minute?.attendees,
      minute?.directives, minute?.content]
      .some((value) => String(value || '').toLocaleLowerCase('ko-KR').includes(query));
  }).sort(newestFirst);
}

export function splitTextLines(value) {
  return String(value || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export function collaborationSourceLabel(item = {}) {
  if (item.manual_override) return 'OneBoard 수정';
  if (item.source_system === 'google_sheets') return '시트 연동';
  return 'OneBoard 입력';
}

function localYmd(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function monthCalendarDates(monthValue) {
  const source = monthValue instanceof Date ? monthValue : new Date(monthValue);
  if (Number.isNaN(source.getTime())) return [];
  const first = new Date(source.getFullYear(), source.getMonth(), 1);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return localYmd(date);
  });
}
