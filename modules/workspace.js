export function filterManualDocuments(documents = [], query = '') {
  const needle = String(query || '').trim().toLocaleLowerCase('ko-KR');
  if (!needle) return [...documents];
  return documents.filter((document) => [
    document.title, document.summary, document.category, document.file,
  ].some((value) => String(value || '').toLocaleLowerCase('ko-KR').includes(needle)));
}

export function markdownBlocks(markdown = '') {
  const blocks = [];
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  let inCode = false;
  let code = [];

  const flushCode = () => {
    if (!code.length) return;
    blocks.push({ type: 'code', text: code.join('\n') });
    code = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (/^```/.test(line.trim())) {
      if (inCode) flushCode();
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      code.push(rawLine);
      continue;
    }
    if (!line.trim()) continue;
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      blocks.push({ type: 'divider' });
      continue;
    }
    const heading = line.match(/^\s*(#{1,4})\s+(.+)$/);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2].trim() });
      continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      blocks.push({ type: 'quote', text: quote[1].trim() });
      continue;
    }
    const checklist = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/);
    if (checklist) {
      blocks.push({ type: 'list-item', ordered: false, checked: checklist[1].toLowerCase() === 'x', text: checklist[2].trim() });
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
    if (bullet) {
      blocks.push({ type: 'list-item', ordered: false, checked: null, text: bullet[1].trim() });
      continue;
    }
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ordered) {
      blocks.push({ type: 'list-item', ordered: true, checked: null, text: ordered[1].trim() });
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      blocks.push({ type: 'table-row', text: line.trim() });
      continue;
    }
    blocks.push({ type: 'paragraph', text: line.trim() });
  }
  if (inCode) flushCode();
  return blocks;
}

export function platformStatePresentation(state = {}) {
  if (state.connectionState !== 'connected') {
    return { tone: 'warning', label: '연결정보 필요', action: '설정에서 연결정보를 입력하세요.' };
  }
  if (state.syncState === 'error' || state.syncState === 'failed') {
    return { tone: 'danger', label: '수집 실패', action: '연결 권한과 토큰을 확인하세요.' };
  }
  if (state.syncState === 'success') {
    const count = Number(state.recordsSynced || 0);
    return count === 0
      ? { tone: 'success', label: '정상 · 0건', action: '선택 기간에 발생한 데이터가 없습니다.' }
      : { tone: 'success', label: '수집 완료', action: `실제 API 데이터 ${count.toLocaleString('ko-KR')}건을 반영했습니다.` };
  }
  return { tone: 'neutral', label: '아직 미수집', action: '수동 갱신하거나 다음 자동 갱신을 기다리세요.' };
}

export function renderPlatformStatusStrip(target, states = []) {
  if (!target) return target;
  const fragment = document.createDocumentFragment();
  for (const state of states) {
    const presentation = platformStatePresentation(state);
    const pill = document.createElement('span');
    pill.className = `channel-state-pill tone-${presentation.tone}`;
    pill.title = presentation.action;
    const label = document.createElement('strong');
    label.textContent = state.label || state.id || '채널';
    const status = document.createElement('span');
    status.textContent = presentation.label;
    pill.append(label, status);
    fragment.appendChild(pill);
  }
  if (!states.length) {
    const empty = document.createElement('div');
    empty.className = 'channel-state-empty';
    empty.textContent = '연결된 판매·광고 채널 상태가 없습니다.';
    fragment.appendChild(empty);
  }
  target.replaceChildren(fragment);
  return target;
}
