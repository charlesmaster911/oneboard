import { describe, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';

import { applyUiPolicy } from '../modules/dom.js';
import {
  filterManualDocuments,
  markdownBlocks,
  platformStatePresentation,
  renderPlatformStatusStrip,
} from '../modules/workspace.js';

describe('restored workspace sections', () => {
  test.each([
    ['owner', ['sales', 'team', 'minutes', 'kpi', 'manual', 'settings']],
    ['ops', ['sales', 'team', 'minutes', 'kpi', 'manual']],
    ['marketing', ['sales', 'team', 'kpi', 'manual']],
    ['member', ['sales', 'team', 'kpi', 'manual']],
    ['system', []],
  ])('%s receives only the approved restored navigation', (role, expected) => {
    document.body.innerHTML = ['sales', 'team', 'minutes', 'kpi', 'manual', 'settings']
      .map((section) => `<button data-section="${section}"></button>`)
      .join('');

    applyUiPolicy({ id: `${role}-1`, role });

    expect([...document.querySelectorAll('[data-section]')]
      .filter((element) => !element.hidden)
      .map((element) => element.dataset.section)).toEqual(expected);
  });

  test('manual search matches title, summary, category, and ignores case', () => {
    const documents = [
      { file: 'daily.md', title: '일일 체크리스트', summary: '출근 루틴', category: '팀 매뉴얼' },
      { file: 'abler.md', title: 'ABLR 사용법', summary: '세척', category: '제품 매뉴얼' },
    ];

    expect(filterManualDocuments(documents, '출근').map((item) => item.file)).toEqual(['daily.md']);
    expect(filterManualDocuments(documents, 'ablr').map((item) => item.file)).toEqual(['abler.md']);
    expect(filterManualDocuments(documents, '제품').map((item) => item.file)).toEqual(['abler.md']);
  });

  test('manual markdown parser emits inert structural blocks for hostile markup', () => {
    const blocks = markdownBlocks('# 제목\n\n- 항목\n<script>window.pwned=true</script>\n\n> 주의');

    expect(blocks).toEqual([
      { type: 'heading', level: 1, text: '제목' },
      { type: 'list-item', ordered: false, checked: null, text: '항목' },
      { type: 'paragraph', text: '<script>window.pwned=true</script>' },
      { type: 'quote', text: '주의' },
    ]);
    expect(window.pwned).toBeUndefined();
  });

  test.each([
    [{ connectionState: 'disconnected' }, { tone: 'warning', label: '연결정보 필요', action: '설정에서 연결정보를 입력하세요.' }],
    [{ connectionState: 'connected', syncState: 'error' }, { tone: 'danger', label: '수집 실패', action: '연결 권한과 토큰을 확인하세요.' }],
    [{ connectionState: 'connected', syncState: 'success', recordsSynced: 0 }, { tone: 'success', label: '정상 · 0건', action: '선택 기간에 발생한 데이터가 없습니다.' }],
    [{ connectionState: 'connected', syncState: 'success', recordsSynced: 4 }, { tone: 'success', label: '수집 완료', action: '실제 API 데이터 4건을 반영했습니다.' }],
    [{ connectionState: 'connected' }, { tone: 'neutral', label: '아직 미수집', action: '수동 갱신하거나 다음 자동 갱신을 기다리세요.' }],
  ])('platform state distinguishes unavailable data from actual zero', (state, expected) => {
    expect(platformStatePresentation(state)).toEqual(expected);
  });

  test('sales status strip renders channel states as safe actionable text', () => {
    const target = document.createElement('div');
    renderPlatformStatusStrip(target, [
      { id: 'cafe24', label: '카페24', connectionState: 'connected', syncState: 'success', recordsSynced: 0 },
      { id: 'meta', label: '<img onerror=alert(1)>', connectionState: 'connected', syncState: 'error' },
    ]);

    expect(target.textContent).toContain('카페24정상 · 0건');
    expect(target.textContent).toContain('<img onerror=alert(1)>수집 실패');
    expect(target.querySelector('img')).toBeNull();
    expect(target.querySelectorAll('.channel-state-pill')).toHaveLength(2);
  });
});

test('the authenticated shell contains the six restored working areas', async () => {
  const source = await readFile(`${process.cwd()}/index.html`, 'utf8');
  const page = new DOMParser().parseFromString(source, 'text/html');

  expect([...page.querySelectorAll('.section-btn')].map((button) => button.dataset.section))
    .toEqual(['sales', 'team', 'minutes', 'kpi', 'manual', 'settings']);
  expect(page.querySelector('#section-kpi #teamKpiTable')).not.toBeNull();
  expect(page.querySelector('#section-manual #manualSearch')).not.toBeNull();
  expect(page.querySelector('#section-manual #manualViewer')).not.toBeNull();
  expect(page.querySelector('#section-settings[data-roles="owner"] #platformSettingsGrid')).not.toBeNull();
  expect(page.querySelector('#manualViewer [aria-live]')).not.toBeNull();
});

test('Cafe24 OAuth can be started from the bearer-authenticated settings screen', async () => {
  const source = await readFile(`${process.cwd()}/app.js`, 'utf8');
  expect(source).toContain("apiFetch('/admin/oauth/cafe24/url')");
  expect(source).toMatch(/window\.location\.assign\(.*authorizationUrl/);
  expect(source).toContain('카페24 로그인 연결');
});
