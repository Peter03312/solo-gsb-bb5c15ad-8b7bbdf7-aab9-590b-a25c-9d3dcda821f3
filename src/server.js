'use strict';

process.env.TZ = process.env.TZ || 'Asia/Shanghai';

const path = require('path');
const express = require('express');
const session = require('express-session');

const { db, getMeta, setMeta } = require('./db');
const { verifyPassword } = require('./auth');
const { init } = require('./initdb');
const {
  timeToMin, minToTime, validatePlan, computeLive, topoAnalyze, explainSchedule,
  simulateWhatIf, computeReview, liveResourceAlerts,
} = require('./scheduling');

init();

const app = express();
app.use(express.json());
app.use(
  session({
    name: 'cueboard.sid',
    secret: process.env.SESSION_SECRET || 'cueboard-dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 12 * 60 * 60 * 1000 },
  })
);

class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

// ---------- 辅助 ----------

function currentMinute() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function positionsList() {
  try {
    return JSON.parse(getMeta('positions', '[]'));
  } catch {
    return [];
  }
}

function requireAuth(req, res, next) {
  if (!req.session.user) return next(new ApiError(401, 'UNAUTHORIZED', '尚未登录'));
  next();
}

function requireSM(req, res, next) {
  if (!req.session.user) return next(new ApiError(401, 'UNAUTHORIZED', '尚未登录'));
  if (req.session.user.role !== 'sm') return next(new ApiError(403, 'FORBIDDEN', '仅舞监可执行该操作'));
  next();
}

function checkDraftVersion(bodyVersion) {
  const current = Number(getMeta('draft_version', '0'));
  if (bodyVersion === undefined || bodyVersion === null || Number(bodyVersion) !== current) {
    throw new ApiError(409, 'VERSION_CONFLICT',
      `草稿已被他人修改：当前版本号为 ${current}，提交基于 ${bodyVersion ?? '空'}，请刷新后重试`,
      { currentVersion: current, submittedVersion: bodyVersion ?? null });
  }
  return current;
}

function bumpDraftVersion() {
  const v = Number(getMeta('draft_version', '0')) + 1;
  setMeta('draft_version', v);
  return v;
}

// ---------- 岗位代班（现场临时换人） ----------

function activeDeputyRows(versionId) {
  return db.prepare('SELECT * FROM position_deputies WHERE version_id = ? AND active = 1').all(versionId);
}

// 执行账号在某版本上的可登记岗位集合：
// 原岗位（未被代班顶替时保留）+ 本人作为在任代班的岗位（代班期间获得该岗位登记权，且保留自己原有岗位权限）
function effectivePositionsFor(user, versionId) {
  const deps = activeDeputyRows(versionId);
  const byPos = new Map(deps.map((d) => [d.position, d]));
  const set = new Set();
  if (user.position) {
    const dep = byPos.get(user.position);
    if (!dep || dep.deputy_user_id === user.id) set.add(user.position);
  }
  for (const d of deps) if (d.deputy_user_id === user.id) set.add(d.position);
  return set;
}

function deputyRecordJson(d) {
  return {
    id: d.id,
    position: d.position,
    deputyUsername: d.deputy_username,
    deputyDisplayName: d.deputy_display_name,
    active: d.active === 1,
    enabledBy: d.enabled_by,
    enabledAt: d.enabled_at,
    revokedBy: d.revoked_by,
    revokedAt: d.revoked_at,
  };
}

// ---------- 双人放行签认：失效传播与开始门禁 ----------

// 登记行版本推进后，使「目标为该提示项」及「直接前置含该提示项」的有效签认失效（保留记录与原因供回看）
function invalidateSignoffsForCueChange(versionId, cueRef, code, newRowVer, stamp) {
  db.prepare(
    `UPDATE release_signoffs SET active = 0, invalidated_reason = ?, invalidated_at = ?
     WHERE version_id = ? AND cue_ref = ? AND active = 1`
  ).run(`目标提示项「${code}」登记已更新（行版本推进至 v${newRowVer}），签认失效`, stamp, versionId, cueRef);
  db.prepare(
    `UPDATE release_signoffs SET active = 0, invalidated_reason = ?, invalidated_at = ?
     WHERE active = 1 AND id IN (
       SELECT s.id FROM release_signoffs s
       JOIN release_signoff_preds p ON p.signoff_id = s.id
       WHERE s.version_id = ? AND p.cue_ref = ?
     )`
  ).run(`直接前置「${code}」登记已更新（行版本推进至 v${newRowVer}），签认失效`, stamp, versionId, cueRef);
}

// 代班变更后：重新核对本版该岗位全部有效「执行人」签认的签认人，
// 失去该岗位登记权者的签认失效（舞监签认不受代班影响）
function invalidateSignoffsForPositionAuth(versionId, position, stamp) {
  const rows = db.prepare(
    `SELECT s.id, s.signer_user_id FROM release_signoffs s
     JOIN published_cues pc ON pc.version_id = s.version_id AND pc.cue_ref = s.cue_ref
     WHERE s.version_id = ? AND pc.position = ? AND s.active = 1 AND s.kind = 'operator'`
  ).all(versionId, position);
  for (const r of rows) {
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(r.signer_user_id);
    if (!u || !effectivePositionsFor(u, versionId).has(position)) {
      db.prepare(
        'UPDATE release_signoffs SET active = 0, invalidated_reason = ?, invalidated_at = ? WHERE id = ?'
      ).run(`岗位「${position}」代班变更，签认人已不再拥有该岗位登记权，签认失效`, stamp, r.id);
    }
  }
}

// 开始门禁：复核某需放行提示项的两类签认是否齐备且仍有效。
// 双保险复核快照与当前登记行版本（正常路径已由登记/更正/跳过主动置失效）；
// 发现不一致就地置失效并视为缺失。须在某事务内调用。
function releaseGateCheck(versionId, cueRef, currentRowVer, stamp) {
  const rows = db.prepare(
    'SELECT * FROM release_signoffs WHERE version_id = ? AND cue_ref = ? AND active = 1'
  ).all(versionId, cueRef);
  const predStmt = db.prepare('SELECT cue_ref, row_ver FROM release_signoff_preds WHERE signoff_id = ?');
  const regStmt = db.prepare('SELECT row_ver FROM registrations WHERE version_id = ? AND cue_ref = ?');
  const codeStmt = db.prepare('SELECT code FROM published_cues WHERE version_id = ? AND cue_ref = ?');
  const valid = new Set();
  for (const s of rows) {
    let staleReason = null;
    if (s.target_row_ver !== currentRowVer) {
      staleReason = `目标提示项登记已更新（签认基于行版本 v${s.target_row_ver}，当前 v${currentRowVer}），签认失效`;
    } else {
      for (const p of predStmt.all(s.id)) {
        const cur = regStmt.get(versionId, p.cue_ref);
        if (!cur || cur.row_ver !== p.row_ver) {
          const pcode = codeStmt.get(versionId, p.cue_ref)?.code || `#${p.cue_ref}`;
          staleReason = `直接前置「${pcode}」登记已更新（签认基于行版本 v${p.row_ver}，当前 v${cur ? cur.row_ver : '缺失'}），签认失效`;
          break;
        }
      }
    }
    if (staleReason) {
      db.prepare('UPDATE release_signoffs SET active = 0, invalidated_reason = ?, invalidated_at = ? WHERE id = ?')
        .run(staleReason, stamp, s.id);
      continue;
    }
    valid.add(s.kind);
  }
  const items = [];
  if (!valid.has('operator')) items.push({ kind: 'operator', reason: '缺少有效的执行人签认（本岗位当班执行人「签认就绪」）' });
  if (!valid.has('sm')) items.push({ kind: 'sm', reason: '缺少有效的舞监签认（舞监「签认可执行」）' });
  return { ready: items.length === 0, items };
}

function deputyRowsFor(versionId) {
  return db.prepare('SELECT * FROM position_deputies WHERE version_id = ? ORDER BY id DESC').all(versionId);
}

function loadDraftCues() {
  return db.prepare(
    'SELECT id, code, title, position, planned_start, duration, needs_release, row_ver FROM draft_cues ORDER BY id'
  ).all().map((c) => ({
    id: c.id, code: c.code, title: c.title, position: c.position,
    plannedStart: c.planned_start, duration: c.duration,
    needsRelease: c.needs_release === 1, rowVersion: c.row_ver,
  }));
}

function loadDraftDeps() {
  return db.prepare('SELECT id, from_cue, to_cue FROM draft_deps ORDER BY id').all()
    .map((d) => ({ id: d.id, from: d.from_cue, to: d.to_cue }));
}

// 草稿共享资源（按 id 稳定排序）
function loadDraftResources() {
  return db.prepare('SELECT id, name, capacity FROM draft_resources ORDER BY id').all()
    .map((r) => ({ id: r.id, name: r.name, capacity: r.capacity }));
}

// 草稿资源占用：cue id -> [{resourceId, resourceName, usage}]
function loadDraftResourceUsages() {
  const map = new Map();
  const rows = db.prepare(
    `SELECT cr.cue_id, cr.resource_id, cr.usage, r.name AS resource_name
     FROM draft_cue_resources cr JOIN draft_resources r ON r.id = cr.resource_id
     ORDER BY cr.cue_id, cr.resource_id`
  ).all();
  for (const row of rows) {
    if (!map.has(row.cue_id)) map.set(row.cue_id, []);
    map.get(row.cue_id).push({ resourceId: row.resource_id, resourceName: row.resource_name, usage: row.usage });
  }
  return map;
}

// 校验用：cue id -> [{resourceId, usage}]
function draftUsageMapForValidate() {
  const map = new Map();
  for (const [cueId, list] of loadDraftResourceUsages().entries()) {
    map.set(cueId, list.map((u) => ({ resourceId: u.resourceId, usage: u.usage })));
  }
  return map;
}

function draftPayload() {
  const cues = loadDraftCues();
  const deps = loadDraftDeps();
  const resources = loadDraftResources();
  const usages = loadDraftResourceUsages();
  // 引用计数用于前端展示「仍被引用，不能删除」（删除由服务端强制）
  const refCount = new Map();
  for (const list of usages.values()) {
    for (const u of list) refCount.set(u.resourceId, (refCount.get(u.resourceId) || 0) + 1);
  }
  const validation = validatePlan(cues, deps, resources, draftUsageMapForValidate());
  return {
    version: Number(getMeta('draft_version', '0')),
    positions: positionsList(),
    resources: resources.map((r) => ({ ...r, cueCount: refCount.get(r.id) || 0 })),
    cues: cues.map((c) => ({
      ...c,
      plannedStartText: minToTime(c.plannedStart),
      resourceUsages: usages.get(c.id) || [],
    })),
    deps,
    validation,
  };
}

// 解析提示项表单中的资源占用：resources 为当前草稿资源数组。
// 支持 [{resourceId, usage}] 或 {resourceId: usage}；正整数占用；引用必须存在。
function parseCueResourceUsages(raw, resources) {
  const byId = new Map(resources.map((r) => [r.id, r]));
  const entries = [];
  if (raw === undefined || raw === null) return entries;
  const pushOne = (resourceId, usageRaw) => {
    if (usageRaw === null || usageRaw === undefined || usageRaw === '') return; // 留空 = 不占用
    const rid = Number(resourceId);
    const usage = Number(usageRaw);
    if (!Number.isInteger(rid) || !byId.has(rid)) {
      throw new ApiError(400, 'RESOURCE_REF_INVALID', `存在失效的共享资源引用（资源 #${resourceId} 已不存在），请刷新草稿后重试`);
    }
    if (!Number.isInteger(usage) || usage <= 0) {
      throw new ApiError(400, 'RESOURCE_USAGE_INVALID', `共享资源「${byId.get(rid).name}」的占用量必须为正整数`);
    }
    entries.push({ resourceId: rid, usage });
  };
  if (Array.isArray(raw)) {
    for (const it of raw) {
      const rid = it && (it.resourceId ?? it.id);
      const usage = it && (it.usage ?? it.quantity);
      if (rid === undefined || rid === null) {
        throw new ApiError(400, 'BAD_INPUT', '资源占用每项须包含 resourceId 与正整数 usage');
      }
      pushOne(rid, usage);
    }
  } else if (typeof raw === 'object') {
    for (const [rid, usage] of Object.entries(raw)) pushOne(rid, usage);
  } else {
    throw new ApiError(400, 'BAD_INPUT', '资源占用格式无效：应为数组 [{resourceId, usage}]');
  }
  const seen = new Set();
  for (const e of entries) {
    if (seen.has(e.resourceId)) {
      throw new ApiError(400, 'BAD_INPUT', `共享资源「${byId.get(e.resourceId).name}」在同一提示项中重复填写`);
    }
    seen.add(e.resourceId);
  }
  return entries;
}

function cueInputFromBody(body) {
  const code = String(body.code || '').trim();
  const title = String(body.title || '').trim();
  const position = String(body.position || '').trim();
  const startText = String(body.plannedStartText || '').trim();
  const plannedStart = timeToMin(startText);
  const duration = Number(body.duration);
  // 需放行：勾选后该提示项须「执行人签认就绪 + 舞监签认可执行」齐备才能登记实际开始；随发布冻结
  const needsRelease = body.needsRelease === true || body.needsRelease === 1
    || body.needsRelease === '1' || body.needsRelease === 'true' || body.needsRelease === 'on';
  if (!code) throw new ApiError(400, 'BAD_INPUT', '提示项编号不能为空');
  if (!position) throw new ApiError(400, 'BAD_INPUT', `「${code}」岗位不能为空`);
  if (!positionsList().includes(position)) throw new ApiError(400, 'BAD_INPUT', `岗位「${position}」不在已配置岗位列表中`);
  if (plannedStart === null) throw new ApiError(400, 'BAD_INPUT', `「${code}」计划开始时间格式应为 HH:MM`);
  if (!Number.isInteger(duration) || duration <= 0) throw new ApiError(400, 'BAD_INPUT', `「${code}」时长必须为正整数分钟`);
  return { code, title, position, plannedStart, duration, needsRelease: needsRelease ? 1 : 0 };
}

// 某版本的计划与现场登记输入（发布时冻结的提示项/前置 + 当前登记），供现场重算与排期来源解释共用
function versionInputs(versionId) {
  const cues = db.prepare(
    `SELECT cue_ref, code, title, position, planned_start, duration, needs_release
     FROM published_cues WHERE version_id = ? ORDER BY id`
  ).all(versionId).map((c) => ({
    id: c.cue_ref, code: c.code, title: c.title, position: c.position,
    plannedStart: c.planned_start, duration: c.duration,
    needsRelease: c.needs_release === 1,
  }));
  const deps = db.prepare(
    'SELECT from_ref, to_ref FROM published_deps WHERE version_id = ? ORDER BY id'
  ).all(versionId).map((d) => ({ from: d.from_ref, to: d.to_ref }));

  const regRows = db.prepare(
    'SELECT * FROM registrations WHERE version_id = ?'
  ).all(versionId);
  const regMap = new Map();
  for (const r of regRows) {
    regMap.set(r.cue_ref, {
      actualStart: r.actual_start, actualEnd: r.actual_end,
      estimatedEnd: r.estimated_end, skipped: r.skipped === 1,
      rowVer: r.row_ver,
      updatedBy: r.updated_by, updatedAt: r.updated_at,
      sourceVersionId: r.source_version_id, sourceCueRef: r.source_cue_ref,
    });
  }
  // 联排中断记录（按时间先后）；resume_minute 为 NULL 的为当前进行中的停排
  const interruptions = db.prepare(
    `SELECT id, pause_minute, reason, paused_by, paused_at, resume_minute, resumed_by, resumed_at
     FROM rehearsal_interruptions WHERE version_id = ? ORDER BY id`
  ).all(versionId).map((it) => ({
    id: it.id,
    pauseMinute: it.pause_minute,
    reason: it.reason,
    pausedBy: it.paused_by,
    pausedAt: it.paused_at,
    resumeMinute: it.resume_minute,
    resumedBy: it.resumed_by,
    resumedAt: it.resumed_at,
  }));
  // 发布时冻结的共享资源（容量）与提示项占用；旧版无资源数据时为空数组/空 Map，沿用原有行为
  const resources = db.prepare(
    'SELECT resource_id AS id, name, capacity FROM published_resources WHERE version_id = ? ORDER BY id'
  ).all(versionId);
  const resourceUsages = new Map();
  db.prepare(
    'SELECT cue_ref, resource_id AS resourceId, usage FROM published_cue_resources WHERE version_id = ? ORDER BY id'
  ).all(versionId).forEach((u) => {
    if (!resourceUsages.has(u.cue_ref)) resourceUsages.set(u.cue_ref, []);
    resourceUsages.get(u.cue_ref).push({ resourceId: u.resourceId, usage: u.usage });
  });
  return { cues, deps, regMap, interruptions, resources, resourceUsages };
}

// 当前进行中的停排（同版至多一段；无则 null）
function activeInterruption(versionId) {
  return db.prepare(
    'SELECT * FROM rehearsal_interruptions WHERE version_id = ? AND resume_minute IS NULL'
  ).get(versionId) || null;
}

// 某时刻是否落入该版本任一段停排区间（半开 [pause, resume)；进行中的停排以 [pause, +∞) 处理）
function timeInAnyInterruption(versionId, minute) {
  return db.prepare(
    'SELECT id, pause_minute, resume_minute FROM rehearsal_interruptions WHERE version_id = ?'
  ).all(versionId).some((it) =>
    minute >= it.pause_minute && (it.resume_minute === null || minute < it.resume_minute));
}

// 联排中断记录 JSON（现场与历史回看共用）
function interruptionJson(it) {
  return {
    id: it.id,
    pauseMinute: it.pauseMinute ?? it.pause_minute,
    pauseText: minToTime(it.pauseMinute ?? it.pause_minute),
    reason: it.reason,
    pausedBy: it.pausedBy ?? it.paused_by,
    pausedAt: it.pausedAt ?? it.paused_at,
    resumeMinute: it.resumeMinute ?? it.resume_minute ?? null,
    resumeText: minToTime(it.resumeMinute ?? it.resume_minute ?? null),
    resumedBy: it.resumedBy ?? it.resumed_by ?? null,
    resumedAt: it.resumedAt ?? it.resumed_at ?? null,
    durationMinutes: (it.resumeMinute ?? it.resume_minute) != null
      ? (it.resumeMinute ?? it.resume_minute) - (it.pauseMinute ?? it.pause_minute)
      : null,
    active: (it.resumeMinute ?? it.resume_minute) == null,
  };
}

// 某版本全部放行签认记录（含已失效），按提示项分组；每条含直接前置行版本快照
function signoffsByCue(versionId, codeByRef) {
  const rows = db.prepare(
    'SELECT * FROM release_signoffs WHERE version_id = ? ORDER BY id'
  ).all(versionId);
  const byCue = new Map();
  if (!rows.length) return byCue;
  const predRows = db.prepare(
    `SELECT p.signoff_id, p.cue_ref, p.row_ver FROM release_signoff_preds p
     JOIN release_signoffs s ON s.id = p.signoff_id WHERE s.version_id = ?
     ORDER BY p.cue_ref`
  ).all(versionId);
  const predsBySignoff = new Map();
  for (const p of predRows) {
    if (!predsBySignoff.has(p.signoff_id)) predsBySignoff.set(p.signoff_id, []);
    predsBySignoff.get(p.signoff_id).push({
      cueRef: p.cue_ref, rowVer: p.row_ver, code: codeByRef.get(p.cue_ref) ?? null,
    });
  }
  for (const s of rows) {
    const rec = {
      id: s.id,
      kind: s.kind,                       // operator 执行人就绪 / sm 舞监可执行
      signedBy: s.signer_display_name,
      signerUsername: s.signer_username,
      signedAt: s.signed_at,
      targetRowVer: s.target_row_ver,
      preds: predsBySignoff.get(s.id) || [],
      active: s.active === 1,
      invalidReason: s.invalidated_reason,
      invalidatedAt: s.invalidated_at,
    };
    if (!byCue.has(s.cue_ref)) byCue.set(s.cue_ref, []);
    byCue.get(s.cue_ref).push(rec);
  }
  return byCue;
}

// 单个需放行提示项的放行状态：同类取最新一条签认为当前状态，全部记录供回看
function releaseViewOf(records) {
  const slot = (kind) => {
    const list = records.filter((r) => r.kind === kind);
    const rec = list.length ? list[list.length - 1] : null; // 记录按 id 升序，末条最新
    if (!rec) return { state: 'missing' };
    const base = {
      signedBy: rec.signedBy,
      signerUsername: rec.signerUsername,
      signedAt: rec.signedAt,
      targetRowVer: rec.targetRowVer,
      preds: rec.preds,
    };
    if (rec.active) return { state: 'valid', ...base };
    return { state: 'invalid', ...base, invalidReason: rec.invalidReason, invalidatedAt: rec.invalidatedAt };
  };
  const operator = slot('operator');
  const sm = slot('sm');
  return {
    required: true,
    ready: operator.state === 'valid' && sm.state === 'valid',
    operator,
    sm,
    records: records.slice().reverse(), // 回看用：最新在前
  };
}

// ---------- 顺延变更待确认（岗位漏看顺延提示的留痕与确认） ----------

const NOTICE_ACTION_LABELS = {
  register: '岗位登记',
  correct: '舞监更正',
  skip: '跳过链',
  pause: '停排',
  resume: '恢复',
};

// 某版本当前「未开始、未跳过」提示项的重算开始时刻：cueRef -> 分钟（以同次读取的版本输入现场重算）
function pendingStartMap(versionId) {
  const { cues, deps, regMap, interruptions } = versionInputs(versionId);
  const live = computeLive(cues, deps, regMap, interruptions);
  const map = new Map();
  if (live.orderProblem) return map;
  for (const c of live.cues) {
    if (c.status === 'PENDING') map.set(c.id, c.schedStart);
  }
  return map;
}

/**
 * 同一次操作前后对照，为重算开始时刻发生变化、且操作后仍为「未开始、未跳过」的提示项分别留一条待确认记录。
 * 必须在触发操作所在事务内、且在所有登记/停排写入完成之后调用；事务随后失败回滚时记录一并回滚，不留痕。
 * beforeMap 须为操作写入前的 pendingStartMap（操作前未开始且未跳过的项才可能被记录）。
 * 记录冻结版本、提示项编号/说明/岗位、变更前后时刻、触发操作（类型+可读说明+直接操作项）与操作人/时间。
 */
function recordScheduleChanges(versionId, beforeMap, { action, detail, triggerCueRef = null, triggerCueCode = null, by, at }) {
  if (!beforeMap || beforeMap.size === 0) return 0;
  const afterMap = pendingStartMap(versionId);
  const cueStmt = db.prepare(
    'SELECT code, title, position FROM published_cues WHERE version_id = ? AND cue_ref = ?'
  );
  const ins = db.prepare(
    `INSERT INTO schedule_change_notices(
       version_id, cue_ref, code, title, position, before_start, after_start,
       trigger_action, trigger_detail, trigger_cue_ref, trigger_cue_code, triggered_by, triggered_at)
     VALUES (@version_id, @cue_ref, @code, @title, @position, @before_start, @after_start,
       @trigger_action, @trigger_detail, @trigger_cue_ref, @trigger_cue_code, @triggered_by, @triggered_at)`
  );
  let count = 0;
  for (const [cueRef, beforeStart] of beforeMap) {
    const afterStart = afterMap.get(cueRef); // 操作后仍为未开始且未跳过才在 Map 中；已开始 / 已跳过 / 已完成不留痕
    if (afterStart === undefined || afterStart === null || afterStart === beforeStart) continue;
    const pc = cueStmt.get(versionId, cueRef);
    if (!pc) continue;
    ins.run({
      version_id: versionId,
      cue_ref: cueRef,
      code: pc.code,
      title: pc.title,
      position: pc.position,
      before_start: beforeStart,
      after_start: afterStart,
      trigger_action: action,
      trigger_detail: detail,
      trigger_cue_ref: triggerCueRef,
      trigger_cue_code: triggerCueCode,
      triggered_by: by,
      triggered_at: at,
    });
    count += 1;
  }
  return count;
}

// 待确认记录 JSON（冻结字段 + 前后时刻文本 + 确认状态；recordVersion 供确认时乐观锁提交）
function noticeJson(n) {
  return {
    id: n.id,
    versionId: n.version_id,
    versionNo: n.version_no,
    cueRef: n.cue_ref,
    code: n.code,
    title: n.title,
    position: n.position,
    beforeStart: n.before_start,
    afterStart: n.after_start,
    beforeStartText: minToTime(n.before_start),
    afterStartText: minToTime(n.after_start),
    deltaMinutes: n.after_start - n.before_start,
    triggerAction: n.trigger_action,
    triggerActionLabel: NOTICE_ACTION_LABELS[n.trigger_action] || n.trigger_action,
    triggerDetail: n.trigger_detail,
    triggerCueRef: n.trigger_cue_ref,
    triggerCueCode: n.trigger_cue_code,
    triggeredBy: n.triggered_by,
    triggeredAt: n.triggered_at,
    acknowledged: n.row_ver >= 2,
    acknowledgedBy: n.acknowledged_by,
    acknowledgedByUsername: n.acknowledged_by_username,
    acknowledgedAt: n.acknowledged_at,
    recordVersion: n.row_ver,
  };
}

/**
 * 待确认清单：执行账号只返回其当前（代班后）有权负责岗位的记录；舞监返回全部记录。
 * 排序：待确认在前（id 倒序，新变更先确认），已确认在后（id 倒序）。
 * 同时给出该范围内的待确认总数；舞监另给出按岗位分组的待确认数（用于监督漏看）。
 * 旧联排版本可传入历史版本只读回看；该范围下执行账号的确认提交会被确认接口拒绝（版本须仍为当前执行版）。
 */
function noticeEnvelope(versionId, user) {
  const ver = db.prepare('SELECT * FROM rehearsal_versions WHERE id = ?').get(versionId);
  const latest = latestPublishedVersion();
  const positions = user.role === 'operator' ? [...effectivePositionsFor(user, versionId)] : null;
  let rows;
  if (positions) {
    if (positions.length === 0) rows = [];
    else {
      rows = db.prepare(
        `SELECT n.*, v.version_no FROM schedule_change_notices n
         JOIN rehearsal_versions v ON v.id = n.version_id
         WHERE n.version_id = ? AND n.position IN (${positions.map(() => '?').join(',')})
         ORDER BY n.id DESC`
      ).all(versionId, ...positions);
    }
  } else {
    rows = db.prepare(
      `SELECT n.*, v.version_no FROM schedule_change_notices n
       JOIN rehearsal_versions v ON v.id = n.version_id
       WHERE n.version_id = ? ORDER BY n.id DESC`
    ).all(versionId);
  }
  const records = rows.map(noticeJson);
  const pending = records.filter((r) => !r.acknowledged);
  const acknowledged = records.filter((r) => r.acknowledged);
  const ordered = pending.concat(acknowledged);
  const byPosition = new Map();
  if (user.role === 'sm') {
    for (const r of pending) byPosition.set(r.position, (byPosition.get(r.position) || 0) + 1);
  }
  return {
    versionId,
    versionNo: ver ? ver.version_no : null,
    isLatest: !!(latest && ver && latest.id === ver.id),
    scope: user.role === 'sm' ? 'all' : 'mine',
    myPositions: positions,
    total: records.length,
    pendingCount: pending.length,
    positions: [...byPosition.entries()].map(([position, count]) => ({ position, pendingCount: count }))
      .sort((a, b) => a.position.localeCompare(b.position, 'zh-Hans-CN')),
    records: ordered,
  };
}

function versionPayload(versionRow) {
  const { cues, deps, regMap, interruptions, resources, resourceUsages } = versionInputs(versionRow.id);

  // 依赖链跳过留痕（每项至多一条）：操作者、时间、原因、触发根项
  const skipMap = new Map();
  db.prepare(
    `SELECT cue_ref, root_cue_ref, reason, skipped_by, skipped_at
     FROM registration_skips WHERE version_id = ?`
  ).all(versionRow.id).forEach((s) => skipMap.set(s.cue_ref, {
    rootCueRef: s.root_cue_ref,
    reason: s.reason,
    skippedBy: s.skipped_by,
    skippedAt: s.skipped_at,
  }));

  const live = computeLive(cues, deps, regMap, interruptions);
  // 现场共享资源超额告警（口径与现场重算一致：跳过项不占用，仅已完成项构成的超额不告警；只提示不阻止登记）
  const resourceAlerts = liveResourceAlerts(resources, live.cues, resourceUsages);
  const latestId = (db.prepare('SELECT MAX(version_no) AS m FROM rehearsal_versions').get().m);

  // 放行签认：cue_ref -> 该提示项全部签认记录（含已失效，按 id 升序）
  const codeByRef = new Map(cues.map((c) => [c.id, c.code]));
  const signoffMap = signoffsByCue(versionRow.id, codeByRef);

  // 交接延续来源：sourceVersionId -> 版本号；(版本, cue_ref) -> 旧版编号
  const sourceRefs = [...regMap.values()]
    .filter((r) => r.sourceVersionId != null)
    .map((r) => ({ svid: r.sourceVersionId, sref: r.sourceCueRef }));
  const sourceVerNo = new Map();
  const sourceCode = new Map();
  if (sourceRefs.length) {
    const vIds = [...new Set(sourceRefs.map((s) => s.svid))];
    db.prepare(
      `SELECT id, version_no FROM rehearsal_versions WHERE id IN (${vIds.map(() => '?').join(',')})`
    ).all(...vIds).forEach((v) => sourceVerNo.set(v.id, v.version_no));
    const q = db.prepare('SELECT code FROM published_cues WHERE version_id = ? AND cue_ref = ?');
    for (const s of sourceRefs) {
      const row = q.get(s.svid, s.sref);
      sourceCode.set(`${s.svid}:${s.sref}`, row ? row.code : null);
    }
  }

  const corrRows = db.prepare(
    `SELECT cue_ref, field, old_value, new_value, reason, cascaded, corrected_by, corrected_at
     FROM registration_corrections WHERE version_id = ?
     ORDER BY COALESCE(group_id, id) DESC, id ASC`
  ).all(versionRow.id);
  const corrMap = new Map();
  for (const c of corrRows) {
    if (!corrMap.has(c.cue_ref)) corrMap.set(c.cue_ref, []);
    corrMap.get(c.cue_ref).push({
      field: c.field,
      oldValueText: minToTime(c.old_value),
      newValueText: minToTime(c.new_value),
      reason: c.reason,
      cascaded: c.cascaded === 1,
      correctedBy: c.corrected_by,
      correctedAt: c.corrected_at,
    });
  }

  return {
    id: versionRow.id,
    versionNo: versionRow.version_no,
    note: versionRow.note,
    createdAt: versionRow.created_at,
    isLatest: versionRow.version_no === latestId,
    deputies: deputyRowsFor(versionRow.id).map(deputyRecordJson),
    cues: live.cues.map((c) => ({
      ...c,
      plannedStartText: minToTime(c.plannedStart),
      schedStartText: minToTime(c.schedStart),
      schedEndText: minToTime(c.schedEnd),
      actualStartText: minToTime(c.actualStart),
      actualEndText: minToTime(c.actualEnd),
      estimatedEndText: minToTime(c.estimatedEnd),
      // 联排中断对该项的影响：已开始项推算/预计结束顺延分钟；未开始项被「不得早于」最近恢复/停排时刻托住
      interrupted: c.interrupted === true,
      pauseShiftMinutes: c.pauseShift || 0,
      pauseHoldText: minToTime(c.pauseHold),
      corrections: corrMap.get(c.id) || [],
      skip: (() => {
        const s = skipMap.get(c.id);
        if (!s) return null;
        const rootCue = cues.find((x) => x.id === s.rootCueRef);
        return {
          reason: s.reason,
          skippedBy: s.skippedBy,
          skippedAt: s.skippedAt,
          rootCueRef: s.rootCueRef,
          rootCode: rootCue ? rootCue.code : null,
        };
      })(),
      handover: (() => {
        const r = regMap.get(c.id);
        if (!r || r.sourceVersionId == null) return null;
        return {
          sourceVersionId: r.sourceVersionId,
          sourceVersionNo: sourceVerNo.get(r.sourceVersionId) ?? null,
          sourceCueRef: r.sourceCueRef,
          sourceCode: sourceCode.get(`${r.sourceVersionId}:${r.sourceCueRef}`) ?? c.code,
        };
      })(),
      // 需放行项：双签状态与失效原因（未标记项 required=false，按原流程登记）
      release: c.needsRelease
        ? releaseViewOf(signoffMap.get(c.id) || [])
        : { required: false },
      // 发布时冻结的共享资源占用（旧版无资源数据时为空数组）
      resourceUsages: (resourceUsages.get(c.id) || []).map((u) => {
        const res = resources.find((r) => r.id === u.resourceId);
        return { resourceId: u.resourceId, resourceName: res ? res.name : `#${u.resourceId}`, usage: u.usage };
      }),
    })),
    conflicts: live.conflicts,
    orderProblem: live.orderProblem,
    // 共享资源：冻结的资源定义与现场超额告警（旧版无资源数据时为空，前端沿用原有行为）
    resources: resources.map((r) => ({ id: r.id, name: r.name, capacity: r.capacity })),
    resourceAlerts,
    // 联排中断：全部停排记录（含已恢复，留痕回看）与当前进行中的停排（无则 null）
    interruptions: interruptions.map(interruptionJson),
    activeInterruption: (() => {
      const active = interruptions.find((it) => it.resumeMinute == null);
      return active ? interruptionJson(active) : null;
    })(),
  };
}

// ---------- 认证 ----------

app.post('/api/login', (req, res, next) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    if (!username || !password) throw new ApiError(400, 'BAD_INPUT', '用户名与密码不能为空');
    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!u || !verifyPassword(password, u.password_hash)) {
      throw new ApiError(401, 'BAD_CREDENTIALS', '用户名或密码错误');
    }
    req.session.user = { id: u.id, username: u.username, role: u.role, position: u.position, displayName: u.display_name };
    res.json({ user: req.session.user });
  } catch (e) { next(e); }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  res.json({ user: req.session.user || null, positions: positionsList() });
});

// ---------- 舞监：草稿编辑 ----------

app.get('/api/draft', requireSM, (req, res, next) => {
  try { res.json(draftPayload()); } catch (e) { next(e); }
});

app.get('/api/draft/validate', requireSM, (req, res, next) => {
  try {
    res.json(validatePlan(loadDraftCues(), loadDraftDeps(), loadDraftResources(), draftUsageMapForValidate()));
  } catch (e) { next(e); }
});

// ---------- 舞监：共享资源（草稿配置：名称 + 正整数容量） ----------

app.post('/api/draft/resources', requireSM, (req, res, next) => {
  try {
    checkDraftVersion(req.body.version);
    const name = String(req.body.name || '').trim();
    const capacity = Number(req.body.capacity);
    if (!name) throw new ApiError(400, 'BAD_INPUT', '共享资源名称不能为空');
    if (name.length > 50) throw new ApiError(400, 'BAD_INPUT', '共享资源名称不能超过 50 字');
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new ApiError(400, 'BAD_INPUT', '共享资源容量必须为正整数');
    }
    if (db.prepare('SELECT 1 FROM draft_resources WHERE name = ?').get(name)) {
      throw new ApiError(400, 'RESOURCE_NAME_EXISTS', `共享资源「${name}」已存在`);
    }
    db.prepare('INSERT INTO draft_resources(name, capacity) VALUES (?, ?)').run(name, capacity);
    bumpDraftVersion();
    res.status(201).json(draftPayload());
  } catch (e) {
    if (String(e.code || '').includes('SQLITE_CONSTRAINT_UNIQUE')) {
      return next(new ApiError(400, 'RESOURCE_NAME_EXISTS', '同名共享资源已存在'));
    }
    next(e);
  }
});

app.put('/api/draft/resources/:id', requireSM, (req, res, next) => {
  try {
    checkDraftVersion(req.body.version);
    const id = Number(req.params.id);
    const resRow = db.prepare('SELECT * FROM draft_resources WHERE id = ?').get(id);
    if (!resRow) throw new ApiError(404, 'NOT_FOUND', '共享资源不存在');
    const name = String(req.body.name ?? resRow.name).trim();
    const capacity = Number(req.body.capacity ?? resRow.capacity);
    if (!name) throw new ApiError(400, 'BAD_INPUT', '共享资源名称不能为空');
    if (name.length > 50) throw new ApiError(400, 'BAD_INPUT', '共享资源名称不能超过 50 字');
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new ApiError(400, 'BAD_INPUT', '共享资源容量必须为正整数');
    }
    const dup = db.prepare('SELECT 1 FROM draft_resources WHERE name = ? AND id != ?').get(name, id);
    if (dup) throw new ApiError(400, 'RESOURCE_NAME_EXISTS', `共享资源「${name}」已存在`);
    db.prepare('UPDATE draft_resources SET name = ?, capacity = ? WHERE id = ?').run(name, capacity, id);
    bumpDraftVersion();
    res.json(draftPayload());
  } catch (e) {
    if (String(e.code || '').includes('SQLITE_CONSTRAINT_UNIQUE')) {
      return next(new ApiError(400, 'RESOURCE_NAME_EXISTS', '同名共享资源已存在'));
    }
    next(e);
  }
});

// 仍被提示项引用的资源不能删除（逐项给出引用提示项，整体拒绝）
app.delete('/api/draft/resources/:id', requireSM, (req, res, next) => {
  try {
    checkDraftVersion(Number(req.query.version));
    const id = Number(req.params.id);
    const resRow = db.prepare('SELECT * FROM draft_resources WHERE id = ?').get(id);
    if (!resRow) throw new ApiError(404, 'NOT_FOUND', '共享资源不存在');
    const refs = db.prepare(
      `SELECT c.id, c.code FROM draft_cue_resources cr
       JOIN draft_cues c ON c.id = cr.cue_id WHERE cr.resource_id = ? ORDER BY c.id`
    ).all(id);
    if (refs.length) {
      throw new ApiError(409, 'RESOURCE_IN_USE',
        `共享资源「${resRow.name}」仍被 ${refs.length} 个提示项引用（${refs.map((c) => c.code).join('、')}），请先移除这些提示项的占用再删除`,
        { items: refs.map((c) => ({ cueId: c.id, code: c.code, reason: `「${c.code}」仍占用该资源` })) });
    }
    db.prepare('DELETE FROM draft_resources WHERE id = ?').run(id);
    bumpDraftVersion();
    res.json(draftPayload());
  } catch (e) { next(e); }
});

app.post('/api/draft/cues', requireSM, (req, res, next) => {
  try {
    checkDraftVersion(req.body.version);
    const fields = cueInputFromBody(req.body);
    const dup = db.prepare('SELECT 1 FROM draft_cues WHERE code = ?').get(fields.code);
    if (dup) throw new ApiError(400, 'BAD_INPUT', `编号「${fields.code}」已存在`);
    const resourceUsages = parseCueResourceUsages(req.body.resources, loadDraftResources());
    db.transaction(() => {
      const info = db.prepare(
        `INSERT INTO draft_cues(code, title, position, planned_start, duration, needs_release)
         VALUES (@code, @title, @position, @plannedStart, @duration, @needsRelease)`
      ).run(fields);
      const cueId = info.lastInsertRowid;
      const insUsage = db.prepare(
        'INSERT INTO draft_cue_resources(cue_id, resource_id, usage) VALUES (?, ?, ?)'
      );
      for (const u of resourceUsages) insUsage.run(cueId, u.resourceId, u.usage);
    })();
    bumpDraftVersion();
    res.status(201).json(draftPayload());
  } catch (e) { next(e); }
});

app.put('/api/draft/cues/:id', requireSM, (req, res, next) => {
  try {
    checkDraftVersion(req.body.version);
    const id = Number(req.params.id);
    const cue = db.prepare('SELECT * FROM draft_cues WHERE id = ?').get(id);
    if (!cue) throw new ApiError(404, 'NOT_FOUND', '提示项不存在');
    if (Number(req.body.rowVersion) !== cue.row_ver) {
      throw new ApiError(409, 'ROW_VERSION_CONFLICT',
        `提示项「${cue.code}」已被修改：当前行版本 ${cue.row_ver}，提交基于 ${req.body.rowVersion}，请刷新后重试`,
        { currentVersion: Number(getMeta('draft_version', '0')), currentRowVersion: cue.row_ver });
    }
    const fields = cueInputFromBody(req.body);
    const dup = db.prepare('SELECT 1 FROM draft_cues WHERE code = ? AND id != ?').get(fields.code, id);
    if (dup) throw new ApiError(400, 'BAD_INPUT', `编号「${fields.code}」已存在`);
    const resourceUsages = parseCueResourceUsages(req.body.resources, loadDraftResources());
    db.transaction(() => {
      db.prepare(
        `UPDATE draft_cues SET code=@code, title=@title, position=@position,
           planned_start=@plannedStart, duration=@duration, needs_release=@needsRelease,
           row_ver=row_ver+1 WHERE id=@id`
      ).run({ ...fields, id });
      db.prepare('DELETE FROM draft_cue_resources WHERE cue_id = ?').run(id);
      const insUsage = db.prepare(
        'INSERT INTO draft_cue_resources(cue_id, resource_id, usage) VALUES (?, ?, ?)'
      );
      for (const u of resourceUsages) insUsage.run(id, u.resourceId, u.usage);
    })();
    bumpDraftVersion();
    res.json(draftPayload());
  } catch (e) { next(e); }
});

app.delete('/api/draft/cues/:id', requireSM, (req, res, next) => {
  try {
    checkDraftVersion(Number(req.query.version));
    const id = Number(req.params.id);
    const cue = db.prepare('SELECT * FROM draft_cues WHERE id = ?').get(id);
    if (!cue) throw new ApiError(404, 'NOT_FOUND', '提示项不存在');
    db.prepare('DELETE FROM draft_cues WHERE id = ?').run(id); // 依赖通过外键级联删除
    bumpDraftVersion();
    res.json(draftPayload());
  } catch (e) { next(e); }
});

app.post('/api/draft/deps', requireSM, (req, res, next) => {
  try {
    checkDraftVersion(req.body.version);
    const from = Number(req.body.from);
    const to = Number(req.body.to);
    if (!Number.isInteger(from) || !Number.isInteger(to)) throw new ApiError(400, 'BAD_INPUT', '前置/后项编号无效');
    if (from === to) throw new ApiError(400, 'BAD_INPUT', '提示项不能以前置自身');
    const cues = db.prepare('SELECT id FROM draft_cues WHERE id IN (?, ?)').all(from, to);
    if (cues.length !== 2) throw new ApiError(404, 'NOT_FOUND', '前置或后项提示项不存在');
    const exists = db.prepare('SELECT 1 FROM draft_deps WHERE from_cue=? AND to_cue=?').get(from, to);
    if (exists) throw new ApiError(400, 'BAD_INPUT', '该前置关系已存在');
    db.prepare('INSERT INTO draft_deps(from_cue, to_cue) VALUES (?, ?)').run(from, to);
    bumpDraftVersion();
    res.status(201).json(draftPayload());
  } catch (e) { next(e); }
});

app.delete('/api/draft/deps/:id', requireSM, (req, res, next) => {
  try {
    checkDraftVersion(Number(req.query.version));
    const id = Number(req.params.id);
    const info = db.prepare('DELETE FROM draft_deps WHERE id = ?').run(id);
    if (info.changes === 0) throw new ApiError(404, 'NOT_FOUND', '前置关系不存在');
    bumpDraftVersion();
    res.json(draftPayload());
  } catch (e) { next(e); }
});

// ---------- 舞监：发布只读联排版本 ----------

// 交接：旧执行版（最新已发布版本，没有则 null）
function latestPublishedVersion() {
  return db.prepare('SELECT * FROM rehearsal_versions ORDER BY version_no DESC LIMIT 1').get() || null;
}

// 某版本已发布提示项（以 cue_ref 为键）
function publishedCueMap(versionId) {
  const map = new Map();
  db.prepare(
    `SELECT cue_ref, code, title, position, planned_start, duration
     FROM published_cues WHERE version_id = ?`
  ).all(versionId).forEach((c) => map.set(c.cue_ref, c));
  return map;
}

// 已发布前置集合：cue_ref -> Set(前置 cue_ref)
function publishedPredSets(versionId) {
  const sets = new Map();
  db.prepare('SELECT from_ref, to_ref FROM published_deps WHERE version_id = ?')
    .all(versionId).forEach((d) => {
      if (!sets.has(d.to_ref)) sets.set(d.to_ref, new Set());
      sets.get(d.to_ref).add(d.from_ref);
    });
  return sets;
}

// 草稿前置集合：cue id -> Set(前置 cue id)
function draftPredSets() {
  const sets = new Map();
  db.prepare('SELECT from_cue, to_cue FROM draft_deps')
    .all().forEach((d) => {
      if (!sets.has(d.to_cue)) sets.set(d.to_cue, new Set());
      sets.get(d.to_cue).add(d.from_cue);
    });
  return sets;
}

function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

// 对照单个旧登记项给出交接资格判定
function evaluateHandoverItem({ old, draftCue, oldPreds, draftPreds, oldCodeByRef, draftCodeById }) {
  if (!draftCue) {
    return { eligible: false, reasons: ['草稿中已不存在同一提示项引用'], diffs: [{ field: 'reference', reason: '草稿中已不存在该提示项引用' }] };
  }
  const fmtPreds = (set, codeOf) =>
    [...set].sort((a, b) => a - b).map((r) => codeOf(r) || `#${r}`).join('、') || '（无）';
  const oldPredsText = fmtPreds(oldPreds, (r) => oldCodeByRef.get(r));
  const newPredsText = fmtPreds(draftPreds, draftCodeById);
  const checks = [
    { field: 'code', label: '编号', same: old.code === draftCue.code,
      oldText: old.code, newText: draftCue.code },
    { field: 'title', label: '说明', same: old.title === draftCue.title,
      oldText: old.title || '（空）', newText: draftCue.title || '（空）' },
    { field: 'position', label: '岗位', same: old.position === draftCue.position,
      oldText: old.position, newText: draftCue.position },
    { field: 'plannedStart', label: '计划开始', same: old.planned_start === draftCue.plannedStart,
      oldText: minToTime(old.planned_start), newText: minToTime(draftCue.plannedStart) },
    { field: 'duration', label: '时长', same: old.duration === draftCue.duration,
      oldText: `${old.duration} 分`, newText: `${draftCue.duration} 分` },
    { field: 'predecessors', label: '前置集合', same: sameSet(oldPreds, draftPreds),
      oldText: oldPredsText, newText: newPredsText },
  ];
  const reasons = [];
  const diffs = [];
  for (const c of checks) {
    if (!c.same) {
      reasons.push(`${c.label}不一致（旧版 ${c.oldText} → 草稿 ${c.newText}）`);
      diffs.push({ field: c.field, label: c.label, oldText: c.oldText, newText: c.newText,
        reason: `${c.label}不一致：旧版为 ${c.oldText}，草稿为 ${c.newText}` });
    }
  }
  return { eligible: reasons.length === 0, reasons, diffs };
}

/**
 * 交接预览：对照当前草稿与旧执行版，列出旧版「已完成（实际开始与实际完成同时存在）」
 * 提示项的交接资格、不合格原因及旧登记行版本号。无旧版时 eligible/ineligible 均为空。
 */
function buildHandoverPreview() {
  const draftVersion = Number(getMeta('draft_version', '0'));
  const oldVer = latestPublishedVersion();
  if (!oldVer) return { draftVersion, oldVersion: null, eligible: [], ineligible: [] };

  const draftCues = loadDraftCues();
  const draftById = new Map(draftCues.map((c) => [c.id, c]));
  const draftPredsAll = draftPredSets();
  const oldCues = publishedCueMap(oldVer.id);
  const oldPredSetsAll = publishedPredSets(oldVer.id);
  const oldCodeByRef = new Map([...oldCues].map(([ref, c]) => [ref, c.code]));
  const draftCodeById = (id) => draftById.get(id)?.code;

  const eligible = [];
  const ineligible = [];
  const regRows = db.prepare(
    'SELECT cue_ref, actual_start, actual_end, row_ver FROM registrations WHERE version_id = ?'
  ).all(oldVer.id);
  for (const reg of regRows) {
    const old = oldCues.get(reg.cue_ref);
    if (!old) continue;
    // 只有旧登记同时有实际开始和实际完成（已完成）才进入交接判定
    if (reg.actual_start === null || reg.actual_end === null) continue;

    const item = {
      cueRef: reg.cue_ref,
      code: old.code,
      title: old.title,
      position: old.position,
      actualStartText: minToTime(reg.actual_start),
      actualEndText: minToTime(reg.actual_end),
      rowVersion: reg.row_ver,
    };
    const draftCue = draftById.get(reg.cue_ref);
    const ev = evaluateHandoverItem({
      old,
      draftCue,
      oldPreds: oldPredSetsAll.get(reg.cue_ref) || new Set(),
      draftPreds: draftPredsAll.get(reg.cue_ref) || new Set(),
      oldCodeByRef,
      draftCodeById,
    });
    if (ev.eligible) {
      eligible.push({ ...item, selected: true });
    } else {
      ineligible.push({ ...item, reasons: ev.reasons, diffs: ev.diffs });
    }
  }

  eligible.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'));
  ineligible.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'));
  return {
    draftVersion,
    oldVersion: { id: oldVer.id, versionNo: oldVer.version_no, note: oldVer.note, createdAt: oldVer.created_at },
    eligible,
    ineligible,
  };
}

// 交接预览（舞监发布前）：无旧版时 eligible/ineligible 为空数组
app.get('/api/publish/handover/preview', requireSM, (req, res, next) => {
  try { res.json(buildHandoverPreview()); } catch (e) { next(e); }
});

// 解析发布请求中的交接选择（未传 handover 时返回 null，维持原发布行为）
function parseHandoverBody(body) {
  if (!Object.prototype.hasOwnProperty.call(body, 'handover')) return null;
  const h = body.handover;
  if (h === null || typeof h !== 'object' || Array.isArray(h)) {
    throw new ApiError(400, 'BAD_INPUT', '交接选择格式无效：handover 应为对象 {oldVersionId, draftVersion, items}');
  }
  if (!Number.isInteger(h.oldVersionId)) {
    throw new ApiError(400, 'BAD_INPUT', '交接选择缺少旧执行版 oldVersionId');
  }
  if (h.draftVersion === undefined || h.draftVersion === null || !Number.isInteger(Number(h.draftVersion))) {
    throw new ApiError(400, 'BAD_INPUT', '交接选择缺少预览时的草稿版本号 draftVersion');
  }
  const rawItems = h.items;
  if (!Array.isArray(rawItems)) {
    throw new ApiError(400, 'BAD_INPUT', '交接选择 items 应为数组 [{cueRef, rowVersion}]');
  }
  const items = [];
  const seen = new Set();
  for (const it of rawItems) {
    const cueRef = Number(it?.cueRef);
    const rowVersion = Number(it?.rowVersion);
    if (!Number.isInteger(cueRef) || !Number.isInteger(rowVersion)) {
      throw new ApiError(400, 'BAD_INPUT', '交接选择每项须包含整数 cueRef 与 rowVersion，请重新预览后选择');
    }
    if (seen.has(cueRef)) throw new ApiError(400, 'BAD_INPUT', `交接选择中提示项引用 ${cueRef} 重复`);
    seen.add(cueRef);
    items.push({ cueRef, rowVersion });
  }
  return { oldVersionId: h.oldVersionId, draftVersion: Number(h.draftVersion), items };
}

app.post('/api/publish', requireSM, (req, res, next) => {
  try {
    const submitted = req.body.version;
    // 未传 handover 字段时为 null，完全沿用原有发布行为
    const handover = parseHandoverBody(req.body);

    const result = db.transaction(() => {
      const current = Number(getMeta('draft_version', '0'));
      if (submitted === undefined || Number(submitted) !== current) {
        throw new ApiError(409, 'VERSION_CONFLICT',
          `草稿已被他人修改：当前版本号为 ${current}，提交基于 ${submitted ?? '空'}，请刷新后重试`,
          { currentVersion: current, submittedVersion: submitted ?? null });
      }

      const cues = loadDraftCues();
      const deps = loadDraftDeps();
      const draftResources = loadDraftResources();
      const draftResourceUsages = draftUsageMapForValidate();
      const validation = validatePlan(cues, deps, draftResources, draftResourceUsages);

      // 交接：确认发布时重新核对草稿版本、旧执行版及所选登记行版本，任一变化或资格失效整体拒绝
      // cueRef -> { actualStart, actualEnd }，仅用于发布时写入延续登记
      const carry = new Map();
      let oldVerForCarry = null;
      if (handover) {
        // 草稿版本与旧执行版：即使未选择任何项也要核对（强制以最新预览为准）
        if (handover.draftVersion !== current) {
          throw new ApiError(409, 'HANDOVER_STALE',
            `交接预览基于草稿版本 v${handover.draftVersion}，当前草稿版本为 v${current}，草稿已变化，请重新预览后再发布`,
            { currentVersion: current, handoverDraftVersion: handover.draftVersion });
        }
        const oldVer = db.prepare('SELECT * FROM rehearsal_versions WHERE id = ?').get(handover.oldVersionId);
        if (!oldVer) {
          throw new ApiError(409, 'HANDOVER_STALE', '交接选择的旧执行版不存在，请重新预览后再发布');
        }
        const latest = db.prepare('SELECT id FROM rehearsal_versions ORDER BY version_no DESC LIMIT 1').get();
        if (!latest || latest.id !== oldVer.id) {
          throw new ApiError(409, 'HANDOVER_STALE',
            `交接预览基于第 ${oldVer.version_no} 版，但当前执行版已变化，请重新预览后再发布`,
            { currentOldVersionId: latest ? latest.id : null });
        }
        oldVerForCarry = oldVer;

        // 以下逐项核对仅针对实际选中的登记行
        if (handover.items.length > 0) {
          const cuesForHandover = loadDraftCues();
          const draftById = new Map(cuesForHandover.map((c) => [c.id, c]));
          const draftPredsAll = draftPredSets();
          const oldCues = publishedCueMap(oldVer.id);
          const oldPredSetsAll = publishedPredSets(oldVer.id);
          const oldCodeByRef = new Map([...oldCues].map(([ref, c]) => [ref, c.code]));
          const draftCodeById = (id) => draftById.get(id)?.code;

          const itemErrors = [];
          for (const sel of handover.items) {
            const old = oldCues.get(sel.cueRef);
            const reg = db.prepare(
              'SELECT * FROM registrations WHERE version_id = ? AND cue_ref = ?'
            ).get(oldVer.id, sel.cueRef);
            if (!old || !reg) {
              itemErrors.push({ cueRef: sel.cueRef, code: old?.code ?? null, reason: '该提示项在旧执行版中不存在，请重新预览后再发布' });
              continue;
            }
            if (reg.actual_start === null || reg.actual_end === null) {
              itemErrors.push({ cueRef: sel.cueRef, code: old.code, reason: `「${old.code}」旧登记已不再同时具备实际开始与实际完成，交接资格已失效` });
              continue;
            }
            if (reg.row_ver !== sel.rowVersion) {
              itemErrors.push({ cueRef: sel.cueRef, code: old.code,
                reason: `「${old.code}」旧登记行版本已变化（预览时 v${sel.rowVersion}，当前 v${reg.row_ver}，可能被岗位登记或舞监更正更新），请重新预览后再发布`,
                currentRowVersion: reg.row_ver });
              continue;
            }
            const ev = evaluateHandoverItem({
              old,
              draftCue: draftById.get(sel.cueRef),
              oldPreds: oldPredSetsAll.get(sel.cueRef) || new Set(),
              draftPreds: draftPredsAll.get(sel.cueRef) || new Set(),
              oldCodeByRef,
              draftCodeById,
            });
            if (!ev.eligible) {
              itemErrors.push({ cueRef: sel.cueRef, code: old.code, reason: `「${old.code}」交接资格已失效：${ev.reasons.join('；')}`, diffs: ev.diffs });
              continue;
            }
            carry.set(sel.cueRef, { actualStart: reg.actual_start, actualEnd: reg.actual_end });
          }
          if (itemErrors.length) {
            throw new ApiError(409, 'HANDOVER_STALE',
              `交接资格核对未通过（${itemErrors.length} 项），本次发布已整体拒绝，请重新预览后再选择发布`,
              { items: itemErrors });
          }
        }
      }

      // 发布新版前必须先恢复当前执行版进行中的停排（停排期间不允许发布新版）
      const beforeLatest = db.prepare('SELECT * FROM rehearsal_versions ORDER BY version_no DESC LIMIT 1').get();
      const beforeActive = beforeLatest ? activeInterruption(beforeLatest.id) : null;
      if (beforeActive) {
        throw new ApiError(409, 'INTERRUPTION_ACTIVE',
          `第 ${beforeLatest.version_no} 版当前处于停排中（${minToTime(beforeActive.pause_minute)} 起），请先由舞监恢复联排后再发布新版`,
          { currentVersionId: beforeLatest.id, currentVersionNo: beforeLatest.version_no });
      }

      if (!validation.ok) {
        throw new ApiError(422, 'PUBLISH_CONFLICT', '存在冲突项，无法发布联排版本', { errors: validation.errors });
      }
      const maxNo = db.prepare('SELECT COALESCE(MAX(version_no), 0) AS m FROM rehearsal_versions').get().m;
      const versionNo = maxNo + 1;
      const info = db.prepare('INSERT INTO rehearsal_versions(version_no, note) VALUES (?, ?)')
        .run(versionNo, String(req.body.note || `联排第 ${versionNo} 版`));
      const versionId = info.lastInsertRowid;

      const insCue = db.prepare(
        `INSERT INTO published_cues(version_id, cue_ref, code, title, position, planned_start, duration, needs_release)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const insDep = db.prepare(
        'INSERT INTO published_deps(version_id, from_ref, to_ref) VALUES (?, ?, ?)'
      );
      // 发布时冻结共享资源（名称、容量）与提示项占用；后续草稿修改不影响旧版
      const insResource = db.prepare(
        'INSERT INTO published_resources(version_id, resource_id, name, capacity) VALUES (?, ?, ?, ?)'
      );
      const insCueResource = db.prepare(
        'INSERT INTO published_cue_resources(version_id, cue_ref, resource_id, usage) VALUES (?, ?, ?, ?)'
      );
      // 未选择交接的提示项保持空登记；所选项仅带入实际开始、实际完成，并标明来源版本与提示项
      const insReg = db.prepare(
        `INSERT INTO registrations(version_id, cue_ref, position, actual_start, actual_end, source_version_id, source_cue_ref)
         VALUES (@version_id, @cue_ref, @position, @actual_start, @actual_end, @source_version_id, @source_cue_ref)`
      );
      for (const c of cues) insCue.run(versionId, c.id, c.code, c.title, c.position, c.plannedStart, c.duration, c.needsRelease ? 1 : 0);
      for (const d of deps) insDep.run(versionId, d.from, d.to);
      for (const r of draftResources) insResource.run(versionId, r.id, r.name, r.capacity);
      for (const c of cues) {
        for (const u of (draftResourceUsages.get(c.id) || [])) {
          insCueResource.run(versionId, c.id, u.resourceId, u.usage);
        }
      }
      for (const c of cues) {
        const h = carry.get(c.id);
        insReg.run({
          version_id: versionId,
          cue_ref: c.id,
          position: c.position,
          actual_start: h ? h.actualStart : null,
          actual_end: h ? h.actualEnd : null,
          source_version_id: h ? oldVerForCarry.id : null,
          source_cue_ref: h ? c.id : null,
        });
      }

      const v2 = current + 1; // 发布同时推进草稿版本号，过期页面必须刷新
      setMeta('draft_version', v2);
      return { versionId, carriedCount: carry.size,
        sourceVersionId: carry.size ? oldVerForCarry.id : null,
        sourceVersionNo: carry.size ? oldVerForCarry.version_no : null };
    })();

    const row = db.prepare('SELECT * FROM rehearsal_versions WHERE id = ?').get(result.versionId);
    res.status(201).json({
      ...versionPayload(row),
      handover: {
        carriedCount: result.carriedCount,
        sourceVersionId: result.sourceVersionId,
        sourceVersionNo: result.sourceVersionNo,
      },
    });
  } catch (e) { next(e); }
});

app.get('/api/versions', requireAuth, (req, res, next) => {
  try {
    const rows = db.prepare(
      `SELECT v.id, v.version_no, v.note, v.created_at,
              (SELECT COUNT(*) FROM registrations r WHERE r.version_id = v.id
                 AND (r.actual_start IS NOT NULL OR r.actual_end IS NOT NULL OR r.estimated_end IS NOT NULL)) AS reg_count,
              (SELECT COUNT(*) FROM registrations r WHERE r.version_id = v.id AND r.skipped = 1) AS skip_count,
              (SELECT COUNT(*) FROM rehearsal_interruptions i WHERE i.version_id = v.id) AS interruption_count,
              (SELECT COUNT(*) FROM rehearsal_interruptions i WHERE i.version_id = v.id AND i.resume_minute IS NULL) AS interruption_active_count,
              (SELECT COUNT(*) FROM published_cues p WHERE p.version_id = v.id) AS cue_count,
              (SELECT COUNT(*) FROM rehearsal_reviews rv WHERE rv.version_id = v.id) AS review_sealed,
              (SELECT rv.sealed_at FROM rehearsal_reviews rv WHERE rv.version_id = v.id) AS review_sealed_at,
              (SELECT COUNT(*) FROM schedule_change_notices n WHERE n.version_id = v.id AND n.row_ver = 1) AS notice_pending_all
       FROM rehearsal_versions v ORDER BY v.version_no DESC`
    ).all();
    // 执行账号只统计自己当前有权负责岗位（含该版代班）的待确认数；舞监统计全部岗位
    res.json({
      versions: rows.map((r) => {
        let noticePendingCount = r.notice_pending_all;
        if (req.session.user.role === 'operator') {
          const positions = effectivePositionsFor(req.session.user, r.id);
          if (positions.size === 0) noticePendingCount = 0;
          else {
            noticePendingCount = db.prepare(
              `SELECT COUNT(*) AS n FROM schedule_change_notices
               WHERE version_id = ? AND row_ver = 1
                 AND position IN (${[...positions].map(() => '?').join(',')})`
            ).get(r.id, ...positions).n;
          }
        }
        return {
          id: r.id, versionNo: r.version_no, note: r.note,
          createdAt: r.created_at, regCount: r.reg_count, skipCount: r.skip_count,
          interruptionCount: r.interruption_count,
          interruptionActive: r.interruption_active_count > 0,
          cueCount: r.cue_count,
          reviewSealed: r.review_sealed > 0,
          reviewSealedAt: r.review_sealed_at || null,
          noticePendingCount,
        };
      }),
    });
  } catch (e) { next(e); }
});

app.get('/api/versions/:id', requireAuth, (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM rehearsal_versions WHERE id = ?').get(Number(req.params.id));
    if (!row) throw new ApiError(404, 'NOT_FOUND', '版本不存在');
    res.json(versionPayload(row));
  } catch (e) { next(e); }
});

// ---------- 排期开始来源解释（舞监与执行岗位均可；当前执行版与历史版本通用，只读） ----------

// 以目标项原计划开始为基线，解释其重算开始时刻如何形成：达到最终最大约束时刻的直接前置全部列出，
// 并沿尚未开始前置逐层追溯来源（实际完成 / 预计结束 / 按时长推算）；已跳过前置不构成约束。
// 只读查询：不改动登记与已发布计划；目标不存在 / 版本不存在 / 目标已开始、已完成、已跳过时给出明确结果。
app.get('/api/versions/:id/cues/:cueRef/explain', requireAuth, (req, res, next) => {
  try {
    const versionId = Number(req.params.id);
    const cueRef = Number(req.params.cueRef);
    if (!Number.isInteger(versionId)) throw new ApiError(404, 'NOT_FOUND', '版本不存在');
    if (!Number.isInteger(cueRef)) throw new ApiError(400, 'BAD_INPUT', '缺少有效的提示项引用 cueRef');
    const ver = db.prepare('SELECT * FROM rehearsal_versions WHERE id = ?').get(versionId);
    if (!ver) throw new ApiError(404, 'NOT_FOUND', '版本不存在');
    const pc = db.prepare('SELECT 1 FROM published_cues WHERE version_id = ? AND cue_ref = ?').get(ver.id, cueRef);
    if (!pc) throw new ApiError(404, 'NOT_FOUND', '提示项不存在于该版本');

    const { cues, deps, regMap, interruptions } = versionInputs(ver.id);
    const skipReasons = new Map();
    db.prepare('SELECT cue_ref, reason FROM registration_skips WHERE version_id = ?')
      .all(ver.id).forEach((s) => skipReasons.set(s.cue_ref, s.reason));

    const explain = explainSchedule(cues, deps, regMap, cueRef, skipReasons, interruptions);
    if (explain.notFound) throw new ApiError(404, 'NOT_FOUND', '提示项不存在于该版本');
    const latestNo = db.prepare('SELECT MAX(version_no) AS m FROM rehearsal_versions').get().m;
    res.json({
      versionId: ver.id,
      versionNo: ver.version_no,
      isLatest: ver.version_no === latestNo,
      ...explain,
    });
  } catch (e) { next(e); }
});

app.get('/api/live', requireAuth, (req, res, next) => {
  try {
    const row = db.prepare('SELECT * FROM rehearsal_versions ORDER BY version_no DESC LIMIT 1').get();
    if (!row) return res.json({ version: null, message: '尚未发布任何联排版本' });
    const payload = versionPayload(row);
    // 现场页面按最新授权显示可操作项：执行账号的有效岗位（含代班获得、排除被顶替）
    if (req.session.user.role === 'operator') {
      payload.myPositions = [...effectivePositionsFor(req.session.user, row.id)];
    }
    res.json({ version: payload });
  } catch (e) { next(e); }
});

// ---------- 舞监：岗位代班（仅当前执行版可变更） ----------

// 代班管理视图：当前执行版的代班记录（含已撤销历史）；舞监另返回可选岗位与执行账号
function deputyManagePayload(ver, user) {
  const payload = {
    versionId: ver ? ver.id : null,
    versionNo: ver ? ver.version_no : null,
    deputies: ver ? deputyRowsFor(ver.id).map(deputyRecordJson) : [],
  };
  if (user.role === 'sm' && ver) {
    payload.positions = db.prepare(
      'SELECT DISTINCT position FROM published_cues WHERE version_id = ? ORDER BY position'
    ).all(ver.id).map((r) => r.position);
    payload.operators = db.prepare(
      "SELECT username, display_name, position FROM users WHERE role = 'operator' ORDER BY username"
    ).all().map((u) => ({ username: u.username, displayName: u.display_name, position: u.position }));
  }
  return payload;
}

app.get('/api/live/deputies', requireAuth, (req, res, next) => {
  try {
    const ver = db.prepare('SELECT * FROM rehearsal_versions ORDER BY version_no DESC LIMIT 1').get();
    res.json(deputyManagePayload(ver, req.session.user));
  } catch (e) { next(e); }
});

// 当前执行版（不存在则 409）；请求可携带 versionId 防止旧页面误操作新版本
function currentLiveVersionForDeputy(body) {
  const ver = db.prepare('SELECT * FROM rehearsal_versions ORDER BY version_no DESC LIMIT 1').get();
  if (!ver) throw new ApiError(409, 'NO_LIVE_VERSION', '尚未发布任何联排版本，无法设置代班');
  const vid = body?.versionId;
  if (vid !== undefined && vid !== null && Number(vid) !== ver.id) {
    throw new ApiError(409, 'VERSION_STALE',
      `页面基于的联排版本已不是当前执行版（当前为第 ${ver.version_no} 版），请刷新后再变更代班`,
      { currentVersionId: ver.id, currentVersionNo: ver.version_no });
  }
  return ver;
}

// 启用代班：同一事务内复核当前版、岗位归属、账号资格与在任唯一性，任一不通过不留部分记录
app.post('/api/live/deputies', requireSM, (req, res, next) => {
  try {
    const position = String(req.body.position || '').trim();
    const username = String(req.body.username || '').trim();
    if (!position) throw new ApiError(400, 'BAD_INPUT', '请选择要设置代班的岗位');
    if (!username) throw new ApiError(400, 'BAD_INPUT', '请选择代班执行账号');

    const ver = db.transaction(() => {
      const v = currentLiveVersionForDeputy(req.body);
      const posExists = db.prepare(
        'SELECT 1 FROM published_cues WHERE version_id = ? AND position = ? LIMIT 1'
      ).get(v.id, position);
      if (!posExists) {
        throw new ApiError(400, 'POSITION_NOT_IN_VERSION',
          `当前执行版（第 ${v.version_no} 版）没有岗位「${position}」的提示项，不能为该岗位设置代班`);
      }
      const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
      if (!u) throw new ApiError(404, 'UNKNOWN_ACCOUNT', `账号「${username}」不存在`);
      if (u.role !== 'operator') {
        throw new ApiError(400, 'NOT_OPERATOR', `账号「${username}」不是执行账号，不能作为代班`);
      }
      const existing = db.prepare(
        'SELECT * FROM position_deputies WHERE version_id = ? AND position = ? AND active = 1'
      ).get(v.id, position);
      if (existing) {
        throw new ApiError(409, 'DEPUTY_EXISTS',
          `岗位「${position}」已有在任代班 ${existing.deputy_display_name}（${existing.deputy_username}），请先撤销再启用`);
      }
      const stamp = new Date().toLocaleString('sv-SE'); // YYYY-MM-DD HH:MM:SS
      db.prepare(
        `INSERT INTO position_deputies(version_id, position, deputy_user_id, deputy_username, deputy_display_name, active, enabled_by, enabled_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
      ).run(v.id, position, u.id, u.username, u.display_name, req.session.user.displayName, stamp);
      // 代班变更：失去该岗位登记权者（原岗位账号）的执行人签认失效（同事务）
      invalidateSignoffsForPositionAuth(v.id, position, stamp);
      return v;
    })();

    res.status(201).json(deputyManagePayload(ver, req.session.user));
  } catch (e) { next(e); }
});

// 撤销代班：同一事务内复核当前版与在任状态；重复撤销明确报错，不留部分记录
app.post('/api/live/deputies/revoke', requireSM, (req, res, next) => {
  try {
    const position = String(req.body.position || '').trim();
    if (!position) throw new ApiError(400, 'BAD_INPUT', '请选择要撤销代班的岗位');

    const ver = db.transaction(() => {
      const v = currentLiveVersionForDeputy(req.body);
      const existing = db.prepare(
        'SELECT * FROM position_deputies WHERE version_id = ? AND position = ? AND active = 1'
      ).get(v.id, position);
      if (!existing) {
        throw new ApiError(409, 'NO_ACTIVE_DEPUTY', `岗位「${position}」当前没有在任代班，无需撤销`);
      }
      const stamp = new Date().toLocaleString('sv-SE');
      db.prepare('UPDATE position_deputies SET active = 0, revoked_by = ?, revoked_at = ? WHERE id = ?')
        .run(req.session.user.displayName, stamp, existing.id);
      // 代班变更：失去该岗位登记权者（被撤销的代班账号）的执行人签认失效（同事务）
      invalidateSignoffsForPositionAuth(v.id, position, stamp);
      return v;
    })();

    res.json(deputyManagePayload(ver, req.session.user));
  } catch (e) { next(e); }
});

// ---------- 双人放行签认（仅当前执行版） ----------

// 签认：执行人（kind=operator，须当下拥有该岗位登记权）签认「就绪」；舞监（kind=sm）签认「可执行」。
// 同一事务内原子复核当前执行版、需放行标记、登记状态、行版本、权限与同类唯一有效签认；
// 记录签认人、时间、目标与直接前置项的登记行版本快照。签认不推进登记行版本。
app.post('/api/live/signoffs', requireAuth, (req, res, next) => {
  try {
    const versionId = Number(req.body.versionId);
    const cueRef = Number(req.body.cueRef);
    const rowVersion = Number(req.body.rowVersion);
    const kind = String(req.body.kind || '');
    if (kind !== 'operator' && kind !== 'sm') {
      throw new ApiError(400, 'BAD_INPUT', '签认类型无效（kind 应为 operator 或 sm）');
    }
    const user = req.session.user;
    if (kind === 'sm' && user.role !== 'sm') throw new ApiError(403, 'FORBIDDEN', '仅舞监可签认「可执行」');
    if (kind === 'operator' && user.role !== 'operator') throw new ApiError(403, 'FORBIDDEN', '仅执行岗位可签认「就绪」');

    const ver = db.transaction(() => {
      const verRow = db.prepare('SELECT * FROM rehearsal_versions WHERE id = ?').get(versionId);
      if (!verRow) throw new ApiError(404, 'NOT_FOUND', '联排版本不存在');
      const latest = db.prepare('SELECT id FROM rehearsal_versions ORDER BY version_no DESC LIMIT 1').get();
      if (!latest || latest.id !== verRow.id) {
        throw new ApiError(409, 'VERSION_ARCHIVED',
          `第 ${verRow.version_no} 版已不是当前执行版本（已有新版本发布），请刷新使用最新版本签认`);
      }
      const pc = db.prepare('SELECT * FROM published_cues WHERE version_id=? AND cue_ref=?').get(versionId, cueRef);
      if (!pc) throw new ApiError(404, 'NOT_FOUND', '提示项不存在于该版本');
      if (pc.needs_release !== 1) {
        throw new ApiError(400, 'RELEASE_NOT_REQUIRED', `「${pc.code}」未标记「需放行」，按原流程登记即可，无需签认`);
      }
      const reg = db.prepare('SELECT * FROM registrations WHERE version_id=? AND cue_ref=?').get(versionId, cueRef);
      if (!reg) throw new ApiError(404, 'NOT_FOUND', '登记记录不存在');
      if (reg.skipped === 1) {
        throw new ApiError(409, 'CUE_SKIPPED', `「${pc.code}」已被舞监标记为跳过（不再执行），不能签认`);
      }
      if (reg.actual_start !== null || reg.actual_end !== null) {
        throw new ApiError(409, 'SIGNOFF_STATE',
          `「${pc.code}」已${reg.actual_end !== null ? '完成' : '开始'}，不能再签认（签认仅在登记实际开始之前有效）`);
      }
      // 停排期间不接受新签认（停排前有效双签已在停排时整体失效，须恢复后重签）
      const activePauseForSignoff = activeInterruption(versionId);
      if (activePauseForSignoff) {
        throw new ApiError(409, 'INTERRUPTION_ACTIVE',
          `第 ${verRow.version_no} 版当前处于停排中（${minToTime(activePauseForSignoff.pause_minute)} 起），停排期间不能签认；恢复联排后请双方重新签认`,
          { pauseText: minToTime(activePauseForSignoff.pause_minute) });
      }
      if (rowVersion !== reg.row_ver) {
        throw new ApiError(409, 'VERSION_CONFLICT',
          `「${pc.code}」登记已被更新：当前行版本 ${reg.row_ver}，提交基于 ${rowVersion}，请刷新后重试`,
          { currentRowVersion: reg.row_ver });
      }
      // 执行人签认：只能为自己当下有登记权的岗位签认（含代班获得的岗位；被代班顶替者已失去登记权）
      if (kind === 'operator' && !effectivePositionsFor(user, versionId).has(pc.position)) {
        const dep = db.prepare(
          'SELECT * FROM position_deputies WHERE version_id = ? AND position = ? AND active = 1'
        ).get(versionId, pc.position);
        if (dep && pc.position === user.position) {
          throw new ApiError(403, 'DEPUTY_ACTIVE',
            `岗位「${pc.position}」当前由 ${dep.deputy_display_name}（${dep.deputy_username}）代班，你的该岗位登记权已暂时移交，不能签认`);
        }
        throw new ApiError(403, 'FORBIDDEN', `「${pc.code}」属于岗位「${pc.position}」，当前账号只能为本岗位提示项签认`);
      }
      const dup = db.prepare(
        'SELECT 1 FROM release_signoffs WHERE version_id=? AND cue_ref=? AND kind=? AND active=1'
      ).get(versionId, cueRef, kind);
      if (dup) {
        throw new ApiError(409, 'SIGNOFF_EXISTS',
          `「${pc.code}」已有有效的${kind === 'operator' ? '执行人「就绪」' : '舞监「可执行」'}签认，无需重复签认`);
      }

      const stamp = new Date().toLocaleString('sv-SE'); // YYYY-MM-DD HH:MM:SS
      const info = db.prepare(
        `INSERT INTO release_signoffs(version_id, cue_ref, kind, signer_user_id, signer_username, signer_display_name, signed_at, target_row_ver, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`
      ).run(versionId, cueRef, kind, user.id, user.username, user.displayName, stamp, reg.row_ver);
      const signoffId = info.lastInsertRowid;
      // 快照直接前置项的登记行版本：任一前置登记行变化即使本签认失效
      const predRefs = db.prepare(
        'SELECT from_ref FROM published_deps WHERE version_id=? AND to_ref=? ORDER BY from_ref'
      ).all(versionId, cueRef);
      const insPred = db.prepare('INSERT INTO release_signoff_preds(signoff_id, cue_ref, row_ver) VALUES (?, ?, ?)');
      const regStmt = db.prepare('SELECT row_ver FROM registrations WHERE version_id=? AND cue_ref=?');
      for (const p of predRefs) {
        const pr = regStmt.get(versionId, p.from_ref);
        insPred.run(signoffId, p.from_ref, pr ? pr.row_ver : 0);
      }
      return verRow;
    })();

    const payload = versionPayload(ver);
    if (user.role === 'operator') payload.myPositions = [...effectivePositionsFor(user, ver.id)];
    res.status(201).json({ version: payload });
  } catch (e) { next(e); }
});

// ---------- 岗位：现场登记 ----------

app.post('/api/registrations', requireAuth, (req, res, next) => {
  try {
    if (req.session.user.role !== 'operator') throw new ApiError(403, 'FORBIDDEN', '仅执行岗位可登记');
    const versionId = Number(req.body.versionId);
    const cueRef = Number(req.body.cueRef);
    const rowVersion = Number(req.body.rowVersion);
    const action = String(req.body.action || '');

    // 同一事务内复核：当前执行版、代班授权、登记行版本；任一不通过整体拒绝，不改动登记
    const ver = db.transaction(() => {
      const verRow = db.prepare('SELECT * FROM rehearsal_versions WHERE id = ?').get(versionId);
      if (!verRow) throw new ApiError(404, 'NOT_FOUND', '联排版本不存在');
      const latest = db.prepare('SELECT id FROM rehearsal_versions ORDER BY version_no DESC LIMIT 1').get();
      if (!latest || latest.id !== verRow.id) {
        throw new ApiError(409, 'VERSION_ARCHIVED',
          `第 ${verRow.version_no} 版已不是当前执行版本（已有新版本发布），请刷新使用最新版本登记`);
      }

      const pc = db.prepare('SELECT * FROM published_cues WHERE version_id=? AND cue_ref=?').get(versionId, cueRef);
      if (!pc) throw new ApiError(404, 'NOT_FOUND', '提示项不存在于该版本');

      // 代班授权：原岗位被代班时原岗位账号失去该岗位登记权；
      // 代班账号获得该岗位登记权且保留自己原有岗位权限（effectivePositionsFor）
      if (!effectivePositionsFor(req.session.user, versionId).has(pc.position)) {
        const dep = db.prepare(
          'SELECT * FROM position_deputies WHERE version_id = ? AND position = ? AND active = 1'
        ).get(versionId, pc.position);
        if (dep && pc.position === req.session.user.position) {
          throw new ApiError(403, 'DEPUTY_ACTIVE',
            `岗位「${pc.position}」当前由 ${dep.deputy_display_name}（${dep.deputy_username}）代班，你的该岗位登记权已暂时移交，请刷新页面`);
        }
        throw new ApiError(403, 'FORBIDDEN', `「${pc.code}」属于岗位「${pc.position}」，当前账号只能登记本岗位提示项`);
      }

      const reg = db.prepare('SELECT * FROM registrations WHERE version_id=? AND cue_ref=?').get(versionId, cueRef);
      if (!reg) throw new ApiError(404, 'NOT_FOUND', '登记记录不存在');
      // 已被舞监标记跳过的依赖链项：执行账号不得再登记（预计结束已在跳过时清除，计划保留）
      if (reg.skipped === 1) {
        throw new ApiError(409, 'CUE_SKIPPED',
          `「${pc.code}」已被舞监标记为跳过（不再执行），执行岗位不能登记；请刷新页面`);
      }
      // 联排停排期间：执行账号的开始 / 预计结束 / 完成登记一律拒绝（须先由舞监恢复）
      const activePause = activeInterruption(versionId);
      if (activePause) {
        throw new ApiError(409, 'INTERRUPTION_ACTIVE',
          `第 ${verRow.version_no} 版当前处于停排中（${minToTime(activePause.pause_minute)} 起，原因：${activePause.reason}），停排期间不能登记开始 / 预计结束 / 完成，请等待舞监恢复联排后再登记`,
          { pauseText: minToTime(activePause.pause_minute) });
      }
      if (rowVersion !== reg.row_ver) {
        throw new ApiError(409, 'VERSION_CONFLICT',
          `「${pc.code}」登记已被更新：当前行版本 ${reg.row_ver}，提交基于 ${rowVersion}，请刷新后重试`,
          { currentRowVersion: reg.row_ver });
      }

      // 顺延变更留痕：以登记写入前的现场重算为「变更前」快照（只含未开始、未跳过项）
      const beforeStartMap = pendingStartMap(versionId);

      const parseOptTime = (v) => (v === undefined || v === null || v === '' ? null : timeToMin(v));
      let patch;
      const actor = req.session.user.displayName;
      const stamp = new Date().toLocaleString('sv-SE'); // YYYY-MM-DD HH:MM:SS

      if (action === 'start') {
        if (reg.actual_start !== null) throw new ApiError(400, 'BAD_STATE', `「${pc.code}」已登记实际开始`);
        // 需放行项：两类有效签认（执行人就绪 + 舞监可执行）齐备才能登记实际开始；
        // 同一事务内复核签认快照与当前登记行版本，缺签/失效整体拒绝，不写入任何登记
        if (pc.needs_release === 1) {
          const gate = releaseGateCheck(versionId, cueRef, reg.row_ver, stamp);
          if (!gate.ready) {
            throw new ApiError(409, 'SIGNOFF_MISSING',
              `「${pc.code}」为需放行项，须双人放行后才能登记实际开始：${gate.items.map((i) => i.reason).join('；')}；请完成签认或刷新查看最新签认状态`,
              { items: gate.items.map((i) => ({ ...i, cueRef, code: pc.code })) });
          }
        }
        const t = parseOptTime(req.body.time) ?? currentMinute();
        patch = { actual_start: t };
      } else if (action === 'estimate') {
        if (reg.actual_end !== null) throw new ApiError(400, 'BAD_STATE', `「${pc.code}」已完成，不能再修改预计结束`);
        const ee = parseOptTime(req.body.estimatedEndText);
        if (ee === null) throw new ApiError(400, 'BAD_INPUT', '请填写预计结束时间（HH:MM）');
        const lower = reg.actual_start !== null ? reg.actual_start : pc.planned_start;
        if (ee < lower) {
          throw new ApiError(400, 'BAD_INPUT',
            `预计结束 ${minToTime(ee)} 早于${reg.actual_start !== null ? '实际开始' : '原计划开始'} ${minToTime(lower)}`);
        }
        patch = { estimated_end: ee };
      } else if (action === 'complete') {
        if (reg.actual_start === null) throw new ApiError(400, 'BAD_STATE', `「${pc.code}」尚未登记实际开始，无法完成`);
        if (reg.actual_end !== null) throw new ApiError(400, 'BAD_STATE', `「${pc.code}」已完成`);
        const t = parseOptTime(req.body.time) ?? currentMinute();
        if (t < reg.actual_start) throw new ApiError(400, 'BAD_INPUT', `完成时刻 ${minToTime(t)} 早于实际开始 ${minToTime(reg.actual_start)}`);
        patch = { actual_end: t };
      } else {
        throw new ApiError(400, 'BAD_INPUT', '未知登记动作');
      }

      db.prepare(
        `UPDATE registrations SET ${Object.keys(patch).map((k) => `${k} = @${k}`).join(', ')},
           row_ver = row_ver + 1, updated_by = @updated_by, updated_at = @updated_at
         WHERE id = @id`
      ).run({ ...patch, updated_by: actor, updated_at: stamp, id: reg.id });
      // 登记行版本已推进：目标或任一直接前置为本项的有效签认随之失效（同事务，失败整体回滚）
      invalidateSignoffsForCueChange(versionId, cueRef, pc.code, reg.row_ver + 1, stamp);
      // 本次登记导致其他未开始项重算开始时刻变化：按项为所属岗位分别留待确认痕（同事务，失败整体回滚不留痕）
      const actionLabels = { start: '实际开始', estimate: '预计结束', complete: '实际完成' };
      recordScheduleChanges(versionId, beforeStartMap, {
        action: 'register',
        detail: `${actor} 为「${pc.code}」登记${actionLabels[action] || action}`,
        triggerCueRef: cueRef,
        triggerCueCode: pc.code,
        by: actor,
        at: stamp,
      });
      return verRow;
    })();

    const payload = versionPayload(ver);
    payload.myPositions = [...effectivePositionsFor(req.session.user, ver.id)];
    res.json({ version: payload });
  } catch (e) { next(e); }
});

// ---------- 舞监：现场登记更正（仅当前执行版本） ----------

const CORRECTION_FIELDS = {
  actual_start: { label: '实际开始', timeKey: 'actualStartText' },
  actual_end: { label: '实际完成', timeKey: 'actualEndText' },
  estimated_end: { label: '预计结束', timeKey: 'estimatedEndText' },
};

app.post('/api/registrations/corrections', requireSM, (req, res, next) => {
  try {
    const versionId = Number(req.body.versionId);
    const cueRef = Number(req.body.cueRef);
    const rowVersion = Number(req.body.rowVersion);
    const field = String(req.body.field || '');
    const clear = req.body.clear === true;
    const reason = String(req.body.reason || '').trim();

    const meta = CORRECTION_FIELDS[field];
    if (!meta) throw new ApiError(400, 'BAD_INPUT', '更正字段无效（仅支持实际开始 / 实际完成 / 预计结束）');
    if (!reason) throw new ApiError(400, 'BAD_INPUT', '请填写更正原因');
    if (reason.length > 200) throw new ApiError(400, 'BAD_INPUT', '更正原因不能超过 200 字');

    const ver = db.prepare('SELECT * FROM rehearsal_versions WHERE id = ?').get(versionId);
    if (!ver) throw new ApiError(404, 'NOT_FOUND', '联排版本不存在');
    const latest = db.prepare('SELECT id FROM rehearsal_versions ORDER BY version_no DESC LIMIT 1').get();
    if (!latest || latest.id !== ver.id) {
      throw new ApiError(409, 'VERSION_ARCHIVED',
        `第 ${ver.version_no} 版已归档（已有新版本发布），归档版本禁止更正，请刷新使用当前执行版本`);
    }

    const pc = db.prepare('SELECT * FROM published_cues WHERE version_id=? AND cue_ref=?').get(versionId, cueRef);
    if (!pc) throw new ApiError(404, 'NOT_FOUND', '提示项不存在于该版本');

    // 更正仅改现场登记，不动 published_cues（已发布计划）。
    // 全部校验与写入在同一事务内：任一不合法均不写入部分更正与历史，行版本与岗位登记共用。
    const result = db.transaction(() => {
      const reg = db.prepare('SELECT * FROM registrations WHERE version_id=? AND cue_ref=?').get(versionId, cueRef);
      if (!reg) throw new ApiError(404, 'NOT_FOUND', '登记记录不存在');
      // 已跳过项只展示，舞监也不得更正其时间（跳过清除预计结束不可通过更正恢复）
      if (reg.skipped === 1) {
        throw new ApiError(409, 'CUE_SKIPPED',
          `「${pc.code}」已被标记为跳过，跳过项的登记时间不可更正（保留已发布计划，仅展示跳过原因）`);
      }
      if (rowVersion !== reg.row_ver) {
        throw new ApiError(409, 'VERSION_CONFLICT',
          `「${pc.code}」登记已被更新（岗位可能已提交新登记）：当前行版本 ${reg.row_ver}，提交基于 ${rowVersion}，请刷新后重试`,
          { currentRowVersion: reg.row_ver });
      }

      const parseOptTime = (v) => (v === undefined || v === null || v === '' ? null : timeToMin(v));
      const next = {
        actual_start: reg.actual_start,
        actual_end: reg.actual_end,
        estimated_end: reg.estimated_end,
      };

      const newValue = clear ? null : parseOptTime(req.body[meta.timeKey]);
      if (!clear && newValue === null) {
        throw new ApiError(400, 'BAD_INPUT', `请填写更正后的${meta.label}时间（HH:MM），或选择清除该项`);
      }
      if (reg[field] === newValue) {
        throw new ApiError(400, 'BAD_INPUT',
          `${meta.label}${newValue === null ? '本就为空' : `仍为 ${minToTime(newValue)}`}，无需更正`);
      }
      next[field] = newValue;

      // 主更正在前；清除实际开始时级联清除实际完成（同样记录历史）
      const history = [{ field, old: reg[field], new: newValue, cascaded: false }];
      if (field === 'actual_start' && clear && reg.actual_end !== null) {
        next.actual_end = null;
        history.push({ field: 'actual_end', old: reg.actual_end, new: null, cascaded: true });
      }

      // 更正后的完成必须有开始且不得早于开始
      if (next.actual_end !== null && next.actual_start === null) {
        throw new ApiError(400, 'BAD_STATE',
          field === 'actual_end' ? `「${pc.code}」没有实际开始，不能登记/保留实际完成，请先更正实际开始`
                                 : `清除实际开始会使「${pc.code}」的实际完成失去开始依据，请同时处理实际完成`);
      }
      if (next.actual_end !== null && next.actual_end < next.actual_start) {
        throw new ApiError(400, 'BAD_INPUT',
          `实际完成 ${minToTime(next.actual_end)} 早于实际开始 ${minToTime(next.actual_start)}`);
      }

      // 联排中断：更正后的实际开始 / 实际完成时刻不得落入任何停排区间（半开 [停排, 恢复)）；
      // 预计结束为计划值不受此限。停排期间舞监更正本身仍可办理（此项不阻止）。
      if (next.actual_start !== null && timeInAnyInterruption(versionId, next.actual_start)) {
        throw new ApiError(400, 'INTERRUPTION_TIME_CONFLICT',
          `更正后的实际开始 ${minToTime(next.actual_start)} 落入联排停排区间，停排期间没有实际执行，请改为停排前或恢复后的时刻`);
      }
      if (next.actual_end !== null && timeInAnyInterruption(versionId, next.actual_end)) {
        throw new ApiError(400, 'INTERRUPTION_TIME_CONFLICT',
          `更正后的实际完成 ${minToTime(next.actual_end)} 落入联排停排区间，停排期间没有实际执行，请改为停排前或恢复后的时刻`);
      }

      // 保留的预计结束不得早于实际开始（无实际开始则为原计划开始）
      if (next.estimated_end !== null) {
        const lower = next.actual_start !== null ? next.actual_start : pc.planned_start;
        if (next.estimated_end < lower) {
          throw new ApiError(400, 'BAD_INPUT',
            `保留的预计结束 ${minToTime(next.estimated_end)} 早于${next.actual_start !== null ? '实际开始' : '原计划开始'} ${minToTime(lower)}，请一并更正或清除预计结束`);
        }
      }

      const actor = req.session.user.displayName;
      const stamp = new Date().toLocaleString('sv-SE'); // YYYY-MM-DD HH:MM:SS
      // 顺延变更留痕：以更正写入前的现场重算为「变更前」快照（只含未开始、未跳过项）
      const beforeStartMap = pendingStartMap(versionId);
      const insCorr = db.prepare(
        `INSERT INTO registration_corrections(version_id, cue_ref, field, old_value, new_value, reason, cascaded, group_id, corrected_by, corrected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const primary = history[0];
      const primaryId = insCorr.run(versionId, cueRef, primary.field, primary.old, primary.new,
        reason, 0, null, actor, stamp).lastInsertRowid;
      for (const h of history.slice(1)) {
        insCorr.run(versionId, cueRef, h.field, h.old, h.new, reason,
          h.cascaded ? 1 : 0, primaryId, actor, stamp);
      }
      db.prepare(
        `UPDATE registrations SET actual_start=@actual_start, actual_end=@actual_end,
           estimated_end=@estimated_end, row_ver=row_ver+1, updated_by=@updated_by, updated_at=@updated_at
         WHERE id=@id`
      ).run({
        actual_start: next.actual_start,
        actual_end: next.actual_end,
        estimated_end: next.estimated_end,
        updated_by: actor,
        updated_at: stamp,
        id: reg.id,
      });
      // 更正同样推进登记行版本：目标或任一直接前置为本项的有效签认随之失效（同事务）
      invalidateSignoffsForCueChange(versionId, cueRef, pc.code, reg.row_ver + 1, stamp);
      // 本次更正导致未开始项重算开始时刻变化：按项为所属岗位分别留待确认痕（同事务，失败整体回滚不留痕）
      const valueText = (v) => (v === null || v === undefined ? '清除' : minToTime(v));
      recordScheduleChanges(versionId, beforeStartMap, {
        action: 'correct',
        detail: `${actor} 更正「${pc.code}」${meta.label}：${valueText(reg[field])} → ${valueText(newValue)}（原因：${reason}）`,
        triggerCueRef: cueRef,
        triggerCueCode: pc.code,
        by: actor,
        at: stamp,
      });
      return { cascaded: history.length > 1 };
    })();

    // 成功后按现有规则重算后续未开始项及岗位冲突（versionPayload 内 computeLive）
    const payload = versionPayload(ver);
    res.json({ version: payload, cascaded: result.cascaded });
  } catch (e) { next(e); }
});

// ---------- 舞监：依赖链跳过（仅当前执行版） ----------

// 沿前置关系向后求闭包：根项 + 沿 from→to 可达的全部后继
function successorClosure(versionId, rootRef) {
  const adj = new Map();
  db.prepare('SELECT from_ref, to_ref FROM published_deps WHERE version_id = ?')
    .all(versionId).forEach((d) => {
      if (!adj.has(d.from_ref)) adj.set(d.from_ref, []);
      adj.get(d.from_ref).push(d.to_ref);
    });
  const seen = new Set([rootRef]);
  const stack = [rootRef];
  while (stack.length) {
    const u = stack.pop();
    for (const v of adj.get(u) || []) {
      if (!seen.has(v)) { seen.add(v); stack.push(v); }
    }
  }
  return seen;
}

// 当前执行版（不存在则 409）；请求可携带 versionId 防止旧页面误操作新版本
function currentLiveVersionForSkip(bodyOrQuery) {
  const ver = latestPublishedVersion();
  if (!ver) throw new ApiError(409, 'NO_LIVE_VERSION', '尚未发布任何联排版本，无法执行跳过');
  const vid = bodyOrQuery?.versionId;
  if (vid !== undefined && vid !== null && Number(vid) !== ver.id) {
    throw new ApiError(409, 'VERSION_STALE',
      `页面基于的联排版本已不是当前执行版（当前为第 ${ver.version_no} 版），请刷新后再操作`,
      { currentVersionId: ver.id, currentVersionNo: ver.version_no });
  }
  return ver;
}

function regStatusOf(reg) {
  if (reg.skipped === 1) return 'SKIPPED';
  if (reg.actual_end !== null) return 'DONE';
  if (reg.actual_start !== null) return 'RUNNING';
  return 'PENDING';
}

// 依赖链跳过预览：根项及其沿前置关系可达的全部后继；逐项给出状态与行版本，
// 已有实际开始/完成的非跳过项列为阻断项；已跳过项只展示（含原因），不重复留痕。
function buildSkipPreview(ver, cueRef) {
  const pc = db.prepare('SELECT * FROM published_cues WHERE version_id=? AND cue_ref=?')
    .get(ver.id, cueRef);
  if (!pc) throw new ApiError(404, 'NOT_FOUND', '提示项不存在于当前执行版本');

  const closure = successorClosure(ver.id, cueRef);
  // 以拓扑序展示依赖链（根在前、后继在后）
  const cueRows = [...publishedCueMap(ver.id).values()].map((c) => ({
    id: c.cue_ref, code: c.code, title: c.title, position: c.position,
    plannedStart: c.planned_start, duration: c.duration,
  }));
  const depRows = db.prepare('SELECT from_ref, to_ref FROM published_deps WHERE version_id = ?')
    .all(ver.id).map((d) => ({ from: d.from_ref, to: d.to_ref }));
  const { order } = topoAnalyze(cueRows, depRows);
  const ordered = (order || [...closure]).filter((r) => closure.has(r));

  const regStmt = db.prepare('SELECT * FROM registrations WHERE version_id=? AND cue_ref=?');
  const cueMap = publishedCueMap(ver.id);
  const skipRows = db.prepare(
    'SELECT cue_ref, root_cue_ref, reason, skipped_by, skipped_at FROM registration_skips WHERE version_id = ?'
  ).all(ver.id);
  const skipInfo = new Map(skipRows.map((s) => [s.cue_ref, s]));

  const chain = [];
  const blockers = [];
  let alreadySkippedCount = 0;
  for (const ref of ordered) {
    const cue = cueMap.get(ref);
    const reg = regStmt.get(ver.id, ref);
    if (!cue || !reg) {
      throw new ApiError(500, 'INTERNAL', `提示项引用 ${ref} 的发布/登记数据缺失`);
    }
    const status = regStatusOf(reg);
    const s = skipInfo.get(ref);
    const item = {
      cueRef: ref,
      code: cue.code,
      title: cue.title,
      position: cue.position,
      plannedStartText: minToTime(cue.planned_start),
      plannedEndText: minToTime(cue.planned_start + cue.duration),
      status,
      rowVersion: reg.row_ver,
      alreadySkipped: status === 'SKIPPED',
      actualStartText: minToTime(reg.actual_start),
      actualEndText: minToTime(reg.actual_end),
      estimatedEndText: minToTime(reg.estimated_end),
      isRoot: ref === cueRef,
      skip: s ? {
        reason: s.reason,
        skippedBy: s.skipped_by,
        skippedAt: s.skipped_at,
        rootCode: (cueMap.get(s.root_cue_ref) || {}).code || null,
      } : null,
    };
    chain.push(item);
    if (status === 'SKIPPED') {
      alreadySkippedCount += 1;
    } else if (reg.actual_start !== null || reg.actual_end !== null) {
      const what = reg.actual_end !== null
        ? `已有实际开始 ${minToTime(reg.actual_start)}、实际完成 ${minToTime(reg.actual_end)}`
        : `已有实际开始 ${minToTime(reg.actual_start)}`;
      blockers.push({
        cueRef: ref,
        code: cue.code,
        status,
        currentRowVersion: reg.row_ver,
        reason: `「${cue.code}」${what}，不能跳过（链中任一项已有实际开始或完成，整次操作将被拒绝）`,
      });
    }
  }

  return {
    versionId: ver.id,
    versionNo: ver.version_no,
    root: { cueRef: cueRef, code: pc.code, title: pc.title, position: pc.position },
    chain,
    blockers,
    canSkip: blockers.length === 0,
    totalCount: chain.length,
    alreadySkippedCount,
    newlySkippedCount: chain.length - alreadySkippedCount - blockers.length,
  };
}

// 跳过影响预览（舞监，仅当前执行版）
app.get('/api/live/skips/preview', requireSM, (req, res, next) => {
  try {
    const ver = currentLiveVersionForSkip(req.query);
    const cueRef = Number(req.query.cueRef);
    if (!Number.isInteger(cueRef)) throw new ApiError(400, 'BAD_INPUT', '缺少有效的提示项引用 cueRef');
    res.json(buildSkipPreview(ver, cueRef));
  } catch (e) { next(e); }
});

// 确认跳过：同一事务内核验当前执行版、整条链范围、每个登记行版本、阻断状态；
// 任一不通过整体拒绝，不留部分标记。首次跳过清除预计结束、保留已发布计划并留痕；
// 已跳过项只展示、不重复留痕。
app.post('/api/live/skips', requireSM, (req, res, next) => {
  try {
    const cueRef = Number(req.body.cueRef);
    const reason = String(req.body.reason || '').trim();
    if (!Number.isInteger(cueRef)) throw new ApiError(400, 'BAD_INPUT', '缺少有效的提示项引用 cueRef');
    if (!reason) throw new ApiError(400, 'BAD_INPUT', '请填写跳过原因（不能为空）');
    if (reason.length > 200) throw new ApiError(400, 'BAD_INPUT', '跳过原因不能超过 200 字');
    const rawItems = req.body.items;
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      throw new ApiError(400, 'BAD_INPUT', '请基于预览所见的整条依赖链提交 items: [{cueRef, rowVersion}]');
    }
    const submitted = new Map();
    for (const it of rawItems) {
      const ref = Number(it?.cueRef);
      const rv = Number(it?.rowVersion);
      if (!Number.isInteger(ref) || !Number.isInteger(rv)) {
        throw new ApiError(400, 'BAD_INPUT', '跳过链每项须包含整数 cueRef 与 rowVersion，请重新预览后再确认');
      }
      if (submitted.has(ref)) throw new ApiError(400, 'BAD_INPUT', `跳过链中提示项引用 ${ref} 重复`);
      submitted.set(ref, rv);
    }

    const ver = db.transaction(() => {
      const v = currentLiveVersionForSkip(req.body);
      const pc = db.prepare('SELECT 1 FROM published_cues WHERE version_id=? AND cue_ref=?').get(v.id, cueRef);
      if (!pc) throw new ApiError(404, 'NOT_FOUND', '提示项不存在于当前执行版本');

      const closure = successorClosure(v.id, cueRef);

      // 提交范围必须与预览的整条依赖链（根 + 全部可达后继）一致，防止漏项或多项
      const missing = [...closure].filter((r) => !submitted.has(r));
      const extra = [...submitted.keys()].filter((r) => !closure.has(r));
      if (missing.length || extra.length) {
        const parts = [];
        if (missing.length) parts.push(`缺少链中提示项引用 ${missing.join(', ')}`);
        if (extra.length) parts.push(`存在链外提示项引用 ${extra.join(', ')}`);
        throw new ApiError(400, 'CHAIN_MISMATCH',
          `提交的依赖链与当前版本不一致（${parts.join('；')}），请重新预览后再确认`);
      }

      const cueMap = publishedCueMap(v.id);
      const regStmt = db.prepare('SELECT * FROM registrations WHERE version_id=? AND cue_ref=?');

      // 1) 预览所见登记行版本变化 → 整次拒绝（含已跳过项的行版本）
      const stale = [];
      for (const [ref, rv] of submitted) {
        const reg = regStmt.get(v.id, ref);
        if (!reg) throw new ApiError(404, 'NOT_FOUND', '登记记录不存在');
        if (rv !== reg.row_ver) {
          stale.push({
            cueRef: ref,
            code: cueMap.get(ref)?.code ?? null,
            previewRowVersion: rv,
            currentRowVersion: reg.row_ver,
            reason: `「${cueMap.get(ref)?.code || ref}」登记行版本已变化（预览时 v${rv}，当前 v${reg.row_ver}），请重新预览后再确认`,
          });
        }
      }
      if (stale.length) {
        throw new ApiError(409, 'VERSION_CONFLICT',
          `跳过链中 ${stale.length} 项登记行版本已变化，本次跳过已整体拒绝，请重新预览后再确认`,
          { items: stale });
      }

      // 2) 链中任一项（非已跳过）已有实际开始或完成 → 整次拒绝并列出阻断项
      const blockers = [];
      for (const ref of closure) {
        const reg = regStmt.get(v.id, ref);
        if (reg.skipped === 1) continue; // 已跳过项只展示、不重复留痕
        if (reg.actual_start !== null || reg.actual_end !== null) {
          const cue = cueMap.get(ref);
          const what = reg.actual_end !== null
            ? `已有实际开始 ${minToTime(reg.actual_start)}、实际完成 ${minToTime(reg.actual_end)}`
            : `已有实际开始 ${minToTime(reg.actual_start)}`;
          blockers.push({
            cueRef: ref,
            code: cue.code,
            currentRowVersion: reg.row_ver,
            reason: `「${cue.code}」${what}，不能跳过`,
          });
        }
      }
      if (blockers.length) {
        throw new ApiError(409, 'SKIP_BLOCKED',
          `依赖链中 ${blockers.length} 项已有实际开始或完成，本次跳过已整体拒绝，未标记任何项`,
          { items: blockers });
      }

      // 3) 全部校验通过：仅对未跳过项首跳留痕——清除预计结束，保留已发布计划
      const stamp = new Date().toLocaleString('sv-SE'); // YYYY-MM-DD HH:MM:SS
      const actor = req.session.user.displayName;
      // 顺延变更留痕：以跳过写入前的现场重算为「变更前」快照（只含未开始、未跳过项）
      const beforeStartMap = pendingStartMap(v.id);
      const upd = db.prepare(
        `UPDATE registrations SET skipped = 1, estimated_end = NULL,
           row_ver = row_ver + 1, updated_by = @by, updated_at = @at
         WHERE version_id = @vid AND cue_ref = @ref AND skipped = 0`
      );
      const ins = db.prepare(
        `INSERT INTO registration_skips(version_id, cue_ref, root_cue_ref, reason, skipped_by, skipped_at)
         VALUES (@vid, @ref, @root, @reason, @by, @at)`
      );
      let newlySkipped = 0;
      for (const ref of closure) {
        const before = regStmt.get(v.id, ref);
        const info = upd.run({ vid: v.id, ref, by: actor, at: stamp });
        if (info.changes === 1) {
          ins.run({ vid: v.id, ref, root: cueRef, reason, by: actor, at: stamp });
          // 跳过推进登记行版本：目标或任一直接前置为本项的有效签认随之失效（同事务）
          invalidateSignoffsForCueChange(v.id, ref, cueMap.get(ref)?.code || `#${ref}`, (before?.row_ver ?? 0) + 1, stamp);
          newlySkipped += 1;
        }
      }
      // 跳过链使仍未开始项的重算开始时刻变化（被跳过前置不再约束，时刻可能回缩）：按项为所属岗位分别留痕。
      // 链中本次被跳过的项操作后为 SKIPPED，不为其留痕（仅仍为未开始的项留痕）。
      const rootCode = cueMap.get(cueRef)?.code || `#${cueRef}`;
      recordScheduleChanges(v.id, beforeStartMap, {
        action: 'skip',
        detail: `${actor} 将「${rootCode}」起整条依赖链标记为跳过（原因：${reason}），新跳过 ${newlySkipped} 项`,
        triggerCueRef: cueRef,
        triggerCueCode: rootCode,
        by: actor,
        at: stamp,
      });
      return { ver: v, newlySkipped };
    })();

    const payload = versionPayload(ver.ver);
    res.json({
      version: payload,
      skip: {
        rootCueRef: cueRef,
        rootCode: publishedCueMap(ver.ver.id).get(cueRef)?.code ?? null,
        reason,
        skippedBy: req.session.user.displayName,
        newlySkippedCount: ver.newlySkipped,
        alreadySkippedCount: closureSizeFor(ver.ver.id, cueRef) - ver.newlySkipped,
        allAlreadySkipped: ver.newlySkipped === 0,
      },
    });
  } catch (e) { next(e); }
});

// 链大小（仅响应汇总用）
function closureSizeFor(versionId, rootRef) {
  return successorClosure(versionId, rootRef).size;
}

// ---------- 舞监：现场顺延预演（仅当前执行版，只读） ----------

// 请求体：{ versionId, rows: [{cueRef, rowVersion}]（全部提示项登记行）,
//           assumptions: [{cueRef, estimatedEndText}]（一项或多项未完成、未跳过提示项的假设预计结束） }
app.post('/api/live/whatif', requireSM, (req, res, next) => {
  try {
    const body = req.body || {};
    const versionId = Number(body.versionId);
    if (!Number.isInteger(versionId)) throw new ApiError(400, 'BAD_INPUT', '缺少有效的 versionId');

    // 结构解析：rows / assumptions 必须为数组，且至少一项假设
    const rawRows = body.rows;
    const rawAssumptions = body.assumptions;
    if (!Array.isArray(rawRows)) {
      throw new ApiError(400, 'BAD_INPUT', 'rows 应为全部提示项登记行数组 [{cueRef, rowVersion}]');
    }
    if (!Array.isArray(rawAssumptions)) {
      throw new ApiError(400, 'BAD_INPUT', 'assumptions 应为数组 [{cueRef, estimatedEndText}]');
    }

    const seenRow = new Set();
    const rows = [];
    for (const it of rawRows) {
      const cueRef = Number(it?.cueRef);
      const rowVersion = Number(it?.rowVersion);
      if (!Number.isInteger(cueRef) || !Number.isInteger(rowVersion)) {
        throw new ApiError(400, 'BAD_INPUT', 'rows 每项须包含整数 cueRef 与 rowVersion（请基于当前页面全部提示项登记行提交）');
      }
      if (seenRow.has(cueRef)) {
        throw new ApiError(400, 'WHATIF_INVALID', '请求中的登记行存在重复 cueRef，请刷新后重新预演');
      }
      seenRow.add(cueRef);
      rows.push({ cueRef, rowVersion });
    }

    const seenAssumed = new Set();
    const assumptionsParsed = [];
    const invalid = [];
    for (const it of rawAssumptions) {
      const cueRef = Number(it?.cueRef);
      if (!Number.isInteger(cueRef)) {
        throw new ApiError(400, 'BAD_INPUT', 'assumptions 每项须包含整数 cueRef');
      }
      if (seenAssumed.has(cueRef)) {
        invalid.push({ cueRef, code: null, reason: `提示项引用 ${cueRef} 的假设重复提交（同一提示项只能填写一项假设）` });
        continue;
      }
      seenAssumed.add(cueRef);
      const text = it?.estimatedEndText;
      const estimatedEnd = timeToMin(text);
      if (estimatedEnd === null) {
        invalid.push({ cueRef, code: null, reason: `提示项引用 ${cueRef} 的假设预计结束时间无效（应为 HH:MM）` });
        continue;
      }
      assumptionsParsed.push({ cueRef, estimatedEnd, estimatedEndText: minToTime(estimatedEnd) });
    }
    if (invalid.length) {
      throw new ApiError(400, 'WHATIF_INVALID',
        `${invalid.length} 项假设格式无效，本次预演已整体拒绝`, { items: invalid });
    }
    if (assumptionsParsed.length === 0) {
      throw new ApiError(400, 'WHATIF_INVALID',
        '请至少为一项未完成、未跳过的提示项填写假设预计结束', { items: [] });
    }

    // 单次事务读取一致快照：当前执行版、全部登记行版本同时核对，任一变化即整体提示刷新，
    // 绝不返回混合时点结果。预演只读，事务内不做任何写入。
    const result = db.transaction(() => {
      const ver = db.prepare('SELECT * FROM rehearsal_versions WHERE id = ?').get(versionId);
      if (!ver) throw new ApiError(404, 'NOT_FOUND', '联排版本不存在');
      const latest = latestPublishedVersion();
      if (!latest) throw new ApiError(409, 'NO_LIVE_VERSION', '尚未发布任何联排版本，无法预演');
      if (latest.id !== ver.id) {
        throw new ApiError(409, 'VERSION_STALE',
          `页面基于的第 ${ver.version_no} 版已不是当前执行版（当前为第 ${latest.version_no} 版），请刷新后重新预演`,
          { currentVersionId: latest.id, currentVersionNo: latest.version_no });
      }

      const { cues, deps, regMap, interruptions, resources, resourceUsages } = versionInputs(ver.id);
      const cueById = new Map(cues.map((c) => [c.id, c]));
      const readAt = new Date().toLocaleString('sv-SE');

      // rows 必须与当前版本全部提示项一一对应；任一登记行版本变化整体拒绝
      const stale = [];
      if (rows.length !== cues.length) {
        stale.push({
          cueRef: null, code: null,
          reason: `提交的登记行数量（${rows.length}）与当前执行版提示项数量（${cues.length}）不一致，请刷新后重新预演`,
        });
      }
      for (const r of rows) {
        const cue = cueById.get(r.cueRef);
        if (!cue) {
          stale.push({
            cueRef: r.cueRef, code: null,
            reason: `提示项引用 ${r.cueRef} 不在当前执行版中（执行版可能已变化），请刷新后重新预演`,
          });
          continue;
        }
        const reg = regMap.get(r.cueRef);
        if (!reg) {
          stale.push({ cueRef: r.cueRef, code: cue.code, reason: `「${cue.code}」登记行缺失，请刷新后重新预演` });
          continue;
        }
        if (reg.rowVer !== r.rowVersion) {
          stale.push({
            cueRef: r.cueRef, code: cue.code,
            previewRowVersion: r.rowVersion,
            currentRowVersion: reg.rowVer,
            reason: `「${cue.code}」登记行版本已变化（提交基于 v${r.rowVersion}，当前 v${reg.rowVer}，可能被岗位登记、舞监更正或跳过更新），请刷新后重新预演`,
          });
        }
      }
      if (stale.length) {
        throw new ApiError(409, 'WHATIF_STALE',
          `执行版或登记行已变化（${stale.length} 项），本次预演已整体拒绝，请刷新后重新预演`,
          { items: stale, currentVersionId: latest.id, currentVersionNo: latest.version_no });
      }

      // 以同一快照为基线一次性套用全部假设并重算（联排中断顺延规则一致）
      const sim = simulateWhatIf(cues, deps, regMap, assumptionsParsed, interruptions, resources, resourceUsages);
      if (sim.orderProblem) {
        throw new ApiError(409, 'WHATIF_ORDER_PROBLEM', `已发布数据检测到依赖环，无法预演：${sim.orderProblem}`);
      }
      if (sim.errors?.length) {
        throw new ApiError(400, 'WHATIF_INVALID',
          `${sim.errors.length} 项假设不成立，本次预演已整体拒绝（未更改任何登记、计划与更正历史）`,
          { items: sim.errors });
      }
      return { ver, sim, readAt, resources };
    })();

    const { ver, sim, readAt, resources } = result;
    res.json({
      versionId: ver.id,
      versionNo: ver.version_no,
      isLatest: true,
      readAt,
      readOnly: true,
      assumptions: assumptionsParsed.map((a) => ({
        cueRef: a.cueRef,
        code: (db.prepare('SELECT code FROM published_cues WHERE version_id=? AND cue_ref=?').get(ver.id, a.cueRef) || {}).code || null,
        estimatedEndText: a.estimatedEndText,
      })),
      cues: sim.cues,
      baselineConflicts: sim.baseline.conflicts,
      scenarioConflicts: sim.scenario.conflicts,
      conflictsAdded: sim.conflictsAdded,
      conflictsRemoved: sim.conflictsRemoved,
      conflictsKept: sim.conflictsKept,
      // 共享资源告警的新增 / 消失 / 持续对照（口径与现场一致）
      resources: resources.map((r) => ({ id: r.id, name: r.name, capacity: r.capacity })),
      baselineResourceAlerts: sim.baselineResourceAlerts,
      scenarioResourceAlerts: sim.scenarioResourceAlerts,
      resourceAlertsAdded: sim.resourceAlertsAdded,
      resourceAlertsRemoved: sim.resourceAlertsRemoved,
      resourceAlertsKept: sim.resourceAlertsKept,
      summary: sim.summary,
    });
  } catch (e) { next(e); }
});

// ---------- 舞监：联排中断（停排 / 恢复，仅当前执行版） ----------

// 停排：为当前执行版填写当日 HH:MM 停排时刻与非空原因。
// 同事务校验：当前执行版、无进行中的停排、时刻不得覆盖任何已登记的实际开始/实际完成；
// 停排生效时清除全部「未开始且未跳过」项的预计结束（推进这些登记行版本并留更正痕迹），
// 停排前的有效双签整体失效（保留原因），恢复后须重签。整体校验失败不留任何部分记录。
app.post('/api/live/interruptions', requireSM, (req, res, next) => {
  try {
    const versionId = Number(req.body.versionId);
    const pauseMinute = timeToMin(req.body.pauseText);
    const reason = String(req.body.reason || '').trim();
    if (!Number.isInteger(versionId)) throw new ApiError(400, 'BAD_INPUT', '缺少有效的 versionId');
    if (pauseMinute === null) throw new ApiError(400, 'BAD_INPUT', '停排时刻格式应为 HH:MM');
    if (!reason) throw new ApiError(400, 'BAD_INPUT', '请填写停排原因（不能为空）');
    if (reason.length > 200) throw new ApiError(400, 'BAD_INPUT', '停排原因不能超过 200 字');

    const result = db.transaction(() => {
      const verRow = db.prepare('SELECT * FROM rehearsal_versions WHERE id = ?').get(versionId);
      if (!verRow) throw new ApiError(404, 'NOT_FOUND', '联排版本不存在');
      const latest = latestPublishedVersion();
      if (!latest || latest.id !== verRow.id) {
        throw new ApiError(409, 'VERSION_ARCHIVED',
          `第 ${verRow.version_no} 版已不是当前执行版本（已有新版本发布），请刷新使用当前执行版本停排`);
      }
      if (activeInterruption(versionId)) {
        throw new ApiError(409, 'INTERRUPTION_EXISTS',
          `第 ${verRow.version_no} 版已有一段进行中的停排，请先恢复后再发起新的停排`);
      }

      // 停排时刻必须递增且不得覆盖已登记的实际开始 / 实际完成（半开：恢复时刻另校验）
      const prior = db.prepare(
        'SELECT MAX(resume_minute) AS m FROM rehearsal_interruptions WHERE version_id = ?'
      ).get(versionId).m;
      if (prior !== null && pauseMinute <= prior) {
        throw new ApiError(400, 'INTERRUPTION_TIME_INVALID',
          `停排时刻 ${minToTime(pauseMinute)} 不晚于最近一次恢复时刻 ${minToTime(prior)}，时刻必须严格递增`);
      }
      const covered = db.prepare(
        `SELECT cue_ref, actual_start, actual_end FROM registrations
         WHERE version_id = ? AND skipped = 0
           AND ((actual_start IS NOT NULL AND actual_start >= ?)
             OR (actual_end  IS NOT NULL AND actual_end  >= ?))`
      ).all(versionId, pauseMinute, pauseMinute);
      if (covered.length) {
        const cueCode = (ref) => db.prepare('SELECT code FROM published_cues WHERE version_id=? AND cue_ref=?')
          .get(versionId, ref)?.code || `#${ref}`;
        const items = covered.map((r) => {
          const parts = [];
          if (r.actual_start !== null && r.actual_start >= pauseMinute) parts.push(`实际开始 ${minToTime(r.actual_start)}`);
          if (r.actual_end !== null && r.actual_end >= pauseMinute) parts.push(`实际完成 ${minToTime(r.actual_end)}`);
          return { cueRef: r.cue_ref, code: cueCode(r.cue_ref),
            reason: `「${cueCode(r.cue_ref)}」${parts.join('、')}不早于停排时刻 ${minToTime(pauseMinute)}，停排不能覆盖已登记的实际时刻` };
        });
        throw new ApiError(400, 'INTERRUPTION_TIME_CONFLICT',
          `停排时刻 ${minToTime(pauseMinute)} 会覆盖 ${covered.length} 项已登记的实际开始 / 完成，请核对时刻`,
          { items });
      }

      const stamp = new Date().toLocaleString('sv-SE');
      const actor = req.session.user.displayName;

      // 顺延变更留痕：以停排生效前的现场重算为「变更前」快照（只含未开始、未跳过项）
      const beforeStartMap = pendingStartMap(versionId);

      // 清除未开始（无实际开始/完成）且未跳过项的预计结束：推进其登记行版本并留更正痕迹
      const pendingRows = db.prepare(
        `SELECT * FROM registrations
         WHERE version_id = ? AND skipped = 0 AND actual_start IS NULL AND actual_end IS NULL
           AND estimated_end IS NOT NULL`
      ).all(versionId);
      const insCorr = db.prepare(
        `INSERT INTO registration_corrections(version_id, cue_ref, field, old_value, new_value, reason, cascaded, group_id, corrected_by, corrected_at)
         VALUES (?, ?, 'estimated_end', ?, NULL, ?, 0, NULL, ?, ?)`
      );
      const clearStmt = db.prepare(
        `UPDATE registrations SET estimated_end = NULL, row_ver = row_ver + 1, updated_by = ?, updated_at = ?
         WHERE id = ?`
      );
      const clearReason = `联排于 ${minToTime(pauseMinute)} 停排（${reason}），停排时清除未开始项原预计结束`;
      let clearedCount = 0;
      for (const r of pendingRows) {
        insCorr.run(versionId, r.cue_ref, r.estimated_end, clearReason, actor, stamp);
        clearStmt.run(actor, stamp, r.id);
        clearedCount += 1;
      }

      // 停排记录（同版至多一段进行中：部分唯一索引兜底）
      const info = db.prepare(
        `INSERT INTO rehearsal_interruptions(version_id, pause_minute, reason, paused_by, paused_at)
         VALUES (?, ?, ?, ?, ?)`
      ).run(versionId, pauseMinute, reason, actor, stamp);

      // 停排前的有效双签整体失效（保留记录与原因，恢复后须重签）
      db.prepare(
        `UPDATE release_signoffs SET active = 0,
           invalidated_reason = ?, invalidated_at = ?
         WHERE version_id = ? AND active = 1`
      ).run(`联排于 ${minToTime(pauseMinute)} 停排（${reason}），停排前双签失效，须恢复后重新签认`, stamp, versionId);

      // 停排后未开始项重算开始不得早于本次停排时刻：为开始时刻被托动的项按所属岗位分别留待确认痕
      recordScheduleChanges(versionId, beforeStartMap, {
        action: 'pause',
        detail: `${actor} 于 ${minToTime(pauseMinute)} 发起停排（原因：${reason}），未开始项重算开始不早于本次停排时刻`,
        triggerCueRef: null,
        triggerCueCode: null,
        by: actor,
        at: stamp,
      });

      return { verRow, interruptionId: info.lastInsertRowid, clearedCount };
    })();

    const payload = versionPayload(result.verRow);
    res.status(201).json({
      version: payload,
      interruption: payload.activeInterruption,
      clearedEstimatedEnds: result.clearedCount,
    });
  } catch (e) {
    if (String(e.code || '').includes('SQLITE_CONSTRAINT')) {
      return next(new ApiError(409, 'INTERRUPTION_EXISTS', '该版本已有一段进行中的停排，请先恢复后再发起新的停排'));
    }
    next(e);
  }
});

// 恢复：为进行中的停排补记恢复时刻（HH:MM，严格晚于停排时刻、不早于最近一次恢复时刻）。
// 恢复本身不改写任何实际登记时间；未开始项重算开始不早于本次恢复时刻，
// 已开始未完成项推算/预计结束顺延该段中断分钟且不早于恢复时刻，依赖顺延与岗位冲突随之重算。
app.post('/api/live/interruptions/resume', requireSM, (req, res, next) => {
  try {
    const versionId = Number(req.body.versionId);
    const resumeMinute = timeToMin(req.body.resumeText);
    if (!Number.isInteger(versionId)) throw new ApiError(400, 'BAD_INPUT', '缺少有效的 versionId');
    if (resumeMinute === null) throw new ApiError(400, 'BAD_INPUT', '恢复时刻格式应为 HH:MM');

    const verRow = db.transaction(() => {
      const verRow = db.prepare('SELECT * FROM rehearsal_versions WHERE id = ?').get(versionId);
      if (!verRow) throw new ApiError(404, 'NOT_FOUND', '联排版本不存在');
      const latest = latestPublishedVersion();
      if (!latest || latest.id !== verRow.id) {
        throw new ApiError(409, 'VERSION_ARCHIVED',
          `第 ${verRow.version_no} 版已不是当前执行版本（已有新版本发布），请刷新使用当前执行版本恢复`);
      }
      const active = activeInterruption(versionId);
      if (!active) {
        throw new ApiError(409, 'NO_ACTIVE_INTERRUPTION',
          `第 ${verRow.version_no} 版当前没有进行中的停排，无需恢复（重复恢复已整体拒绝）`);
      }
      if (resumeMinute <= active.pause_minute) {
        throw new ApiError(400, 'INTERRUPTION_TIME_INVALID',
          `恢复时刻 ${minToTime(resumeMinute)} 不晚于停排时刻 ${minToTime(active.pause_minute)}，时刻必须严格递增`);
      }
      // 恢复时刻同样不得覆盖已登记的实际开始 / 完成（停排期间执行登记被拒绝，此处双保险）
      const covered = db.prepare(
        `SELECT cue_ref, actual_start, actual_end FROM registrations
         WHERE version_id = ? AND skipped = 0
           AND ((actual_start IS NOT NULL AND actual_start >= ?)
             OR (actual_end  IS NOT NULL AND actual_end  >= ?))`
      ).all(versionId, resumeMinute, resumeMinute);
      if (covered.length) {
        const cueCode = (ref) => db.prepare('SELECT code FROM published_cues WHERE version_id=? AND cue_ref=?')
          .get(versionId, ref)?.code || `#${ref}`;
        const items = covered.map((r) => {
          const parts = [];
          if (r.actual_start !== null && r.actual_start >= resumeMinute) parts.push(`实际开始 ${minToTime(r.actual_start)}`);
          if (r.actual_end !== null && r.actual_end >= resumeMinute) parts.push(`实际完成 ${minToTime(r.actual_end)}`);
          return { cueRef: r.cue_ref, code: cueCode(r.cue_ref),
            reason: `「${cueCode(r.cue_ref)}」${parts.join('、')}不早于恢复时刻 ${minToTime(resumeMinute)}，恢复不能覆盖已登记的实际时刻` };
        });
        throw new ApiError(400, 'INTERRUPTION_TIME_CONFLICT',
          `恢复时刻 ${minToTime(resumeMinute)} 会覆盖 ${covered.length} 项已登记的实际时刻，请核对时刻`,
          { items });
      }

      const stamp = new Date().toLocaleString('sv-SE');
      // 顺延变更留痕：以恢复写入前的现场重算（停排中，以停排时刻为最早开始）为「变更前」快照
      const beforeStartMap = pendingStartMap(versionId);
      db.prepare(
        'UPDATE rehearsal_interruptions SET resume_minute = ?, resumed_by = ?, resumed_at = ? WHERE id = ?'
      ).run(resumeMinute, req.session.user.displayName, stamp, active.id);
      // 恢复后未开始项重算开始改以恢复时刻为下界（可能较停排中时刻进一步后移）：按项为所属岗位分别留待确认痕
      recordScheduleChanges(versionId, beforeStartMap, {
        action: 'resume',
        detail: `${req.session.user.displayName} 于 ${minToTime(resumeMinute)} 恢复联排，未开始项重算开始不早于最近恢复时刻`,
        triggerCueRef: null,
        triggerCueCode: null,
        by: req.session.user.displayName,
        at: stamp,
      });
      return verRow;
    })();

    const payload = versionPayload(verRow);
    const rec = payload.interruptions.find((it) => it.active === false && it.resumeText === minToTime(resumeMinute));
    res.json({
      version: payload,
      interruption: rec || null,
    });
  } catch (e) { next(e); }
});

// 当前执行版停排记录查询（全部留痕，最新在前；进行中置首）
app.get('/api/live/interruptions', requireAuth, (req, res, next) => {
  try {
    const ver = latestPublishedVersion();
    if (!ver) throw new ApiError(409, 'NO_LIVE_VERSION', '尚未发布任何联排版本');
    const rows = db.prepare(
      'SELECT * FROM rehearsal_interruptions WHERE version_id = ? ORDER BY id DESC'
    ).all(ver.id);
    res.json({
      versionId: ver.id,
      versionNo: ver.version_no,
      activeInterruption: rows.find((r) => r.resume_minute === null)
        ? interruptionJson(rows.find((r) => r.resume_minute === null)) : null,
      interruptions: rows.map(interruptionJson),
    });
  } catch (e) { next(e); }
});

// ---------- 顺延变更待确认（执行账号查看 / 确认；舞监查看全部与未确认数） ----------

// 当前执行版的待确认清单：执行账号仅含其当前有权负责岗位（含代班获得、排除被顶替），舞监含全部
app.get('/api/live/change-notices', requireAuth, (req, res, next) => {
  try {
    const ver = latestPublishedVersion();
    if (!ver) throw new ApiError(409, 'NO_LIVE_VERSION', '尚未发布任何联排版本');
    res.json(noticeEnvelope(ver.id, req.session.user));
  } catch (e) { next(e); }
});

// 指定（含历史只读）版本的待确认记录回看：权限口径与当前执行版一致——执行账号只见其在该版本的有效岗位
app.get('/api/versions/:id/change-notices', requireAuth, (req, res, next) => {
  try {
    const versionId = Number(req.params.id);
    const ver = db.prepare('SELECT * FROM rehearsal_versions WHERE id = ?').get(versionId);
    if (!ver) throw new ApiError(404, 'NOT_FOUND', '版本不存在');
    res.json(noticeEnvelope(ver.id, req.session.user));
  } catch (e) { next(e); }
});

// 确认一条顺延变更：执行账号须为该记录所属岗位的当前当班人，且记录仍属当前执行版、仍待确认；
// 必须携带所见记录版本 recordVersion（初始为 1，确认后为 2）。
// 版本归档、岗位权限变化（如代班被撤销/换人）、记录已确认或重复提交均拒绝，绝不误确认其他记录。
app.post('/api/live/change-notices/:id/acknowledge', requireAuth, (req, res, next) => {
  try {
    if (req.session.user.role !== 'operator') {
      throw new ApiError(403, 'FORBIDDEN', '顺延待确认记录由执行岗位确认，舞监仅查看');
    }
    const noticeId = Number(req.params.id);
    const recordVersion = Number(req.body?.recordVersion);
    if (!Number.isInteger(noticeId)) throw new ApiError(400, 'BAD_INPUT', '缺少有效的待确认记录 id');
    if (!Number.isInteger(recordVersion)) {
      throw new ApiError(400, 'BAD_INPUT', '请携带所见记录版本 recordVersion 后再确认');
    }
    const user = req.session.user;

    const result = db.transaction(() => {
      const n = db.prepare('SELECT * FROM schedule_change_notices WHERE id = ?').get(noticeId);
      if (!n) throw new ApiError(404, 'NOT_FOUND', '待确认记录不存在（可能已随版本清理）');
      // 版本归档（发布新版）后拒绝旧提交：待确认仅针对当前执行版
      const latest = latestPublishedVersion();
      if (!latest || latest.id !== n.version_id) {
        const verRow = db.prepare('SELECT version_no FROM rehearsal_versions WHERE id = ?').get(n.version_id);
        throw new ApiError(409, 'NOTICE_VERSION_ARCHIVED',
          `该顺延变更属于第 ${verRow ? verRow.version_no : '?'} 版，该版本已归档（当前为第 ${latest ? latest.version_no : '?'} 版），旧提交不能确认；记录可在该版本只读回看`,
          { currentVersionId: latest ? latest.id : null });
      }
      // 岗位权限变化（代班启用 / 撤销）后以当前授权复核：非当班人拒绝，避免误确认
      if (!effectivePositionsFor(user, n.version_id).has(n.position)) {
        throw new ApiError(403, 'NOTICE_FORBIDDEN_POSITION',
          `该顺延变更属于岗位「${n.position}」，你当前已不拥有该岗位的负责权（代班可能已变更），不能确认此记录`);
      }
      if (n.row_ver >= 2) {
        throw new ApiError(409, 'NOTICE_ALREADY_ACKNOWLEDGED',
          `「${n.code}」重算开始 ${minToTime(n.before_start)} → ${minToTime(n.after_start)} 的变更已于 ${n.acknowledged_at} 由 ${n.acknowledged_by} 确认，无需重复确认`,
          { currentRecordVersion: n.row_ver });
      }
      if (recordVersion !== n.row_ver) {
        throw new ApiError(409, 'NOTICE_STALE',
          `提交基于的记录版本 ${recordVersion} 与当前记录版本 ${n.row_ver} 不一致，请刷新待确认清单后再确认`,
          { currentRecordVersion: n.row_ver });
      }
      const stamp = new Date().toLocaleString('sv-SE');
      db.prepare(
        `UPDATE schedule_change_notices
           SET row_ver = 2, acknowledged_by = ?, acknowledged_by_username = ?, acknowledged_at = ?
         WHERE id = ? AND row_ver = 1`
      ).run(user.displayName, user.username, stamp, noticeId);
      return db.prepare('SELECT * FROM schedule_change_notices WHERE id = ?').get(noticeId);
    })();

    res.json({
      notice: { ...noticeJson(result), versionNo: latestPublishedVersion()?.version_no ?? null },
      ...(noticeEnvelope(result.version_id, user)),
    });
  } catch (e) { next(e); }
});

// ---------- 舞监：执行版复盘（实时预览 + 封存快照） ----------

const REVIEW_STATUS_LABELS = {
  DONE: '本版完成',
  DONE_HANDOVER: '交接自旧版完成',
  RUNNING: '进行中',
  PENDING: '未开始',
  SKIPPED: '已跳过',
};

// 实时复盘明细：按冻结计划、现场登记与停排记录逐项计算（只读）。
// sourceVersionNo/sourceCode 用于交接自旧版完成项的来源标注。
function buildReviewLive(ver) {
  const { cues, deps, regMap, interruptions } = versionInputs(ver.id);
  const review = computeReview(cues, deps, regMap, interruptions);

  const sourceRefs = review.cues
    .filter((c) => c.handover)
    .map((c) => ({ svid: c.handover.sourceVersionId, sref: c.handover.sourceCueRef }));
  const sourceVerNo = new Map();
  const sourceCode = new Map();
  if (sourceRefs.length) {
    const vIds = [...new Set(sourceRefs.map((s) => s.svid))];
    db.prepare(
      `SELECT id, version_no FROM rehearsal_versions WHERE id IN (${vIds.map(() => '?').join(',')})`
    ).all(...vIds).forEach((v) => sourceVerNo.set(v.id, v.version_no));
    const q = db.prepare('SELECT code FROM published_cues WHERE version_id = ? AND cue_ref = ?');
    for (const s of sourceRefs) {
      const row = q.get(s.svid, s.sref);
      sourceCode.set(`${s.svid}:${s.sref}`, row ? row.code : null);
    }
  }

  const closedInterruptions = interruptions
    .filter((it) => it.resumeMinute !== null)
    .map((it) => ({ id: it.id, pauseText: minToTime(it.pauseMinute), resumeText: minToTime(it.resumeMinute), durationMinutes: it.resumeMinute - it.pauseMinute }));

  return {
    review: {
      cues: review.cues.map((c) => ({
        ...c,
        statusLabel: REVIEW_STATUS_LABELS[c.status] || c.status,
        handover: c.handover ? {
          sourceVersionId: c.handover.sourceVersionId,
          sourceVersionNo: sourceVerNo.get(c.handover.sourceVersionId) ?? null,
          sourceCueRef: c.handover.sourceCueRef,
          sourceCode: sourceCode.get(`${c.handover.sourceVersionId}:${c.handover.sourceCueRef}`) ?? c.code,
        } : null,
      })),
      positions: review.positions,
      totals: review.totals,
      counts: review.counts,
    },
    // 封存核对依据：全部登记行版本 + 已结束停排段（进行中的停排不是扣减依据）
    basis: {
      versionId: ver.id,
      rows: review.cues
        .map((c) => ({ cueRef: c.cueRef, rowVersion: c.rowVer }))
        .sort((a, b) => a.cueRef - b.cueRef),
      closedInterruptions: closedInterruptions
        .map((it) => ({ id: it.id, pauseText: it.pauseText, resumeText: it.resumeText }))
        .sort((a, b) => a.id - b.id),
      activePause: interruptions.some((it) => it.resumeMinute === null)
        ? (() => { const a = interruptions.find((it) => it.resumeMinute === null); return { id: a.id, pauseText: minToTime(a.pauseMinute) }; })()
        : null,
    },
  };
}

// 封存快照 JSON 反序列化（容错）
function reviewSnapshotJson(row) {
  const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
  return {
    id: row.id,
    versionId: row.version_id,
    note: row.note,
    sealedBy: row.sealed_by,
    sealedAt: row.sealed_at,
    detail: parse(row.detail_json),
    summary: parse(row.summary_json),
    basis: parse(row.basis_json),
  };
}

function reviewEnvelope(ver) {
  const latest = latestPublishedVersion();
  const isLatest = !!latest && latest.id === ver.id;
  const { review, basis } = buildReviewLive(ver);
  const snapRow = db.prepare('SELECT * FROM rehearsal_reviews WHERE version_id = ?').get(ver.id);
  return {
    versionId: ver.id,
    versionNo: ver.version_no,
    isLatest,
    live: review,
    basis,
    sealed: snapRow ? (() => { const s = reviewSnapshotJson(snapRow); return { note: s.note, sealedBy: s.sealedBy, sealedAt: s.sealedAt }; })() : null,
  };
}

// 实时复盘预览（仅舞监；当前执行版）：登记更正或停排/恢复后重取即随之更新
app.get('/api/live/review', requireSM, (req, res, next) => {
  try {
    const ver = latestPublishedVersion();
    if (!ver) throw new ApiError(409, 'NO_LIVE_VERSION', '尚未发布任何联排版本，没有可复盘的执行版');
    res.json(reviewEnvelope(ver));
  } catch (e) { next(e); }
});

// 指定版本复盘回看（仅舞监，历史版与当前执行版通用）：实时明细 + 已封存快照（若有）
app.get('/api/versions/:id/review', requireSM, (req, res, next) => {
  try {
    const ver = db.prepare('SELECT * FROM rehearsal_versions WHERE id = ?').get(Number(req.params.id));
    if (!ver) throw new ApiError(404, 'NOT_FOUND', '版本不存在');
    const envelope = reviewEnvelope(ver);
    const snapRow = db.prepare('SELECT * FROM rehearsal_reviews WHERE version_id = ?').get(ver.id);
    if (snapRow) {
      const s = reviewSnapshotJson(snapRow);
      envelope.sealed = { note: s.note, sealedBy: s.sealedBy, sealedAt: s.sealedAt };
      envelope.snapshot = { note: s.note, sealedBy: s.sealedBy, sealedAt: s.sealedAt,
        detail: s.detail, summary: s.summary, basis: s.basis };
    } else {
      envelope.snapshot = null;
    }
    res.json(envelope);
  } catch (e) { next(e); }
});

// 封存复盘：舞监携预览所见的执行版、全部登记行版本与停排状态封存；
// 任一依据变化（执行版被新版替代、任一登记行版本推进、停排段新增/恢复）整体拒绝。
// 每版仅能封存一次；明细与汇总作为当时快照保存，此后登记更正、交接或发布新版不得改写。
app.post('/api/live/review/seal', requireSM, (req, res, next) => {
  try {
    const body = req.body || {};
    const versionId = Number(body.versionId);
    if (!Number.isInteger(versionId)) throw new ApiError(400, 'BAD_INPUT', '缺少有效的 versionId');
    const note = String(body.note || '').trim();
    if (note.length > 200) throw new ApiError(400, 'BAD_INPUT', '复盘备注不能超过 200 字');

    const rawRows = body.rows;
    const rawBasis = body.basis;
    // 兼容两种提交：rows 在顶层或封装在 basis 内
    const rowsSrc = Array.isArray(rawRows) ? rawRows : rawBasis?.rows;
    if (!Array.isArray(rowsSrc)) {
      throw new ApiError(400, 'BAD_INPUT', '请携带预览所见的全部登记行版本 rows: [{cueRef, rowVersion}]');
    }
    const submittedRows = new Map();
    for (const it of rowsSrc) {
      const cueRef = Number(it?.cueRef);
      const rowVersion = Number(it?.rowVersion);
      if (!Number.isInteger(cueRef) || !Number.isInteger(rowVersion)) {
        throw new ApiError(400, 'BAD_INPUT', '封存依据每行须包含整数 cueRef 与 rowVersion，请重新打开预览后再封存');
      }
      if (submittedRows.has(cueRef)) throw new ApiError(400, 'BAD_INPUT', `封存依据中提示项引用 ${cueRef} 重复`);
      submittedRows.set(cueRef, rowVersion);
    }
    const submittedClosed = new Map();
    for (const it of (rawBasis?.closedInterruptions || [])) {
      const id = Number(it?.id);
      if (!Number.isInteger(id)) throw new ApiError(400, 'BAD_INPUT', '封存依据的停排段 id 无效');
      submittedClosed.set(id, { pauseText: String(it.pauseText || ''), resumeText: String(it.resumeText || '') });
    }
    const submittedActivePauseId = rawBasis?.activePause ? Number(rawBasis.activePause.id) : null;

    const result = db.transaction(() => {
      const ver = db.prepare('SELECT * FROM rehearsal_versions WHERE id = ?').get(versionId);
      if (!ver) throw new ApiError(404, 'NOT_FOUND', '联排版本不存在');
      const latest = latestPublishedVersion();
      if (!latest || latest.id !== ver.id) {
        throw new ApiError(409, 'REVIEW_VERSION_STALE',
          `第 ${ver.version_no} 版已不是当前执行版本（当前为第 ${latest ? latest.version_no : '?'} 版），不能再封存该版复盘；历史版可回看其已封存快照`,
          { currentVersionId: latest ? latest.id : null });
      }
      const existing = db.prepare('SELECT id FROM rehearsal_reviews WHERE version_id = ?').get(ver.id);
      if (existing) {
        throw new ApiError(409, 'REVIEW_ALREADY_SEALED',
          `第 ${ver.version_no} 版复盘已封存，每版仅能封存一次；明细与汇总已作为当时快照保存，不能再次封存或改写`);
      }

      const { review, basis } = buildReviewLive(ver);

      // 1) 登记行依据：集合必须一致，版本必须逐一相等（登记更正、岗位登记、跳过、停排清除预计结束都会推进）
      const rowIssues = [];
      if (submittedRows.size !== basis.rows.length) {
        rowIssues.push({ cueRef: null, code: null,
          reason: `预览依据的登记行数量（${submittedRows.size}）与当前版本（${basis.rows.length}）不一致，请重新打开预览后再封存` });
      }
      for (const b of basis.rows) {
        const seen = submittedRows.get(b.cueRef);
        if (seen === undefined) {
          const code = review.cues.find((c) => c.cueRef === b.cueRef)?.code || `#${b.cueRef}`;
          rowIssues.push({ cueRef: b.cueRef, code, reason: `「${code}」不在封存依据中，请重新打开预览后再封存` });
        } else if (seen !== b.rowVersion) {
          const code = review.cues.find((c) => c.cueRef === b.cueRef)?.code || `#${b.cueRef}`;
          rowIssues.push({ cueRef: b.cueRef, code, previewRowVersion: seen, currentRowVersion: b.rowVersion,
            reason: `「${code}」登记行版本已变化（预览时 v${seen}，当前 v${b.rowVersion}，可能被登记更正、岗位登记或停排更新），请重新打开预览后再封存` });
        }
      }
      for (const cueRef of submittedRows.keys()) {
        if (!basis.rows.some((b) => b.cueRef === cueRef)) {
          rowIssues.push({ cueRef, code: null, reason: `提示项引用 ${cueRef} 已不在当前执行版中，请重新打开预览后再封存` });
        }
      }
      if (rowIssues.length) {
        throw new ApiError(409, 'REVIEW_BASIS_STALE',
          `封存依据已变化（${rowIssues.length} 项登记行），本次封存已整体拒绝，请刷新预览后再封存`,
          { items: rowIssues });
      }

      // 2) 停排依据：已结束停排段集合与每段时刻必须一致；进行中停排状态必须一致
      const pauseIssues = [];
      if (submittedClosed.size !== basis.closedInterruptions.length) {
        pauseIssues.push(`已结束停排段数量变化（预览时 ${submittedClosed.size} 段，当前 ${basis.closedInterruptions.length} 段）`);
      }
      for (const cur of basis.closedInterruptions) {
        const seen = submittedClosed.get(cur.id);
        if (!seen) {
          pauseIssues.push(`预览后新增了停排段 ${cur.pauseText}–${cur.resumeText}`);
        } else if (seen.pauseText !== cur.pauseText || seen.resumeText !== cur.resumeText) {
          pauseIssues.push(`停排段 ${cur.pauseText}–${cur.resumeText} 的时刻与预览所见（${seen.pauseText}–${seen.resumeText}）不一致`);
        }
      }
      for (const [id, seen] of submittedClosed) {
        if (!basis.closedInterruptions.some((c) => c.id === id)) {
          pauseIssues.push(`预览所见停排段（${seen.pauseText}–${seen.resumeText}）已不存在`);
        }
      }
      const currentActiveId = basis.activePause ? basis.activePause.id : null;
      if ((submittedActivePauseId ?? null) !== (currentActiveId ?? null)) {
        pauseIssues.push(currentActiveId
          ? `预览后联排已进入停排（${basis.activePause.pauseText} 起），停排状态已变化`
          : '预览后联排已恢复停排，停排状态已变化');
      }
      if (pauseIssues.length) {
        throw new ApiError(409, 'REVIEW_BASIS_STALE',
          `封存依据中的停排状态已变化（${pauseIssues.length} 项），本次封存已整体拒绝，请刷新预览后再封存`,
          { items: pauseIssues.map((reason) => ({ reason })) });
      }

      const stamp = new Date().toLocaleString('sv-SE'); // YYYY-MM-DD HH:MM:SS
      const actor = req.session.user.displayName;
      // 明细与汇总作为当时快照整体保存（此后登记更正、交接或发布新版均不得改写）
      const detail = review.cues;
      const summary = {
        versionId: ver.id,
        versionNo: ver.version_no,
        counts: review.counts,
        positions: review.positions,
        totals: review.totals,
      };
      db.prepare(
        `INSERT INTO rehearsal_reviews(version_id, note, detail_json, summary_json, basis_json, sealed_by, sealed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(ver.id, note, JSON.stringify(detail), JSON.stringify(summary), JSON.stringify(basis), actor, stamp);
      return { ver, stamp, actor };
    })();

    res.status(201).json(reviewEnvelope(result.ver));
  } catch (e) {
    if (String(e.code || '').includes('SQLITE_CONSTRAINT_UNIQUE')
        || String(e.message || '').includes('UNIQUE constraint failed: rehearsal_reviews.version_id')) {
      return next(new ApiError(409, 'REVIEW_ALREADY_SEALED', '该版复盘已封存，每版仅能封存一次，快照不可改写'));
    }
    next(e);
  }
});

// ---------- 静态页面与错误处理 ----------

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: 'BAD_JSON', message: '请求体不是合法 JSON' });
  }
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: err.code, message: err.message, ...err.extra });
  }
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: 'INTERNAL', message: '服务器内部错误' });
});

const PORT = Number(process.env.PORT || 3000);
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    // eslint-disable-next-line no-console
    console.log(`联排提示板已启动: http://localhost:${PORT}`);
  });
}

module.exports = app;
