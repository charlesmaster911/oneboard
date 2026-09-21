import { describe, expect, test } from 'vitest';
import {
  AD_PLATFORMS, SALES_PLATFORMS, buildPlatformMatrix, salesDatePreset, validateSalesDateRange,
} from '../modules/workspace.js';

describe('sales date ranges', () => {
  test('presets include both endpoints and stay on calendar dates across months and leap days', () => {
    expect(salesDatePreset('today', '2026-09-21')).toEqual({ from: '2026-09-21', to: '2026-09-21' });
    expect(salesDatePreset('yesterday', '2024-03-01')).toEqual({ from: '2024-02-29', to: '2024-02-29' });
    expect(salesDatePreset('7days', '2026-01-03')).toEqual({ from: '2025-12-28', to: '2026-01-03' });
    expect(salesDatePreset('30days', '2026-09-21')).toEqual({ from: '2026-08-23', to: '2026-09-21' });
    expect(salesDatePreset('month', '2024-02-29')).toEqual({ from: '2024-02-01', to: '2024-02-29' });
  });

  test('validation rejects nonexistent, malformed, reversed and future dates', () => {
    expect(validateSalesDateRange('2024-02-29', '2024-03-01', '2024-03-01')).toBe('');
    for (const date of ['2026-02-29', '2026-04-31', '2026-9-01', '2026-09-01T00:00:00Z', '', null]) {
      expect(validateSalesDateRange(date, '2026-09-21', '2026-09-21')).not.toBe('');
    }
    expect(validateSalesDateRange('2026-09-21', '2026-09-20', '2026-09-21')).toContain('시작일');
    expect(validateSalesDateRange('2026-09-21', '2026-09-22', '2026-09-21')).toContain('미래');
    expect(validateSalesDateRange('2026-09-21', '2026-09-21', 'invalid')).toContain('오늘');
    expect(() => salesDatePreset('today', '2026-02-29')).toThrow(RangeError);
    expect(() => salesDatePreset('unknown', '2026-09-21')).toThrow(RangeError);
  });

  test('maximum range is 366 calendar days inclusive', () => {
    expect(validateSalesDateRange('2024-01-01', '2024-12-31', '2026-09-21')).toBe('');
    expect(validateSalesDateRange('2024-01-01', '2025-01-01', '2026-09-21')).toContain('366');
    expect(validateSalesDateRange('2026-09-21', '2026-09-21', '2026-09-21')).toBe('');
  });
});

describe('platform sales matrices', () => {
  test('all dates appear latest first with separate missing and explicitly zero cells and period totals', () => {
    const matrix = buildPlatformMatrix([
      { date: '2026-09-19', platform: 'cafe24', total_sales: '10000' },
      { date: '2026-09-21', platform: 'naver_store', total_sales: 25000 },
      { date: '2026-09-21', platform: 'coupang', total_sales: 0 },
      { date: '2026-09-19', platform: 'naver_store', total_sales: 5000 },
      { date: '2026-09-21', platform: 'meta', total_sales: 999999 },
      { date: '2026-09-18', platform: 'cafe24', total_sales: 50000 },
    ], SALES_PLATFORMS, 'total_sales', { from: '2026-09-19', to: '2026-09-21' });
    expect(matrix.rows.map((row) => row.date)).toEqual(['2026-09-21', '2026-09-20', '2026-09-19']);
    expect(matrix.rows[0].values).toEqual({ cafe24: null, naver_store: 25000, coupang: 0, kakao_talk_store: null, kakao_gift: null });
    expect(matrix.rows[0].total).toBe(25000);
    expect(matrix.rows[1].total).toBeNull();
    expect(matrix.rows[2].total).toBe(15000);
    expect(matrix.totals).toEqual({ cafe24: 10000, naver_store: 30000, coupang: 0, kakao_talk_store: null, kakao_gift: null });
    expect(matrix.grandTotal).toBe(40000);
  });

  test('a missing period does not fabricate zero sales; actual zero remains zero', () => {
    const range = { from: '2026-09-21', to: '2026-09-21' };
    const missing = buildPlatformMatrix([], SALES_PLATFORMS, 'total_sales', range);
    expect(missing.rows).toHaveLength(1);
    expect(missing.rows[0].total).toBeNull();
    expect(missing.grandTotal).toBeNull();
    expect(Object.values(missing.totals).every((total) => total === null)).toBe(true);
    const zero = buildPlatformMatrix([{ date: range.from, platform: 'cafe24', total_sales: 0 }], SALES_PLATFORMS, 'total_sales', range);
    expect(zero.rows[0].total).toBe(0);
    expect(zero.grandTotal).toBe(0);
  });

  test('ad matrix selects spend only, aggregates provided values and supports legacy platform_raw', () => {
    const matrix = buildPlatformMatrix([
      { date: '2026-09-21', platform: 'meta', ad_spend: 1000, total_sales: 7000 },
      { date: '2026-09-21', platform: 'meta', ad_spend: 2000 },
      { date: '2026-09-21', platform_raw: 'naver_ads', ad_spend: '500' },
      { date: '2026-09-21', platform: 'kakao', ad_spend: null },
      { date: '2026-09-21', platform: 'cafe24', ad_spend: 9000 },
    ], AD_PLATFORMS, 'ad_spend', { from: '2026-09-21', to: '2026-09-21' });
    expect(matrix.rows[0].values).toEqual({ meta: 3000, naver_ads: 500, kakao: null });
    expect(matrix.grandTotal).toBe(3500);
  });

  test('invalid metric values and mismatched dates remain missing instead of corrupting totals', () => {
    const records = [null, {}, ...[null, undefined, '', '  ', true, {}, Infinity, NaN, 'unknown'].map((value) => ({
      date: '2026-09-21', platform: 'cafe24', total_sales: value,
    })), { date: '2026-9-21', platform: 'cafe24', total_sales: 100 }];
    const matrix = buildPlatformMatrix(records, SALES_PLATFORMS, 'total_sales', { from: '2026-09-21', to: '2026-09-21' });
    expect(matrix.grandTotal).toBeNull();
    expect(matrix.rows[0].values.cafe24).toBeNull();
  });

  test('leap days are included and invalid or oversized ranges cannot create excessive rows', () => {
    const matrix = buildPlatformMatrix([], SALES_PLATFORMS, 'total_sales', { from: '2024-02-28', to: '2024-03-01' });
    expect(matrix.rows.map((row) => row.date)).toEqual(['2024-03-01', '2024-02-29', '2024-02-28']);
    expect(() => buildPlatformMatrix([], SALES_PLATFORMS, 'total_sales', { from: '2026-02-29', to: '2026-03-01' })).toThrow(RangeError);
    expect(() => buildPlatformMatrix([], SALES_PLATFORMS, 'total_sales', { from: '2024-01-01', to: '2026-09-21' })).toThrow(RangeError);
  });
});
