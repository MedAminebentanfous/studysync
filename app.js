/* =====================================================================
   StudySync — frontend (vanilla JS single-page app)
   Talks to the Flask REST API in app.py via fetch().
   ===================================================================== */
'use strict';

// ---------------------------------------------------------------- helpers
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const trim = (n) => (n === null || n === undefined || n === '' ? '—' : String(+Number(n).toFixed(2)));
const fix2 = (n) => (n === null || n === undefined || Number.isNaN(n) ? '—' : Number(n).toFixed(2));
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const fmtDate = (iso, opts = { weekday: 'short', month: 'short', day: 'numeric' }) =>
  (iso ? new Date(`${iso.slice(0, 10)}T00:00`).toLocaleDateString(undefined, opts) : '—');
const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString(undefined,
  { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const fmtSize = (b) => (b == null ? '' : b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`);
const debounce = (fn, ms = 300) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

const DEFAULT_CATEGORIES = ['Notes', 'Video', 'Article', 'Course', 'Book', 'Past paper', 'Reference', 'Interactive', 'Other'];
const GRADE_TYPES = ['exam', 'quiz', 'homework', 'project', 'oral', 'lab', 'other'];
const PALETTE = ['#4f46e5', '#0891b2', '#16a34a', '#d97706', '#db2777', '#7c3aed', '#dc2626', '#0d9488', '#65a30d', '#475569'];
const STATUS_LABEL = { todo: 'To do', in_progress: 'In progress', done: 'Done' };

const state = {
  user: null,
  subjects: [],
  taskFilters: { status: '', priority: '', subject_id: '' },
  gradeFilter: '',
  resFilters: { category: '', q: '', subject_id: '' },
};

// -------------------------------------------------------------------- API
class ApiError extends Error {
  constructor(message, status, fields) { super(message); this.status = status; this.fields = fields || {}; }
}

async function api(path, { method = 'GET', body, form } = {}) {
  const init = { method, headers: { Accept: 'application/json' }, credentials: 'same-origin' };
  if (form) init.body = form;
  else if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  let res;
  try { res = await fetch(path, init); } catch {
    throw new ApiError('Network error — is the StudySync server running?', 0);
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    if (res.status === 401 && !/\/api\/auth\/(login|register)/.test(path)) showAuth();
    throw new ApiError(data?.error || `Request failed (${res.status})`, res.status, data?.fields);
  }
  return data;
}

async function loadSubjects() {
  const { subjects } = await api('/api/subjects');
  state.subjects = subjects;
  return subjects;
}

const subjectOptions = (noneLabel = '— None —') =>
  [{ value: '', label: noneLabel }, ...state.subjects.map((s) => ({ value: s.id, label: s.name }))];

// ------------------------------------------------------------------- UI bits
function toast(msg, type = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${type === 'error' ? 'error' : ''}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

const emptyState = (title, text) => `<div class="empty"><strong>${esc(title)}</strong>${esc(text)}</div>`;
const subjectPill = (name, color) => (name
  ? `<span class="subject-pill"><span class="dot" style="background:${esc(color)}"></span>${esc(name)}</span>` : '');

function dueInfo(due, done = false) {
  if (!due) return { text: 'No due date', cls: '' };
  const days = Math.round((new Date(`${due}T00:00`) - new Date(`${todayISO()}T00:00`)) / 86400000);
  if (done) return { text: `Due ${fmtDate(due)}`, cls: '' };
  if (days < 0) return { text: `Overdue by ${-days}d`, cls: 'due-overdue' };
  if (days === 0) return { text: 'Due today', cls: 'due-soon' };
  if (days === 1) return { text: 'Due tomorrow', cls: 'due-soon' };
  if (days <= 3) return { text: `Due in ${days} days`, cls: 'due-soon' };
  return { text: `Due ${fmtDate(due)}`, cls: '' };
}

// ------------------------------------------------------------------- Modal
function fieldHtml(f, value) {
  const val = value ?? f.default ?? '';
  const attrs = [
    `name="${f.name}"`, f.required ? 'required' : '',
    f.min !== undefined ? `min="${f.min}"` : '', f.max !== undefined ? `max="${f.max}"` : '',
    f.step ? `step="${f.step}"` : '', f.placeholder ? `placeholder="${esc(f.placeholder)}"` : '',
    f.list ? `list="dl-${f.name}"` : '', f.accept ? `accept="${esc(f.accept)}"` : '',
    f.maxlength ? `maxlength="${f.maxlength}"` : '',
  ].filter(Boolean).join(' ');
  let input;
  if (f.type === 'select') {
    input = `<select ${attrs}>${f.options.map((o) =>
      `<option value="${esc(o.value)}" ${String(o.value) === String(val) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
  } else if (f.type === 'textarea') {
    input = `<textarea ${attrs}>${esc(val)}</textarea>`;
  } else if (f.type === 'file') {
    input = `<input type="file" ${attrs}>`;
  } else {
    input = `<input type="${f.type || 'text'}" ${attrs} value="${esc(val)}">`;
  }
  const dl = f.list ? `<datalist id="dl-${f.name}">${f.list.map((o) => `<option value="${esc(o)}"></option>`).join('')}</datalist>` : '';
  return `<label class="field ${f.full ? 'field-full' : ''}"><span>${esc(f.label)}${f.hint ? ` <span class="muted">${esc(f.hint)}</span>` : ''}</span>${input}${dl}</label>`;
}

function openForm({ title, submitLabel = 'Save', fields, values = {}, onSubmit }) {
  const modal = $('#modal');
  $('#modal-title').textContent = title;
  $('#modal-submit').textContent = submitLabel;
  $('#modal-submit').hidden = false;
  $('#modal-error').textContent = '';
  const bodyEl = $('#modal-body');
  bodyEl.className = 'modal-body two';
  bodyEl.innerHTML = fields.map((f) => fieldHtml(f, values[f.name])).join('');
  modal._fields = fields;
  modal._onSubmit = onSubmit;
  modal.showModal();
  bodyEl.querySelector('input, select, textarea')?.focus();
}

function initModal() {
  const modal = $('#modal');
  const form = $('#modal-form');
  $$('[data-close]', modal).forEach((b) => b.addEventListener('click', () => modal.close()));
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.close(); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = $('#modal-error');
    if (!form.checkValidity()) {
      const bad = form.querySelector(':invalid');
      const label = bad?.closest('label')?.querySelector('span')?.textContent?.trim() || 'Field';
      errEl.textContent = `${label}: ${bad?.validationMessage || 'invalid value'}`;
      bad?.focus();
      return;
    }
    const fd = new FormData(form);
    const values = {};
    modal._fields.forEach((f) => { values[f.name] = fd.get(f.name); });
    const btn = $('#modal-submit');
    btn.disabled = true;
    errEl.textContent = '';
    try {
      await modal._onSubmit(values);
      modal.close();
    } catch (err) {
      errEl.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
}

/** In-page confirmation dialog (native confirm() is blocked in some embedded viewers). */
function askConfirm(what) {
  return new Promise((resolve) => {
    const d = $('#confirm-dialog');
    $('#confirm-msg').textContent = `Delete ${what}? This cannot be undone.`;
    const done = (v) => { d.onclose = null; d.close(); resolve(v); };
    $('#confirm-ok').onclick = () => done(true);
    $('#confirm-cancel').onclick = () => done(false);
    d.onclose = () => resolve(false);
    d.showModal();
    $('#confirm-cancel').focus();
  });
}

/** Read-only modal used for file previews. */
function openInfo(title, html) {
  const modal = $('#modal');
  $('#modal-title').textContent = title;
  $('#modal-error').textContent = '';
  const bodyEl = $('#modal-body');
  bodyEl.className = 'modal-body';
  bodyEl.innerHTML = html;
  $('#modal-submit').hidden = true;
  modal._fields = [];
  modal._onSubmit = async () => {};
  modal.showModal();
}

// ======================================================== PERFORMANCE VIEW
function perfBars(perf) {
  if (!perf.subjects.length) return emptyState('No subjects yet', 'Add subjects and grades on the Grades page.');
  const scale = perf.grade_scale;
  return `<div class="perf-list">${perf.subjects.map((s) => {
    const pct = s.average == null ? 0 : Math.min(100, (s.average / scale) * 100);
    const tgt = s.target_average != null ? Math.min(100, (s.target_average / scale) * 100) : null;
    return `<div class="perf-row">
      <div class="perf-name"><span class="dot" style="background:${esc(s.color)}"></span><span class="n" title="${esc(s.name)}">${esc(s.name)}</span><small>×${trim(s.coefficient)}</small></div>
      <div class="bar" title="${s.average == null ? 'No grades yet' : `Average ${fix2(s.average)} / ${trim(scale)}`}">
        <div class="bar-fill" style="width:${pct}%;background:${esc(s.color)}"></div>
        ${tgt != null ? `<div class="bar-target" style="left:calc(${tgt}% - 1px)" title="Target ${trim(s.target_average)}"></div>` : ''}
      </div>
      <div class="perf-val ${s.average == null ? 'na' : ''}">${s.average == null ? '—' : fix2(s.average)}</div>
    </div>`;
  }).join('')}</div>`;
}

/** Client-side mirror of the backend algorithm, used for live "what-if" previews. */
function computeLocal(subjects, grades, scale, extra = null) {
  let weighted = 0; let coefs = 0;
  const per = {};
  subjects.forEach((s) => {
    const items = grades.filter((g) => g.subject_id === s.id)
      .map((g) => ({ n: (g.score / g.max_score) * scale, w: g.weight }));
    if (extra && extra.subject_id === s.id) items.push({ n: (extra.score / extra.max_score) * scale, w: extra.weight });
    const W = items.reduce((a, x) => a + x.w, 0);
    const S = items.reduce((a, x) => a + x.n * x.w, 0);
    const avg = W ? S / W : null;
    per[s.id] = { avg, W, S };
    if (avg !== null) { weighted += avg * s.coefficient; coefs += s.coefficient; }
  });
  return { overall: coefs ? weighted / coefs : null, per };
}

// =============================================================== DASHBOARD
async function renderDashboard(view) {
  const d = await api('/api/dashboard');
  const p = d.performance;
  const t = d.tasks;
  const pctDone = t.total ? Math.round((t.done / t.total) * 100) : 0;
  const nextExam = d.next_exams[0];
  setActions('<a class="btn btn-primary" href="#grades">+ Add grade</a><a class="btn btn-ghost" href="#planner">+ Add task</a>');

  view.innerHTML = `
  <section class="stats">
    <div class="card stat stat-hero">
      <div class="stat-label">Overall weighted average</div>
      <div class="stat-value">${p.overall_average == null ? '—' : fix2(p.overall_average)} <small>/ ${trim(p.grade_scale)}</small></div>
      <div class="stat-foot">${p.overall_average == null ? 'Add grades to see your average' : `GPA ${fix2(p.gpa_4)} / 4 · ${esc(p.mention)}`}</div>
    </div>
    <div class="card stat">
      <div class="stat-label">Tasks completed</div>
      <div class="stat-value">${t.done}<small> / ${t.total}</small></div>
      <div class="progress" style="margin-top:10px"><div style="width:${pctDone}%"></div></div>
    </div>
    <div class="card stat">
      <div class="stat-label">Overdue · due today</div>
      <div class="stat-value" style="${t.overdue ? 'color:var(--danger)' : ''}">${t.overdue}<small> · ${t.due_today}</small></div>
      <div class="stat-foot">${t.overdue ? 'Catch up on overdue tasks' : 'You are on track'}</div>
    </div>
    <div class="card stat">
      <div class="stat-label">Next exam</div>
      ${nextExam ? `<div class="stat-value" style="font-size:22px;margin-top:10px">${esc(nextExam.title)}</div>
        <div class="stat-foot"><span class="mini-countdown" data-countdown="${esc(nextExam.exam_at)}"></span></div>`
    : '<div class="stat-value">—</div><div class="stat-foot">No upcoming exams</div>'}
    </div>
  </section>

  <section class="cols">
    <div class="card span-7">
      <div class="card-head"><h2>Performance by subject</h2><a class="btn btn-ghost btn-sm" href="#grades">Details</a></div>
      <div class="card-body">${perfBars(p)}</div>
    </div>
    <div class="card span-5">
      <div class="card-head"><h2>Up next</h2><a class="btn btn-ghost btn-sm" href="#planner">Planner</a></div>
      ${d.upcoming_tasks.length ? `<ul class="list">${d.upcoming_tasks.map((tk) => {
    const due = dueInfo(tk.due_date);
    return `<li class="list-item">
          <input type="checkbox" class="check" data-toggle="${tk.id}" aria-label="Mark ${esc(tk.title)} as done">
          <div class="grow"><div class="title">${esc(tk.title)}</div>
            <div class="meta">${subjectPill(tk.subject_name, tk.subject_color)}<span class="${due.cls}">${due.text}</span></div></div>
          <span class="tag tag-${tk.priority}">${tk.priority}</span></li>`;
  }).join('')}</ul>` : emptyState('All clear', 'No open tasks — add one in the planner.')}
    </div>
    <div class="card span-5">
      <div class="card-head"><h2>Exam countdowns</h2><a class="btn btn-ghost btn-sm" href="#exams">Manage</a></div>
      ${d.next_exams.length ? `<ul class="list">${d.next_exams.map((e) => `<li class="list-item">
          <div class="grow"><div class="title">${esc(e.title)}</div>
          <div class="meta">${subjectPill(e.subject_name, e.subject_color)}<span>${fmtDateTime(e.exam_at)}</span></div></div>
          <span class="mini-countdown" data-countdown="${esc(e.exam_at)}"></span></li>`).join('')}</ul>`
    : emptyState('No exams scheduled', 'Add exam dates to start the countdown.')}
    </div>
    <div class="card span-7">
      <div class="card-head"><h2>Recent grades</h2><span class="muted" style="font-size:13px">${d.resource_count} study resources saved</span></div>
      ${d.recent_grades.length ? `<div class="table-wrap"><table><thead><tr><th>Assessment</th><th>Subject</th><th class="num">Score</th><th class="num">Weight</th></tr></thead><tbody>
        ${d.recent_grades.map((g) => `<tr><td>${esc(g.title)}<div class="muted" style="font-size:12px">${fmtDate(g.graded_on)}</div></td>
          <td>${subjectPill(g.subject_name, g.subject_color)}</td>
          <td class="num">${trim(g.score)}/${trim(g.max_score)}</td><td class="num">×${trim(g.weight)}</td></tr>`).join('')}
      </tbody></table></div>` : emptyState('No grades yet', 'Record your first grade on the Grades page.')}
    </div>
  </section>`;

  view.onchange = async (e) => {
    const id = e.target.dataset.toggle;
    if (!id) return;
    try { await api(`/api/tasks/${id}/toggle`, { method: 'POST' }); toast('Task completed ✓'); rerender(); } catch (err) { toast(err.message, 'error'); }
  };
  tickCountdowns();
}

// ================================================================== GRADES
function subjectFields() {
  return [
    { name: 'name', label: 'Subject name', required: true, maxlength: 80, full: true, placeholder: 'e.g. Mathematics' },
    { name: 'coefficient', label: 'Coefficient', type: 'number', required: true, min: 0.1, step: 0.1, default: 1, hint: '(credit weight)' },
    { name: 'target_average', label: 'Target average', type: 'number', min: 0, step: 0.1, hint: '(optional)' },
    { name: 'color', label: 'Colour', type: 'color', default: PALETTE[state.subjects.length % PALETTE.length], full: true },
  ];
}

function gradeFields() {
  const scale = state.user.grade_scale;
  return [
    { name: 'subject_id', label: 'Subject', type: 'select', required: true, options: state.subjects.map((s) => ({ value: s.id, label: s.name })), full: true },
    { name: 'title', label: 'Assessment', required: true, maxlength: 120, placeholder: 'e.g. Midterm exam', full: true },
    { name: 'score', label: 'Score', type: 'number', required: true, min: 0, step: 0.01 },
    { name: 'max_score', label: 'Out of', type: 'number', required: true, min: 0.01, step: 0.01, default: scale },
    { name: 'weight', label: 'Weight multiplier', type: 'number', required: true, min: 0.01, step: 0.01, default: 1, hint: '(e.g. final ×2)' },
    { name: 'grade_type', label: 'Type', type: 'select', options: GRADE_TYPES.map((g) => ({ value: g, label: g[0].toUpperCase() + g.slice(1) })) },
    { name: 'graded_on', label: 'Date', type: 'date', default: todayISO(), full: true },
  ];
}

const numOrNull = (v) => (v === '' || v === null || v === undefined ? null : Number(v));

function openSubjectForm(subject) {
  openForm({
    title: subject ? 'Edit subject' : 'New subject',
    submitLabel: subject ? 'Save changes' : 'Add subject',
    fields: subjectFields(),
    values: subject || {},
    onSubmit: async (v) => {
      const payload = { ...v, coefficient: Number(v.coefficient), target_average: numOrNull(v.target_average) };
      if (subject) await api(`/api/subjects/${subject.id}`, { method: 'PUT', body: payload });
      else await api('/api/subjects', { method: 'POST', body: payload });
      toast(subject ? 'Subject updated' : 'Subject added');
      await loadSubjects();
      rerender();
    },
  });
}

function openGradeForm(grade, preset = {}) {
  if (!state.subjects.length) { toast('Add a subject first', 'error'); openSubjectForm(); return; }
  openForm({
    title: grade ? 'Edit grade' : 'Record a grade',
    submitLabel: grade ? 'Save changes' : 'Add grade',
    fields: gradeFields(),
    values: grade || { subject_id: state.gradeFilter || state.subjects[0].id, ...preset },
    onSubmit: async (v) => {
      const payload = { ...v, subject_id: Number(v.subject_id), score: Number(v.score), max_score: Number(v.max_score), weight: Number(v.weight) };
      if (grade) await api(`/api/grades/${grade.id}`, { method: 'PUT', body: payload });
      else await api('/api/grades', { method: 'POST', body: payload });
      toast(grade ? 'Grade updated' : 'Grade recorded');
      rerender();
    },
  });
}

async function renderGrades(view) {
  const [{ grades }, perf] = await Promise.all([api('/api/grades'), api('/api/performance'), loadSubjects()]);
  const scale = perf.grade_scale;
  setActions('<button class="btn btn-ghost" data-act="add-subject">+ Subject</button><button class="btn btn-primary" data-act="add-grade">+ Grade</button>');

  const filtered = state.gradeFilter ? grades.filter((g) => g.subject_id === Number(state.gradeFilter)) : grades;

  view.innerHTML = `
  <section class="stats">
    <div class="card stat stat-hero"><div class="stat-label">Weighted average</div>
      <div class="stat-value">${fix2(perf.overall_average)} <small>/ ${trim(scale)}</small></div>
      <div class="stat-foot">${perf.percentage == null ? 'No grades yet' : `${perf.percentage}%`}</div></div>
    <div class="card stat"><div class="stat-label">GPA (4.0 scale)</div>
      <div class="stat-value">${fix2(perf.gpa_4)}</div><div class="stat-foot">Linear conversion from /${trim(scale)}</div></div>
    <div class="card stat"><div class="stat-label">Standing</div>
      <div class="stat-value" style="font-size:26px;margin-top:10px">${esc(perf.mention || '—')}</div>
      <div class="stat-foot">${perf.graded_subjects} of ${perf.subjects.length} subjects graded</div></div>
    <div class="card stat"><div class="stat-label">Total coefficients</div>
      <div class="stat-value">${trim(perf.total_coefficient)}</div><div class="stat-foot">${grades.length} grades recorded</div></div>
  </section>

  <section class="cols">
    <div class="card span-7">
      <div class="card-head"><h2>Subjects &amp; breakdown</h2><span class="tag tag-neutral">${perf.subjects.length} subjects</span></div>
      ${perf.subjects.length ? `<div class="table-wrap"><table><thead><tr>
        <th>Subject</th><th class="num">Coef</th><th class="num">Grades</th><th class="num">Average</th><th class="num">Contribution</th><th class="num">Target</th><th></th></tr></thead><tbody>
        ${perf.subjects.map((s) => `<tr>
          <td>${subjectPill(s.name, s.color)}</td>
          <td class="num">×${trim(s.coefficient)}</td>
          <td class="num">${s.grade_count}</td>
          <td class="num"><strong>${fix2(s.average)}</strong></td>
          <td class="num">${s.contribution == null ? '—' : `+${fix2(s.contribution)}`}</td>
          <td class="num">${s.target_average == null ? '—'
    : `<span class="tag ${s.meets_target === null ? 'tag-neutral' : s.meets_target ? 'tag-low' : 'tag-high'}">${trim(s.target_average)}</span>`}</td>
          <td class="actions"><button class="icon-btn" data-edit-subject="${s.subject_id}" title="Edit subject">✎</button><button class="icon-btn danger" data-del-subject="${s.subject_id}" title="Delete subject">✕</button></td>
        </tr>`).join('')}
      </tbody></table></div>
      <div class="card-body">${perfBars(perf)}
        <p class="muted mono" style="font-size:12px;margin:16px 0 0">Subject avg = Σ(score × weight) / Σ weight &nbsp;·&nbsp; Overall = Σ(avg × coef) / Σ coef</p></div>` : emptyState('No subjects yet', 'Create a subject (e.g. Math ×4) to start.')}
    </div>

    <div class="card span-5">
      <div class="card-head"><h2>What-if calculator</h2><span class="tag tag-accent">Live</span></div>
      <div class="card-body whatif">
        ${state.subjects.length ? `
        <p class="muted" style="margin:0;font-size:13.5px">Try a hypothetical grade and see how it moves your averages before you record it.</p>
        <div class="grid-2">
          <label class="field field-full">Subject<select id="wi-subject">${state.subjects.map((s) => `<option value="${s.id}">${esc(s.name)} (×${trim(s.coefficient)})</option>`).join('')}</select></label>
          <label class="field">Score<input id="wi-score" type="number" min="0" step="0.25" value="${trim(scale * 0.75)}"></label>
          <label class="field">Out of<input id="wi-max" type="number" min="0.01" step="0.25" value="${trim(scale)}"></label>
          <label class="field field-full">Weight multiplier<input id="wi-weight" type="number" min="0.01" step="0.25" value="1"></label>
        </div>
        <div class="whatif-result" id="wi-result"></div>
        <p id="wi-target" style="margin:0;font-size:13.5px"></p>
        <button class="btn btn-ghost" data-act="wi-save">Record this grade</button>`
    : emptyState('No subjects', 'Add a subject to use the calculator.')}
      </div>
    </div>

    <div class="card span-12">
      <div class="card-head"><h2>All grades</h2>
        <select id="grade-filter" class="inline-select" style="padding:6px 10px">
          <option value="">All subjects</option>${state.subjects.map((s) => `<option value="${s.id}" ${String(s.id) === String(state.gradeFilter) ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
        </select></div>
      ${filtered.length ? `<div class="table-wrap"><table><thead><tr>
        <th>Date</th><th>Subject</th><th>Assessment</th><th>Type</th><th class="num">Score</th><th class="num">On /${trim(scale)}</th><th class="num">Weight</th><th></th></tr></thead><tbody>
        ${filtered.map((g) => `<tr>
          <td>${fmtDate(g.graded_on, { month: 'short', day: 'numeric', year: 'numeric' })}</td>
          <td>${subjectPill(g.subject_name, g.subject_color)}</td>
          <td>${esc(g.title)}</td>
          <td><span class="tag tag-neutral">${esc(g.grade_type)}</span></td>
          <td class="num">${trim(g.score)} / ${trim(g.max_score)}</td>
          <td class="num"><strong>${fix2((g.score / g.max_score) * scale)}</strong></td>
          <td class="num">×${trim(g.weight)}</td>
          <td class="actions"><button class="icon-btn" data-edit-grade="${g.id}" title="Edit">✎</button><button class="icon-btn danger" data-del-grade="${g.id}" title="Delete">✕</button></td>
        </tr>`).join('')}</tbody></table></div>` : emptyState('No grades here yet', 'Use “+ Grade” to record an assessment.')}
    </div>
  </section>`;

  // ---- what-if live computation
  const updateWhatIf = () => {
    const sid = Number($('#wi-subject')?.value);
    if (!sid) return;
    const score = Number($('#wi-score').value);
    const max = Number($('#wi-max').value);
    const weight = Number($('#wi-weight').value);
    const box = $('#wi-result');
    if (!(max > 0) || !(weight > 0) || score < 0 || score > max || Number.isNaN(score)) {
      box.innerHTML = '<div class="whatif-box" style="grid-column:1/-1;color:var(--danger)">Enter a score between 0 and the max, and a positive weight.</div>';
      $('#wi-target').textContent = '';
      return;
    }
    const before = computeLocal(state.subjects, grades, scale);
    const after = computeLocal(state.subjects, grades, scale, { subject_id: sid, score, max_score: max, weight });
    const delta = (a, b) => {
      if (b == null) return '';
      if (a == null) return '<span class="delta-up">new</span>';
      const d = b - a;
      return `<span class="${d >= 0 ? 'delta-up' : 'delta-down'}">${d >= 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(2)}</span>`;
    };
    const sb = before.per[sid].avg; const sa = after.per[sid].avg;
    box.innerHTML = `
      <div class="whatif-box"><div class="lbl">Subject average</div><div class="val">${fix2(sa)}</div><div class="muted" style="font-size:12.5px">was ${fix2(sb)} ${delta(sb, sa)}</div></div>
      <div class="whatif-box"><div class="lbl">Overall average</div><div class="val">${fix2(after.overall)}</div><div class="muted" style="font-size:12.5px">was ${fix2(before.overall)} ${delta(before.overall, after.overall)}</div></div>`;
    const subj = state.subjects.find((s) => s.id === sid);
    const tEl = $('#wi-target');
    if (subj.target_average == null) { tEl.innerHTML = '<span class="muted">Set a target for this subject to see the score you need.</span>'; return; }
    const { S, W } = before.per[sid];
    const needNorm = (subj.target_average * (W + weight) - S) / weight;
    if (needNorm <= 0) tEl.innerHTML = `<span class="delta-up">✓ Target ${trim(subj.target_average)} is secured regardless of this assessment.</span>`;
    else if (needNorm > scale) tEl.innerHTML = `<span class="delta-down">Target ${trim(subj.target_average)} is out of reach with one ×${trim(weight)} assessment.</span>`;
    else tEl.innerHTML = `To reach your target of <strong>${trim(subj.target_average)}</strong> you need at least <strong>${(needNorm / scale * max).toFixed(2)} / ${trim(max)}</strong> on this ×${trim(weight)} assessment.`;
  };
  view.oninput = (e) => { if (e.target.id?.startsWith('wi-')) updateWhatIf(); };
  view.onchange = (e) => {
    if (e.target.id === 'wi-subject') updateWhatIf();
    if (e.target.id === 'grade-filter') { state.gradeFilter = e.target.value; rerender(); }
  };
  view.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    try {
      if (d.act === 'wi-save') {
        openGradeForm(null, { subject_id: $('#wi-subject').value, score: $('#wi-score').value, max_score: $('#wi-max').value, weight: $('#wi-weight').value, title: '' });
      } else if (d.editSubject) {
        openSubjectForm(state.subjects.find((s) => s.id === Number(d.editSubject)));
      } else if (d.delSubject) {
        const s = state.subjects.find((x) => x.id === Number(d.delSubject));
        if (await askConfirm(`“${s.name}” and all its grades`)) {
          await api(`/api/subjects/${s.id}`, { method: 'DELETE' });
          if (String(state.gradeFilter) === String(s.id)) state.gradeFilter = '';
          toast('Subject deleted'); await loadSubjects(); rerender();
        }
      } else if (d.editGrade) {
        openGradeForm(grades.find((g) => g.id === Number(d.editGrade)));
      } else if (d.delGrade) {
        if (await askConfirm('this grade')) { await api(`/api/grades/${d.delGrade}`, { method: 'DELETE' }); toast('Grade deleted'); rerender(); }
      }
    } catch (err) { toast(err.message, 'error'); }
  };
  updateWhatIf();
}

// ================================================================= PLANNER
function taskFields() {
  return [
    { name: 'title', label: 'Task', required: true, maxlength: 150, full: true, placeholder: 'e.g. Revise chapter 3' },
    { name: 'description', label: 'Notes', type: 'textarea', maxlength: 2000, full: true },
    { name: 'subject_id', label: 'Subject', type: 'select', options: subjectOptions() },
    { name: 'due_date', label: 'Due date', type: 'date' },
    { name: 'priority', label: 'Priority', type: 'select', default: 'medium', options: [{ value: 'high', label: 'High' }, { value: 'medium', label: 'Medium' }, { value: 'low', label: 'Low' }] },
    { name: 'status', label: 'Status', type: 'select', default: 'todo', options: Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label })) },
  ];
}

function openTaskForm(task) {
  openForm({
    title: task ? 'Edit task' : 'New study task',
    submitLabel: task ? 'Save changes' : 'Add task',
    fields: taskFields(),
    values: task || { due_date: todayISO(), subject_id: state.taskFilters.subject_id },
    onSubmit: async (v) => {
      const payload = { ...v, subject_id: v.subject_id ? Number(v.subject_id) : null, due_date: v.due_date || null };
      if (task) await api(`/api/tasks/${task.id}`, { method: 'PUT', body: payload });
      else await api('/api/tasks', { method: 'POST', body: payload });
      toast(task ? 'Task updated' : 'Task added');
      rerender();
    },
  });
}

async function renderPlanner(view) {
  await loadSubjects();
  const f = state.taskFilters;
  const qs = new URLSearchParams();
  if (f.priority) qs.set('priority', f.priority);
  if (f.subject_id) qs.set('subject_id', f.subject_id);
  const { tasks } = await api(`/api/tasks?${qs}`);
  setActions('<button class="btn btn-primary" data-act="add-task">+ Task</button>');

  const counts = { '': tasks.length, todo: 0, in_progress: 0, done: 0 };
  tasks.forEach((t) => { counts[t.status] += 1; });
  const shown = f.status ? tasks.filter((t) => t.status === f.status) : tasks;
  const pct = tasks.length ? Math.round((counts.done / tasks.length) * 100) : 0;

  view.innerHTML = `
  <div class="card card-pad" style="display:grid;gap:14px">
    <div class="toolbar">
      <div class="chips" role="tablist">
        ${[['', 'All'], ['todo', 'To do'], ['in_progress', 'In progress'], ['done', 'Done']].map(([v, l]) =>
    `<button class="chip ${f.status === v ? 'active' : ''}" data-status-filter="${v}">${l}<span class="count">${counts[v]}</span></button>`).join('')}
      </div>
      <div class="filters">
        <select id="f-priority" aria-label="Filter by priority"><option value="">Any priority</option>
          ${['high', 'medium', 'low'].map((p) => `<option value="${p}" ${f.priority === p ? 'selected' : ''}>${p[0].toUpperCase() + p.slice(1)} priority</option>`).join('')}</select>
        <select id="f-subject" aria-label="Filter by subject"><option value="">All subjects</option>
          ${state.subjects.map((s) => `<option value="${s.id}" ${String(f.subject_id) === String(s.id) ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:12px"><div class="progress" style="flex:1"><div style="width:${pct}%"></div></div>
      <span class="muted mono" style="font-size:13px">${counts.done}/${tasks.length} done · ${pct}%</span></div>
  </div>

  <div class="card">
    ${shown.length ? `<ul class="list">${shown.map((t) => {
    const done = t.status === 'done';
    const due = dueInfo(t.due_date, done);
    return `<li class="list-item ${done ? 'task-done' : ''}">
        <input type="checkbox" class="check" data-toggle="${t.id}" ${done ? 'checked' : ''} aria-label="Toggle ${esc(t.title)}">
        <div class="grow">
          <div class="title">${esc(t.title)}</div>
          <div class="meta">${subjectPill(t.subject_name, t.subject_color)}<span class="${due.cls}">${due.text}</span>
            ${t.description ? `<span>· ${esc(t.description)}</span>` : ''}</div>
        </div>
        <span class="tag tag-${t.priority}">${t.priority}</span>
        <select class="inline-select" data-set-status="${t.id}" aria-label="Status">
          ${Object.entries(STATUS_LABEL).map(([v, l]) => `<option value="${v}" ${t.status === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <button class="icon-btn" data-edit-task="${t.id}" title="Edit">✎</button>
        <button class="icon-btn danger" data-del-task="${t.id}" title="Delete">✕</button>
      </li>`;
  }).join('')}</ul>` : emptyState('No tasks match', 'Add a task or change the filters.')}
  </div>`;

  view.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    try {
      if (d.statusFilter !== undefined) { f.status = d.statusFilter; rerender(); } else if (d.editTask) openTaskForm(tasks.find((t) => t.id === Number(d.editTask)));
      else if (d.delTask && await askConfirm('this task')) { await api(`/api/tasks/${d.delTask}`, { method: 'DELETE' }); toast('Task deleted'); rerender(); }
    } catch (err) { toast(err.message, 'error'); }
  };
  view.onchange = async (e) => {
    const el = e.target;
    try {
      if (el.dataset.toggle) {
        const { task } = await api(`/api/tasks/${el.dataset.toggle}/toggle`, { method: 'POST' });
        toast(task.status === 'done' ? 'Nice work — task done ✓' : 'Task reopened');
        rerender();
      } else if (el.dataset.setStatus) {
        await api(`/api/tasks/${el.dataset.setStatus}`, { method: 'PATCH', body: { status: el.value } });
        toast(`Moved to “${STATUS_LABEL[el.value]}”`); rerender();
      } else if (el.id === 'f-priority') { f.priority = el.value; rerender(); } else if (el.id === 'f-subject') { f.subject_id = el.value; rerender(); }
    } catch (err) { toast(err.message, 'error'); rerender(); }
  };
}

// =================================================================== EXAMS
function countdownParts(iso) {
  const diff = new Date(iso) - new Date();
  if (Number.isNaN(diff)) return null;
  if (diff <= 0) return { past: true, d: 0, h: 0, m: 0, s: 0, diff };
  const s = Math.floor(diff / 1000);
  return { past: false, d: Math.floor(s / 86400), h: Math.floor((s % 86400) / 3600), m: Math.floor((s % 3600) / 60), s: s % 60, diff };
}

function tickCountdowns() {
  $$('[data-countdown]').forEach((el) => {
    const p = countdownParts(el.dataset.countdown);
    if (!p) return;
    if (el.classList.contains('countdown')) {
      ['d', 'h', 'm', 's'].forEach((u) => { const n = el.querySelector(`[data-u="${u}"]`); if (n) n.textContent = u === 'd' ? p[u] : pad(p[u]); });
      const card = el.closest('.exam-card');
      if (card) {
        card.classList.toggle('exam-past', p.past);
        card.classList.toggle('exam-urgent', !p.past && p.diff < 3 * 86400000);
        const st = card.querySelector('[data-exam-status]');
        if (st) st.innerHTML = p.past ? '<span class="tag tag-neutral">Finished</span>'
          : p.diff < 86400000 ? '<span class="tag tag-high">Tomorrow / today</span>'
            : p.diff < 7 * 86400000 ? '<span class="tag tag-medium">This week</span>' : '<span class="tag tag-low">Upcoming</span>';
      }
    } else {
      el.textContent = p.past ? 'Started' : `${p.d}d ${pad(p.h)}h ${pad(p.m)}m ${pad(p.s)}s`;
    }
  });
}

function examFields() {
  const d = new Date(Date.now() + 7 * 86400000);
  return [
    { name: 'title', label: 'Exam', required: true, maxlength: 120, full: true, placeholder: 'e.g. Physics final' },
    { name: 'subject_id', label: 'Subject', type: 'select', options: subjectOptions() },
    { name: 'exam_at', label: 'Date & time', type: 'datetime-local', required: true, default: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T09:00` },
    { name: 'location', label: 'Location', maxlength: 120, full: true, placeholder: 'Room / building' },
    { name: 'notes', label: 'Notes', type: 'textarea', maxlength: 1000, full: true },
  ];
}

function openExamForm(exam) {
  openForm({
    title: exam ? 'Edit exam' : 'New exam countdown',
    submitLabel: exam ? 'Save changes' : 'Start countdown',
    fields: examFields(),
    values: exam || {},
    onSubmit: async (v) => {
      const payload = { ...v, subject_id: v.subject_id ? Number(v.subject_id) : null };
      if (exam) await api(`/api/exams/${exam.id}`, { method: 'PUT', body: payload });
      else await api('/api/exams', { method: 'POST', body: payload });
      toast(exam ? 'Exam updated' : 'Countdown started');
      rerender();
    },
  });
}

async function renderExams(view) {
  const [{ exams }] = await Promise.all([api('/api/exams'), loadSubjects()]);
  setActions('<button class="btn btn-primary" data-act="add-exam">+ Exam</button>');
  const now = new Date();
  const upcoming = exams.filter((e) => new Date(e.exam_at) > now);
  const past = exams.filter((e) => new Date(e.exam_at) <= now).reverse();

  const card = (e) => `
    <article class="card exam-card" style="--exam-color:${esc(e.subject_color || 'var(--accent)')}">
      <div class="exam-head">
        <div><h3>${esc(e.title)}</h3><div style="margin-top:4px">${subjectPill(e.subject_name, e.subject_color)}</div></div>
        <div data-exam-status></div>
      </div>
      <div class="countdown" data-countdown="${esc(e.exam_at)}" aria-label="Time remaining">
        ${[['d', 'days'], ['h', 'hours'], ['m', 'min'], ['s', 'sec']].map(([u, l]) => `<div class="cd-unit"><div class="cd-num" data-u="${u}">–</div><div class="cd-lbl">${l}</div></div>`).join('')}
      </div>
      <div class="exam-meta">
        <span>📅 ${fmtDateTime(e.exam_at)}</span>
        ${e.location ? `<span>📍 ${esc(e.location)}</span>` : ''}
        ${e.notes ? `<span>📝 ${esc(e.notes)}</span>` : ''}
      </div>
      <div style="display:flex;gap:6px;justify-content:flex-end">
        <button class="btn btn-ghost btn-sm" data-edit-exam="${e.id}">Edit</button>
        <button class="btn btn-danger btn-sm" data-del-exam="${e.id}">Delete</button>
      </div>
    </article>`;

  view.innerHTML = `
    ${upcoming.length ? `<div class="exam-grid">${upcoming.map(card).join('')}</div>`
    : `<div class="card">${emptyState('No upcoming exams', 'Add an exam date to start a live countdown.')}</div>`}
    ${past.length ? `<h2 style="font-size:16px;margin-top:8px" class="muted">Past exams</h2><div class="exam-grid">${past.map(card).join('')}</div>` : ''}`;

  view.onclick = async (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    try {
      if (b.dataset.editExam) openExamForm(exams.find((x) => x.id === Number(b.dataset.editExam)));
      else if (b.dataset.delExam && await askConfirm('this exam')) { await api(`/api/exams/${b.dataset.delExam}`, { method: 'DELETE' }); toast('Exam deleted'); rerender(); }
    } catch (err) { toast(err.message, 'error'); }
  };
  tickCountdowns();
}

// =============================================================== RESOURCES
let resourceCategories = [];

function resourceFields(kind, existing) {
  const cats = [...new Set([...DEFAULT_CATEGORIES, ...resourceCategories])];
  const fields = [{ name: 'title', label: 'Title', required: true, maxlength: 150, full: true }];
  if (kind === 'link') fields.push({ name: 'url', label: 'URL', type: 'url', required: !existing, full: true, placeholder: 'https://…' });
  if (kind === 'file' && !existing) fields.push({ name: 'file', label: 'File', type: 'file', required: true, full: true, hint: '(max 16 MB · pdf, docx, pptx, images, zip…)', accept: '.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.csv,.txt,.md,.png,.jpg,.jpeg,.gif,.webp,.zip,.py,.ipynb,.odt,.odp' });
  fields.push(
    { name: 'category', label: 'Category', list: cats, default: 'Notes', maxlength: 50, placeholder: 'Pick or type a new one' },
    { name: 'subject_id', label: 'Subject', type: 'select', options: subjectOptions() },
    { name: 'notes', label: 'Notes', type: 'textarea', maxlength: 1000, full: true },
  );
  return fields;
}

function openResourceForm(kind, res) {
  openForm({
    title: res ? 'Edit resource' : kind === 'file' ? 'Upload a file' : 'Save a link',
    submitLabel: res ? 'Save changes' : kind === 'file' ? 'Upload' : 'Save link',
    fields: resourceFields(kind, res),
    values: res || { subject_id: state.resFilters.subject_id, category: state.resFilters.category || 'Notes' },
    onSubmit: async (v) => {
      if (res) {
        await api(`/api/resources/${res.id}`, { method: 'PUT', body: { ...v, subject_id: v.subject_id ? Number(v.subject_id) : null } });
      } else if (kind === 'file') {
        if (!v.file || !v.file.size) throw new Error('Please choose a file.');
        if (v.file.size > 16 * 1024 * 1024) throw new Error('File is larger than 16 MB.');
        const fd = new FormData();
        Object.entries(v).forEach(([k, val]) => { if (val !== null && val !== '') fd.append(k, val); });
        await api('/api/resources', { method: 'POST', form: fd });
      } else {
        await api('/api/resources', { method: 'POST', body: { ...v, subject_id: v.subject_id ? Number(v.subject_id) : null } });
      }
      toast(res ? 'Resource updated' : 'Resource saved');
      loadResourceList();
    },
  });
}

let lastResources = [];

async function loadResourceList() {
  const f = state.resFilters;
  const qs = new URLSearchParams();
  if (f.category) qs.set('category', f.category);
  if (f.subject_id) qs.set('subject_id', f.subject_id);
  if (f.q) qs.set('q', f.q);
  const { resources, categories } = await api(`/api/resources?${qs}`);
  lastResources = resources;
  resourceCategories = categories;
  if (f.category && !categories.includes(f.category)) { f.category = ''; return loadResourceList(); }

  const chips = $('#res-chips');
  const list = $('#res-list');
  if (!chips || !list) return null;
  chips.innerHTML = [['', 'All'], ...categories.map((c) => [c, c])].map(([v, l]) =>
    `<button class="chip ${f.category === v ? 'active' : ''}" data-cat="${esc(v)}">${esc(l)}</button>`).join('');

  if (!resources.length) {
    list.innerHTML = `<div class="card" style="grid-column:1/-1">${emptyState('Nothing here yet', f.q || f.category || f.subject_id ? 'Try different filters.' : 'Save a link or upload a file to build your library.')}</div>`;
    return null;
  }
  list.innerHTML = resources.map((r) => {
    let host = '';
    if (r.kind === 'link') { try { host = new URL(r.url).hostname.replace(/^www\./, ''); } catch { host = r.url; } }
    const ext = r.kind === 'file' ? (r.original_name.split('.').pop() || 'file').slice(0, 4).toUpperCase() : '↗';
    const href = r.kind === 'link' ? r.url : `/api/resources/${r.id}/file`;
    return `<article class="card res-card">
      <div class="res-top">
        <div class="res-ico" style="${r.subject_color ? `background:${esc(r.subject_color)}22;color:${esc(r.subject_color)}` : ''};font-size:${r.kind === 'file' ? '11px' : '18px'}">${esc(ext)}</div>
        <div style="min-width:0;flex:1">
          <a class="res-title" href="${esc(href)}" target="_blank" rel="noopener noreferrer" style="color:inherit;text-decoration:none">${esc(r.title)}</a>
          <div class="res-host">${r.kind === 'link' ? esc(host) : `${esc(r.original_name)} · ${fmtSize(r.file_size)}`}</div>
        </div>
      </div>
      ${r.notes ? `<p class="res-notes">${esc(r.notes)}</p>` : ''}
      <div class="res-foot">
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="tag tag-accent">${esc(r.category)}</span>${subjectPill(r.subject_name, r.subject_color)}</div>
        <div>
          <a class="icon-btn" href="${esc(href)}${r.kind === 'file' ? '?download=1' : ''}" ${r.kind === 'link' ? 'target="_blank" rel="noopener noreferrer"' : ''} title="${r.kind === 'file' ? 'Download' : 'Open link'}">${r.kind === 'file' ? '⤓' : '↗'}</a>
          <button class="icon-btn" data-edit-res="${r.id}" title="Edit">✎</button>
          <button class="icon-btn danger" data-del-res="${r.id}" title="Delete">✕</button>
        </div>
      </div>
    </article>`;
  }).join('');
  return null;
}

async function renderResources(view) {
  await loadSubjects();
  const f = state.resFilters;
  setActions('<button class="btn btn-ghost" data-act="add-file">⤒ Upload file</button><button class="btn btn-primary" data-act="add-link">+ Link</button>');
  view.innerHTML = `
    <div class="card card-pad" style="display:grid;gap:14px">
      <div class="toolbar">
        <input id="res-search" type="search" placeholder="Search title or notes…" value="${esc(f.q)}" style="flex:1;min-width:200px">
        <select id="res-subject" aria-label="Filter by subject"><option value="">All subjects</option>
          ${state.subjects.map((s) => `<option value="${s.id}" ${String(f.subject_id) === String(s.id) ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
      </div>
      <div class="chips" id="res-chips"></div>
    </div>
    <div class="res-grid" id="res-list"><div class="loading"><span class="spinner"></span></div></div>`;

  const search = debounce(() => loadResourceList().catch((err) => toast(err.message, 'error')), 300);
  view.oninput = (e) => { if (e.target.id === 'res-search') { f.q = e.target.value.trim(); search(); } };
  view.onchange = (e) => { if (e.target.id === 'res-subject') { f.subject_id = e.target.value; loadResourceList(); } };
  view.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    try {
      if (d.cat !== undefined) { f.category = d.cat; await loadResourceList(); } else if (d.editRes) {
        const r = lastResources.find((x) => x.id === Number(d.editRes));
        openResourceForm(r.kind, r);
      } else if (d.delRes && await askConfirm('this resource')) {
        await api(`/api/resources/${d.delRes}`, { method: 'DELETE' }); toast('Resource deleted'); await loadResourceList();
      }
    } catch (err) { toast(err.message, 'error'); }
  };
  await loadResourceList();
}

// ================================================================== ROUTER
const ROUTES = {
  dashboard: { title: 'Dashboard', sub: () => `Welcome back, ${state.user.full_name.split(' ')[0]} — here’s your academic snapshot.`, render: renderDashboard },
  grades: { title: 'Grades & GPA', sub: () => 'Weighted averages using subject coefficients and assessment multipliers.', render: renderGrades },
  planner: { title: 'Revision planner', sub: () => 'Plan, prioritise and tick off your study tasks.', render: renderPlanner },
  exams: { title: 'Exam countdowns', sub: () => 'Live timers for every exam on your calendar.', render: renderExams },
  resources: { title: 'Resource library', sub: () => 'Links and files for your study material, sorted by category.', render: renderResources },
};
let renderToken = 0;

function setActions(html) { $('#page-actions').innerHTML = html; }

function currentRoute() {
  const r = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('?')[0];
  return ROUTES[r] ? r : 'dashboard';
}

async function rerender() {
  if (!state.user) return;
  const name = currentRoute();
  const route = ROUTES[name];
  const view = $('#view');
  const token = ++renderToken;
  $$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === name));
  $('#page-title').textContent = route.title;
  $('#page-sub').textContent = route.sub();
  document.title = `${route.title} · StudySync`;
  view.onclick = view.onchange = view.oninput = null;
  if (!view.children.length || view.dataset.route !== name) {
    view.innerHTML = '<div class="loading"><span class="spinner"></span></div>';
    setActions('');
  }
  view.dataset.route = name;
  try {
    const scrollY = window.scrollY;
    await route.render(view);
    if (token !== renderToken) return;
    window.scrollTo(0, scrollY);
  } catch (err) {
    if (err.status === 401) return;
    view.innerHTML = `<div class="card">${emptyState('Something went wrong', err.message)}</div>`;
  }
}

// ==================================================================== AUTH
function showAuth() {
  state.user = null;
  $('#app-shell').hidden = true;
  $('#auth-screen').hidden = false;
  document.title = 'StudySync — Academic Performance Tracker';
}

function showApp(user) {
  state.user = user;
  $('#auth-screen').hidden = true;
  $('#app-shell').hidden = false;
  $('#user-name').textContent = user.full_name;
  $('#user-email').textContent = user.email;
  $('#user-avatar').textContent = user.full_name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  if (!location.hash) location.hash = '#dashboard';
  rerender();
}

function initAuth() {
  $$('[data-auth-tab]').forEach((tab) => tab.addEventListener('click', () => {
    $$('[data-auth-tab]').forEach((t) => t.classList.toggle('active', t === tab));
    $('#login-form').hidden = tab.dataset.authTab !== 'login';
    $('#register-form').hidden = tab.dataset.authTab !== 'register';
  }));
  const handle = (formSel, path) => $(formSel).addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const err = form.querySelector('.form-error');
    err.textContent = '';
    if (!form.checkValidity()) {
      const bad = form.querySelector(':invalid');
      err.textContent = bad.validationMessage; bad.focus(); return;
    }
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const { user } = await api(path, { method: 'POST', body: Object.fromEntries(new FormData(form)) });
      form.reset();
      showApp(user);
    } catch (ex) { err.textContent = ex.message; } finally { btn.disabled = false; }
  });
  handle('#login-form', '/api/auth/login');
  handle('#register-form', '/api/auth/register');
}

function openSettings() {
  openForm({
    title: 'Account settings',
    fields: [
      { name: 'full_name', label: 'Full name', required: true, maxlength: 100, full: true },
      { name: 'grade_scale', label: 'Grading scale', type: 'select', full: true, options: [
        { value: 20, label: 'Out of 20 (French / Tunisian system)' }, { value: 100, label: 'Out of 100 (percentage)' },
        { value: 10, label: 'Out of 10' }, { value: 4, label: 'Out of 4 (GPA)' },
        ...([20, 100, 10, 4].includes(Number(state.user.grade_scale)) ? [] : [{ value: state.user.grade_scale, label: `Out of ${state.user.grade_scale}` }]),
      ] },
    ],
    values: { ...state.user, grade_scale: Number(state.user.grade_scale) },
    onSubmit: async (v) => {
      const { user } = await api('/api/auth/me', { method: 'PATCH', body: { full_name: v.full_name, grade_scale: Number(v.grade_scale) } });
      toast('Settings saved');
      showApp(user);
    },
  });
}

// =================================================================== THEME
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('ss-theme', theme); } catch { /* storage unavailable */ }
}
function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('ss-theme'); } catch { /* ignore */ }
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = saved || (prefersDark ? 'dark' : 'light');
  $('#theme-toggle').addEventListener('click', () =>
    applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
}

// ==================================================================== BOOT
async function boot() {
  initTheme();
  initModal();
  initAuth();

  const sidebar = $('#sidebar');
  const scrim = $('#scrim');
  const closeMenu = () => { sidebar.classList.remove('open'); scrim.hidden = true; };
  $('#menu-btn').addEventListener('click', () => { sidebar.classList.add('open'); scrim.hidden = false; });
  scrim.addEventListener('click', closeMenu);
  $$('.nav a').forEach((a) => a.addEventListener('click', closeMenu));

  $('#logout-btn').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
    showAuth();
  });
  $('#user-chip').addEventListener('click', openSettings);

  // Page-level action buttons in the top bar
  $('#page-actions').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    ({
      'add-subject': () => openSubjectForm(),
      'add-grade': () => openGradeForm(),
      'add-task': () => openTaskForm(),
      'add-exam': () => openExamForm(),
      'add-link': () => openResourceForm('link'),
      'add-file': () => openResourceForm('file'),
    })[act]?.();
  });

  window.addEventListener('hashchange', () => { $('#view').innerHTML = ''; rerender(); });
  setInterval(tickCountdowns, 1000);

  try {
    const { user } = await api('/api/auth/me');
    showApp(user);
  } catch {
    showAuth();
  }
}

document.addEventListener('DOMContentLoaded', boot);
