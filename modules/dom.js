const CANONICAL_ROLES = new Set(['owner', 'ops', 'marketing', 'member', 'system']);
const SECTION_ROLES = Object.freeze({
  sales: new Set(['owner', 'ops', 'marketing', 'member']),
  team: new Set(['owner', 'ops', 'marketing', 'member']),
  minutes: new Set(['owner', 'ops']),
  kpi: new Set(['owner', 'ops', 'marketing', 'member']),
  manual: new Set(['owner', 'ops', 'marketing', 'member']),
  settings: new Set(['owner']),
});
const PROGRESS_FIELDS = new Set(['status', 'memo', 'comment']);

export function setText(element, value) {
  if (!element) return element;
  element.textContent = value == null ? '' : String(value);
  return element;
}

export function createElement(tagName, { className, text, attributes = {} } = {}) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text !== undefined) setText(element, text);
  for (const [name, value] of Object.entries(attributes)) {
    if (value != null) element.setAttribute(name, String(value));
  }
  return element;
}

export function replaceChildren(parent, ...children) {
  if (!parent) return parent;
  parent.replaceChildren(...children.filter(Boolean));
  return parent;
}

export function formatWon(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  return `₩${Math.round(amount).toLocaleString('ko-KR')}`;
}

export function formatDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function applyRoleVisibility(role, root = document) {
  const currentRole = CANONICAL_ROLES.has(role) ? role : null;
  root.querySelectorAll('[data-roles]').forEach((element) => {
    const allowedRoles = element.dataset.roles
      .split(',')
      .map((value) => value.trim())
      .filter((value) => CANONICAL_ROLES.has(value));
    element.hidden = !currentRole || !allowedRoles.includes(currentRole);
  });
}

export function applyUiPolicy(user, root = document) {
  const role = CANONICAL_ROLES.has(user?.role) ? user.role : null;
  root.querySelectorAll('[data-section]').forEach((element) => {
    const allowed = SECTION_ROLES[element.dataset.section];
    if (allowed) element.hidden = !role || !allowed.has(role);
  });
  applyRoleVisibility(role, root);
}

export function canMutateAssignedTask(user, task, fields = []) {
  if (!user || !CANONICAL_ROLES.has(user.role) || user.role === 'system') return false;
  if (user.role === 'owner' || user.role === 'ops') return true;
  const assignedUserId = task?.assignedUserId || task?.assigned_user_id;
  return String(assignedUserId || '') === String(user.id)
    && fields.length > 0
    && fields.every((field) => PROGRESS_FIELDS.has(field));
}

export function applyTaskMutationPolicy(user, task, root = document) {
  const managesWorkspace = user?.role === 'owner' || user?.role === 'ops';
  const mayProgress = canMutateAssignedTask(user, task, ['status']);
  root.querySelectorAll('[data-task-control]').forEach((element) => {
    element.hidden = element.dataset.taskControl === 'progress'
      ? !(managesWorkspace || mayProgress)
      : !managesWorkspace;
  });
}
