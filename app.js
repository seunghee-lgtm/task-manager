/* ============================================================
   app.js - GitHub Pages용 클라이언트 로직
   ------------------------------------------------------------
   기존 Scripts.html(google.script.run 방식)과 화면 동작은 100% 동일합니다.
   바뀐 부분은 서버 호출 방식뿐입니다: google.script.run 대신 fetch()로
   Apps Script 웹앱(doPost)에 JSON을 보내고 JSON으로 응답받습니다.

   [중요] index.html에 있는 window.API_BASE_URL 값이 반드시 본인의
   Apps Script 배포 주소(.../exec)로 설정되어 있어야 합니다.
============================================================ */

const STATUS_LIST = ['해야 할 일', '진행 중', '검토할 일', '체크할 일', '보류', '완료'];
const PRIORITY_LIST = ['긴급', '높음', '보통', '낮음'];
const STATUS_CLASS = { '해야 할 일': 'todo', '진행 중': 'progress', '검토할 일': 'review', '체크할 일': 'check', '보류': 'hold', '완료': 'done' };

const STATUS_EN = { '해야 할 일': 'To Do', '진행 중': 'In Progress', '검토할 일': 'To Review', '체크할 일': 'To Check', '보류': 'On Hold', '완료': 'Completed' };
const PRIORITY_EN = { '긴급': 'Urgent', '높음': 'High', '보통': 'Normal', '낮음': 'Low' };
const ROLE_EN = { '관리자': 'Administrator', '일반': 'User' };

/* ============================================================
   (9단계 추가) 영어 UI 툴팁 사전
   ------------------------------------------------------------
   영어 UI 문구에 마우스를 올리면 한글 뜻을 툴팁으로 보여줍니다.
   업무 데이터(제목/메모 등 사용자가 직접 입력한 내용)는 대상이 아니며,
   시스템이 만드는 고정 문구에만 적용됩니다.
============================================================ */
const EN_TOOLTIPS_ = {
  'Dashboard': '대시보드', "Today's Tasks": '오늘의 업무', 'To Do': '할 일', 'In Progress': '진행 중',
  'To Review': '검토할 일', 'To Check': '체크할 일', 'On Hold': '보류', 'Completed': '완료',
  'Overdue': '기한 초과', 'All Tasks': '전체 업무', 'Calendar': '캘린더', 'Words': '단어',
  'Settings': '설정', 'Task': '업무', 'Tasks': '업무들',
  'Save': '저장', 'Delete': '삭제', 'Cancel': '취소', 'Edit': '수정', 'Add': '추가', 'Close': '닫기',
  'Apply': '적용', 'Log In': '로그인', 'Log Out': '로그아웃', 'New Task': '새 업무',
  'Status': '진행 상태', 'Priority': '우선순위', 'Category': '구분', 'Assignee': '담당자',
  'Title': '제목', 'Notes': '메모', 'Start Date': '시작일', 'Due Date': '마감일',
  'Urgent': '긴급', 'High': '높음', 'Normal': '보통', 'Low': '낮음',
  'Total Tasks': '전체 업무', 'Due Soon': '마감 임박', 'Completed Today': '오늘 완료',
  "Today's Priorities": '오늘의 우선순위', "Today's Word": '오늘의 문장', "This Hour's Word": '이번 시간의 문장', "Today's Progress": '오늘의 진행률'
};

/**
 * 영어 문구를 툴팁이 붙은 span으로 감싸서 반환합니다.
 * 사전에 없는 문구는 안전하게 그냥 이스케이프된 텍스트만 반환합니다(에러 없음).
 */
function tip(text) {
  const ko = EN_TOOLTIPS_[text];
  if (!ko) return esc(text);
  return `<span class="i18n-tip" data-tip="${esc(ko)}">${esc(text)}</span>`;
}

let SESSION_TOKEN = sessionStorage.getItem('tm_token') || '';
let CURRENT_VIEW = 'dashboard';
let CAL_STATE = { year: new Date().getFullYear(), month: new Date().getMonth() };
let TASK_PAGE = 1;
let CURRENT_USER_ID = '';
let CURRENT_ROLE = '';
let CURRENT_USER_NAME = '';
const REMEMBER_ID_KEY = 'tm_remembered_id';

function canModifyTaskClient_(task) {
  return CURRENT_ROLE === '관리자' || task.createdBy === CURRENT_USER_ID || task.assignee === CURRENT_USER_ID;
}

/* ============================================================
   API 호출 (fetch GET 방식, 11단계로 교체)
   ------------------------------------------------------------
   iframe+postMessage 방식이 구글 쪽에서 404로 막히는 것이 확인되어,
   이번엔 가장 단순한 fetch() GET 요청으로 다시 시도합니다. GET 요청은
   "단순 요청(simple request)"이라 사전 확인(OPTIONS)이 필요 없고,
   Google Apps Script가 GET 응답에는 cross-origin 읽기를 허용하는
   경우가 많다는 점을 이용합니다.
============================================================ */
function callApi_(action, params, token) {
  const url = window.API_BASE_URL
    + '?action=' + encodeURIComponent(action)
    + '&token=' + encodeURIComponent((token !== undefined ? token : SESSION_TOKEN) || '')
    + '&params=' + encodeURIComponent(JSON.stringify(params || {}));

  return fetch(url, { method: 'GET' }).then(res => {
    if (!res.ok) throw new Error('Network error (HTTP ' + res.status + ')');
    return res.json();
  });
}

function getErrorMessage_(err) {
  if (!err) return 'An unknown error occurred.';
  if (typeof err === 'string') return err;
  return err.message || 'An unknown error occurred.';
}

function logClientError_(action, msg) {
  console.error('[callServerSafe] ' + action + ': ' + msg);
}

/**
 * callApi_ 호출 + 공통 오류 처리를 한 번에 수행합니다. (기존 callServerSafe와 동일한 개념)
 */
async function callServerSafe(action, params, options) {
  options = options || {};
  try {
    return await callApi_(action, params);
  } catch (err) {
    const raw = getErrorMessage_(err);
    if (typeof raw === 'string' && raw.indexOf('로그인이 만료') > -1) {
      forceShowLogin_();
      return null;
    }
    const msg = options.formatMsg ? options.formatMsg(raw) : raw;
    logClientError_(action, raw);
    if (options.targetElId) {
      const el = document.getElementById(options.targetElId);
      if (el) el.innerHTML = '<p class="text-danger">' + esc(msg) + '</p>';
    } else if (!options.silent) {
      showToast(msg);
    }
    return null;
  }
}

function showToast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2500);
}

const IN_FLIGHT_ACTIONS_ = new Set();
async function withSubmitGuard_(key, fn) {
  if (IN_FLIGHT_ACTIONS_.has(key)) return;
  IN_FLIGHT_ACTIONS_.add(key);
  try {
    await fn();
  } finally {
    IN_FLIGHT_ACTIONS_.delete(key);
  }
}

/* ---------------- 초기화: 세션 확인 + Remember ID ---------------- */
window.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('loginBtn').addEventListener('click', doLogin);
  document.getElementById('loginPw').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  document.getElementById('hamburgerBtn').addEventListener('click', () => {
    document.getElementById('sidebar').classList.toggle('open');
  });
  document.getElementById('fabBtn').addEventListener('click', () => openTaskModal(null));

  const savedId = localStorage.getItem(REMEMBER_ID_KEY);
  if (savedId) {
    document.getElementById('loginId').value = savedId;
    const chk = document.getElementById('rememberIdChk');
    if (chk) chk.checked = true;
  }

  if (SESSION_TOKEN) {
    const res = await callServerSafe('checkSession', {}, { silent: true });
    if (res && res.valid) { enterApp(res.userId, res.role, res.name); return; }
  }
  // 구글 워크스페이스 자동 로그인은 크로스오리진 환경에서는 안정적으로 동작하지 않을 수 있습니다.
  // 실패하면 조용히 아이디/비밀번호 로그인 화면으로 넘어갑니다.
  const auto = await callServerSafe('tryGoogleAutoLogin', {}, { silent: true });
  if (auto && auto.success) {
    SESSION_TOKEN = auto.token;
    sessionStorage.setItem('tm_token', SESSION_TOKEN);
    enterApp(auto.userId, auto.role, auto.name);
    return;
  }
  showLogin();
  if (auto && auto.reason === 'NOT_REGISTERED') {
    document.getElementById('loginError').textContent = 'This Google account is not registered yet. Please ask an administrator to register it, or log in with your username and password.';
  } else if (auto && auto.reason === 'DISABLED') {
    document.getElementById('loginError').textContent = 'This account has been disabled. Please contact an administrator.';
  }
});

function showLogin() {
  document.getElementById('loginView').classList.remove('hidden');
  document.getElementById('appView').classList.add('hidden');
}

function forceShowLogin_() {
  sessionStorage.removeItem('tm_token');
  SESSION_TOKEN = '';
  CURRENT_USER_ID = ''; CURRENT_ROLE = ''; CURRENT_USER_NAME = '';
  stopTodayLabelTimer_();
  stopHourlyWordTimer_();
  const dash = document.getElementById('view-dashboard');
  if (dash) dash.innerHTML = '';
  document.querySelectorAll('.view-panel').forEach(el => { el.innerHTML = ''; });
  closeTaskModal();
  closeDayModal();
  showLogin();
}

async function revalidateSession_() {
  if (!SESSION_TOKEN) { forceShowLogin_(); return; }
  const res = await callServerSafe('checkSession', {}, { silent: true });
  if (!res || !res.valid) forceShowLogin_();
}

window.addEventListener('pageshow', (event) => {
  if (event.persisted) revalidateSession_();
});

document.addEventListener('visibilitychange', () => {
  const appView = document.getElementById('appView');
  if (document.visibilityState === 'visible' && appView && !appView.classList.contains('hidden')) {
    revalidateSession_();
  }
});

async function doLogin() {
  await withSubmitGuard_('doLogin', async () => {
    const id = document.getElementById('loginId').value.trim();
    const pw = document.getElementById('loginPw').value;
    const errEl = document.getElementById('loginError');
    errEl.textContent = '';
    const res = await callServerSafe('login', { userId: id, password: pw }, { silent: true });
    if (!res) { errEl.textContent = 'An error occurred while logging in.'; return; }
    if (res.success) {
      const rememberChk = document.getElementById('rememberIdChk');
      if (rememberChk && rememberChk.checked) localStorage.setItem(REMEMBER_ID_KEY, id);
      else localStorage.removeItem(REMEMBER_ID_KEY);

      SESSION_TOKEN = res.token;
      sessionStorage.setItem('tm_token', SESSION_TOKEN);
      enterApp(res.userId, res.role, res.name);
    } else {
      errEl.textContent = res.message || 'Login failed.';
    }
  });
}

async function doLogout() {
  await callServerSafe('logout', {}, { silent: true });
  sessionStorage.removeItem('tm_token');
  SESSION_TOKEN = '';
  location.reload();
}

function enterApp(userId, role, name) {
  CURRENT_USER_ID = userId;
  CURRENT_ROLE = role || '';
  CURRENT_USER_NAME = name || userId;
  document.getElementById('loginView').classList.add('hidden');
  document.getElementById('appView').classList.remove('hidden');
  document.getElementById('userLabel').textContent = CURRENT_USER_NAME + (CURRENT_ROLE ? ' · ' + (ROLE_EN[CURRENT_ROLE] || CURRENT_ROLE) : '');
  bindNav();
  navigateTo('dashboard');
}

/* ---------------- 내비게이션 ---------------- */
function bindNav() {
  document.querySelectorAll('.nav-item').forEach(el => {
    el.addEventListener('click', () => {
      document.getElementById('sidebar').classList.remove('open');
      navigateTo(el.dataset.view);
    });
  });
}

function navigateTo(view, params) {
  CURRENT_VIEW = view;
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.view === view));
  document.querySelectorAll('.view-panel').forEach(el => el.classList.add('hidden'));
  const panel = document.getElementById('view-' + view);
  if (panel) panel.classList.remove('hidden');
  document.getElementById('fabBtn').style.display = (view === 'dashboard' || view === 'words') ? 'none' : 'flex';

  if (view !== 'dashboard') { stopTodayLabelTimer_(); stopHourlyWordTimer_(); }

  if (view === 'dashboard') loadDashboard();
  else if (view === 'calendar') loadCalendar();
  else if (view === 'settings') loadSettings();
  else if (view === 'words') loadWordsView();
  else loadTaskListView(view, params);
}

/* ============================================================
   대시보드
============================================================ */
async function loadDashboard() {
  const el = document.getElementById('view-dashboard');
  el.innerHTML = '<p class="text-muted">Loading...</p>';
  const d = await callServerSafe('getDashboardData', {}, {
    targetElId: 'view-dashboard',
    formatMsg: msg => 'Failed to load dashboard: ' + msg
  });
  if (!d) return;
  LAST_DASHBOARD_TASKS = { priority: d.todaysPriority, review: d.reviewTasks, check: d.checkTasks };
  el.innerHTML = renderDashboard(d);
  startTodayLabelTimer_();
  loadDailyEnglishWords();
  startHourlyWordTimer_();
}

let LAST_DASHBOARD_TASKS = { priority: [], review: [], check: [] };
const QUICK_SECTION_VIEW = { priority: 'today', review: 'review', check: 'check' };
const QUICK_SECTION_STATUS = { review: '검토할 일', check: '체크할 일' };

function todaySeoulLabel_() {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  return fmt.format(new Date());
}

let TODAY_LABEL_TIMER_ = null;
function startTodayLabelTimer_() {
  stopTodayLabelTimer_();
  TODAY_LABEL_TIMER_ = setInterval(() => {
    const el = document.getElementById('todayDateLabel');
    if (!el) { stopTodayLabelTimer_(); return; }
    const label = 'Today: ' + todaySeoulLabel_();
    if (el.textContent !== label) el.textContent = label;
  }, 60000);
}
function stopTodayLabelTimer_() {
  if (TODAY_LABEL_TIMER_) { clearInterval(TODAY_LABEL_TIMER_); TODAY_LABEL_TIMER_ = null; }
}

/**
 * (GPT 제안 기능을 기존 구조에 맞게 통합) 대시보드를 계속 보고 있으면
 * 1시간마다 "This Hour's Word" 카드를 자동으로 새로고침합니다.
 * 대시보드를 벗어나면(navigateTo, 로그아웃) 자동으로 멈춥니다.
 */
let HOURLY_WORD_TIMER_ = null;
function startHourlyWordTimer_() {
  stopHourlyWordTimer_();
  HOURLY_WORD_TIMER_ = setInterval(() => {
    const box = document.getElementById('englishWordsBox');
    if (!box) { stopHourlyWordTimer_(); return; }
    loadDailyEnglishWords();
  }, 60 * 60 * 1000);
}
function stopHourlyWordTimer_() {
  if (HOURLY_WORD_TIMER_) { clearInterval(HOURLY_WORD_TIMER_); HOURLY_WORD_TIMER_ = null; }
}

function renderDashboard(d) {
  const statCard = (label, num, view) => `
    <div class="card" style="cursor:pointer" onclick="navigateTo('${view}')">
      <div class="stat-num">${num}</div><div class="stat-label">${tip(label)}</div>
    </div>`;

  const listBlock = (title, tasks, view) => `
    <div class="card" style="margin-top:16px;">
      <h3 style="cursor:pointer" onclick="navigateTo('${view}')">${title} <span class="text-muted-sm" style="font-weight:400;">(${tasks.length})</span></h3>
      ${tasks.length ? renderTaskList(tasks.slice(0, 6)) : '<p class="text-muted-sm">No tasks.</p>'}
    </div>`;

  const quickSection = (key, title, tasks) => `
    <div class="card" style="margin-top:16px;">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
        <h3 style="cursor:pointer;margin:0;" onclick="navigateTo('${QUICK_SECTION_VIEW[key]}')">${title} <span class="text-muted-sm" style="font-weight:400;">(${tasks.length})</span></h3>
        <button class="btn btn-sm" onclick="event.stopPropagation();toggleQuickAdd('${key}')">+ Add Task</button>
      </div>
      <div id="quickadd-${key}" class="quick-add-box hidden">
        <div class="form-row">
          <input id="qa-title-${key}" placeholder="Task title">
          <input id="qa-due-${key}" type="date">
          <input id="qa-assignee-${key}" placeholder="Assignee">
        </div>
        <div style="margin-top:8px;text-align:right;">
          <button class="btn btn-sm" onclick="toggleQuickAdd('${key}')">${tip('Cancel')}</button>
          <button class="btn btn-sm btn-sage" onclick="submitQuickAdd('${key}')">${tip('Add')}</button>
        </div>
      </div>
      ${tasks.length ? renderQuickTaskList_(tasks, key) : '<p class="text-muted-sm">No tasks.</p>'}
    </div>`;

  const calEvents = (d.todaysCalendar.personal || []).concat(d.todaysCalendar.shared || []);

  return `
    <div class="dashboard-top-row">
      <div>
        <h2>Dashboard</h2>
        <p class="today-date" id="todayDateLabel">Today: ${todaySeoulLabel_()}</p>
      </div>
      <div class="card eng-words-card" id="englishWordsCard">
        <h3>📖 This Hour's Word</h3>
        <div id="englishWordsBox"><p class="text-muted">Loading...</p></div>
      </div>
    </div>
    <div class="grid grid-4">
      ${statCard('Total Tasks', d.totalCount, 'all')}
      ${statCard('Due Soon', d.dueSoon.length, 'all')}
      ${statCard('Overdue', d.overdue.length, 'overdue')}
      ${statCard('Completed Today', d.completedToday.length, 'done')}
    </div>
    <div class="grid grid-2" style="margin-top:16px;">
      <div class="card">
        <h3>Overall Progress</h3>
        <div class="progress-bar"><div class="progress-bar-fill" style="width:${d.progressRate}%"></div></div>
        <p style="font-size:12px;color:var(--text-muted);margin-top:6px;">${d.progressRate}% complete · This week: ${d.weekCompletionRate}%</p>
      </div>
      <div class="card">
        <h3>Today's Calendar Events</h3>
        ${calEvents.length ? calEvents.map(e => `<div class="cal-evt ${e.calendarType}" style="display:block;margin-bottom:4px;">${esc(e.title)} (${e.start.substring(11)})</div>`).join('') : '<p class="text-muted-sm">No events today.</p>'}
      </div>
    </div>
    ${quickSection('priority', "⭐ Today's Priorities", d.todaysPriority)}
    ${d.holdRecheckDue.length ? listBlock('🔔 Hold - Recheck Needed', d.holdRecheckDue, 'hold') : ''}
    <div class="grid grid-2" style="margin-top:16px;">
      ${quickSection('review', '🟣 To Review', d.reviewTasks)}
      ${quickSection('check', '🟡 To Check', d.checkTasks)}
    </div>
    ${d.recentCompleted.length ? `
    <div class="card" style="margin-top:16px;">
      <h3>✅ Recently Completed <span class="text-muted-sm" style="font-weight:400;">(shown separately from incomplete tasks)</span></h3>
      ${renderTaskList(d.recentCompleted)}
    </div>` : ''}
  `;
}

function renderQuickTaskList_(tasks, sectionKey) {
  return '<div class="task-list">' + tasks.map((t, idx) => {
    const cls = STATUS_CLASS[t.status] || 'todo';
    const overdue = t.dueDate && t.dueDate < todayStr() && t.status !== '완료';
    const canEdit = canModifyTaskClient_(t);
    return `
      <div class="task-row">
        <span class="badge badge-${cls}">${tip(STATUS_EN[t.status] || t.status)}</span>
        ${t.priority === '긴급' ? `<span class="badge badge-urgent">${tip(PRIORITY_EN['긴급'])}</span>` : ''}
        <span class="title" onclick="openTaskModal('${t.id}')">${esc(t.title)}</span>
        <span class="meta">${esc(t.assignee || '-')}</span>
        <span class="meta ${overdue ? 'badge badge-overdue' : ''}">${t.dueDate ? 'Due ' + t.dueDate : ''}</span>
        ${canEdit ? `
          <button class="icon-btn" title="Move up" onclick="event.stopPropagation();moveQuickTask('${sectionKey}','${t.id}',-1)" ${idx===0?'disabled':''}>▲</button>
          <button class="icon-btn" title="Move down" onclick="event.stopPropagation();moveQuickTask('${sectionKey}','${t.id}',1)" ${idx===tasks.length-1?'disabled':''}>▼</button>
          <button class="icon-btn" title="Complete" onclick="event.stopPropagation();quickComplete('${t.id}')">✓</button>
          <button class="icon-btn" title="Delete" onclick="event.stopPropagation();quickDelete('${t.id}')">✕</button>
        ` : ''}
      </div>`;
  }).join('') + '</div>';
}

function toggleQuickAdd(key) {
  const el = document.getElementById('quickadd-' + key);
  if (!el) return;
  el.classList.toggle('hidden');
  if (!el.classList.contains('hidden')) {
    const t = document.getElementById('qa-title-' + key);
    if (t) t.focus();
  }
}

async function submitQuickAdd(key) {
  await withSubmitGuard_('submitQuickAdd-' + key, async () => {
    const titleEl = document.getElementById('qa-title-' + key);
    const dueEl = document.getElementById('qa-due-' + key);
    const assigneeEl = document.getElementById('qa-assignee-' + key);
    const title = titleEl.value.trim();
    if (!title) { showToast('Please enter a task title.'); return; }

    const data = {
      title: title, detail: '', category: '', assignee: assigneeEl.value.trim(),
      status: QUICK_SECTION_STATUS[key] || '해야 할 일',
      priority: key === 'priority' ? '높음' : '보통',
      startDate: '', dueDate: dueEl.value || (key === 'priority' ? todayStr() : '')
    };
    const res = await callServerSafe('createTask', { data: data }, { formatMsg: msg => 'Error: ' + msg });
    if (!res) return;
    if (res.success) {
      showToast('Task added.');
      titleEl.value = ''; dueEl.value = ''; assigneeEl.value = '';
      toggleQuickAdd(key);
      loadDashboard();
    } else {
      showToast(res.message || 'Failed to add task.');
    }
  });
}

function taskToUpdatePayload_(task, overrides) {
  return Object.assign({
    title: task.title, detail: task.detail, category: task.category, assignee: task.assignee,
    status: task.status, priority: task.priority, startDate: task.startDate, dueDate: task.dueDate,
    sortOrder: task.sortOrder, holdReason: task.holdReason
  }, overrides);
}

function findInDashboardCache_(taskId) {
  for (const key in LAST_DASHBOARD_TASKS) {
    const found = (LAST_DASHBOARD_TASKS[key] || []).find(t => t.id === taskId);
    if (found) return found;
  }
  return null;
}

async function moveQuickTask(sectionKey, taskId, dir) {
  const list = LAST_DASHBOARD_TASKS[sectionKey] || [];
  const idx = list.findIndex(t => t.id === taskId);
  const swapIdx = idx + dir;
  if (idx < 0 || swapIdx < 0 || swapIdx >= list.length) return;
  const a = list[idx], b = list[swapIdx];
  const aOrder = a.sortOrder || 999, bOrder = b.sortOrder || 999;
  const r1 = await callServerSafe('updateTask', { taskId: a.id, data: taskToUpdatePayload_(a, { sortOrder: bOrder }) }, { formatMsg: msg => 'Error reordering: ' + msg });
  if (!r1) return;
  const r2 = await callServerSafe('updateTask', { taskId: b.id, data: taskToUpdatePayload_(b, { sortOrder: aOrder }) }, { formatMsg: msg => 'Error reordering: ' + msg });
  if (!r2) return;
  loadDashboard();
}

async function quickComplete(taskId) {
  const task = findInDashboardCache_(taskId);
  if (!task) { showToast('Reloading task data, please try again.'); loadDashboard(); return; }
  const res = await callServerSafe('updateTask', { taskId: taskId, data: taskToUpdatePayload_(task, { status: '완료' }) }, { formatMsg: msg => 'Error completing task: ' + msg });
  if (!res) return;
  if (res.success) { showToast('Marked as complete.'); loadDashboard(); }
  else showToast(res.message || 'Failed to update.');
}

async function quickDelete(taskId) {
  if (!confirm('Delete this task?')) return;
  const delCal = confirm('Also delete the linked calendar event?');
  const res = await callServerSafe('deleteTask', { taskId: taskId, deleteCalendarEvent: delCal }, { formatMsg: msg => 'Error: ' + msg });
  if (!res) return;
  if (res.success) { showToast('Deleted.'); loadDashboard(); }
  else showToast(res.message || 'Failed to delete.');
}

/* ============================================================
   Today's Word + Words 탭
============================================================ */
function jsStr_(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function loadDailyEnglishWords() {
  const box = document.getElementById('englishWordsBox');
  if (!box) return;
  box.innerHTML = '<p class="text-muted">Loading...</p>';
  const data = await callServerSafe('getHourlyWords', {}, {
    targetElId: 'englishWordsBox',
    formatMsg: msg => 'Failed to load word: ' + msg
  });
  if (!data) return;
  box.innerHTML = renderTodaysWord_(data);
  if (data.changesEveryHour) {
    const info = document.createElement('p');
    info.className = 'text-muted-sm';
    info.style.marginTop = '6px';
    info.textContent = 'Changes every hour';
    box.appendChild(info);
  }
}

let LAST_TODAYS_WORD_ = null; // 클릭 시 상세(단어별 직역/자연스러운 해석) 펼치기용 캐시

function renderTodaysWord_(data) {
  if (!data.word) {
    return `
      <p class="text-muted-sm">No sentences yet. Add your first sentence to get started!</p>
      <button class="btn btn-sm btn-sage" onclick="navigateTo('words')">+ Add a Sentence</button>
    `;
  }
  LAST_TODAYS_WORD_ = data;
  const w = data.word;
  const keyWordsHtml = (w.keyWords || []).map(kw => `
    <span class="key-word-chip">
      <span onclick="event.stopPropagation();">${esc(kw.word)}${kw.meaning ? ' (' + esc(kw.meaning) + ')' : ''}</span>
      <button class="star-btn" title="Save to My Words" onclick="event.stopPropagation();quickSaveWord('${jsStr_(kw.word)}','${jsStr_(kw.meaning||'')}','${jsStr_(w.word)}')">★</button>
    </span>`).join('');

  return `
    <p class="text-muted-sm">Sentence ${data.index} of ${data.totalWords}</p>
    <div class="eng-word-item">
      <div class="eng-word-head">
        <input type="checkbox" ${data.completed ? 'checked' : ''} onclick="event.stopPropagation();" onchange="toggleWordMemorized('${data.date}','${jsStr_(w.id)}',this.checked)">
        <b style="font-size:16px;cursor:pointer;" onclick="toggleTodaysWordDetail_()">${esc(w.word)}</b>
      </div>
      <div class="text-muted-sm">${esc(w.meaning || '(no translation)')}</div>
      ${keyWordsHtml ? `<p class="text-muted-sm" style="margin:8px 0 2px;">Key words (tap ★ to save):</p><div class="key-word-list">${keyWordsHtml}</div>` : ''}
      <div id="todaysWordDetail" class="word-detail-box hidden"></div>
    </div>
    ${data.completed ? '<p style="color:var(--sage);font-weight:700;">🎉 You studied this hour&#39;s sentence!</p>' : ''}
    <div style="margin-top:8px;text-align:right;">
      <button class="btn btn-sm" onclick="toggleTodaysWordDetail_()">Details</button>
      <button class="btn btn-sm" onclick="navigateTo('words')">Manage Words</button>
    </div>
  `;
}

/**
 * 문장을 클릭하면 펼쳐지는 상세 영역: 단어별 직역 + 자연스러운 해석.
 * (문법 설명은 자동 생성하지 않습니다 - 답변 상단 설계 설명 참고)
 */
function toggleTodaysWordDetail_() {
  const el = document.getElementById('todaysWordDetail');
  if (!el || !LAST_TODAYS_WORD_) return;
  const hidden = el.classList.contains('hidden');
  if (hidden) {
    el.innerHTML = renderTodaysWordDetail_(LAST_TODAYS_WORD_.word);
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

function renderTodaysWordDetail_(w) {
  const wordByWord = (w.wordByWord || [])
    .map(x => esc(x.word) + (x.meaning ? '(' + esc(x.meaning) + ')' : ''))
    .join(' ');
  return `
    <p class="text-muted-sm"><b>Word-by-word:</b><br>${wordByWord || '-'}</p>
    <p class="text-muted-sm"><b>Natural translation:</b><br>${esc(w.meaning || '-')}</p>
  `;
}

/** 문장 안의 핵심 단어를 개인 복습장(★ My Words)에 저장합니다. */
async function quickSaveWord(word, meaning, sourceSentence) {
  const pron = prompt('(Optional) Type a Korean pronunciation hint for "' + word + '":', '');
  const res = await callServerSafe('saveWordToVocabulary', {
    word: word, meaning: meaning, pronunciation: pron || '', sourceSentence: sourceSentence
  }, { formatMsg: msg => 'Error saving word: ' + msg });
  if (!res) return;
  if (res.success) showToast('Saved to My Words.');
  else showToast(res.message || 'Failed to save.');
}

async function toggleWordMemorized(dateStr, wordId, checked) {
  const res = await callServerSafe('setWordMemorized', { dateStr: dateStr, wordId: wordId, completed: checked }, { formatMsg: msg => 'Error saving: ' + msg });
  if (!res) return;
  if (res.success) loadDailyEnglishWords();
  else showToast(res.message || 'Failed to save.');
}

let LAST_WORDS_LIST_ = [];
let LAST_SAVED_WORDS_ = [];

async function loadWordsView() {
  const el = document.getElementById('view-words');
  el.innerHTML = '<h2>📖 Words</h2><p class="text-muted">Loading...</p>';
  const list = await callServerSafe('listMyWords', {}, {
    targetElId: 'view-words',
    formatMsg: msg => 'Failed to load sentences: ' + msg
  });
  if (!list) return;
  LAST_WORDS_LIST_ = list;

  const saved = await callServerSafe('listSavedWords', {}, {
    targetElId: 'view-words',
    formatMsg: msg => 'Failed to load saved words: ' + msg
  });
  if (!saved) return;
  LAST_SAVED_WORDS_ = saved;

  el.innerHTML = renderWordsView_(list, saved);
}

function renderWordsView_(list, saved) {
  const rows = list.slice().reverse().map(w => `
    <tr>
      <td>${esc(w.word)}</td>
      <td>${esc(w.meaning || '-')}</td>
      <td>${esc(w.example || '-')}</td>
      <td>${esc(w.exampleMeaning || '-')}</td>
      <td>
        <button class="btn btn-sm" onclick="openEditWordModal('${jsStr_(w.id)}')">${tip('Edit')}</button>
        <button class="btn btn-sm btn-danger" onclick="doDeleteMyWord('${jsStr_(w.id)}')">${tip('Delete')}</button>
      </td>
    </tr>`).join('');

  const savedRows = saved.slice().reverse().map(w => `
    <tr>
      <td>${esc(w.word)}</td>
      <td>${esc(w.meaning || '-')}</td>
      <td>${esc(w.pronunciation || '-')}</td>
      <td>${esc(w.sourceSentence || '-')}</td>
      <td><input type="checkbox" ${w.completed ? 'checked' : ''} onchange="toggleSavedWordMemorized('${jsStr_(w.id)}',this.checked)"></td>
      <td><button class="btn btn-sm btn-danger" onclick="doDeleteSavedWord('${jsStr_(w.id)}')">${tip('Delete')}</button></td>
    </tr>`).join('');

  return `
    <h2>📖 Words</h2>
    <p class="text-muted-sm">Add your own English sentences below. The Korean meaning is translated automatically. The dashboard shows one sentence per day from this list.</p>
    <p class="text-muted-sm">Tip: You can also type a sentence directly into the "EnglishWords" tab of the Google Sheet (just the Word column) — it will be auto-translated and added here automatically.</p>
    <div class="card" style="margin-bottom:16px;">
      <h3>+ Add a Sentence</h3>
      <div class="form-row">
        <input id="nw-word" placeholder="English sentence (e.g. They were busy yesterday.)">
        <input id="nw-example" placeholder="Optional note">
      </div>
      <div style="margin-top:8px;text-align:right;">
        <button class="btn btn-sage" id="addWordBtn" onclick="submitAddWord()">${tip('Add')}</button>
      </div>
    </div>
    <div class="card" style="margin-bottom:16px;">
      <h3>My Sentences <span class="text-muted-sm" style="font-weight:400;">(${list.length})</span></h3>
      <table class="data-table">
        <thead><tr><th>Sentence</th><th>Meaning</th><th>Note</th><th>Note Translation</th><th>Actions</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" class="text-muted-sm">No sentences yet. Add your first sentence above.</td></tr>'}</tbody>
      </table>
    </div>
    <div class="card">
      <h3>⭐ My Words <span class="text-muted-sm" style="font-weight:400;">(${saved.length})</span></h3>
      <p class="text-muted-sm">Words you starred from This Hour's Word. Check off the ones you've memorized.</p>
      <table class="data-table">
        <thead><tr><th>Word</th><th>Meaning</th><th>Pronunciation</th><th>From Sentence</th><th>${tip('Completed')}</th><th>Actions</th></tr></thead>
        <tbody>${savedRows || '<tr><td colspan="6" class="text-muted-sm">No saved words yet. Tap the ★ next to a key word in Today\'s Word.</td></tr>'}</tbody>
      </table>
    </div>
  `;
}

async function toggleSavedWordMemorized(id, checked) {
  const res = await callServerSafe('setSavedWordMemorized', { id: id, completed: checked }, { formatMsg: msg => 'Error: ' + msg });
  if (!res) return;
  if (!res.success) showToast(res.message || 'Failed to update.');
}

async function doDeleteSavedWord(id) {
  if (!confirm('Delete this saved word?')) return;
  const res = await callServerSafe('deleteSavedWord', { id: id }, { formatMsg: msg => 'Error: ' + msg });
  if (!res) return;
  if (res.success) { showToast('Deleted.'); loadWordsView(); }
  else showToast(res.message || 'Failed to delete.');
}

async function submitAddWord() {
  await withSubmitGuard_('submitAddWord', async () => {
    const wordEl = document.getElementById('nw-word');
    const exEl = document.getElementById('nw-example');
    const word = wordEl.value.trim();
    const example = exEl.value.trim();
    if (!word) { showToast('Please enter an English word or sentence.'); return; }
    const btn = document.getElementById('addWordBtn');
    if (btn) btn.disabled = true;
    const res = await callServerSafe('addMyWord', { word: word, example: example }, { formatMsg: msg => 'Error: ' + msg });
    if (btn) btn.disabled = false;
    if (!res) return;
    if (res.success) {
      showToast(res.translateWarning ? 'Word added, but automatic translation failed — please edit the meaning manually.' : 'Word added.');
      wordEl.value = ''; exEl.value = '';
      loadWordsView();
    } else {
      showToast(res.message || 'Failed to add word.');
    }
  });
}

function openEditWordModal(id) {
  const w = LAST_WORDS_LIST_.find(x => x.id === id);
  if (!w) { showToast('Word not found. Refreshing list.'); loadWordsView(); return; }
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'wordEditOverlay';
  overlay.innerHTML = `
    <div class="modal">
      <h2>Edit Word</h2>
      <div class="form-group"><label>Word</label><input id="ew-word" value="${esc(w.word)}"></div>
      <div class="form-group"><label>Meaning</label><input id="ew-meaning" value="${esc(w.meaning||'')}"></div>
      <div class="form-group"><label>Example</label><input id="ew-example" value="${esc(w.example||'')}"></div>
      <div class="form-group"><label>Translation</label><input id="ew-exmeaning" value="${esc(w.exampleMeaning||'')}"></div>
      <div class="modal-actions">
        <button class="btn" onclick="closeWordEditModal_()">${tip('Cancel')}</button>
        <button class="btn btn-sage" onclick="saveWordEdit('${jsStr_(id)}')">${tip('Save')}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}
function closeWordEditModal_() {
  const el = document.getElementById('wordEditOverlay');
  if (el) el.remove();
}

async function saveWordEdit(id) {
  const word = document.getElementById('ew-word').value.trim();
  const meaning = document.getElementById('ew-meaning').value.trim();
  const example = document.getElementById('ew-example').value.trim();
  const exampleMeaning = document.getElementById('ew-exmeaning').value.trim();
  if (!word) { showToast('Please enter a word.'); return; }
  const res = await callServerSafe('updateMyWord', { wordId: id, word: word, meaning: meaning, example: example, exampleMeaning: exampleMeaning }, { formatMsg: msg => 'Error: ' + msg });
  if (!res) return;
  if (res.success) { showToast('Word updated.'); closeWordEditModal_(); loadWordsView(); }
  else showToast(res.message || 'Failed to update.');
}

async function doDeleteMyWord(id) {
  if (!confirm('Delete this word?')) return;
  const res = await callServerSafe('deleteMyWord', { wordId: id }, { formatMsg: msg => 'Error: ' + msg });
  if (!res) return;
  if (res.success) { showToast('Deleted.'); loadWordsView(); }
  else showToast(res.message || 'Failed to delete.');
}

/* ============================================================
   업무 목록 (분류 화면 공통)
============================================================ */
const VIEW_STATUS_MAP = {
  todo: '해야 할 일', progress: '진행 중', review: '검토할 일', check: '체크할 일', hold: '보류', done: '완료'
};

let searchDebounceTimer = null;

async function loadTaskListView(view, params) {
  const el = document.getElementById('view-' + view);
  if (!el) return;
  TASK_PAGE = 1;
  el.innerHTML = buildTaskListShell(view);
  document.getElementById('search-' + view).addEventListener('input', () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => refreshTaskList(view), 350);
  });
  refreshTaskList(view);
}

function buildTaskListShell(view) {
  const title = { all: 'All Tasks', today: "Today's Tasks", todo: 'To Do', progress: 'In Progress',
    review: 'To Review', check: 'To Check', hold: 'On Hold', done: 'Completed', overdue: 'Overdue' }[view] || view;
  return `
    <h2>${title}</h2>
    <div class="filter-bar">
      <input type="search" id="search-${view}" placeholder="Search tasks...">
      <select id="assignee-${view}"><option value="">All Assignees</option></select>
      <select id="priority-${view}"><option value="">All Priorities</option>${PRIORITY_LIST.map(p => `<option value="${p}">${PRIORITY_EN[p]}</option>`).join('')}</select>
      <select id="sort-${view}">
        <option value="dueDate">Due Date</option>
        <option value="priority">Priority</option>
        <option value="createdDate">Created Date</option>
      </select>
      <button class="btn" onclick="refreshTaskList('${view}')">${tip('Apply')}</button>
    </div>
    <div id="list-${view}" class="task-list"></div>
    <div id="pager-${view}" style="margin-top:14px;text-align:center;color:var(--text-muted);font-size:12px;"></div>
  `;
}

async function refreshTaskList(view) {
  const filters = {
    keyword: document.getElementById('search-' + view).value,
    assignee: document.getElementById('assignee-' + view).value,
    priority: document.getElementById('priority-' + view).value,
    sortBy: document.getElementById('sort-' + view).value,
    page: TASK_PAGE, pageSize: 20
  };
  if (VIEW_STATUS_MAP[view]) filters.status = VIEW_STATUS_MAP[view];
  if (view === 'overdue') filters.category = 'overdue';
  if (view === 'today') filters.category = 'today';

  const listEl = document.getElementById('list-' + view);
  listEl.innerHTML = '<p class="text-muted">Loading...</p>';
  const res = await callServerSafe('getTasks', { filters: filters }, { targetElId: 'list-' + view });
  if (!res) return;
  listEl.innerHTML = res.tasks.length ? renderTaskList(res.tasks, view) : '<p class="text-muted">No tasks found.</p>';
  const totalPages = Math.max(1, Math.ceil(res.total / res.pageSize));
  document.getElementById('pager-' + view).innerHTML =
    `Showing ${(res.page-1)*res.pageSize+1}-${Math.min(res.page*res.pageSize, res.total)} of ${res.total}` +
    (totalPages > 1 ? ` &nbsp; <button class="btn btn-sm" onclick="changePage('${view}',-1)" ${res.page<=1?'disabled':''}>Prev</button> ${res.page}/${totalPages} <button class="btn btn-sm" onclick="changePage('${view}',1)" ${res.page>=totalPages?'disabled':''}>Next</button>` : '');
}
function changePage(view, delta) { TASK_PAGE += delta; refreshTaskList(view); }

function renderTaskList(tasks) {
  return '<div class="task-list">' + tasks.map(t => {
    const cls = STATUS_CLASS[t.status] || 'todo';
    const overdue = t.dueDate && t.dueDate < todayStr() && t.status !== '완료';
    return `
      <div class="task-row">
        <span class="badge badge-${cls}">${tip(STATUS_EN[t.status] || t.status)}</span>
        ${t.priority === '긴급' ? `<span class="badge badge-urgent">${tip(PRIORITY_EN['긴급'])}</span>` : ''}
        <span class="title" onclick="openTaskModal('${t.id}')">${esc(t.title)}</span>
        <span class="meta">${esc(t.assignee || '-')}</span>
        <span class="meta ${overdue ? 'badge badge-overdue' : ''}">${t.dueDate ? 'Due ' + t.dueDate : ''}</span>
        ${t.status === '체크할 일' && canModifyTaskClient_(t) ? `<input type="checkbox" onclick="event.stopPropagation();toggleCheck('${t.id}',this.checked)">` : ''}
      </div>`;
  }).join('') + '</div>';
}

async function toggleCheck(taskId, checked) {
  const res = await callServerSafe('checkTask', { taskId: taskId, checked: checked });
  if (!res) return;
  if (res.success) {
    showToast(checked ? 'Marked as done.' : 'Unmarked.');
  } else {
    showToast(res.message || 'Failed to update.');
  }
  navigateTo(CURRENT_VIEW);
}

function todayStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}
function esc(s) {
  if (s === null || s === undefined) return '';
  const div = document.createElement('div');
  div.textContent = String(s);
  return div.innerHTML;
}

/* ============================================================
   업무 등록/수정 모달
============================================================ */
async function openTaskModal(taskId) {
  let task = null;
  if (taskId) {
    task = await callServerSafe('getTaskById', { taskId: taskId });
    if (!task) return;
  }
  const canEdit = !task || canModifyTaskClient_(task);
  const ro = canEdit ? '' : 'disabled';
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'taskModalOverlay';
  overlay.innerHTML = `
    <div class="modal">
      <h2>${task ? (canEdit ? 'Edit Task' : 'Task Details (Read-only)') : 'New Task'}</h2>
      ${!canEdit ? '<p class="text-muted-sm" style="margin-bottom:10px;">Only the assignee, creator, or an administrator can edit this task.</p>' : ''}
      <div class="form-group"><label>${tip('Title')} *</label><input id="f-title" ${ro} value="${task ? esc(task.title) : ''}"></div>
      <div class="form-group"><label>${tip('Notes')}</label><textarea id="f-detail" rows="3" ${ro}>${task ? esc(task.detail) : ''}</textarea></div>
      <div class="form-row">
        <div class="form-group"><label>${tip('Category')}</label><input id="f-category" ${ro} value="${task ? esc(task.category) : ''}"></div>
        <div class="form-group"><label>${tip('Assignee')}</label><input id="f-assignee" ${ro} value="${task ? esc(task.assignee) : ''}"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>${tip('Status')}</label><select id="f-status" ${ro}>${STATUS_LIST.map(s => `<option value="${s}" ${task && task.status===s?'selected':''}>${STATUS_EN[s]}</option>`).join('')}</select></div>
        <div class="form-group"><label>${tip('Priority')}</label><select id="f-priority" ${ro}>${PRIORITY_LIST.map(p => `<option value="${p}" ${task && task.priority===p?'selected':''}>${PRIORITY_EN[p]}</option>`).join('')}</select></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>${tip('Start Date')}</label><input type="date" id="f-start" ${ro} value="${task ? task.startDate : ''}"></div>
        <div class="form-group"><label>${tip('Due Date')}</label><input type="date" id="f-due" ${ro} value="${task ? task.dueDate : ''}"></div>
      </div>
      <div class="form-group" id="holdReasonGroup" style="display:none;">
        <label>Hold Reason *</label><input id="f-holdreason" ${ro} value="${task ? esc(task.holdReason||'') : ''}">
      </div>
      ${!task ? `<div class="form-group"><label><input type="checkbox" id="f-createcal" style="width:auto;"> Also create a Google Calendar event</label></div>
      <div class="form-group" id="calTypeGroup" style="display:none;"><label>Calendar</label>
        <select id="f-caltype"><option value="personal">Personal Calendar</option><option value="shared">Shared Calendar</option></select>
      </div>` : ''}
      <div class="modal-actions">
        ${task && canEdit ? `<button class="btn btn-danger" onclick="doDeleteTask('${task.id}')">${tip('Delete')}</button>` : ''}
        <button class="btn" onclick="closeTaskModal()">${canEdit ? 'Cancel' : 'Close'}</button>
        ${canEdit ? `<button class="btn btn-sage" id="saveTaskBtn" onclick="saveTask(${task ? "'"+task.id+"'" : 'null'})">${tip('Save')}</button>` : ''}
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const statusSel = document.getElementById('f-status');
  const toggleHold = () => document.getElementById('holdReasonGroup').style.display = statusSel.value === '보류' ? 'block' : 'none';
  statusSel.addEventListener('change', toggleHold); toggleHold();

  const createCalChk = document.getElementById('f-createcal');
  if (createCalChk) createCalChk.addEventListener('change', () => {
    document.getElementById('calTypeGroup').style.display = createCalChk.checked ? 'block' : 'none';
  });
}

function closeTaskModal() {
  const el = document.getElementById('taskModalOverlay');
  if (el) el.remove();
}

async function saveTask(taskId) {
  await withSubmitGuard_('saveTask', async () => {
    const data = {
      title: document.getElementById('f-title').value.trim(),
      detail: document.getElementById('f-detail').value,
      category: document.getElementById('f-category').value,
      assignee: document.getElementById('f-assignee').value,
      status: document.getElementById('f-status').value,
      priority: document.getElementById('f-priority').value,
      startDate: document.getElementById('f-start').value,
      dueDate: document.getElementById('f-due').value,
      holdReason: document.getElementById('f-holdreason') ? document.getElementById('f-holdreason').value : ''
    };
    if (!data.title) { showToast('Please enter a task title.'); return; }
    if (data.status === '보류' && !data.holdReason) { showToast('Please enter a hold reason.'); return; }

    const createCalChk = document.getElementById('f-createcal');
    if (createCalChk) {
      data.createCalendarEvent = createCalChk.checked;
      data.calendarType = document.getElementById('f-caltype').value;
    }

    const saveBtn = document.getElementById('saveTaskBtn');
    if (saveBtn) saveBtn.disabled = true;

    const action = taskId ? 'updateTask' : 'createTask';
    const apiParams = taskId ? { taskId: taskId, data: data } : { data: data };
    const res = await callServerSafe(action, apiParams, { formatMsg: msg => 'Error: ' + msg });
    if (!res) { if (saveBtn) saveBtn.disabled = false; return; }
    if (res.success) {
      showToast('Saved.');
      closeTaskModal();
      navigateTo(CURRENT_VIEW);
    } else {
      showToast(res.message || 'Failed to save.');
      if (saveBtn) saveBtn.disabled = false;
    }
  });
}

async function doDeleteTask(taskId) {
  if (!confirm('Delete this task?')) return;
  const delCal = confirm('Also delete the linked calendar event?');
  const res = await callServerSafe('deleteTask', { taskId: taskId, deleteCalendarEvent: delCal }, { formatMsg: msg => 'Error: ' + msg });
  if (!res) return;
  if (res.success) { showToast('Deleted.'); closeTaskModal(); navigateTo(CURRENT_VIEW); }
  else { showToast(res.message || 'Failed to delete.'); }
}

/* ============================================================
   달력 화면
============================================================ */
const CAL_MONTH_NAMES_EN = ['January','February','March','April','May','June','July','August','September','October','November','December'];

async function loadCalendar() {
  const el = document.getElementById('view-calendar');
  el.innerHTML = '<h2>Calendar</h2><div id="calToolbar" style="margin-bottom:12px;"></div><div id="calBody" class="card">Loading...</div>';
  document.getElementById('calToolbar').innerHTML = `
    <button class="btn btn-sm" onclick="calShift(-1)">◀ Prev</button>
    <button class="btn btn-sm" onclick="calToday()">Today</button>
    <button class="btn btn-sm" onclick="calShift(1)">Next ▶</button>
    <b style="margin-left:10px;">${CAL_MONTH_NAMES_EN[CAL_STATE.month]} ${CAL_STATE.year}</b>
  `;
  await renderCalendarMonth();
}
function calShift(n) {
  CAL_STATE.month += n;
  if (CAL_STATE.month < 0) { CAL_STATE.month = 11; CAL_STATE.year--; }
  if (CAL_STATE.month > 11) { CAL_STATE.month = 0; CAL_STATE.year++; }
  loadCalendar();
}
function calToday() { CAL_STATE = { year: new Date().getFullYear(), month: new Date().getMonth() }; loadCalendar(); }

let CAL_DAY_CACHE = {};

async function renderCalendarMonth() {
  const y = CAL_STATE.year, m = CAL_STATE.month;
  const first = new Date(y, m, 1);
  const last = new Date(y, m + 1, 0);
  const startPad = first.getDay();
  const pad2 = n => String(n).padStart(2, '0');
  const rangeStart = `${y}-${pad2(m+1)}-01`;
  const rangeEnd = `${y}-${pad2(m+1)}-${pad2(last.getDate())}`;

  let calData = { personal: [], shared: [] };
  let taskData = { tasks: [] };
  try {
    [calData, taskData] = await Promise.all([
      callApi_('getCalendarEvents', { rangeStart: rangeStart, rangeEnd: rangeEnd }),
      callApi_('getTasks', { filters: { dateFrom: rangeStart, dateTo: rangeEnd, pageSize: 500 } })
    ]);
  } catch (e) { document.getElementById('calBody').innerHTML = 'Error: ' + esc(getErrorMessage_(e)); return; }

  const byDay = {};
  const pushEntry = (dateStr, entry) => { (byDay[dateStr] = byDay[dateStr] || []).push(entry); };

  (calData.personal || []).forEach(e => pushEntry(e.start.substring(0, 10), calEntryFromEvent_(e, 'personal')));
  (calData.shared || []).forEach(e => pushEntry(e.start.substring(0, 10), calEntryFromEvent_(e, 'shared')));
  (taskData.tasks || []).forEach(t => {
    if (!t.dueDate) return;
    pushEntry(t.dueDate, {
      kind: 'task', type: t.status === '완료' ? 'done' : 'due',
      title: (t.status === '완료' ? 'Done: ' : 'Due: ') + t.title,
      taskId: t.id, status: t.status, assignee: t.assignee, memo: t.detail
    });
  });
  CAL_DAY_CACHE = byDay;

  let html = '<div class="cal-grid">';
  ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].forEach(d => html += `<div class="cal-day-head">${d}</div>`);
  for (let i = 0; i < startPad; i++) html += '<div></div>';
  for (let d = 1; d <= last.getDate(); d++) {
    const dateStr = `${y}-${pad2(m+1)}-${pad2(d)}`;
    const isToday = dateStr === todayStr();
    const dayEvents = byDay[dateStr] || [];
    const visible = dayEvents.slice(0, 2);
    const extra = dayEvents.length - visible.length;
    html += `<div class="cal-cell ${isToday?'today':''}" onclick="openDayModal('${dateStr}')">
      <div class="daynum">${d}</div>
      ${visible.map((e, idx) => `<div class="cal-evt ${e.type}" onclick="event.stopPropagation();handleCalEntryClick('${dateStr}',${idx})">${esc(e.title)}</div>`).join('')}
      ${extra > 0 ? `<div class="cal-more" onclick="event.stopPropagation();openDayModal('${dateStr}')">+${extra} more</div>` : ''}
    </div>`;
  }
  html += '</div>';
  if (calData.errors && calData.errors.length) {
    html = `<p class="text-danger-sm">${calData.errors.map(esc).join(' / ')}</p>` + html;
  }
  document.getElementById('calBody').innerHTML = html;
}

function calEntryFromEvent_(e, calendarType) {
  const m = /업무ID:\s*([\w-]+)/.exec(e.description || '');
  return {
    kind: 'calendar', type: calendarType, id: e.id, calendarType: calendarType,
    title: e.title,
    time: (e.start || '').substring(11, 16) + (e.end ? '~' + e.end.substring(11, 16) : ''),
    memo: (e.description || '').replace(/\n*\(업무관리시스템[^)]*\)/, '').trim(),
    start: e.start, end: e.end,
    taskId: m ? m[1] : null
  };
}

function handleCalEntryClick(dateStr, idx) {
  const entry = (CAL_DAY_CACHE[dateStr] || [])[idx];
  if (!entry) return;
  if (entry.kind === 'task' || entry.taskId) { openTaskModal(entry.taskId); return; }
  openDayModal(dateStr, idx);
}

function formatDateEn_(dateStr) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const date = new Date(y, mo - 1, d);
  return new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric' }).format(date);
}

function openDayModal(dateStr, focusIdx) {
  const entries = CAL_DAY_CACHE[dateStr] || [];
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay day-modal-overlay';
  overlay.id = 'dayModalOverlay';
  overlay.innerHTML = `
    <div class="modal day-modal">
      <h2>Schedule — ${formatDateEn_(dateStr)}</h2>
      <div id="dayModalList">${entries.length ? renderDayEntries_(dateStr, entries) : '<p class="text-muted-sm">No events scheduled.</p>'}</div>
      <div class="modal-actions">
        <button class="btn" onclick="closeDayModal()">${tip('Close')}</button>
        <button class="btn btn-sage" onclick="closeDayModal();calDayAddTask('${dateStr}')">+ Add Event</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  if (typeof focusIdx === 'number') {
    const el = document.getElementById('day-entry-' + focusIdx);
    if (el) el.scrollIntoView({ block: 'center' });
  }
}
function closeDayModal() {
  const el = document.getElementById('dayModalOverlay');
  if (el) el.remove();
}

function renderDayEntries_(dateStr, entries) {
  return entries.map((e, idx) => {
    if (e.kind === 'task') {
      return `
        <div class="day-entry" id="day-entry-${idx}">
          <div class="day-entry-head">
            <span class="title" onclick="closeDayModal();openTaskModal('${e.taskId}')">${esc(e.title.replace(/^(Due|Done): /, ''))}</span>
            <span class="badge badge-${STATUS_CLASS[e.status]||'todo'}">${tip(STATUS_EN[e.status] || e.status)}</span>
          </div>
          <div class="text-muted-sm">Assignee: ${esc(e.assignee || '-')}${e.memo ? ' · ' + esc(e.memo) : ''}</div>
          <div class="day-entry-actions">
            ${e.status !== '완료' ? `<button class="btn btn-sm" onclick="dayQuickComplete('${e.taskId}')">Complete</button>` : ''}
            <button class="btn btn-sm" onclick="closeDayModal();openTaskModal('${e.taskId}')">${tip('Edit')}</button>
            <button class="btn btn-sm btn-danger" onclick="dayQuickDelete('${e.taskId}')">${tip('Delete')}</button>
          </div>
        </div>`;
    }
    return `
      <div class="day-entry" id="day-entry-${idx}">
        <div class="day-entry-head">
          <span class="title" onclick="editStandaloneEvent('${dateStr}',${idx})">${esc(e.title)}</span>
          <span class="text-muted-sm">${esc(e.time)}</span>
        </div>
        ${e.memo ? `<div class="text-muted-sm">${esc(e.memo)}</div>` : ''}
        <div class="day-entry-actions">
          <button class="btn btn-sm" onclick="editStandaloneEvent('${dateStr}',${idx})">${tip('Edit')}</button>
          <button class="btn btn-sm btn-danger" onclick="deleteStandaloneEvent('${dateStr}',${idx})">${tip('Delete')}</button>
        </div>
      </div>`;
  }).join('');
}

function calDayAddTask(dateStr) {
  openTaskModal(null);
  setTimeout(() => {
    const s = document.getElementById('f-start'); const dEl = document.getElementById('f-due');
    if (s) s.value = dateStr; if (dEl) dEl.value = dateStr;
  }, 50);
}

async function dayQuickComplete(taskId) {
  const res = await callServerSafe('checkTask', { taskId: taskId, checked: true }, { formatMsg: msg => 'Error completing task: ' + msg });
  if (!res) return;
  if (res.success) { showToast('Marked as complete.'); closeDayModal(); if (CURRENT_VIEW === 'calendar') loadCalendar(); }
  else showToast(res.message || 'Failed to update.');
}

async function dayQuickDelete(taskId) {
  if (!confirm('Delete this task?')) return;
  const delCal = confirm('Also delete the linked calendar event?');
  const res = await callServerSafe('deleteTask', { taskId: taskId, deleteCalendarEvent: delCal }, { formatMsg: msg => 'Error: ' + msg });
  if (!res) return;
  if (res.success) { showToast('Deleted.'); closeDayModal(); loadCalendar(); }
  else showToast(res.message || 'Failed to delete.');
}

function editStandaloneEvent(dateStr, idx) {
  const entry = (CAL_DAY_CACHE[dateStr] || [])[idx];
  if (!entry) return;
  const startTime = (entry.start || '').substring(11, 16) || '09:00';
  const endTime = (entry.end || '').substring(11, 16) || '10:00';
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'eventEditOverlay';
  overlay.innerHTML = `
    <div class="modal">
      <h2>Edit Event</h2>
      <div class="form-group"><label>Title</label><input id="ev-title" value="${esc(entry.title)}"></div>
      <div class="form-row">
        <div class="form-group"><label>Start Time</label><input type="time" id="ev-start" value="${startTime}"></div>
        <div class="form-group"><label>End Time</label><input type="time" id="ev-end" value="${endTime}"></div>
      </div>
      <div class="form-group"><label>${tip('Notes')}</label><textarea id="ev-memo" rows="3">${esc(entry.memo||'')}</textarea></div>
      <div class="modal-actions">
        <button class="btn" onclick="closeEventEditModal_()">${tip('Cancel')}</button>
        <button class="btn btn-sage" onclick="saveStandaloneEvent('${dateStr}',${idx})">${tip('Save')}</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}
function closeEventEditModal_() {
  const el = document.getElementById('eventEditOverlay');
  if (el) el.remove();
}

async function saveStandaloneEvent(dateStr, idx) {
  const entry = (CAL_DAY_CACHE[dateStr] || [])[idx];
  if (!entry) return;
  const title = document.getElementById('ev-title').value.trim();
  const startTime = document.getElementById('ev-start').value || '09:00';
  const endTime = document.getElementById('ev-end').value || '10:00';
  const memo = document.getElementById('ev-memo').value;
  if (!title) { showToast('Please enter a title.'); return; }
  const res = await callServerSafe('updateStandaloneCalendarEvent', {
    eventId: entry.id, calendarType: entry.calendarType, title: title,
    startDateTime: dateStr + 'T' + startTime + ':00', endDateTime: dateStr + 'T' + endTime + ':00', description: memo
  }, { formatMsg: msg => 'Error updating event: ' + msg });
  if (!res) return;
  if (res.success) { showToast('Event updated.'); closeEventEditModal_(); closeDayModal(); loadCalendar(); }
  else showToast(res.message || 'Failed to update.');
}

async function deleteStandaloneEvent(dateStr, idx) {
  const entry = (CAL_DAY_CACHE[dateStr] || [])[idx];
  if (!entry) return;
  if (!confirm('Delete this event?')) return;
  const res = await callServerSafe('deleteStandaloneCalendarEvent', { eventId: entry.id, calendarType: entry.calendarType }, { formatMsg: msg => 'Error deleting event: ' + msg });
  if (!res) return;
  if (res.success) { showToast('Event deleted.'); closeDayModal(); loadCalendar(); }
  else showToast(res.message || 'Failed to delete.');
}

/* ============================================================
   설정 화면
============================================================ */
async function loadSettings() {
  const el = document.getElementById('view-settings');
  const profile = await callServerSafe('getMyProfile', {}, {
    targetElId: 'view-settings',
    formatMsg: msg => 'Failed to load your info: ' + msg
  });
  if (!profile) return;

  let settingsHtml = '';
  let usersHtml = '';
  if (profile.role === '관리자') {
    const s = await callServerSafe('getSettings', {}, {
      targetElId: 'view-settings',
      formatMsg: msg => 'Failed to load settings: ' + msg
    });
    if (!s) return;
    settingsHtml = renderSystemSettingsForm_(s);

    const users = await callServerSafe('listUsers', {}, {
      targetElId: 'view-settings',
      formatMsg: msg => 'Failed to load user list: ' + msg
    });
    if (!users) return;
    usersHtml = renderUserManagement_(users);
  }

  el.innerHTML = `
    <h2>Settings</h2>
    <div class="card">
      <h3>My Info</h3>
      <p class="text-muted-sm">Username: ${esc(profile.userId)} · Name: ${esc(profile.name)} · Role: ${esc(ROLE_EN[profile.role] || profile.role)}</p>
    </div>
    ${settingsHtml}
    <div class="card" style="margin-top:20px;">
      <h3>Change Password</h3>
      <div class="form-row">
        <div class="form-group"><label>Current Password</label><input type="password" id="pw-old"></div>
        <div class="form-group"><label>New Password (min 8 characters)</label><input type="password" id="pw-new"></div>
      </div>
      <button class="btn" onclick="doChangePassword()">Change Password</button>
    </div>
    ${usersHtml}
  `;
}

function renderSystemSettingsForm_(s) {
  return `
    <div class="card grid-2" style="display:grid;gap:16px;margin-top:20px;">
      <div class="form-group"><label>System Name</label><input id="s-name" value="${esc(s.systemName||'')}"></div>
      <div class="form-group"><label>Personal Calendar ID (leave blank for default calendar)</label><input id="s-personalcal" value="${esc(s.personalCalendarId||'')}"></div>
      <div class="form-group"><label>Shared Calendar ID</label><input id="s-sharedcal" value="${esc(s.sharedCalendarId||'')}"></div>
      <div class="form-group"><label>Default View Range (days)</label><input type="number" id="s-viewdays" value="${s.defaultViewDays||30}"></div>
      <div class="form-group"><label>Items per Page</label><input type="number" id="s-pagesize" value="${s.pageSize||20}"></div>
      <div class="form-group"><label><input type="checkbox" id="s-emailenabled" style="width:auto;" ${s.emailNotifyEnabled?'checked':''}> Enable daily morning email notifications</label></div>
      <div class="form-group"><label>Send Time</label><input type="time" id="s-emailtime" value="${s.emailNotifyTime||'08:00'}"></div>
    </div>
    <div style="margin-top:14px;"><button class="btn btn-sage" onclick="saveSettingsForm()">Save Settings</button></div>
  `;
}

function renderUserManagement_(users) {
  const rows = users.map(u => `
    <tr>
      <td>${esc(u.userId)}</td>
      <td>${esc(u.name)}</td>
      <td>${esc(u.email || '-')}</td>
      <td>
        <select onchange="doChangeUserRole('${u.userId}', this.value)">
          <option value="관리자" ${u.role==='관리자'?'selected':''}>Administrator</option>
          <option value="일반" ${u.role==='일반'?'selected':''}>User</option>
        </select>
      </td>
      <td>${u.active === 'Y' ? 'Active' : 'Inactive'}</td>
      <td>
        <button class="btn btn-sm" onclick="doToggleUserActive('${u.userId}', ${u.active !== 'Y'})">${u.active === 'Y' ? 'Deactivate' : 'Activate'}</button>
        <button class="btn btn-sm" onclick="doResetUserPassword('${u.userId}')">Reset Password</button>
      </td>
    </tr>`).join('');

  return `
    <div class="card" style="margin-top:20px;">
      <h3>User Management</h3>
      <table class="data-table">
        <thead><tr><th>ID</th><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="6" class="text-muted-sm">No users registered.</td></tr>'}</tbody>
      </table>
      <h3 style="margin-top:18px;">Add New User</h3>
      <div class="form-row">
        <div class="form-group"><label>ID</label><input id="nu-id"></div>
        <div class="form-group"><label>Name</label><input id="nu-name"></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label>Email (for Google auto-login, optional)</label><input id="nu-email"></div>
        <div class="form-group"><label>Initial Password (min 8 characters)</label><input type="password" id="nu-pw"></div>
      </div>
      <div class="form-group"><label>Role</label>
        <select id="nu-role"><option value="일반">User</option><option value="관리자">Administrator</option></select>
      </div>
      <button class="btn btn-sage" onclick="doCreateUser()">Add User</button>
    </div>
  `;
}

async function saveSettingsForm() {
  const data = {
    systemName: document.getElementById('s-name').value,
    personalCalendarId: document.getElementById('s-personalcal').value,
    sharedCalendarId: document.getElementById('s-sharedcal').value,
    defaultViewDays: Number(document.getElementById('s-viewdays').value) || 30,
    pageSize: Number(document.getElementById('s-pagesize').value) || 20,
    emailNotifyEnabled: document.getElementById('s-emailenabled').checked,
    emailNotifyTime: document.getElementById('s-emailtime').value
  };
  const saved = await callServerSafe('saveSettings', { data: data }, {
    formatMsg: msg => 'Error saving settings: ' + msg
  });
  if (!saved) return;
  const triggered = await callServerSafe('updateEmailTrigger', { enabled: data.emailNotifyEnabled, timeStr: data.emailNotifyTime }, {
    formatMsg: msg => 'Error updating email notification: ' + msg
  });
  if (!triggered) return;
  showToast('Settings saved.');
}

async function doChangePassword() {
  const oldPw = document.getElementById('pw-old').value;
  const newPw = document.getElementById('pw-new').value;
  const res = await callServerSafe('changePassword', { oldPassword: oldPw, newPassword: newPw }, {
    formatMsg: msg => 'Error changing password: ' + msg
  });
  if (!res) return;
  showToast(res.success ? 'Password changed.' : (res.message || 'Failed to change password.'));
  if (res.success) { document.getElementById('pw-old').value = ''; document.getElementById('pw-new').value = ''; }
}

/* ============================================================
   사용자 관리 (관리자 전용 화면에서만 노출됨)
============================================================ */
async function doCreateUser() {
  await withSubmitGuard_('doCreateUser', async () => {
    const data = {
      userId: document.getElementById('nu-id').value.trim(),
      name: document.getElementById('nu-name').value.trim(),
      email: document.getElementById('nu-email').value.trim(),
      password: document.getElementById('nu-pw').value,
      role: document.getElementById('nu-role').value
    };
    if (!data.userId || !data.name || !data.password) { showToast('Please enter an ID, name, and password.'); return; }
    const res = await callServerSafe('createUser', { data: data }, { formatMsg: msg => 'Error adding user: ' + msg });
    if (!res) return;
    if (res.success) { showToast('User added.'); loadSettings(); }
    else { showToast(res.message || 'Failed to add user.'); }
  });
}

async function doToggleUserActive(userId, activate) {
  const res = await callServerSafe('setUserActive', { userId: userId, active: activate }, { formatMsg: msg => 'Error: ' + msg });
  if (!res) return;
  if (res.success) { showToast(activate ? 'Activated.' : 'Deactivated.'); loadSettings(); }
  else { showToast(res.message || 'Failed to update.'); loadSettings(); }
}

async function doChangeUserRole(userId, role) {
  const res = await callServerSafe('setUserRole', { userId: userId, role: role }, { formatMsg: msg => 'Error changing role: ' + msg });
  if (!res) return;
  if (res.success) { showToast('Role updated.'); }
  else { showToast(res.message || 'Failed to update.'); }
  loadSettings();
}

async function doResetUserPassword(userId) {
  const pw = prompt('Enter a new password for ' + userId + ' (min 8 characters):');
  if (!pw) return;
  const res = await callServerSafe('resetUserPassword', { userId: userId, newPassword: pw }, { formatMsg: msg => 'Error resetting password: ' + msg });
  if (!res) return;
  showToast(res.success ? 'Password reset.' : (res.message || 'Failed to reset.'));
}

/* ============================================================
   전역 오류 안전망
============================================================ */
window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled promise rejection:', event.reason);
  showToast('An unexpected error occurred. Please try again.');
});
window.addEventListener('error', (event) => {
  console.error('Unhandled error:', event.error || event.message);
});
