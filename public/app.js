'use strict';

const state = {
  me: null,
  positions: [],
  draft: null,
  live: null,
  versions: [],
  detail: null,
  editingCueId: null,
  handover: null,
  handoverLoading: false,
  deputies: null,
  skipPreview: null,
  whatifInputs: new Map(),
  reviewEnv: null,
  notices: null,
  detailNotices: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

// ---------- API ----------

async function api(method, url, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON */ }
  if (res.status === 401) {
    showLogin();
    throw new Error(data?.message || '未登录');
  }
  if (!res.ok) {
    const err = new Error(data?.message || `请求失败 (${res.status})`);
    err.status = res.status;
    err.data = data || {};
    throw err;
  }
  return data;
}

let alertTimer = null;
function alertBar(kind, message, ms = 5000) {
  const bar = $('#alert-bar');
  bar.className = `alert ${kind}`;
  bar.innerHTML = message;
  bar.hidden = false;
  clearTimeout(alertTimer);
  if (ms) alertTimer = setTimeout(() => { bar.hidden = true; }, ms);
}

function errorToHtml(err) {
  const d = err.data || {};
  let html = `<strong>${esc(err.message)}</strong>`;
  if (d.errors?.length) {
    html += '<ul>' + d.errors.map((e) => `<li>[${esc(e.type)}] ${esc(e.message)}</li>`).join('') + '</ul>';
  }
  if (Array.isArray(d.items) && d.items.length) {
    html += '<ul>' + d.items.map((it) => `<li>${esc(it.code || ('引用#' + it.cueRef))}：${esc(it.reason)}</li>`).join('') + '</ul>';
  }
  if (d.currentVersion !== undefined) html += `<div class="muted">请刷新草稿获取最新数据后再提交。</div>`;
  return html;
}

// ---------- 登录 / 启动 ----------

function showLogin() {
  $('#app-view').hidden = true;
  $('#login-view').hidden = false;
}

function showApp() {
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  const isSM = state.me.role === 'sm';
  const tabs = isSM
    ? [['draft', '草稿编辑'], ['live', '现场联排'], ['versions', '发布版本']]
    : [['live', '现场联排'], ['versions', '发布版本']];
  $('#tabs').innerHTML = tabs.map(([k, label], i) =>
    `<button data-tab="${k}" class="${i === 0 ? 'active' : ''}">${label}</button>`).join('');
  $('#user-tag').innerHTML =
    `<span class="role-tag ${isSM ? 'sm' : ''}">${isSM ? '舞监' : esc(state.me.position) + '执行'}</span>
     ${esc(state.me.displayName)}（${esc(state.me.username)}）`;
  switchTab(isSM ? 'draft' : 'live');
}

function switchTab(tab) {
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  ['draft', 'live', 'versions'].forEach((t) => { $('#tab-' + t).hidden = t !== tab; });
  if (tab === 'draft') loadDraft().catch((e) => alertBar('error', errorToHtml(e)));
  if (tab === 'live') loadLive().catch((e) => alertBar('error', errorToHtml(e)));
  if (tab === 'versions') loadVersions().catch((e) => alertBar('error', errorToHtml(e)));
}

$('#login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('#login-error').hidden = true;
  const fd = new FormData(ev.target);
  try {
    const { user } = await api('POST', '/api/login', {
      username: fd.get('username'), password: fd.get('password'),
    });
    state.me = user;
    showApp();
  } catch (e) {
    const box = $('#login-error');
    box.textContent = e.message;
    box.hidden = false;
  }
});

$('#logout-btn').addEventListener('click', async () => {
  await api('POST', '/api/logout');
  state.me = null;
  showLogin();
});

$('#tabs').addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-tab]');
  if (btn) switchTab(btn.dataset.tab);
});

// ---------- 舞监：草稿 ----------

async function loadDraft() {
  state.draft = await api('GET', '/api/draft');
  state.positions = state.draft.positions;
  renderDraft();
  loadHandover().catch((e) => {
    state.handover = null;
    renderHandover(`<span class="muted">交接预览加载失败：${esc(e.message)}</span>`);
  });
}

async function loadDraftFresh() {
  return api('GET', '/api/draft');
}

// ---------- 舞监：发布前交接预览 ----------

async function loadHandover() {
  state.handoverLoading = true;
  try {
    state.handover = await api('GET', '/api/publish/handover/preview');
    renderHandover();
  } finally {
    state.handoverLoading = false;
  }
}

function handoverRowHtml(it, eligible) {
  const check = eligible
    ? `<input type="checkbox" data-act="pick-handover" data-ref="${it.cueRef}" ${it.selected ? 'checked' : ''} />`
    : '<span class="muted">不可选</span>';
  const reason = eligible ? '' : `<ul class="ho-reasons">${
    (it.reasons || []).map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`;
  return `<tr class="${eligible ? 'ho-eligible' : 'ho-ineligible'}">
    <td>${check}</td>
    <td><strong>${esc(it.code)}</strong></td>
    <td>${esc(it.title || '')}</td>
    <td>${esc(it.position)}</td>
    <td class="mono">${esc(it.actualStartText)} - ${esc(it.actualEndText)}</td>
    <td class="mono">v${it.rowVer}</td>
    <td>${reason || '<span class="muted">编号/说明/岗位/计划开始/时长/前置集合一致，且旧登记已完成</span>'}</td>
  </tr>`;
}

function renderHandover(errorHtml) {
  const box = $('#handover-body');
  if (!box) return;
  if (errorHtml) { box.innerHTML = errorHtml; return; }
  const h = state.handover;
  if (!h) { box.innerHTML = '<span class="muted">加载中…</span>'; return; }
  if (!h.oldVersion) {
    box.innerHTML = '<div class="muted">尚无旧执行版（首次发布），没有可交接的已完成登记。</div>';
    return;
  }
  const stale = h.draftVersion !== state.draft?.version;
  const total = h.eligible.length + h.ineligible.length;
  const head = `
    <div class="ho-meta">
      旧执行版：<strong>第 ${h.oldVersion.versionNo} 版</strong> ${esc(h.oldVersion.note || '')}
      <span class="muted">发布于 ${esc(h.oldVersion.createdAt)}</span>
      ｜预览基于草稿 v${h.draftVersion}${stale ? '<strong class="ho-stale"> · 草稿已变化，请重新预览</strong>' : ''}
      ｜已完成项 ${total} 项，可延续 ${h.eligible.length} 项
    </div>`;
  if (total === 0) {
    box.innerHTML = head + '<div class="muted">旧执行版中没有同时具备实际开始与实际完成的提示项，无可交接登记。</div>';
    return;
  }
  const eligibleRows = h.eligible.map((it) => handoverRowHtml(it, true)).join('');
  const ineligibleRows = h.ineligible.map((it) => handoverRowHtml(it, false)).join('');
  const allSelected = h.eligible.length > 0 && h.eligible.every((it) => it.selected);
  box.innerHTML = `${head}
    <div class="table-wrap ho-table-wrap">
      <table>
        <thead><tr>
          <th><input type="checkbox" id="ho-select-all" title="全选/全不选可延续项" ${allSelected ? 'checked' : ''} /></th>
          <th>编号</th><th>说明</th><th>岗位</th><th>旧版实际开始-完成</th><th>行版本</th><th>交接资格 / 不合格原因</th>
        </tr></thead>
        <tbody>${eligibleRows}${ineligibleRows}</tbody>
      </table>
    </div>
    <div class="muted">勾选的项在发布时仅带入<strong>实际开始、实际完成</strong>（不带预计结束）；未选项保持空登记。延续而来的登记会在新版标明来源版本与提示项，旧版登记与更正历史仍可回看，已发布计划保持冻结。</div>`;
}

function cueLabel(c) {
  return `${c.code}${c.title ? ' ' + c.title : ''}（${c.position} ${c.plannedStartText}）`;
}

function renderValidation(v) {
  const panel = $('#validation-panel');
  if (v.ok) {
    panel.innerHTML = `<div class="val-ok">✅ 计划校验通过：前置顺序、同岗位时段、依赖环、共享资源容量检查均无问题，可以发布。</div>`;
  } else {
    panel.innerHTML = `<div class="val-err"><strong>⚠ ${v.errors.length} 项冲突，无法发布：</strong><ul>${
      v.errors.map((e) => `<li>${esc(e.message)}</li>`).join('')
    }</ul></div>`;
  }
}

// ---------- 舞监：共享资源（草稿配置） ----------

function renderResources() {
  const d = state.draft;
  const tbody = $('#draft-resource-tbody');
  if (!tbody) return;
  tbody.innerHTML = (d.resources || []).map((r) => `
    <tr>
      <td><strong>${esc(r.name)}</strong></td>
      <td class="mono">${r.capacity}</td>
      <td>${r.cueCount ? `<span class="res-ref-count" title="仍被提示项引用，不能删除">${r.cueCount} 项引用</span>` : '<span class="muted">未被引用</span>'}</td>
      <td>
        <button class="ghost tiny" data-act="edit-resource" data-id="${r.id}">编辑</button>
        <button class="ghost tiny" data-act="del-resource" data-id="${r.id}" data-name="${esc(r.name)}" ${r.cueCount ? 'disabled title="仍被提示项引用，不能删除"' : ''}>删除</button>
      </td>
    </tr>`).join('')
    || '<tr><td colspan="4" class="muted">尚未配置共享资源。可新增如「无线麦（容量 2）」，并在提示项表单填写占用量。</td></tr>';
}

function renderCueResourceFields(cue) {
  const box = $('#cue-resource-fields');
  if (!box) return;
  const resources = state.draft?.resources || [];
  if (!resources.length) {
    box.innerHTML = '<span class="muted">尚无共享资源，请先在下方「联排共享资源」区新增。</span>';
    return;
  }
  const usageById = new Map((cue?.resourceUsages || []).map((u) => [u.resourceId, u.usage]));
  box.innerHTML = resources.map((r) => `
    <label class="cue-resource-item">${esc(r.name)}
      <small class="muted">容量 ${r.capacity}</small>
      <input type="number" min="1" step="1" data-resource-id="${r.id}" class="cue-resource-input"
             value="${usageById.has(r.id) ? usageById.get(r.id) : ''}" placeholder="占用量" />
    </label>`).join('');
}

function collectCueResources() {
  const resources = [];
  for (const inp of $$('.cue-resource-input')) {
    const val = inp.value.trim();
    if (val === '') continue;
    resources.push({ resourceId: Number(inp.dataset.resourceId), usage: Number(val) });
  }
  return resources;
}

function resetResourceForm() {
  const form = $('#resource-form');
  form.reset();
  form.elements.id.value = '';
  $('#resource-submit').textContent = '新增资源';
  $('#resource-cancel').hidden = true;
}

$('#resource-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  if (!state.draft) return;
  const f = ev.target;
  const id = f.elements.id.value;
  const payload = {
    version: state.draft.version,
    name: f.elements.name.value.trim(),
    capacity: Number(f.elements.capacity.value),
  };
  try {
    if (id) {
      state.draft = await api('PUT', `/api/draft/resources/${id}`, payload);
      alertBar('ok', '共享资源已更新，草稿版本号 v' + state.draft.version);
    } else {
      state.draft = await api('POST', '/api/draft/resources', payload);
      alertBar('ok', '共享资源已新增，草稿版本号 v' + state.draft.version);
    }
    resetResourceForm();
    renderDraft();
  } catch (e) {
    alertBar('error', errorToHtml(e));
    if (e.status === 409) loadDraft().then(renderDraft).catch(() => {});
  }
});

$('#resource-cancel').addEventListener('click', resetResourceForm);

$('#draft-resource-tbody').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const r = (state.draft?.resources || []).find((x) => x.id === id);
  if (!r) return;
  if (btn.dataset.act === 'edit-resource') {
    const f = $('#resource-form');
    f.elements.id.value = r.id;
    f.elements.name.value = r.name;
    f.elements.capacity.value = r.capacity;
    $('#resource-submit').textContent = '保存修改';
    $('#resource-cancel').hidden = false;
  } else if (btn.dataset.act === 'del-resource') {
    if (r.cueCount > 0) {
      alertBar('error', `共享资源「${r.name}」仍被 ${r.cueCount} 个提示项引用，请先移除这些提示项的占用再删除。`);
      return;
    }
    if (!confirm(`确认删除共享资源「${r.name}」？`)) return;
    try {
      state.draft = await api('DELETE', `/api/draft/resources/${id}?version=${state.draft.version}`);
      alertBar('ok', '共享资源已删除，草稿版本号 v' + state.draft.version);
      resetResourceForm();
      renderDraft();
    } catch (e) {
      alertBar('error', errorToHtml(e));
      if (e.status === 409) loadDraft().then(renderDraft).catch(() => {});
    }
  }
});

function resourceUsageTag(list) {
  if (!list?.length) return '<span class="muted">—</span>';
  return list.map((u) =>
    `<span class="res-usage-tag" title="发布时随版本冻结">${esc(u.resourceName)} ×${u.usage}</span>`).join(' ');
}

function renderDraft() {
  const d = state.draft;
  if (!d) return;
  $('#draft-ver').textContent = `（草稿版本号 v${d.version}）`;
  renderValidation(d.validation);
  renderResources();

  const posSelect = $('#cue-position-select');
  posSelect.innerHTML = '<option value="">选择岗位</option>' +
    d.positions.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('');

  const cueOptions = d.cues.map((c) => `<option value="${c.id}">${esc(cueLabel(c))}</option>`).join('');
  $('#dep-from').innerHTML = cueOptions;
  $('#dep-to').innerHTML = cueOptions;

  const cueMap = new Map(d.cues.map((c) => [c.id, c]));
  const predsOf = new Map(d.cues.map((c) => [c.id, []]));
  for (const dep of d.deps) {
    if (predsOf.has(dep.to)) predsOf.get(dep.to).push(dep.from);
  }

  $('#draft-cue-tbody').innerHTML = d.cues.map((c) => {
    const preds = predsOf.get(c.id).map((pid) => esc(cueMap.get(pid)?.code || `#${pid}`)).join('、') || '—';
    const end = c.plannedStart + c.duration;
    return `<tr>
      <td><strong>${esc(c.code)}</strong></td>
      <td>${esc(c.title)}</td>
      <td>${esc(c.position)}</td>
      <td class="mono">${c.plannedStartText}</td>
      <td class="mono">${c.duration} 分</td>
      <td class="mono">${minText(end)}</td>
      <td class="res-usage-cell">${resourceUsageTag(c.resourceUsages)}</td>
      <td>${c.needsRelease ? '<span class="release-tag">需放行</span>' : '<span class="muted">—</span>'}</td>
      <td>${preds}</td>
      <td>
        <button class="ghost tiny" data-act="edit-cue" data-id="${c.id}">编辑</button>
        <button class="ghost tiny" data-act="del-cue" data-id="${c.id}" data-code="${esc(c.code)}">删除</button>
      </td>
    </tr>`;
  }).join('') || `<tr><td colspan="10" class="muted">暂无提示项，请在左侧新增。</td></tr>`;

  $('#dep-list').innerHTML = d.deps.map((dep) => {
    const a = cueMap.get(dep.from), b = cueMap.get(dep.to);
    return `<div class="dep-item">
      <span>${a ? esc(a.code) : '#' + dep.from} → ${b ? esc(b.code) : '#' + dep.to}</span>
      <button class="ghost tiny" data-act="del-dep" data-id="${dep.id}">移除</button>
    </div>`;
  }).join('') || '<div class="muted">暂无前置关系。</div>';

  // 未在编辑态时按最新资源列表刷新占用录入（编辑态保留当前填写，避免录入中被打断）
  if (!state.editingCueId) renderCueResourceFields(null);

  $('#publish-result').innerHTML = '';
}

function minText(min) {
  const h = String(Math.floor(min / 60)).padStart(2, '0');
  const m = String(min % 60).padStart(2, '0');
  return `${h}:${m}`;
}

function resetCueForm() {
  const form = $('#cue-form');
  form.reset();
  form.elements.id.value = '';
  form.elements.rowVersion.value = '';
  $('#cue-form-title').textContent = '新增提示项';
  $('#cue-submit').textContent = '新增';
  $('#cue-cancel').hidden = true;
  state.editingCueId = null;
  renderCueResourceFields(null);
}

$('#cue-cancel').addEventListener('click', resetCueForm);

$('#cue-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const fd = new FormData(f);
  const payload = {
    version: state.draft.version,
    code: fd.get('code'),
    title: fd.get('title'),
    position: fd.get('position'),
    plannedStartText: fd.get('plannedStartText'),
    duration: Number(fd.get('duration')),
    needsRelease: f.elements.needsRelease.checked,
    resources: collectCueResources(),
  };
  const id = fd.get('id');
  try {
    if (id) {
      payload.rowVersion = Number(fd.get('rowVersion'));
      state.draft = (await api('PUT', `/api/draft/cues/${id}`, payload));
      alertBar('ok', '提示项已更新，草稿版本号 v' + state.draft.version);
    } else {
      state.draft = await api('POST', '/api/draft/cues', payload);
      alertBar('ok', '提示项已新增，草稿版本号 v' + state.draft.version);
    }
    resetCueForm();
    renderDraft();
  } catch (e) {
    alertBar('error', errorToHtml(e));
    if (e.status === 409) loadDraft().then(renderDraft).catch(() => {});
  }
});

$('#draft-cue-tbody').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  if (act === 'edit-cue') {
    const c = state.draft.cues.find((x) => x.id === Number(btn.dataset.id));
    if (!c) return;
    const f = $('#cue-form');
    f.elements.id.value = c.id;
    f.elements.rowVersion.value = c.rowVersion;
    f.elements.code.value = c.code;
    f.elements.title.value = c.title;
    f.elements.position.value = c.position;
    f.elements.plannedStartText.value = c.plannedStartText;
    f.elements.duration.value = c.duration;
    f.elements.needsRelease.checked = !!c.needsRelease;
    renderCueResourceFields(c);
    $('#cue-form-title').textContent = `编辑提示项 ${c.code}`;
    $('#cue-submit').textContent = '保存修改';
    $('#cue-cancel').hidden = false;
    state.editingCueId = c.id;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } else if (act === 'del-cue') {
    if (!confirm(`确认删除提示项「${btn.dataset.code}」及其相关前置关系？`)) return;
    try {
      state.draft = await api('DELETE', `/api/draft/cues/${btn.dataset.id}?version=${state.draft.version}`);
      alertBar('ok', '已删除，草稿版本号 v' + state.draft.version);
      if (state.editingCueId === Number(btn.dataset.id)) resetCueForm();
      renderDraft();
    } catch (e) {
      alertBar('error', errorToHtml(e));
      if (e.status === 409) loadDraft().then(renderDraft).catch(() => {});
    }
  }
});

$('#dep-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  const from = Number(fd.get('from'));
  const to = Number(fd.get('to'));
  if (from === to) return alertBar('error', '请选择不同的前置与后项提示项');
  try {
    state.draft = await api('POST', '/api/draft/deps', { version: state.draft.version, from, to });
    alertBar('ok', '前置关系已添加，草稿版本号 v' + state.draft.version);
    renderDraft();
  } catch (e) {
    alertBar('error', errorToHtml(e));
    if (e.status === 409) loadDraft().then(renderDraft).catch(() => {});
  }
});

$('#dep-list').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-act="del-dep"]');
  if (!btn) return;
  try {
    state.draft = await api('DELETE', `/api/draft/deps/${btn.dataset.id}?version=${state.draft.version}`);
    alertBar('ok', '前置关系已移除，草稿版本号 v' + state.draft.version);
    renderDraft();
  } catch (e) {
    alertBar('error', errorToHtml(e));
    if (e.status === 409) loadDraft().then(renderDraft).catch(() => {});
  }
});

function selectedHandoverItems() {
  return (state.handover?.eligible || []).filter((it) => it.selected)
    .map((it) => ({ cueRef: it.cueRef, rowVersion: it.rowVersion }));
}

$('#handover-reload').addEventListener('click', () =>
  loadHandover().then(() => alertBar('ok', '交接预览已刷新')).catch((e) => alertBar('error', errorToHtml(e))));

$('#handover-box').addEventListener('change', (ev) => {
  const cb = ev.target;
  if (cb.id === 'ho-select-all') {
    const checked = cb.checked;
    for (const it of state.handover?.eligible || []) it.selected = checked;
    $$('#handover-box input[data-act="pick-handover"]').forEach((box) => { box.checked = checked; });
    return;
  }
  if (cb.dataset.act === 'pick-handover') {
    const ref = Number(cb.dataset.ref);
    const it = (state.handover?.eligible || []).find((x) => x.cueRef === ref);
    if (it) it.selected = cb.checked;
  }
});

$('#publish-btn').addEventListener('click', async () => {
  if (!state.draft) return;
  if (!state.draft.validation.ok) {
    alertBar('error', '当前草稿存在冲突项，请先根据上方红色提示修正后再发布。');
    return;
  }
  const payload = {
    version: state.draft.version,
    note: $('#publish-note').value.trim(),
  };
  // 已加载过交接预览：携带 handover（即使无可选项也传，保持校验闭环；加载失败时不传，维持原发布行为）
  if (state.handover && state.handover.oldVersion) {
    if (state.handover.draftVersion !== state.draft.version) {
      alertBar('error', '交接预览基于的草稿版本已过期，请点击「重新预览」后再发布。');
      return;
    }
    payload.handover = {
      oldVersionId: state.handover.oldVersion.id,
      draftVersion: state.handover.draftVersion,
      items: selectedHandoverItems(),
    };
  }
  const carried = payload.handover?.items.length || 0;
  if (!confirm(`确认发布只读联排版本？${carried ? `将延续 ${carried} 项旧版已完成登记的实际开始 / 实际完成。` : '未选择交接项，新版登记均为空。'}发布后岗位将依据新版本登记。`)) return;
  try {
    const result = await api('POST', '/api/publish', payload);
    $('#publish-note').value = '';
    const carriedMsg = result.handover?.carriedCount
      ? `，已从第 ${result.handover.sourceVersionNo} 版延续 ${result.handover.carriedCount} 项实际开始/完成` : '';
    alertBar('ok', `🎉 已发布联排第 ${result.versionNo} 版（版本号校验通过）${carriedMsg}，草稿版本已推进，请刷新视图`);
    state.draft = await loadDraftFresh();
    renderDraft();
  } catch (e) {
    if (e.status === 422) alertBar('error', errorToHtml(e), 12000);
    else alertBar('error', errorToHtml(e));
    // 发布失败（草稿/交接变化）后重新拉取草稿与交接预览
    loadDraft().then(renderDraft).catch(() => {});
  }
});

// 发布成功后草稿版本号已推进，由调用处重新拉取。

$('#draft-reload').addEventListener('click', () =>
  loadDraft().then(() => alertBar('ok', '草稿已刷新')).catch((e) => alertBar('error', errorToHtml(e))));

// ---------- 现场联排 ----------

async function loadLive() {
  const data = await api('GET', '/api/live');
  state.live = data.version;
  if (state.me.role === 'sm') {
    // 舞监代班面板数据（当前执行版岗位 + 执行账号 + 代班记录）
    try { state.deputies = await api('GET', '/api/live/deputies'); }
    catch { state.deputies = null; }
  }
  renderLive();
  loadLiveNotices().catch(() => { state.notices = null; renderChangeNoticePanel(); });
  if (state.me.role === 'sm' && state.live) {
    loadReviewLive().catch(() => { state.reviewEnv = null; renderReviewPanel(); });
  }
}

// ---------- 顺延变更待确认 ----------

async function loadLiveNotices() {
  if (!state.live) { state.notices = null; renderChangeNoticePanel(); return; }
  state.notices = await api('GET', '/api/live/change-notices');
  renderChangeNoticePanel();
}

function deltaText(n) {
  const d = n.deltaMinutes;
  const sign = d > 0 ? '+' : '';
  return `<span class="${d > 0 ? 'wi-delay' : 'wi-advance'}">${sign}${d} 分</span>`;
}

function noticeRecordRow(n, { canAck }) {
  const ackCell = n.acknowledged
    ? `<span class="badge done">已确认</span><div class="muted">${esc(n.acknowledgedBy)}（${esc(n.acknowledgedByUsername || '')}）<br>${esc(n.acknowledgedAt)}</div>`
    : (canAck
      ? `<button class="primary tiny" data-act="ack-notice" data-id="${n.id}" data-ver="${n.recordVersion}">确认</button>`
      : '<span class="badge pending">待确认</span>');
  return `<tr class="${n.acknowledged ? 'notice-acked' : 'notice-pending-row'}">
    <td><strong>${esc(n.code)}</strong><div class="muted">${esc(n.title || '')}</div></td>
    <td>${esc(n.position)}</td>
    <td class="mono">${esc(n.beforeStartText)} → <strong>${esc(n.afterStartText)}</strong> ${deltaText(n)}</td>
    <td><span class="notice-trigger">${esc(n.triggerActionLabel)}</span><div class="muted notice-detail">${esc(n.triggerDetail)}</div></td>
    <td class="mono">${esc(n.triggeredBy)}<br>${esc(n.triggeredAt)}</td>
    <td>${ackCell}<div class="muted mono">记录 v${n.recordVersion}</div></td>
  </tr>`;
}

function renderChangeNoticePanel() {
  const panel = $('#change-notice-panel');
  if (!panel) return;
  const v = state.live;
  const data = state.notices;
  if (!v || !data) { panel.hidden = true; return; }
  panel.hidden = false;
  const isSM = state.me.role === 'sm';
  const posLine = isSM && data.positions?.length
    ? `各岗位待确认：` + data.positions.map((p) => `「${esc(p.position)}」${p.pendingCount}`).join('、')
    : '';
  $('#change-notice-summary').textContent =
    `（共 ${data.total} 条，待确认 ${data.pendingCount} 条${isSM ? `；${posLine}` : ''}）`;
  const canAck = state.me.role === 'operator' && v.isLatest;
  const body = $('#change-notice-body');
  if (!data.records.length) {
    body.innerHTML = '<div class="muted">当前没有顺延变更记录。</div>';
    return;
  }
  const mine = isSM ? ''
    : `<div class="muted">仅显示你当前负责岗位（${(data.myPositions || []).map(esc).join('、') || '无'}）的记录；代班期间以当班授权为准。</div>`;
  body.innerHTML = `
    ${mine}
    <div class="table-wrap notice-table-wrap">
      <table>
        <thead><tr><th>提示项</th><th>岗位</th><th>重算开始（前 → 后）</th><th>触发操作</th><th>触发（人 / 时间）</th><th>确认</th></tr></thead>
        <tbody>${data.records.map((n) => noticeRecordRow(n, { canAck })).join('')}</tbody>
      </table>
    </div>`;
}

// 确认一条待确认（携带所见 recordVersion；归档 / 失权 / 重复 / 旧版本均由服务端拒绝）
$('#live-change-notices').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-act="ack-notice"]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const recordVersion = Number(btn.dataset.ver);
  btn.disabled = true;
  try {
    const data = await api('POST', `/api/live/change-notices/${id}/acknowledge`, { recordVersion });
    state.notices = data;
    renderChangeNoticePanel();
    alertBar('ok', '已确认该顺延变更（仅确认留痕，不改动任何登记）。');
  } catch (e) {
    alertBar('error', errorToHtml(e));
    if (e.status === 409 || e.status === 403) loadLiveNotices().catch(() => {});
    else btn.disabled = false;
  }
});

// ---------- 舞监：执行版复盘（实时预览 + 封存） ----------

async function loadReviewLive() {
  state.reviewEnv = await api('GET', '/api/live');
  renderReviewPanel();
}

function renderReviewPanel() {
  const panel = $('#review-panel');
  if (!panel) return;
  const show = state.me?.role === 'sm' && state.live && state.live.isLatest;
  panel.hidden = !show;
  if (!show) return;
  const tag = $('#review-sealed-tag');
  const env = state.reviewEnv;
  if (env?.sealed) {
    tag.innerHTML = `<span class="review-sealed-tag">🔒 本版复盘已于 ${esc(env.sealed.sealedAt)} 由 ${esc(env.sealed.sealedBy)} 封存（快照不可改写，可回看）</span>`;
  } else {
    tag.innerHTML = '<span class="muted">本版尚未封存复盘。</span>';
  }
}

function statusBadge(s) {
  if (s === 'DONE') return '<span class="badge done">已完成</span>';
  if (s === 'RUNNING') return '<span class="badge running">已开始</span>';
  if (s === 'SKIPPED') return '<span class="badge skipped">已跳过</span>';
  return '<span class="badge pending">未开始</span>';
}

// 排期来源入口：任一提示项均可查看其排期开始时刻如何形成（未开始项给出完整来源链）
function explainBtn(c, scope) {
  return `<button class="ghost tiny explain-btn" data-act="open-explain" data-scope="${scope}" data-cue="${c.id}" title="查看排期开始时刻如何形成">来源</button>`;
}

// 依赖链跳过标注（含操作者、时间、原因与触发根项）；点击可看完整原因
function skipTag(c) {
  if (!c.skip) return '';
  const tip = `已跳过：${c.skip.reason}&#10;操作者：${c.skip.skippedBy}｜时间：${c.skip.skippedAt}｜触发项：${c.skip.rootCode || ''}`;
  return `<div class="skip-tag" title="${tip}">⛔ 跳过${c.skip.rootCode && c.skip.rootCode !== c.code ? `（随 ${esc(c.skip.rootCode)}）` : ''}：${esc(c.skip.reason)}</div>`;
}

// 放行签认列：需放行项展示两类签认状态与失效原因；未标记项显示 —
function releaseCell(c) {
  const r = c.release;
  if (!r || !r.required) return '<span class="muted">—</span>';
  const slot = (label, s) => {
    if (!s || s.state === 'missing') {
      return `<div class="signoff-slot"><span class="signoff-missing">✗ ${label}：未签认</span></div>`;
    }
    if (s.state === 'valid') {
      return `<div class="signoff-slot"><span class="signoff-valid">✓ ${label}：${esc(s.signedBy)}</span><span class="muted mono"> ${esc(s.signedAt)}</span></div>`;
    }
    return `<div class="signoff-slot"><span class="signoff-invalid">⚠ ${label}签认已失效</span><div class="muted signoff-reason">${esc(s.invalidReason || '')}</div></div>`;
  };
  const histBtn = r.records?.length
    ? `<button class="ghost tiny" data-act="open-signoffs" data-cue="${c.id}">签认记录(${r.records.length})</button>` : '';
  return `<div class="signoff-cell">
    ${slot('执行人', r.operator)}
    ${slot('舞监', r.sm)}
    ${r.ready ? '<div class="signoff-ready">✅ 双签齐备，可登记开始</div>' : ''}
    ${histBtn}
  </div>`;
}

// 签认记录弹窗（现场页与回看页共用，只读）
function renderSignoffHistoryHtml(cue, v) {
  const rows = cue.release?.records || [];
  const KIND_LABEL = { operator: '执行人「就绪」', sm: '舞监「可执行」' };
  return `
    <div class="muted">
      第 ${v.versionNo} 版 · <strong>${esc(cue.code)}</strong> ${esc(cue.title || '')}（${esc(cue.position)}）
      ${v.isLatest ? '' : '· 归档版本（只读）'}
    </div>
    <div class="table-wrap corr-history">
      <table>
        <thead><tr><th>类型</th><th>签认人</th><th>时间</th><th>目标行版本</th><th>直接前置快照</th><th>状态 / 失效原因</th></tr></thead>
        <tbody>${rows.map((s) => `<tr>
          <td>${esc(KIND_LABEL[s.kind] || s.kind)}</td>
          <td>${esc(s.signedBy)}（${esc(s.signerUsername)}）</td>
          <td class="mono">${esc(s.signedAt)}</td>
          <td class="mono">v${s.targetRowVer}</td>
          <td class="mono">${s.preds.length ? s.preds.map((p) => `${esc(p.code || '#' + p.cueRef)} v${p.rowVer}`).join('、') : '（无前置）'}</td>
          <td>${s.active
            ? '<span class="badge done">有效</span>'
            : `<span class="badge pending">已失效</span><div class="muted signoff-reason">${esc(s.invalidReason || '')}</div>`}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>
    <div class="muted">签认记录随版本保存；目标或任一直接前置项登记行变化、代班变更导致签认人失去登记权，均会使签认失效，需重新签认。</div>`;
}

// 联排中断对未开始项重算开始的「不得早于恢复/停排时刻」托底标注
function pauseHoldTag(c) {
  return c.pauseHoldText ? `<div class="pause-hold" title="联排中断后重算开始不得早于该时刻">⏸ 不早于 ${esc(c.pauseHoldText)}</div>` : '';
}

// 联排中断对已开始未完成项推算 / 预计结束的顺延标注
function pauseShiftTag(c) {
  return c.pauseShiftMinutes > 0
    ? `<div class="pause-shift" title="按时长推算结束 / 停排前预计结束顺延该段中断分钟，且不早于最近恢复时刻；实际登记时间不变">⏸ 中断顺延 ${c.pauseShiftMinutes} 分</div>`
    : '';
}

function fmtInterruption(it) {
  if (it.active) {
    return `<strong class="mono">${esc(it.pauseText)}</strong> 起停排中｜原因：${esc(it.reason)}｜${esc(it.pausedBy)} 于 ${esc(it.pausedAt)} 登记`;
  }
  return `<span class="mono">${esc(it.pauseText)} – ${esc(it.resumeText)}</span>（${it.durationMinutes} 分）｜原因：${esc(it.reason)}
    ｜停排 ${esc(it.pausedBy)} ${esc(it.pausedAt)}｜恢复 ${esc(it.resumedBy)} ${esc(it.resumedAt)}`;
}

// 停排状态横幅：所有登录用户可见（执行账号与舞监）
function renderInterruptionBanner(v) {
  const box = $('#live-interruption-banner');
  if (!v) { box.innerHTML = ''; return; }
  const a = v.activeInterruption;
  if (a) {
    box.innerHTML = `<div class="pause-banner">
      <div class="pause-banner-title">⛔ 联排停排中（第 ${v.versionNo} 版）　自 <strong class="mono">${esc(a.pauseText)}</strong> 起</div>
      <div>停排原因：${esc(a.reason)}</div>
      <div class="muted">${esc(a.pausedBy)} 于 ${esc(a.pausedAt)} 登记｜恢复前不能登记开始 / 预计结束 / 完成、不能新签认，也不能发布新版；舞监更正、跳过仍可办理。</div>
    </div>`;
    return;
  }
  const past = (v.interruptions || []).filter((it) => !it.active);
  if (past.length) {
    box.innerHTML = `<div class="pause-resumed-banner">
      ✅ 联排已恢复：本版已记录 ${past.length} 段停排（最近 <strong class="mono">${esc(past[0].pauseText)}–${esc(past[0].resumeText)}</strong>，${past[0].durationMinutes} 分），未开始项排期不早于最近恢复时刻，停排前双签须重签。
    </div>`;
    return;
  }
  box.innerHTML = '';
}

// 舞监停排 / 恢复操作面板（仅当前执行版）
function renderInterruptionPanel(v) {
  const panel = $('#interruption-panel');
  const show = state.me?.role === 'sm' && v && v.isLatest;
  panel.hidden = !show;
  if (!show) return;
  const body = $('#interruption-body');
  const a = v.activeInterruption;
  const history = (v.interruptions || []).filter((it) => !it.active).slice(0, 5);
  const histHtml = history.length
    ? `<div class="pause-history"><div class="muted">本版停排记录（留痕回看）：</div>
        <ul>${history.map((it) => `<li>${fmtInterruption(it)}</li>`).join('')}</ul></div>`
    : '<div class="muted">本版暂无停排记录。</div>';
  if (a) {
    body.innerHTML = `
      <div class="pause-active-box">
        <div class="pause-banner-title">⛔ 停排中：${fmtInterruption(a)}</div>
        <form id="pause-resume-form" class="pause-form">
          <label>恢复时刻（HH:MM，严格晚于停排时刻 ${esc(a.pauseText)}）
            <input type="time" name="resumeText" required />
          </label>
          <button type="submit" class="primary">恢复联排</button>
        </form>
        <div class="muted">恢复后：未开始项重算开始不早于恢复时刻；已开始未完成项推算 / 预计结束顺延本次中断分钟且不早于恢复时刻；依赖顺延与同岗位冲突同步更新；停排前双签已失效须重签。实际登记时间不变。</div>
      </div>
      ${histHtml}`;
  } else {
    const last = history[0];
    body.innerHTML = `
      <form id="pause-start-form" class="pause-form">
        <label>停排时刻（HH:MM${last ? `，须晚于最近恢复时刻 ${last.resumeText}` : ''}）
          <input type="time" name="pauseText" required />
        </label>
        <label class="pause-reason-label">停排原因（必填，≤200 字）
          <textarea name="reason" rows="2" maxlength="200" required placeholder="如：设备故障、演员临时受伤处理"></textarea>
        </label>
        <button type="submit" class="danger">停排</button>
      </form>
      <div class="muted">停排即：清除全部未开始项的原预计结束（推进登记行版本并留痕）、停排前有效双签整体失效（保留原因）；执行岗位登记 / 新签认与发布新版在恢复前一律拒绝。</div>
      ${histHtml}`;
  }
}

function renderConflicts(conflicts) {
  const box = $('#live-conflicts');
  if (!conflicts?.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="conflict-banner"><strong>⚠ 顺延后岗位冲突 ${conflicts.length} 项：</strong><ul>${
    conflicts.map((c) => `<li>${esc(c.message)}</li>`).join('')
  }</ul></div>`;
}

// 现场共享资源超额告警（不阻止登记；跳过项不占用，仅已完成项构成的超额不展示）
function renderResourceAlerts(alerts) {
  const box = $('#live-resource-alerts');
  if (!box) return;
  if (!alerts?.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="resource-banner"><strong>🔶 共享资源超额 ${alerts.length} 项（告警不阻止登记）：</strong><ul>${
    alerts.map((a) => `<li>${esc(a.message)}</li>`).join('')
  }</ul></div>`;
}

function liveResourceCell(c) {
  return `<td class="res-usage-cell">${c.status === 'SKIPPED' ? '<span class="muted">—（跳过不占用）</span>' : resourceUsageTag(c.resourceUsages)}</td>`;
}

function renderLive() {
  const v = state.live;
  if (!v) {
    $('#live-meta').innerHTML = '<div class="muted">尚未发布任何联排版本，请等待舞监发布。</div>';
    $('#live-conflicts').innerHTML = '';
    $('#live-interruption-banner').innerHTML = '';
    $('#live-deputy-banner').innerHTML = '';
    $('#deputy-panel').hidden = true;
    $('#interruption-panel').hidden = true;
    $('#whatif-panel').hidden = true;
    $('#review-panel').hidden = true;
    $('#live-tbody').innerHTML = '';
    $('#live-resource-alerts').innerHTML = '';
    return;
  }
  $('#live-meta').innerHTML =
    `<strong>第 ${v.versionNo} 版</strong>　${esc(v.note)}　<span class="muted">发布于 ${esc(v.createdAt)}</span>
     ${v.isLatest ? '<span class="latest-tag">当前执行版本</span>' : '<span class="latest-tag" style="background:#999">非最新版本</span>'}`;
  renderConflicts(v.conflicts);
  renderResourceAlerts(v.resourceAlerts);
  renderInterruptionBanner(v);
  renderInterruptionPanel(v);
  renderDeputyBanner(v);
  renderDeputyPanel(v);

  const isOp = state.me.role === 'operator';
  const isSM = state.me.role === 'sm';
  const myPos = state.me.position;
  // 现场页面按最新授权显示可操作项：优先用服务器下发的有效岗位（含代班），兼容旧响应
  const myPositions = Array.isArray(v.myPositions) ? v.myPositions : (isOp && myPos ? [myPos] : []);
  const canReg = isOp && v.isLatest;
  const pauseActive = !!v.activeInterruption;
  $('#live-col-reg').textContent = isSM ? '签认 / 跳过 / 更正 / 预演' : '岗位登记';
  $('#sm-correct-hint').hidden = !isSM;
  const skipHint = $('#sm-skip-hint');
  if (skipHint) skipHint.hidden = !isSM;
  $('#whatif-panel').hidden = !(isSM && v.isLatest);

  const activeDepByPos = new Map((v.deputies || []).filter((d) => d.active).map((d) => [d.position, d]));

  $('#live-tbody').innerHTML = v.cues.map((c) => {
    const mine = isOp && myPositions.includes(c.position);
    const skipped = c.status === 'SKIPPED';
    const delayed = c.delayed ? `<div class="delayed">已顺延</div>` : '';
    let reg = '<span class="muted">—</span>';
    if (skipped) {
      // 跳过项只展示：执行账号无操作入口；舞监可查看原因与历史更正（不可再更正、不重复留痕）
      const histBtn = c.corrections?.length
        ? `<button class="ghost tiny" data-act="open-history" data-cue="${c.id}">更正记录(${c.corrections.length})</button>` : '';
      reg = isSM
        ? `<div class="corr-actions"><button class="ghost tiny" data-act="open-skip-view" data-cue="${c.id}">跳过原因</button>${histBtn}</div>`
        : '<span class="muted">已跳过</span>';
    } else if (pauseActive && isOp && mine) {
      // 停排期间执行岗位的开始 / 预计结束 / 完成一律不可登记（恢复后再操作）
      reg = '<span class="pause-locked">⛔ 停排中，暂停登记</span>';
    } else if (canReg && mine) {
      reg = renderRegControls(c);
    } else if (mine && isOp) {
      reg = '<span class="muted">本岗位（版本已归档）</span>';
    } else if (isOp && c.position === myPos && activeDepByPos.has(c.position)) {
      const d = activeDepByPos.get(c.position);
      reg = `<span class="muted">已由 ${esc(d.deputyDisplayName)} 代班</span>`;
    } else if (isSM) {
      reg = renderCorrectionCell(c, v, 'live');
    }
    return `<tr class="${mine ? 'own-row' : ''} ${skipped ? 'skipped-row' : ''} ${c.interrupted ? 'interrupted-row' : ''}" data-cue="${c.id}">
      <td><strong>${esc(c.code)}</strong>${c.release?.required ? '<div class="release-tag">需放行</div>' : ''}</td>
      <td>${esc(c.title)}</td>
      <td>${esc(c.position)}${deputyPosTag(activeDepByPos.get(c.position))}</td>
      <td class="mono">${c.plannedStartText} - ${minText(c.plannedStart + c.duration)}</td>
      ${liveResourceCell(c)}
      <td class="mono">${skipped ? '—' : `${c.schedStartText}${delayed}${pauseHoldTag(c)}`}<div>${explainBtn(c, 'live')}</div></td>
      <td class="mono">${skipped ? '—' : `${c.schedEndText}${pauseShiftTag(c)}`}</td>
      <td>${statusBadge(c.status)}<div class="muted">v${c.rowVer}</div></td>
      <td>${releaseCell(c)}</td>
      <td class="mono">${skipped ? '—' : (c.actualStartText ?? '—')}${handoverTag(c)}${skipTag(c)}</td>
      <td class="mono">${skipped ? '—' : (c.actualEndText ?? '—')}</td>
      <td class="mono">${skipped ? '—' : (c.estimatedEndText ?? '—')}</td>
      <td>${reg}</td>
    </tr>`;
  }).join('');
}

function deputyPosTag(dep) {
  if (!dep) return '';
  return `<div class="deputy-tag" title="${esc(dep.enabledBy)} 于 ${esc(dep.enabledAt)} 启用">代班：${esc(dep.deputyDisplayName)}</div>`;
}

// 代班横幅：执行账号识别自己的代班岗位 / 本岗位被代班；舞监看在任代班汇总
function renderDeputyBanner(v) {
  const box = $('#live-deputy-banner');
  const active = (v.deputies || []).filter((d) => d.active);
  if (!active.length) { box.innerHTML = ''; return; }
  if (state.me.role === 'operator') {
    const parts = [];
    const gains = active.filter((d) => d.deputyUsername === state.me.username && d.position !== state.me.position);
    if (gains.length) {
      parts.push(`你正在代班岗位：${gains.map((d) => `「${esc(d.position)}」（${esc(d.enabledBy)} 于 ${esc(d.enabledAt)} 启用）`).join('、')}，可登记该岗位提示项，原有岗位权限保留`);
    }
    const lost = active.find((d) => d.position === state.me.position && d.deputyUsername !== state.me.username);
    if (lost) {
      parts.push(`你的岗位「${esc(state.me.position)}」当前由 ${esc(lost.deputyDisplayName)}（${esc(lost.deputyUsername)}）代班，本岗位登记权已暂时移交`);
    }
    box.innerHTML = parts.length ? `<div class="deputy-banner">${parts.map((p) => `<div>${p}</div>`).join('')}</div>` : '';
  } else {
    box.innerHTML = `<div class="deputy-banner">在任代班 ${active.length} 项：${
      active.map((d) => `「${esc(d.position)}」→ ${esc(d.deputyDisplayName)}（${esc(d.deputyUsername)}）`).join('；')
    }</div>`;
  }
}

// 舞监：当前执行版代班管理面板
function renderDeputyPanel(v) {
  const panel = $('#deputy-panel');
  const isSM = state.me?.role === 'sm';
  panel.hidden = !isSM || !v || !v.isLatest;
  if (panel.hidden) return;
  const manage = state.deputies;
  const positions = manage?.positions || [...new Set(v.cues.map((c) => c.position))];
  $('#deputy-position').innerHTML = '<option value="">选择岗位</option>'
    + positions.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  $('#deputy-operator').innerHTML = '<option value="">选择执行账号</option>'
    + (manage?.operators || []).map((o) =>
      `<option value="${esc(o.username)}">${esc(o.displayName)}（${esc(o.username)}${o.position ? ' · ' + esc(o.position) : ''}）</option>`).join('');
  $('#deputy-tbody').innerHTML = (v.deputies || []).map((d) => `<tr>
    <td>${esc(d.position)}</td>
    <td>${esc(d.deputyDisplayName)}（${esc(d.deputyUsername)}）</td>
    <td>${d.active ? '<span class="badge running">在任</span>' : '<span class="badge pending">已撤销</span>'}</td>
    <td class="mono">${esc(d.enabledBy)}<br>${esc(d.enabledAt)}</td>
    <td class="mono">${d.active ? '—' : `${esc(d.revokedBy || '')}<br>${esc(d.revokedAt || '')}`}</td>
    <td>${d.active ? `<button class="danger tiny" data-act="revoke-deputy" data-position="${esc(d.position)}">撤销</button>` : ''}</td>
  </tr>`).join('') || '<tr><td colspan="6" class="muted">当前执行版暂无代班记录。</td></tr>';
}

// ---------- 舞监：联排中断（停排 / 恢复） ----------

$('#interruption-panel').addEventListener('submit', async (ev) => {
  const form = ev.target.closest('#pause-start-form, #pause-resume-form');
  if (!form) return;
  ev.preventDefault();
  const v = state.live;
  if (!v) return;
  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    if (form.id === 'pause-start-form') {
      const pauseText = form.elements.pauseText.value;
      const reason = form.elements.reason.value.trim();
      if (!pauseText) { alertBar('error', '请填写停排时刻'); btn.disabled = false; return; }
      if (!reason) { alertBar('error', '请填写停排原因'); btn.disabled = false; return; }
      if (!confirm(`确认在 ${pauseText} 停排？\n将清除全部未开始项的原预计结束、停排前有效双签失效；执行岗位登记 / 新签认与发布新版在恢复前一律拒绝。`)) { btn.disabled = false; return; }
      const data = await api('POST', '/api/live/interruptions', { versionId: v.id, pauseText, reason });
      state.live = data.version;
      renderLive();
      alertBar('error', `⛔ 已在 ${pauseText} 停排（${data.clearedEstimatedEnds} 项未开始预计结束已清除）；恢复后双签须重签。`, 9000);
    } else {
      const resumeText = form.elements.resumeText.value;
      if (!resumeText) { alertBar('error', '请填写恢复时刻'); btn.disabled = false; return; }
      if (!confirm(`确认在 ${resumeText} 恢复联排？\n未开始项排期不早于该时刻，已开始未完成项结束顺延该中断分钟。`)) { btn.disabled = false; return; }
      const data = await api('POST', '/api/live/interruptions/resume', { versionId: v.id, resumeText });
      state.live = data.version;
      renderLive();
      const n = data.version.conflicts.length;
      alertBar(n ? 'error' : 'ok',
        `✅ 已在 ${resumeText} 恢复联排，排期与同岗位冲突已按中断顺延重算。` + (n ? ` 当前 ${n} 项冲突请查看红条。` : ''),
        n ? 9000 : 6000);
    }
    loadLiveNotices().catch(() => {});
  } catch (e) {
    btn.disabled = false;
    alertBar('error', errorToHtml(e), 10000);
    if (e.status === 409) loadLive().catch(() => {});
  }
});

$('#deputy-enable').addEventListener('click', async () => {
  const position = $('#deputy-position').value;
  const username = $('#deputy-operator').value;
  if (!position || !username) return alertBar('error', '请选择岗位与执行账号');
  if (!confirm(`确认启用代班：岗位「${position}」由 ${username} 代班？启用后原岗位账号将暂时失去该岗位登记权。`)) return;
  try {
    state.deputies = await api('POST', '/api/live/deputies', { position, username, versionId: state.live?.id });
    alertBar('ok', `已启用岗位「${position}」代班，该岗位登记权已移交代班账号。`);
    await loadLive();
  } catch (e) {
    alertBar('error', errorToHtml(e));
    if (e.status === 409) loadLive().catch(() => {});
  }
});

$('#deputy-tbody').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-act="revoke-deputy"]');
  if (!btn) return;
  const position = btn.dataset.position;
  if (!confirm(`确认撤销岗位「${position}」的在任代班？撤销后原岗位账号恢复该岗位登记权。`)) return;
  try {
    state.deputies = await api('POST', '/api/live/deputies/revoke', { position, versionId: state.live?.id });
    alertBar('ok', `已撤销岗位「${position}」代班，原岗位账号已恢复登记权。`);
    await loadLive();
  } catch (e) {
    alertBar('error', errorToHtml(e));
    if (e.status === 409) loadLive().catch(() => {});
  }
});

function handoverTag(c) {
  if (!c.handover) return '';
  return `<div class="handover-tag" title="实际开始/完成延续自第 ${c.handover.sourceVersionNo} 版提示项 ${c.handover.sourceCode}">↩ 交接自第 ${c.handover.sourceVersionNo} 版·${esc(c.handover.sourceCode)}</div>`;
}

function renderRegControls(c) {
  const common = `data-cue="${c.id}" data-ver="${c.rowVer}" data-version-id="${state.live.id}"`;
  // 需放行项：双签齐备前「开始」禁用并提示；执行人可签认「就绪」（签认不推进行版本）
  const needRelease = c.release?.required === true;
  const releaseReady = c.release?.ready === true;
  const pauseActive = !!state.live.activeInterruption;
  let buttons = '';
  if (c.status === 'PENDING') {
    const startBtn = needRelease && !releaseReady
      ? `<button class="primary tiny" data-reg="start" ${common} disabled title="需放行项：须执行人「签认就绪」与舞监「签认可执行」均有效后才能登记实际开始">开始（待双签）</button>`
      : `<button class="primary tiny" data-reg="start" ${common}>开始</button>`;
    const signoffBtn = needRelease && c.release.operator.state !== 'valid' && !pauseActive
      ? `<div class="reg-actions"><button class="warn tiny" data-signoff="operator" ${common}>签认就绪</button></div>`
      : (needRelease && pauseActive ? '<div class="muted">停排中，恢复后重签</div>' : '');
    buttons = `
      <div class="reg-actions">
        <input type="time" data-role="start-time" title="留空取当前时间" />
        ${startBtn}
      </div>
      ${signoffBtn}
      <div class="reg-actions">
        <input type="time" data-role="est-time" />
        <button class="ghost tiny" data-reg="estimate" ${common}>预计结束</button>
      </div>`;
  } else if (c.status === 'RUNNING') {
    buttons = `
      <div class="reg-actions">
        <input type="time" data-role="end-time" title="留空取当前时间" />
        <button class="primary tiny" data-reg="complete" ${common}>完成</button>
      </div>
      <div class="reg-actions">
        <input type="time" data-role="est-time" value="${c.estimatedEndText ?? ''}" />
        <button class="ghost tiny" data-reg="estimate" ${common}>改预计</button>
      </div>`;
  } else {
    buttons = '<span class="muted">已完成</span>';
  }
  return buttons;
}

$('#live-tbody').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-reg]');
  if (!btn) return;
  const tr = btn.closest('tr');
  const action = btn.dataset.reg;
  const payload = {
    versionId: Number(btn.dataset.versionId),
    cueRef: Number(btn.dataset.cue),
    rowVersion: Number(btn.dataset.ver),
    action,
  };
  if (action === 'start') payload.time = $('[data-role="start-time"]', tr)?.value || null;
  if (action === 'complete') payload.time = $('[data-role="end-time"]', tr)?.value || null;
  if (action === 'estimate') {
    payload.estimatedEndText = $('[data-role="est-time"]', tr)?.value || '';
    if (!payload.estimatedEndText) return alertBar('error', '请先填写预计结束时间');
  }
  try {
    const data = await api('POST', '/api/registrations', payload);
    state.live = data.version;
    const hasConflict = data.version.conflicts.length > 0;
    alertBar(hasConflict ? 'error' : 'ok',
      hasConflict
        ? `登记成功，但出现 ${data.version.conflicts.length} 项顺延岗位冲突，请查看红色提示。`
        : '登记成功，重算结果已更新。');
    renderLive();
    loadLiveNotices().catch(() => {});
  } catch (e) {
    alertBar('error', errorToHtml(e));
    if (e.status === 409) loadLive().catch(() => {});
  }
});

$('#live-reload').addEventListener('click', () =>
  loadLive().then(() => alertBar('ok', '已刷新')).catch((e) => alertBar('error', errorToHtml(e))));

// ---------- 双人放行签认（执行人「就绪」/ 舞监「可执行」） ----------

$('#live-tbody').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-signoff]');
  if (!btn) return;
  const kind = btn.dataset.signoff;
  const label = kind === 'sm' ? '舞监「可执行」' : '执行人「就绪」';
  if (!confirm(`确认对「${btn.closest('tr')?.querySelector('strong')?.textContent || ''}」提交${label}签认？签认将记录签认人、时间及目标与直接前置项的登记行版本。`)) return;
  btn.disabled = true;
  try {
    const data = await api('POST', '/api/live/signoffs', {
      versionId: Number(btn.dataset.versionId),
      cueRef: Number(btn.dataset.cue),
      rowVersion: Number(btn.dataset.ver),
      kind,
    });
    state.live = data.version;
    alertBar('ok', `${label}签认已记录。${data.version.cues.find((c) => c.id === Number(btn.dataset.cue))?.release?.ready ? '双签齐备，可登记实际开始。' : '待另一类签认齐备后方可登记实际开始。'}`);
    renderLive();
  } catch (e) {
    alertBar('error', errorToHtml(e));
    if (e.status === 409 || e.status === 403) loadLive().catch(() => {});
    else btn.disabled = false;
  }
});

// ---------- 舞监：现场登记更正 ----------

const CORR_FIELDS = [
  { key: 'actual_start', label: '实际开始', timeKey: 'actualStartText' },
  { key: 'actual_end', label: '实际完成', timeKey: 'actualEndText' },
  { key: 'estimated_end', label: '预计结束', timeKey: 'estimatedEndText' },
];
const CORR_FIELD_LABEL = Object.fromEntries(CORR_FIELDS.map((f) => [f.key, f.label]));

function timeOrDash(t) { return t ?? '<span class="muted">空</span>'; }

function renderCorrectionCell(c, v, scope) {
  const skipBtn = (v.isLatest && scope === 'live' && c.status !== 'SKIPPED')
    ? `<button class="warn tiny" data-act="open-skip-preview" data-cue="${c.id}">跳过链…</button>`
    : '';
  // 顺延预演仅对未完成、未跳过项开放（已开始项可用；结果不会写入任何登记）
  const whatifBtn = (v.isLatest && scope === 'live' && c.status === 'PENDING')
    || (v.isLatest && scope === 'live' && c.status === 'RUNNING')
    ? `<button class="ghost tiny" data-act="open-whatif" data-cue="${c.id}">顺延预演</button>`
    : '';
  // 需放行项：舞监签认「可执行」（仅当前执行版、未开始项；停排期间禁止新签认；签认不推进行版本）
  const signoffBtn = (v.isLatest && scope === 'live' && c.release?.required && c.status === 'PENDING' && c.release.sm.state !== 'valid' && !v.activeInterruption)
    ? `<button class="warn tiny" data-signoff="sm" data-cue="${c.id}" data-ver="${c.rowVer}" data-version-id="${v.id}">签认可执行</button>`
    : '';
  const corrBtn = v.isLatest && scope === 'live'
    ? `<button class="danger tiny" data-act="open-correct" data-scope="${scope}" data-cue="${c.id}">更正</button>`
    : scope === 'live' ? '<span class="muted">归档不可更正</span>' : '';
  const histBtn = c.corrections?.length
    ? `<button class="ghost tiny" data-act="open-history" data-scope="${scope}" data-cue="${c.id}">更正记录(${c.corrections.length})</button>`
    : '';
  return `<div class="corr-actions">${signoffBtn}${skipBtn}${whatifBtn}${corrBtn}${histBtn}</div>`;
}

function openModal(title, html) {
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = html;
  $('#modal-overlay').hidden = false;
}

function closeModal() {
  $('#modal-overlay').hidden = true;
  $('#modal-body').innerHTML = '';
}

$('#modal-close').addEventListener('click', closeModal);
$('#modal-overlay').addEventListener('click', (ev) => {
  if (ev.target.id === 'modal-overlay') closeModal();
});

function findCueInContext(scope, cueId) {
  const v = scope === 'live' ? state.live : state.detail;
  const cue = v?.cues.find((x) => x.id === cueId);
  return { v, cue };
}

function renderHistoryHtml(cue, v) {
  const rows = cue.corrections || [];
  return `
    <div class="muted">
      第 ${v.versionNo} 版 · <strong>${esc(cue.code)}</strong> ${esc(cue.title)}（${esc(cue.position)}）
      ${v.isLatest ? '' : '· 归档版本（只读）'}
    </div>
    <div class="table-wrap corr-history">
      <table>
        <thead><tr><th>更正项</th><th>更正前</th><th>更正后</th><th>操作者</th><th>时间</th><th>原因</th></tr></thead>
        <tbody>${rows.map((r) => `<tr${r.cascaded ? ' class="cascaded-row"' : ''}>
          <td>${esc(CORR_FIELD_LABEL[r.field] || r.field)}${r.cascaded ? '<div class="muted">级联清除</div>' : ''}</td>
          <td class="mono">${timeOrDash(r.oldValueText)}</td>
          <td class="mono">${timeOrDash(r.newValueText)}</td>
          <td>${esc(r.correctedBy)}</td>
          <td class="mono">${esc(r.correctedAt)}</td>
          <td class="corr-reason">${esc(r.reason)}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>
    <div class="muted">更正只改变现场登记，不改变已发布计划；清除实际开始时系统会同时清除实际完成。</div>`;
}

$('#live-tbody').addEventListener('click', (ev) => {
  const corrBtn = ev.target.closest('button[data-act="open-correct"], button[data-act="open-history"], button[data-act="open-skip-preview"], button[data-act="open-skip-view"], button[data-act="open-explain"], button[data-act="open-whatif"], button[data-act="open-signoffs"]');
  if (!corrBtn) return;
  const cueId = Number(corrBtn.dataset.cue);
  if (corrBtn.dataset.act === 'open-explain') {
    openExplain(cueId, 'live');
    return;
  }
  if (corrBtn.dataset.act === 'open-whatif') {
    openWhatIf([cueId]);
    return;
  }
  const { v, cue } = findCueInContext('live', cueId);
  if (!cue) return;
  if (corrBtn.dataset.act === 'open-history') {
    openModal(`更正记录：${cue.code}`, renderHistoryHtml(cue, v));
  } else if (corrBtn.dataset.act === 'open-signoffs') {
    openModal(`放行签认记录：${cue.code}`, renderSignoffHistoryHtml(cue, v));
  } else if (corrBtn.dataset.act === 'open-skip-preview') {
    openSkipPreview(cueId);
  } else if (corrBtn.dataset.act === 'open-skip-view') {
    openSkipView(cue, v);
  } else {
    openCorrectForm(cue, v);
  }
});

// ---------- 舞监：依赖链跳过（影响预览 → 确认） ----------

function renderSkipChainRows(chain) {
  return chain.map((c) => {
    const state = c.alreadySkipped
      ? '<span class="badge skipped">已跳过（只展示，不重复留痕）</span>'
      : (c.status === 'PENDING'
          ? '<span class="badge pending">未开始，将跳过</span>'
          : `<span class="badge ${c.status === 'DONE' ? 'done' : 'running'}">${c.status === 'DONE' ? '已完成' : '已开始'}（阻断）</span>`);
    const reason = c.skip
      ? `<div class="skip-tag">${esc(c.skip.reason)}<span class="muted">（${esc(c.skip.skippedBy)} · ${esc(c.skip.skippedAt)}）</span></div>`
      : '';
    return `<tr class="${c.alreadySkipped ? 'chain-skipped' : ''} ${c.isRoot ? 'chain-root' : ''}">
      <td>${c.isRoot ? '<strong>▶ 根项</strong>' : ''}</td>
      <td><strong>${esc(c.code)}</strong></td>
      <td>${esc(c.title || '')}</td>
      <td>${esc(c.position)}</td>
      <td class="mono">${c.plannedStartText} - ${c.plannedEndText}</td>
      <td class="mono">v${c.rowVersion}</td>
      <td>${state}${reason}</td>
    </tr>`;
  }).join('');
}

async function openSkipPreview(cueId) {
  const v = state.live;
  if (!v) return;
  openModal('依赖链跳过：影响预览', '<div class="muted">正在计算沿前置关系可达的全部后继…</div>');
  try {
    const data = await api('GET', `/api/live/skips/preview?cueRef=${cueId}&versionId=${v.id}`);
    state.skipPreview = data;
    const blockerHtml = data.blockers.length
      ? `<div class="conflict-banner"><strong>⚠ ${data.blockers.length} 项阻断，当前无法跳过：</strong><ul>${
          data.blockers.map((b) => `<li>${esc(b.reason)}</li>`).join('')}</ul></div>` : '';
    const counts = `共 ${data.totalCount} 项：新跳过 ${data.newlySkippedCount} 项，已跳过（只展示）${data.alreadySkippedCount} 项`;
    openModal(`依赖链跳过：${data.root.code}`, `
      <div class="muted">
        当前执行版：第 ${data.versionNo} 版｜触发项 <strong>${esc(data.root.code)}</strong> ${esc(data.root.title || '')}（${esc(data.root.position)}）<br>
        跳过将作用于触发项及沿前置关系可达的<strong>全部后继</strong>：${counts}。
      </div>
      ${blockerHtml}
      <div class="table-wrap skip-chain-wrap">
        <table>
          <thead><tr><th></th><th>编号</th><th>说明</th><th>岗位</th><th>计划时段</th><th>行版本</th><th>状态 / 跳过原因</th></tr></thead>
          <tbody>${renderSkipChainRows(data.chain)}</tbody>
        </table>
      </div>
      <form id="skip-form">
        <label>跳过原因（必填，≤200 字，将记录到链中每一项）
          <textarea id="skip-reason" rows="2" maxlength="200" required placeholder="如：设备故障无法执行，整条依赖链取消"></textarea>
        </label>
        <div class="muted">
          首次跳过会清除各项预计结束、保留已发布计划，记录操作者与时间；执行账号将不能再登记这些项，且跳过时间不可由舞监更正。
          现场重算不再把跳过项计入待执行时段与岗位冲突。
        </div>
        <div id="skip-err" class="error-text" hidden></div>
        <div class="form-actions">
          <button type="submit" class="danger" id="skip-confirm" ${data.canSkip ? '' : 'disabled'}>
            确认跳过 ${data.newlySkippedCount} 项
          </button>
          <button type="button" class="ghost" id="skip-cancel">取消</button>
        </div>
      </form>`);
    $('#skip-cancel').addEventListener('click', closeModal);
  } catch (e) {
    closeModal();
    alertBar('error', errorToHtml(e));
    if (e.status === 409) loadLive().catch(() => {});
  }
}

// 已跳过项的原因查看（只读，含操作者/时间/触发根项）
function openSkipView(cue, v) {
  const s = cue.skip;
  openModal(`跳过项：${cue.code}`, `
    <div class="skip-view">
      <div><span class="badge skipped">已跳过</span>
        <strong>${esc(cue.code)}</strong> ${esc(cue.title || '')}（${esc(cue.position)}）</div>
      <div>触发根项：<strong>${esc(s.rootCode || '')}</strong>（第 ${v.versionNo} 版）</div>
      <div>操作者：${esc(s.skippedBy)}</div>
      <div>时间：${esc(s.skippedAt)}</div>
      <div>原因：<div class="skip-reason-box">${esc(s.reason)}</div></div>
      <div class="muted">已发布计划保留；预计结束已在跳过时清除；跳过项只展示、不重复留痕，登记时间不可更正。</div>
      <div class="form-actions"><button type="button" class="ghost" id="skip-view-close">关闭</button></div>
    </div>`);
  $('#skip-view-close').addEventListener('click', closeModal);
}

$('#modal-overlay').addEventListener('submit', async (ev) => {
  const form = ev.target.closest('#skip-form');
  if (!form) return;
  ev.preventDefault();
  const p = state.skipPreview;
  if (!p) { closeModal(); return; }
  const reason = $('#skip-reason').value.trim();
  const errBox = $('#skip-err');
  errBox.hidden = true;
  if (!reason) { errBox.textContent = '请填写跳过原因（不能为空）'; errBox.hidden = false; return; }
  const btn = $('#skip-confirm');
  btn.disabled = true;
  try {
    const data = await api('POST', '/api/live/skips', {
      cueRef: p.root.cueRef,
      versionId: p.versionId,
      reason,
      items: p.chain.map((c) => ({ cueRef: c.cueRef, rowVersion: c.rowVersion })),
    });
    state.live = data.version;
    state.skipPreview = null;
    closeModal();
    const n = data.skip.newlySkippedCount;
    alertBar(n ? 'ok' : 'error',
      n
        ? `⛔ 已将以「${data.skip.rootCode}」为根的依赖链 ${n} 项标记为跳过，预计结束已清除，其他项已按现有规则重算。`
        : '链中项此前均已跳过，本次只展示、未重复留痕。',
      n ? 8000 : 5000);
    renderLive();
    loadLiveNotices().catch(() => {});
  } catch (e) {
    btn.disabled = false;
    // 阻断 / 行版本变化：整体拒绝、无部分标记，重新拉取现场与预览
    alertBar('error', errorToHtml(e), 10000);
    state.skipPreview = null;
    closeModal();
    loadLive().then(renderLive).catch(() => {});
  }
});

// ---------- 排期开始来源解释（当前执行版与历史版本通用，只读） ----------

async function openExplain(cueId, scope) {
  const v = scope === 'live' ? state.live : state.detail;
  if (!v) return;
  openModal('排期来源', '<div class="muted">正在以原计划开始为基线追溯来源链…</div>');
  try {
    const data = await api('GET', `/api/versions/${v.id}/cues/${cueId}/explain`);
    openModal(`排期来源：${data.cue?.code || ''}`, renderExplainHtml(data));
  } catch (e) {
    closeModal();
    alertBar('error', errorToHtml(e));
    if (e.status === 409 && scope === 'live') loadLive().catch(() => {});
  }
}

function renderExplainHtml(data) {
  const head = `<div class="muted">第 ${data.versionNo} 版${data.isLatest ? '（当前执行版）' : '（归档版本 · 按归档状态只读回看）'}</div>`;
  if (!data.applicable) {
    const c = data.cue || {};
    const badge = c.status
      ? statusBadge(c.status) : '';
    return `${head}
      <div class="explain-na">
        <div><strong>${esc(c.code || '')}</strong> ${esc(c.title || '')}（${esc(c.position || '')}）${badge}
          <span class="mono muted">计划 ${esc(c.plannedStartText || '')} - ${esc(c.plannedEndText || '')}</span></div>
        <p>${esc(data.reason || '该提示项当前没有可解释的排期开始。')}</p>
        <div class="muted">登记、更正或跳过后刷新页面，可查看最新解释；本查询不改动登记与已发布计划。</div>
      </div>`;
  }
  const c = data.cue;
  let html = `${head}
    <div class="explain-cue">
      <strong>${esc(c.code)}</strong> ${esc(c.title || '')}（${esc(c.position)}）
      <span class="mono">计划 ${esc(c.plannedStartText)} - ${esc(c.plannedEndText)}（${c.duration} 分）</span>
      ${statusBadge(c.status)}
    </div>
    <div class="explain-baseline">基线：原计划开始 <strong class="mono">${esc(data.baselineText)}</strong>（重算开始不早于该时刻）</div>`;
  if (data.decidedByPlan) {
    html += `<div class="explain-plan">✅ 原计划本身决定开始：重算开始 <strong class="mono">${esc(data.maxTimeText)}</strong> ＝ 原计划开始，<strong>无需顺延</strong>。</div>`;
    if (data.constraints.length) {
      html += `<div class="muted">以下 ${data.constraints.length} 条直接前置的结束时刻恰与原计划相同（共同达到 ${esc(data.maxTimeText)}，未造成顺延）：</div>
        <div class="explain-tree">${data.constraints.map(renderTraceNode).join('')}</div>`;
    }
  } else {
    html += `<div class="explain-max">重算开始 <strong class="mono">${esc(data.maxTimeText)}</strong>（较原计划顺延 ${data.delayMinutes} 分钟）：
      达到最终约束时刻 <strong class="mono">${esc(data.maxTimeText)}</strong> 的直接前置共 <strong>${data.constraints.length}</strong> 条，全部展示如下：</div>
      <div class="explain-tree">${data.constraints.map(renderTraceNode).join('')}</div>`;
  }
  html += renderSkippedPreds(data.skippedPreds);
  html += renderOtherPreds(data.otherPreds);
  html += `<div class="muted">来源链与第 ${data.versionNo} 版现场重算结果一致；登记、更正或跳过后刷新即可看到最新解释。已跳过前置不构成约束；本查询不改动登记与已发布计划。</div>`;
  return html;
}

function renderTraceNode(node) {
  let html = `<div class="trace-node">
    <div class="trace-line">
      <strong>${esc(node.code)}</strong> ${esc(node.title || '')}（${esc(node.position)}）
      结束 <strong class="mono">${esc(node.endText)}</strong>
      <span class="src-tag src-${esc(node.endSource)}">${esc(node.endSourceLabel)}</span>
      <span class="muted">${esc(node.endDetail || '')}</span>
    </div>`;
  if (node.start) {
    const s = node.start;
    html += `<div class="trace-sub">
      <div class="trace-line sub-head">↳ 「${esc(node.code)}」尚未开始，其重算开始 <strong class="mono">${esc(s.schedStartText)}</strong>
        ${s.decidedByPlan
          ? `＝ 原计划开始 ${esc(s.plannedStartText)}（该层无需顺延）`
          : `＝ max（原计划 ${esc(s.plannedStartText)}，下列前置结束），该层顺延 ${s.schedStart - s.plannedStart} 分钟`}</div>
      ${s.constraints.map(renderTraceNode).join('')}
      ${renderSkippedPreds(s.skippedPreds)}
      ${renderOtherPreds(s.otherPreds)}
    </div>`;
  }
  return html + '</div>';
}

function renderSkippedPreds(list) {
  if (!list?.length) return '';
  return `<div class="explain-skipped">已跳过前置（不构成约束）：${list.map((p) =>
    `<span class="skip-tag">⛔ ${esc(p.code)}${p.skipReason ? `：${esc(p.skipReason)}` : ''}</span>`).join(' ')}</div>`;
}

function renderOtherPreds(list) {
  if (!list?.length) return '';
  return `<div class="muted">其他前置（结束时刻早于最终约束，未决定该开始）：${list.map((p) =>
    `${esc(p.code)} 结束 ${esc(p.endText)}`).join('；')}</div>`;
}

// ---------- 舞监：现场顺延预演（只读假设推演） ----------

function whatifEligible(v) {
  // 仅未完成、未跳过提示项可填写假设（未开始 / 已开始）
  return (v?.cues || []).filter((c) => c.status === 'PENDING' || c.status === 'RUNNING');
}

function deltaHtml(delta) {
  if (delta > 0) return `<span class="wi-delay">+${delta} 分</span>`;
  if (delta < 0) return `<span class="wi-advance">${delta} 分</span>`;
  return '<span class="muted">无变化</span>';
}

function openWhatIf(prefillIds = []) {
  const v = state.live;
  if (!v) return;
  const eligible = whatifEligible(v);
  if (!eligible.length) {
    alertBar('error', '当前执行版没有未完成且未跳过的提示项，无法填写假设。');
    return;
  }
  const preSet = new Set(prefillIds);
  const rows = eligible.map((c) => {
    const saved = state.whatifInputs.get(c.id);
    const val = saved ?? (preSet.has(c.id) ? (c.estimatedEndText ?? c.schedEndText) : '');
    const cur = c.status === 'RUNNING'
      ? `实际开始 ${esc(c.actualStartText)}｜预计结束 ${esc(c.estimatedEndText ?? '—')}`
      : `预计结束 ${esc(c.estimatedEndText ?? '—')}`;
    return `<tr class="${preSet.has(c.id) ? 'wi-prefill' : ''}">
      <td><strong>${esc(c.code)}</strong></td>
      <td>${esc(c.title)}</td>
      <td>${esc(c.position)}</td>
      <td>${statusBadge(c.status)}</td>
      <td class="mono">${esc(c.schedStartText)} - ${esc(c.schedEndText)}</td>
      <td class="muted">${cur}<div>行版本 v${c.rowVer}</div></td>
      <td><input type="time" data-wi-cue="${c.id}" class="wi-time" value="${esc(val ?? '')}" />
        <div class="muted">假设预计结束（留空=不假设）</div></td>
    </tr>`;
  }).join('');
  openModal('现场顺延预演：填写假设', `
    <form id="whatif-form">
      <div class="muted">
        第 ${v.versionNo} 版（当前执行版）。为一项或多项<strong>未完成、未跳过</strong>提示项填写假设预计结束（HH:MM）；
        已开始项不得早于实际开始，未开始项不得早于预演算出的开始（含同批其他假设的联动结果）。<br>
        提交时携带当前页面所见版本与<strong>全部提示项登记行版本</strong>：执行版或任一登记行已变化时整体拒绝并提示刷新。
        预演<strong>只读</strong>，不更改登记、计划、跳过状态与更正历史。
      </div>
      <div class="table-wrap whatif-form-wrap">
        <table>
          <thead><tr><th>编号</th><th>说明</th><th>岗位</th><th>状态</th><th>当前待执行时段</th><th>现有登记 / 行版本</th><th>假设预计结束</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div id="whatif-err" class="error-text" hidden></div>
      <div class="form-actions">
        <button type="submit" class="primary">同时套用全部假设并重算</button>
        <button type="button" class="ghost" id="whatif-cancel">取消</button>
      </div>
    </form>`);
  $('#whatif-cancel').addEventListener('click', closeModal);
  const first = prefillIds.length ? $(`.wi-time[data-wi-cue="${prefillIds[0]}"]`) : $('.wi-time');
  if (first && first.value) first.focus();
}

$('#whatif-open')?.addEventListener('click', () => openWhatIf([]));

function renderWhatIfResult(data) {
  const s = data.summary;
  const head = `
    <div class="muted">
      第 ${data.versionNo} 版（当前执行版）｜快照读取于 ${esc(data.readAt)}｜只读预演，未写入任何数据<br>
      本次假设 ${s.assumedCount} 项；逐项时段变化 ${s.changedCount} 项；
      同岗位冲突：基线 ${s.baselineConflictCount} 项 → 预演 ${s.scenarioConflictCount} 项
      （新增 ${s.addedCount}、消失 ${s.removedCount}、仍存在 ${s.keptCount}）<br>
      共享资源超额：基线 ${s.baselineResourceAlertCount} 项 → 预演 ${s.scenarioResourceAlertCount} 项
      （🔴 新增 ${s.resourceAddedCount}、🟢 消失 ${s.resourceRemovedCount}、🟠 持续 ${s.resourceKeptCount}）
    </div>
    <div class="wi-assumptions">套用假设：${data.assumptions.map((a) =>
      `<span class="wi-assumed-tag">${esc(a.code)} ≤ <strong class="mono">${esc(a.estimatedEndText)}</strong></span>`).join(' ')}</div>`;

  const added = data.conflictsAdded?.length
    ? `<div class="conflict-banner"><strong>🔴 新增同岗位冲突 ${data.conflictsAdded.length} 项：</strong><ul>${
        data.conflictsAdded.map((c) => `<li>${esc(c.message)}</li>`).join('')}</ul></div>` : '';
  const removed = data.conflictsRemoved?.length
    ? `<div class="wi-removed-box"><strong>🟢 消失的冲突 ${data.conflictsRemoved.length} 项：</strong><ul>${
        data.conflictsRemoved.map((c) => `<li>${esc(c.message)}</li>`).join('')}</ul></div>` : '';
  const kept = data.conflictsKept?.length
    ? `<div class="wi-kept-box"><strong>🟠 仍存在的冲突 ${data.conflictsKept.length} 项：</strong><ul>${
        data.conflictsKept.map((k) => k.baseline.message === k.scenario.message
          ? `<li>${esc(k.scenario.message)}</li>`
          : `<li>变更前：${esc(k.baseline.message)}<br>变更后：${esc(k.scenario.message)}</li>`).join('')}</ul></div>`
    : '';
  const noConflict = (!s.addedCount && !s.removedCount && !s.keptCount)
    ? '<div class="val-ok">✅ 预演前后均无同岗位冲突。</div>' : '';

  // 共享资源告警对照（口径与现场一致：跳过项不占用，仅已完成项构成的超额不告警）
  const resAdded = data.resourceAlertsAdded?.length
    ? `<div class="conflict-banner"><strong>🔴 新增共享资源超额 ${data.resourceAlertsAdded.length} 项：</strong><ul>${
        data.resourceAlertsAdded.map((a) => `<li>${esc(a.message)}</li>`).join('')}</ul></div>` : '';
  const resRemoved = data.resourceAlertsRemoved?.length
    ? `<div class="wi-removed-box"><strong>🟢 消失的共享资源超额 ${data.resourceAlertsRemoved.length} 项：</strong><ul>${
        data.resourceAlertsRemoved.map((a) => `<li>${esc(a.message)}</li>`).join('')}</ul></div>` : '';
  const resKept = data.resourceAlertsKept?.length
    ? `<div class="wi-kept-box"><strong>🟠 持续的共享资源超额 ${data.resourceAlertsKept.length} 项：</strong><ul>${
        data.resourceAlertsKept.map((k) => k.baseline.message === k.scenario.message
          ? `<li>${esc(k.scenario.message)}</li>`
          : `<li>变更前：${esc(k.baseline.message)}<br>变更后：${esc(k.scenario.message)}</li>`).join('')}</ul></div>`
    : '';
  const noResource = (!s.resourceAddedCount && !s.resourceRemovedCount && !s.resourceKeptCount)
    ? '<div class="muted">预演前后均无共享资源超额（跳过项不占用、仅已完成项构成的超额不告警）。</div>' : '';

  const trs = data.cues.map((c) => {
    const skipped = c.status === 'SKIPPED';
    const base = skipped ? '—（跳过）' : `${esc(c.baselineStartText)} - ${esc(c.baselineEndText)}`;
    const scen = skipped
      ? '—（跳过）'
      : `${esc(c.scenarioStartText)} - ${esc(c.scenarioEndText)}${c.delayed ? '<div class="delayed">晚于原计划</div>' : ''}`;
    return `<tr class="${c.assumed ? 'wi-assumed-row' : ''} ${skipped ? 'skipped-row' : ''} ${c.changed ? 'wi-changed-row' : ''}">
      <td><strong>${esc(c.code)}</strong>${c.assumed ? '<div class="wi-assumed-flag">假设项</div>' : ''}</td>
      <td>${esc(c.title)}</td>
      <td>${esc(c.position)}</td>
      <td>${esc(c.statusLabel)}</td>
      <td class="mono">${esc(c.plannedStartText)} - ${esc(c.plannedEndText)}</td>
      <td class="mono">${base}</td>
      <td class="mono">${scen}</td>
      <td class="mono">${skipped ? '—' : deltaHtml(c.startDeltaMinutes)}</td>
      <td class="mono">${skipped ? '—' : deltaHtml(c.endDeltaMinutes)}</td>
    </tr>`;
  }).join('');

  openModal(`现场顺延预演结果：第 ${data.versionNo} 版`, `
    ${head}
    ${added}${removed}${kept}${noConflict || ''}
    <h4 class="wi-res-head">共享资源超额对照（口径与现场一致）</h4>
    ${resAdded}${resRemoved}${resKept}${noResource}
    <div class="table-wrap whatif-result-wrap">
      <table>
        <thead><tr>
          <th>编号</th><th>说明</th><th>岗位</th><th>状态</th><th>原计划时段</th>
          <th>变更前（基线）待执行</th><th>变更后（预演）待执行</th><th>开始差</th><th>结束差</th>
        </tr></thead>
        <tbody>${trs}</tbody>
      </table>
    </div>
    <div class="muted">
      差异以同一次读取的当前版本与登记快照为基线计算；已跳过项无待执行时段、不参与冲突。
      本预演<strong>不更改登记、已发布计划、跳过状态与更正历史</strong>；如需落实，请由岗位按既有流程登记或由舞监更正。
    </div>
    <div class="form-actions">
      <button type="button" class="primary" id="whatif-edit">调整假设重新预演</button>
      <button type="button" class="ghost" id="whatif-close">关闭</button>
    </div>`);
  $('#whatif-close').addEventListener('click', closeModal);
  $('#whatif-edit').addEventListener('click', () => openWhatIf([]));
}

$('#modal-overlay').addEventListener('submit', async (ev) => {
  const form = ev.target.closest('#whatif-form');
  if (!form) return;
  ev.preventDefault();
  const v = state.live;
  if (!v) { closeModal(); return; }
  const errBox = $('#whatif-err');
  errBox.hidden = true;
  errBox.textContent = '';

  const assumptions = [];
  const inputs = $$('.wi-time', form);
  for (const inp of inputs) {
    const cueRef = Number(inp.dataset.wiCue);
    const val = inp.value?.trim() || '';
    state.whatifInputs.set(cueRef, val);
    if (val) assumptions.push({ cueRef, estimatedEndText: val });
  }
  if (!assumptions.length) {
    errBox.textContent = '请至少为一项提示项填写假设预计结束（不需要假设的行保持留空）。';
    errBox.hidden = false;
    return;
  }
  // 请求携带所见版本及全部提示项登记行版本；服务端在同一事务内核验，不返回混合时点结果
  const payload = {
    versionId: v.id,
    rows: v.cues.map((c) => ({ cueRef: c.id, rowVersion: c.rowVer })),
    assumptions,
  };
  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    const data = await api('POST', '/api/live/whatif', payload);
    renderWhatIfResult(data);
  } catch (e) {
    btn.disabled = false;
    if (e.status === 409) {
      // 执行版或登记行变化：整体提示刷新，不使用旧页面继续推演
      closeModal();
      alertBar('error', errorToHtml(e), 10000);
      loadLive().then(renderLive).catch(() => {});
    } else {
      errBox.innerHTML = errorToHtml(e);
      errBox.hidden = false;
    }
  }
});

function openCorrectForm(cue, v) {
  const options = CORR_FIELDS.map((f) =>
    `<option value="${f.key}">${f.label}（当前 ${cue[f.timeKey] ?? '空'}）</option>`).join('');
  openModal(`现场登记更正：${cue.code}`, `
    <form id="corr-form" class="cue-form" data-cue-id="${cue.id}">
      <div class="muted">
        第 ${v.versionNo} 版 · <strong>${esc(cue.code)}</strong> ${esc(cue.title)}（${esc(cue.position)}），
        行版本 v${cue.rowVer}。仅可更正/清除其中一项；已发布计划不受影响。
      </div>
      <label>更正项
        <select name="field" id="corr-field">${options}</select>
      </label>
      <label>更正后时间
        <input type="time" name="time" id="corr-time" />
      </label>
      <label class="corr-clear-line"><input type="checkbox" name="clear" id="corr-clear" /> 清除该项（留空）</label>
      <label>更正原因（必填）
        <textarea name="reason" id="corr-reason" rows="2" maxlength="200" required placeholder="如：岗位口误报错、舞监现场核定"></textarea>
      </label>
      <div id="corr-err" class="error-text" hidden></div>
      <div class="form-actions">
        <button type="submit" class="danger">保存更正</button>
        <button type="button" class="ghost" id="corr-cancel">取消</button>
      </div>
      <div class="muted" id="corr-rule-hint"></div>
    </form>`);

  const fieldSel = $('#corr-field');
  const timeInput = $('#corr-time');
  const clearBox = $('#corr-clear');
  const hint = $('#corr-rule-hint');
  const FILL_DEFAULTS = { actual_start: cue.actualStartText, actual_end: cue.actualEndText, estimated_end: cue.estimatedEndText };
  const RULE_HINTS = {
    actual_start: '更正完成须不早于开始；清除实际开始将同时清除实际完成；保留的预计结束不得早于实际开始（无实际开始则为原计划开始）。',
    actual_end: '实际完成必须有实际开始且不得早于实际开始。',
    estimated_end: '预计结束不得早于实际开始（若无实际开始则为原计划开始）。',
  };
  function syncField() {
    const f = fieldSel.value;
    hint.textContent = RULE_HINTS[f];
    clearBox.checked = false;
    timeInput.disabled = false;
    timeInput.value = FILL_DEFAULTS[f] || '';
  }
  fieldSel.addEventListener('change', syncField);
  clearBox.addEventListener('change', () => { timeInput.disabled = clearBox.checked; });
  $('#corr-cancel').addEventListener('click', closeModal);
  syncField();
}

$('#modal-overlay').addEventListener('submit', async (ev) => {
  const form = ev.target.closest('#corr-form');
  if (!form) return;
  ev.preventDefault();
  const errBox = $('#corr-err');
  errBox.hidden = true;
  const v = state.live;
  const cueId = Number(form.dataset.cueId);
  const cue = v?.cues.find((x) => x.id === cueId);
  if (!cue) { closeModal(); return; }
  const field = $('#corr-field').value;
  const clear = $('#corr-clear').checked;
  const reason = $('#corr-reason').value.trim();
  if (!reason) {
    errBox.textContent = '请填写更正原因';
    errBox.hidden = false;
    return;
  }
  if (!clear && !$('#corr-time').value) {
    errBox.textContent = '请填写更正后的时间，或勾选“清除该项”';
    errBox.hidden = false;
    return;
  }
  const meta = CORR_FIELDS.find((f) => f.key === field);
  const payload = {
    versionId: v.id,
    cueRef: cueId,
    rowVersion: cue.rowVer,
    field,
    clear,
    reason,
  };
  payload[meta.timeKey] = clear ? null : $('#corr-time').value;
  try {
    const data = await api('POST', '/api/registrations/corrections', payload);
    state.live = data.version;
    closeModal();
    const conflictN = data.version.conflicts.length;
    alertBar(conflictN ? 'error' : 'ok',
      (data.cascaded ? '更正成功（清除开始已同时清除完成）。' : '更正成功，后续未开始项已按现有规则重算。')
      + (conflictN ? ` 当前存在 ${conflictN} 项顺延岗位冲突，请查看红色提示。` : ''),
      conflictN ? 10000 : 5000);
    renderLive();
    loadLiveNotices().catch(() => {});
  } catch (e) {
    if (e.status === 409) {
      // 与岗位登记共用行版本：过期时拒绝并提示刷新，不能覆盖新登记
      alertBar('error', errorToHtml(e));
      loadLive().then(renderLive).catch(() => {});
      closeModal();
    } else {
      errBox.textContent = e.message;
      errBox.hidden = false;
    }
  }
});

// ---------- 舞监：执行版复盘（预览 / 封存 / 快照回看） ----------

function signedMin(n) {
  if (n === null || n === undefined) return '—';
  if (n > 0) return `+${n}`;
  return String(n);
}

function reviewStatusBadge(status) {
  if (status === 'DONE') return '<span class="badge done">本版完成</span>';
  if (status === 'DONE_HANDOVER') return '<span class="badge handover">↩ 交接完成</span>';
  if (status === 'RUNNING') return '<span class="badge running">进行中</span>';
  if (status === 'SKIPPED') return '<span class="badge skipped">已跳过</span>';
  return '<span class="badge pending">未开始</span>';
}

// 复盘明细表（实时预览与封存快照共用）
function reviewCuesHtml(cues) {
  return `<div class="table-wrap review-table-wrap"><table>
    <thead><tr>
      <th>编号</th><th>说明</th><th>岗位</th><th>计划时段</th>
      <th>状态</th><th>实际开始</th><th>实际完成</th>
      <th>开始偏差(分)</th><th>实际持续(分)</th><th>停排扣除(分)</th><th>净执行(分)</th><th>行版本</th>
    </tr></thead>
    <tbody>${cues.map((c) => {
      const done = c.status === 'DONE' || c.status === 'DONE_HANDOVER';
      const rowCls = c.status === 'DONE' ? 'review-done-row'
        : c.status === 'DONE_HANDOVER' ? 'review-handover-row'
        : c.status === 'SKIPPED' ? 'skipped-row' : '';
      const handover = c.handover
        ? `<div class="handover-tag">↩ 交接自第 ${esc(c.handover.sourceVersionNo ?? '?')} 版·${esc(c.handover.sourceCode || c.code)}</div>` : '';
      return `<tr class="${rowCls}">
        <td><strong>${esc(c.code)}</strong>${handover}</td>
        <td>${esc(c.title || '')}</td>
        <td>${esc(c.position)}</td>
        <td class="mono">${esc(c.plannedStartText)} - ${esc(c.plannedEndText)}</td>
        <td>${reviewStatusBadge(c.status)}${c.status === 'DONE_HANDOVER' ? '<div class="muted">不计入本版汇总</div>' : ''}</td>
        <td class="mono">${esc(c.actualStartText ?? '—')}</td>
        <td class="mono">${esc(c.actualEndText ?? '—')}</td>
        <td class="mono review-delta">${done ? esc(signedMin(c.startDeltaMinutes)) : '—'}</td>
        <td class="mono">${done ? c.actualDurationMinutes : '—'}</td>
        <td class="mono">${done && c.status === 'DONE' ? c.deductedPauseMinutes : '—'}</td>
        <td class="mono"><strong>${done && c.status === 'DONE' ? c.netDurationMinutes : '—'}</strong></td>
        <td class="mono muted">v${c.rowVer}</td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>
  <div class="muted">开始偏差＝实际开始 − 计划开始（正为晚开始、负为提前）；净执行＝实际持续 − 实际起止区间与已结束停排段的交集分钟（半开区间，重叠分钟只扣一次）；进行中的停排不扣。</div>`;
}

// 岗位汇总 + 本版合计
function reviewSummaryHtml(live) {
  const posRows = live.positions.length
    ? live.positions.map((p) => `<tr>
        <td>${esc(p.position)}</td>
        <td class="mono">${p.doneCount}</td>
        <td class="mono">${p.netDurationMinutes}</td>
        <td class="mono review-delta">${esc(signedMin(p.startDeltaSum))}</td>
      </tr>`).join('')
    : '<tr><td colspan="4" class="muted">本版暂无完成项。</td></tr>';
  return `<div class="review-positions">
    <table>
      <thead><tr><th>岗位</th><th>本版完成数</th><th>净执行分钟</th><th>开始偏差之和(分)</th></tr></thead>
      <tbody>${posRows}</tbody>
      <tfoot><tr>
        <th>本版合计</th>
        <th class="mono">${live.totals.doneCount}</th>
        <th class="mono">${live.totals.netDurationMinutes}</th>
        <th class="mono review-delta">${esc(signedMin(live.totals.startDeltaSum))}</th>
      </tr></tfoot>
    </table>
    <div class="muted">
      全部 ${live.counts.total} 项：本版完成 ${live.counts.done}、
      交接自旧版完成 ${live.counts.doneHandover}、进行中 ${live.counts.running}、
      未开始 ${live.counts.pending}、已跳过 ${live.counts.skipped}；
      交接完成 / 进行中 / 未开始 / 已跳过均不计入本版完成汇总。
    </div>
  </div>`;
}

function reviewBasisHtml(env) {
  const pauses = env.basis?.closedInterruptions || [];
  const active = env.basis?.activePause;
  return `<div class="review-basis muted">
    封存依据：执行版第 ${env.versionNo} 版；全部登记行版本 ${env.basis?.rows.length ?? 0} 条；
    已结束停排 ${pauses.length} 段${pauses.length ? '（' + pauses.map((p) => esc(p.pauseText) + '–' + esc(p.resumeText)).join('、') + '）' : ''}；
    ${active ? `当前<strong>停排中</strong>（${esc(active.pauseText)} 起，进行中的停排不扣净执行）` : '当前无进行中停排'}。
    封存时将在同一事务内复核，任一依据变化整体拒绝。
  </div>`;
}

// 打开当前执行版复盘预览弹窗
async function openReviewLive() {
  try {
    const env = await api('GET', '/api/live/review');
    state.reviewEnv = env;
    renderReviewPanel();
    showReviewModal(env, false);
  } catch (e) { alertBar('error', errorToHtml(e)); }
}

function showReviewModal(env, isHistory) {
  const sealed = env.sealed;
  const title = isHistory
    ? `第 ${env.versionNo} 版复盘回看${env.isLatest ? '（当前执行版）' : '（历史版 · 只读）'}`
    : `第 ${env.versionNo} 版复盘预览（当前执行版）`;
  const sealBox = (!isHistory && !sealed) ? `
    <div class="review-seal-box">
      <label>复盘备注（可选，≤200 字）<input id="review-note" maxlength="200" placeholder="如：首场联排复盘" /></label>
      <div class="form-actions">
        <button type="button" class="danger" id="review-seal-btn">封存复盘（每版仅一次，封存后不可改写）</button>
      </div>
    </div>` : '';
  const sealedBox = sealed ? `
    <div class="review-sealed-banner">🔒 本版复盘已于 <strong>${esc(sealed.sealedAt)}</strong> 由 ${esc(sealed.sealedBy)} 封存${sealed.note ? '；备注：' + esc(sealed.note) : ''}。以下封存快照为当时明细与汇总，此后登记更正、交接或发布新版均不改写。</div>` : '';
  openModal(title, `
    ${sealedBox}
    <h4>实时明细（${isHistory ? '随该版当前登记变化' : '更正 / 停排恢复后重开即更新'}）</h4>
    ${reviewCuesHtml(env.live.cues)}
    <h4>按岗位汇总</h4>
    ${reviewSummaryHtml(env.live)}
    ${reviewBasisHtml(env)}
    ${sealBox}
  `);
  const btn = $('#review-seal-btn');
  if (btn) btn.addEventListener('click', () => sealReview(env));
}

// 历史版本复盘回看：实时明细 + 已封存快照
async function openReviewHistory(versionId) {
  try {
    const env = await api('GET', `/api/versions/${versionId}/review`);
    openModal(`第 ${env.versionNo} 版复盘回看${env.isLatest ? '（当前执行版）' : '（历史版）'}`, '<span class="muted">加载中…</span>');
    const body = $('#modal-body');
    const sealedBanner = env.snapshot
      ? `<div class="review-sealed-banner">🔒 已封存快照：<strong>${esc(env.snapshot.sealedAt)}</strong> 由 ${esc(env.snapshot.sealedBy)} 封存${env.snapshot.note ? '；备注：' + esc(env.snapshot.note) : ''}（不可改写）</div>`
      : '<div class="muted">该版尚未封存复盘，仅可查看实时明细。</div>';
    body.innerHTML = `
      <div class="review-snapshot-toggle">
        <button type="button" class="ghost tiny" id="review-tab-live">实时明细</button>
        <button type="button" class="ghost tiny" id="review-tab-snap" ${env.snapshot ? '' : 'disabled'}>已封存快照</button>
      </div>
      <div id="review-pane-live">
        ${sealedBanner}
        <h4>实时明细</h4>
        ${reviewCuesHtml(env.live.cues)}
        <h4>按岗位汇总</h4>
        ${reviewSummaryHtml(env.live)}
      </div>
      <div id="review-pane-snap" hidden>
        ${env.snapshot ? `
          ${sealedBanner}
          <h4>封存时明细快照</h4>
          ${reviewCuesHtml(env.snapshot.detail)}
          <h4>封存时岗位汇总快照</h4>
          ${reviewSummaryHtml({ positions: env.snapshot.summary.positions, totals: env.snapshot.summary.totals, counts: env.snapshot.summary.counts })}
        ` : '<div class="muted">该版尚未封存复盘。</div>'}
      </div>`;
    $('#review-tab-live').addEventListener('click', () => {
      $('#review-pane-live').hidden = false; $('#review-pane-snap').hidden = true;
    });
    $('#review-tab-snap').addEventListener('click', () => {
      $('#review-pane-live').hidden = true; $('#review-pane-snap').hidden = false;
    });
  } catch (e) { alertBar('error', errorToHtml(e)); }
}

// 封存：携预览所见执行版、全部登记行版本与停排状态提交；任一依据变化整体拒绝
async function sealReview(env) {
  const note = $('#review-note')?.value.trim() || '';
  if (!confirm('确认封存本版复盘？\n封存将核对所见执行版、全部登记行版本与停排状态，任一依据变化会整体拒绝；每版仅能封存一次，封存后明细与汇总作为当时快照永久保存，此后更正、交接或发布新版均不得改写。')) return;
  const btn = $('#review-seal-btn');
  btn.disabled = true;
  try {
    const updated = await api('POST', '/api/live/review/seal', {
      versionId: env.versionId,
      note,
      basis: env.basis,
    });
    state.reviewEnv = updated;
    renderReviewPanel();
    closeModal();
    alertBar('ok', `🔒 第 ${env.versionNo} 版复盘已封存（${updated.sealed.sealedAt}），快照不可改写；可在「发布版本」页回看。`);
    loadVersions().catch(() => {});
  } catch (e) {
    btn.disabled = false;
    alertBar('error', errorToHtml(e), 10000);
    // 依据变化：刷新预览数据，引导重开
    if (e.status === 409) {
      try {
        state.reviewEnv = await api('GET', '/api/live/review');
        renderReviewPanel();
      } catch { /* ignore */ }
    }
  }
}

$('#review-open')?.addEventListener('click', openReviewLive);

// ---------- 已发布版本回看 ----------

async function loadVersions() {
  const data = await api('GET', '/api/versions');
  state.versions = data.versions;
  renderVersions();
}

function renderVersions() {
  $('#versions-tbody').innerHTML = state.versions.map((v) =>
    `<tr>
      <td><strong>第 ${v.versionNo} 版</strong></td>
      <td>${esc(v.note)}</td>
      <td class="mono">${esc(v.createdAt)}</td>
      <td>${v.cueCount}</td>
      <td>${v.regCount}</td>
      <td>${v.skipCount ? `<span class="skip-count">⛔ ${v.skipCount}</span>` : 0}</td>
      <td>${v.interruptionCount ? `<span class="pause-count ${v.interruptionActive ? 'pause-count-active' : ''}">⏸ ${v.interruptionCount}${v.interruptionActive ? '（进行中）' : ''}</span>` : 0}</td>
      <td>${v.noticePendingCount ? `<span class="notice-count" title="该版本尚有未确认的顺延变更${state.me?.role === 'sm' ? '（全岗位）' : '（你的岗位）'}">🔔 ${v.noticePendingCount}</span>` : '<span class="muted">0</span>'}</td>
      <td>${v.reviewSealed
        ? `<span class="review-sealed-tag" title="封存于 ${esc(v.reviewSealedAt || '')}">🔒 已封存</span>`
        : '<span class="muted">未封存</span>'}</td>
      <td>
        <button class="ghost tiny" data-act="view-version" data-id="${v.id}">回看</button>
        ${state.me?.role === 'sm' ? `<button class="ghost tiny" data-act="view-review" data-id="${v.id}">复盘</button>` : ''}
      </td>
    </tr>`).join('')
    || '<tr><td colspan="10" class="muted">暂无已发布版本。</td></tr>';
}

$('#versions-tbody').addEventListener('click', async (ev) => {
  const reviewBtn = ev.target.closest('button[data-act="view-review"]');
  if (reviewBtn && state.me?.role === 'sm') {
    await openReviewHistory(Number(reviewBtn.dataset.id));
    return;
  }
  const btn = ev.target.closest('button[data-act="view-version"]');
  if (!btn) return;
  try {
    state.detail = await api('GET', `/api/versions/${btn.dataset.id}`);
    state.detailNotices = null;
    renderDetail();
    api('GET', `/api/versions/${btn.dataset.id}/change-notices`)
      .then((data) => { state.detailNotices = data; renderDetailNotices(); })
      .catch(() => { state.detailNotices = null; renderDetailNotices(); });
  } catch (e) { alertBar('error', errorToHtml(e)); }
});

// 回看页（含归档版本）只展示更正历史、跳过原因与签认记录，不提供更正/跳过/签认入口
$('#version-detail').addEventListener('click', (ev) => {
  const exBtn = ev.target.closest('button[data-act="open-explain"]');
  if (exBtn) {
    openExplain(Number(exBtn.dataset.cue), 'detail');
    return;
  }
  const histBtn = ev.target.closest('button[data-act="open-history"]');
  if (histBtn) {
    const cueId = Number(histBtn.dataset.cue);
    const v = state.detail;
    const cue = v?.cues.find((x) => x.id === cueId);
    if (cue) openModal(`更正记录：${cue.code}`, renderHistoryHtml(cue, v));
    return;
  }
  const soBtn = ev.target.closest('button[data-act="open-signoffs"]');
  if (soBtn) {
    const cueId = Number(soBtn.dataset.cue);
    const v = state.detail;
    const cue = v?.cues.find((x) => x.id === cueId);
    if (cue) openModal(`放行签认记录：${cue.code}`, renderSignoffHistoryHtml(cue, v));
    return;
  }
  const skipBtn = ev.target.closest('button[data-act="open-skip-view"]');
  if (skipBtn && state.me?.role === 'sm') {
    const cueId = Number(skipBtn.dataset.cue);
    const v = state.detail;
    const cue = v?.cues.find((x) => x.id === cueId);
    if (cue) openSkipView(cue, v);
  }
});

function renderDetailNotices() {
  const body = $('#detail-notice-body');
  if (!body) return;
  const data = state.detailNotices;
  if (!data) { body.textContent = '暂无权限或记录加载失败。'; return; }
  const isSM = state.me?.role === 'sm';
  if (!data.records.length) {
    body.textContent = isSM ? '该版本没有顺延变更记录。' : '该版本中没有你负责岗位的顺延变更记录。';
    return;
  }
  const head = `<div class="muted" style="margin-bottom:8px">
    共 ${data.total} 条，待确认 ${data.pendingCount} 条${data.isLatest ? '' : '（该版本已归档，记录只读，旧提交不能确认）'}
    ${isSM && data.positions?.length ? '；' + data.positions.map((p) => `「${esc(p.position)}」待确认 ${p.pendingCount}`).join('、') : ''}
  </div>`;
  body.innerHTML = head + `
    <div class="table-wrap notice-table-wrap">
      <table>
        <thead><tr><th>提示项</th><th>岗位</th><th>重算开始（前 → 后）</th><th>触发操作</th><th>触发（人 / 时间）</th><th>状态</th></tr></thead>
        <tbody>${data.records.map((n) => `<tr class="${n.acknowledged ? 'notice-acked' : 'notice-pending-row'}">
          <td><strong>${esc(n.code)}</strong><div class="muted">${esc(n.title || '')}</div></td>
          <td>${esc(n.position)}</td>
          <td class="mono">${esc(n.beforeStartText)} → <strong>${esc(n.afterStartText)}</strong> ${deltaText(n)}</td>
          <td><span class="notice-trigger">${esc(n.triggerActionLabel)}</span><div class="muted notice-detail">${esc(n.triggerDetail)}</div></td>
          <td class="mono">${esc(n.triggeredBy)}<br>${esc(n.triggeredAt)}</td>
          <td>${n.acknowledged
            ? `<span class="badge done">已确认</span><div class="muted">${esc(n.acknowledgedBy)}（${esc(n.acknowledgedByUsername || '')}）<br>${esc(n.acknowledgedAt)}</div>`
            : '<span class="badge pending">待确认</span>'}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>`;
}

function renderDetail() {
  const v = state.detail;
  if (!v) return;
  const conflictHtml = v.conflicts.length
    ? `<div class="conflict-banner"><strong>冲突 ${v.conflicts.length} 项：</strong><ul>${
        v.conflicts.map((c) => `<li>${esc(c.message)}</li>`).join('')}</ul></div>` : '';
  // 旧版代班记录只读可查（含在任/已撤销、每次变更的操作者与时间）
  const deputyHtml = (v.deputies || []).length
    ? `<div class="panel"><h3>代班记录（只读）</h3>
        <div class="table-wrap"><table>
          <thead><tr><th>岗位</th><th>代班账号</th><th>状态</th><th>启用（操作者 / 时间）</th><th>撤销（操作者 / 时间）</th></tr></thead>
          <tbody>${v.deputies.map((d) => `<tr>
            <td>${esc(d.position)}</td>
            <td>${esc(d.deputyDisplayName)}（${esc(d.deputyUsername)}）</td>
            <td>${d.active ? '<span class="badge running">在任</span>' : '<span class="badge pending">已撤销</span>'}</td>
            <td class="mono">${esc(d.enabledBy)}<br>${esc(d.enabledAt)}</td>
            <td class="mono">${d.active ? '—' : `${esc(d.revokedBy || '')}<br>${esc(d.revokedAt || '')}`}</td>
          </tr>`).join('')}</tbody>
        </table></div></div>` : '';
  // 旧版联排中断记录只读可查（含进行中/已恢复、停排与恢复的操作者、时间、原因、分钟数）
  const interruptionHtml = (v.interruptions || []).length
    ? `<div class="panel"><h3>联排中断记录（只读 · ${v.interruptions.length} 段${v.activeInterruption ? '，当前停排中' : '，均已恢复'}）</h3>
        <div class="table-wrap"><table>
          <thead><tr><th>停排</th><th>恢复</th><th>中断(分)</th><th>原因</th><th>停排（操作者 / 时间）</th><th>恢复（操作者 / 时间）</th></tr></thead>
          <tbody>${v.interruptions.map((it) => `<tr class="${it.active ? 'pause-row-active' : ''}">
            <td class="mono">${esc(it.pauseText)}</td>
            <td class="mono">${it.active ? '<span class="pause-locked">⛔ 停排中</span>' : esc(it.resumeText)}</td>
            <td class="mono">${it.durationMinutes ?? '—'}</td>
            <td>${esc(it.reason)}</td>
            <td class="mono">${esc(it.pausedBy)}<br>${esc(it.pausedAt)}</td>
            <td class="mono">${it.active ? '—' : `${esc(it.resumedBy)}<br>${esc(it.resumedAt)}`}</td>
          </tr>`).join('')}</tbody>
        </table></div></div>` : '';
  $('#version-detail').innerHTML = `
    <div class="panel">
      <h3>回看：第 ${v.versionNo} 版（只读）${v.isLatest ? '<span class="latest-tag">当前执行版本</span>' : ''}</h3>
      <div class="muted">${esc(v.note)} · 发布于 ${esc(v.createdAt)}</div>
    </div>
    ${v.activeInterruption ? `<div class="pause-banner">⛔ 该版本当前停排中（自 <strong class="mono">${esc(v.activeInterruption.pauseText)}</strong> 起，原因：${esc(v.activeInterruption.reason)}），登记 / 新签认 / 发布均被拒绝。</div>` : ''}
    ${conflictHtml}
    ${(v.resourceAlerts || []).length ? `<div class="resource-banner"><strong>🔶 共享资源超额 ${v.resourceAlerts.length} 项（按该版当前重算口径，仅提示）：</strong><ul>${
        v.resourceAlerts.map((a) => `<li>${esc(a.message)}</li>`).join('')}</ul></div>` : ''}
    ${interruptionHtml}
    ${deputyHtml}
    <div class="panel" id="detail-notices-panel">
      <h3>顺延变更待确认记录（只读）</h3>
      <div id="detail-notice-body" class="muted">加载中…</div>
    </div>
    <div class="panel"><div class="table-wrap"><table>
      <thead><tr><th>编号</th><th>说明</th><th>岗位</th><th>计划</th><th>共享资源</th><th>重算开始</th><th>重算结束</th><th>状态</th><th>放行签认</th><th>实际开始</th><th>实际完成</th><th>预计结束</th><th>登记人/时间</th>${state.me?.role === 'sm' ? '<th>更正</th>' : ''}</tr></thead>
      <tbody>${v.cues.map((c) => {
        const skipped = c.status === 'SKIPPED';
        const skipViewBtn = state.me?.role === 'sm' && skipped
          ? `<button class="ghost tiny" data-act="open-skip-view" data-cue="${c.id}">跳过原因</button>` : '';
        return `<tr class="${skipped ? 'skipped-row' : ''}">
        <td><strong>${esc(c.code)}</strong>${c.release?.required ? '<div class="release-tag">需放行</div>' : ''}</td>
        <td>${esc(c.title)}</td>
        <td>${esc(c.position)}</td>
        <td class="mono">${c.plannedStartText} - ${minText(c.plannedStart + c.duration)}</td>
        ${liveResourceCell(c)}
        <td class="mono">${skipped ? '—' : `${c.schedStartText}${c.delayed ? '<div class="delayed">顺延</div>' : ''}${pauseHoldTag(c)}`}<div>${explainBtn(c, 'detail')}</div></td>
        <td class="mono">${skipped ? '—' : `${c.schedEndText}${pauseShiftTag(c)}`}</td>
        <td>${statusBadge(c.status)}</td>
        <td>${releaseCell(c)}</td>
        <td class="mono">${skipped ? '—' : (c.actualStartText ?? '—')}${handoverTag(c)}${skipTag(c)}</td>
        <td class="mono">${skipped ? '—' : (c.actualEndText ?? '—')}</td>
        <td class="mono">${skipped ? '—' : (c.estimatedEndText ?? '—')}</td>
        <td class="muted">${skipped ? '—' : (c.updatedBy ? esc(c.updatedBy) + '<br>' + esc(c.updatedAt || '') : '—')}</td>
        <td>${state.me?.role === 'sm' ? (skipViewBtn || renderCorrectionCell(c, v, 'detail')) : ''}</td>
      </tr>`;
      }).join('')}</tbody>
    </table></div></div>`;
}

$('#versions-reload').addEventListener('click', () =>
  loadVersions().then(() => alertBar('ok', '版本列表已刷新')).catch((e) => alertBar('error', errorToHtml(e))));

// ---------- 启动 ----------

(async function boot() {
  try {
    const data = await fetch('/api/me').then((r) => r.json());
    if (data.user) {
      state.me = data.user;
      state.positions = data.positions || [];
      showApp();
    } else {
      showLogin();
    }
  } catch {
    showLogin();
  }
})();
