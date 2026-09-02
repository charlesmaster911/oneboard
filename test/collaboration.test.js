import { describe, expect, test } from 'vitest';

import {
  filterMinutes,
  filterTasks,
  formatBoardDate,
  monthCalendarDates,
  splitTextLines,
  summarizeTasks,
} from '../modules/collaboration.js';

describe('collaboration view helpers', () => {
  test('formats API dates as readable Korean calendar dates', () => {
    expect(formatBoardDate('2026-09-02T00:00:00.000Z')).toBe('2026. 09. 02. (수)');
    expect(formatBoardDate('invalid')).toBe('날짜 없음');
  });

  test('summarizes every task status without dropping unknown values from the total', () => {
    expect(summarizeTasks([
      { status: '예정' },
      { status: '진행' },
      { status: '진행중' },
      { status: '완료' },
      { status: '보류' },
    ])).toEqual({ total: 5, planned: 1, progress: 2, done: 1 });
  });

  test('filters tasks by query, status and assignee then sorts newest first', () => {
    const tasks = [
      { id: 'old', date: '2026-08-01', assignee: '운영팀', task: '광고 점검', status: '진행' },
      { id: 'new', date: '2026-09-02', assignee: '운영팀', task: '광고 보고', status: '진행중' },
      { id: 'done', date: '2026-09-03', assignee: '물류팀', task: '출고 확인', status: '완료' },
    ];

    expect(filterTasks(tasks, { query: '광고', status: '진행', assignee: '운영팀' })
      .map(({ id }) => id)).toEqual(['new', 'old']);
    expect(filterTasks(tasks, { query: '', status: '전체', assignee: '전체' })
      .map(({ id }) => id)).toEqual(['done', 'new', 'old']);
  });

  test('searches meeting title, summary, attendees and content in newest-first order', () => {
    const minutes = [
      { id: 'old', date: '2026-08-01', title: '월간 회의', summary: '재고', attendees: '운영팀' },
      { id: 'new', date: '2026-09-02', title: '주간 회의', summary: '광고 점검', attendees: '마케팅팀' },
      { id: 'content', date: '2026-09-01', title: '운영 회의', content: '광고 보고' },
    ];

    expect(filterMinutes(minutes, '광고').map(({ id }) => id)).toEqual(['new', 'content']);
  });

  test('turns multi-line text into non-empty trimmed display lines', () => {
    expect(splitTextLines('  첫 항목\n\n둘째 항목  \r\n')).toEqual(['첫 항목', '둘째 항목']);
  });

  test('builds the six-week Sunday-first range used by the original team calendar', () => {
    const dates = monthCalendarDates(new Date(2026, 8, 1));

    expect(dates).toHaveLength(42);
    expect(dates[0]).toBe('2026-08-30');
    expect(dates.at(-1)).toBe('2026-10-10');
  });
});
