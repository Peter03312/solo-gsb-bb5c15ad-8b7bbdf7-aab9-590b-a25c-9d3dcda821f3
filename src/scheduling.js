'use strict';

// 所有时刻均以「当日 00:00 起的分钟数」表示，输入输出统一为 HH:MM。

function pad2(n) { return String(n).padStart(2, '0'); }

function timeToMin(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value).trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function minToTime(v) {
  if (v === null || v === undefined) return null;
  const m = ((v % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}

/**
 * 拓扑排序 + 环检测（DFS，确定性顺序：按 id 升序）。
 * cues: [{id}], deps: [{from, to}]（from 为前置，to 为后项）
 * 返回 { order: [id], cycle: [id, ...] | null }
 */
function topoAnalyze(cues, deps) {
  const ids = cues.map((c) => c.id).sort((a, b) => a - b);
  const adj = new Map();
  ids.forEach((id) => adj.set(id, []));
  for (const d of deps) {
    if (adj.has(d.from) && adj.has(d.to)) adj.get(d.from).push(d.to);
  }
  adj.forEach((list) => list.sort((a, b) => a - b));

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map(ids.map((id) => [id, WHITE]));
  const stack = [];
  let cycle = null;

  function dfs(u) {
    if (cycle) return;
    color.set(u, GRAY);
    stack.push(u);
    for (const v of adj.get(u)) {
      if (color.get(v) === GRAY) {
        const idx = stack.indexOf(v);
        cycle = stack.slice(idx).concat(v);
        return;
      }
      if (color.get(v) === WHITE) dfs(v);
      if (cycle) return;
    }
    stack.pop();
    color.set(u, BLACK);
  }

  for (const id of ids) {
    if (color.get(id) === WHITE) dfs(id);
    if (cycle) break;
  }

  if (cycle) return { order: null, cycle };

  const order = [];
  const done = new Set();
  function visit(u) {
    if (done.has(u)) return;
    for (const v of adj.get(u)) visit(v);
    done.add(u);
    order.push(u);
  }
  ids.forEach(visit); // post-order：反转后保证前置在前、后项在后
  order.reverse();
  return { order, cycle: null };
}

function halfOpenOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// ---------- 联排共享资源：半开时段占用扫描 ----------

/**
 * 按半开时段 [start, end) 扫描每个共享资源的占用，返回所有「占用 > 容量」的连续时段。
 * resources: [{id, name, capacity}]（空数组 / 空入参时返回空——旧版没有资源数据沿用原有行为）
 * intervalsByCue: Map(cueId -> {code, start, end, status?, usages: [{resourceId, usage}]})
 *   跳过项不应放入 Map（调用方负责）；时段按调用方给出的实际 / 预计 / 顺延后执行时段。
 * 返回 [{resourceId, resource, capacity, start, end, startText, endText, used, over,
 *        cues: [{cueRef, code, usage}], key}]
 * 相邻的超额半开时段若涉及的提示项集合完全相同则合并为一段（占用量相同，必然连续）。
 */
function scanResourceWindows(resources, intervalsByCue) {
  const windows = [];
  if (!Array.isArray(resources) || !resources.length || !intervalsByCue) return windows;

  // 资源 id -> 容量/名称 + 参与提示项列表 [{cueRef, code, start, end, usage}]
  const byResource = new Map(resources.map((r) => [r.id, {
    id: r.id, name: r.name, capacity: r.capacity, items: [],
  }]));
  for (const [cueId, iv] of intervalsByCue.entries()) {
    if (!iv || iv.start === null || iv.end === null || iv.end <= iv.start) continue;
    for (const u of (iv.usages || [])) {
      if (!u || !(u.usage > 0)) continue;
      const res = byResource.get(u.resourceId);
      if (!res) continue; // 失效资源引用忽略（写入路径会拦截；此处容错）
      res.items.push({ cueRef: cueId, code: iv.code, start: iv.start, end: iv.end, usage: u.usage, status: iv.status });
    }
  }

  for (const res of byResource.values()) {
    if (!res.items.length) continue;
    // 事件点扫描：占用量只在某提示项开始/结束时变化
    const points = [...new Set(res.items.flatMap((it) => [it.start, it.end]))].sort((a, b) => a - b);
    let open = null;
    for (let i = 0; i + 1 < points.length; i++) {
      const s = points[i];
      const e = points[i + 1];
      // 半开 [s,e)：项的开始严格小于格子结束，且项的结束不早于格子结束（[start,end) 覆盖整个格子）
      const active = res.items.filter((it) => it.start < e && it.end >= e);
      const used = active.reduce((n, it) => n + it.usage, 0);
      const activeRefs = active.map((it) => it.cueRef).sort((a, b) => a - b);
      const key = `${res.id}#${activeRefs.join(',')}`;
      if (used > res.capacity) {
        if (open && open.key === key && open.end === s) {
          open.end = e; // 同一组提示项的相邻超额时段合并
        } else {
          if (open) windows.push(open);
          open = {
            resourceId: res.id, resource: res.name, capacity: res.capacity,
            start: s, end: e, used, over: used - res.capacity, key,
            cues: active.map((it) => ({ cueRef: it.cueRef, code: it.code, usage: it.usage, status: it.status }))
              .sort((a, b) => a.cueRef - b.cueRef),
          };
        }
      } else if (open) {
        windows.push(open);
        open = null;
      }
    }
    if (open) windows.push(open);
  }

  return windows
    .map((w) => ({ ...w, startText: minToTime(w.start), endText: minToTime(w.end) }))
    .sort((a, b) => a.resourceId - b.resourceId || a.start - b.start);
}

function resourceWindowMessage(w) {
  return `共享资源「${w.resource}」容量 ${w.capacity} 在 ${w.startText}-${w.endText} 被占用 ${w.used}（超额 ${w.over}），相关提示项：${w.cues
    .map((c) => `「${c.code}」占 ${c.usage}`).join('、')}`;
}

/**
 * 现场共享资源超额告警（口径与现场重算一致）：
 * 跳过项不占用；仅由已完成项构成的超额不告警（至少一个相关提示项为未完成/已开始才告警）。
 * 告警只提示，不阻止登记。
 * liveCues: computeLive 的 cues（含 status / schedStart / schedEnd）
 * resourceUsages: Map(cueRef -> [{resourceId, usage}])
 * 返回 [{resourceId, resource, capacity, startText, endText, used, over, key, message, cues}]
 */
function liveResourceAlerts(resources, liveCues, resourceUsages) {
  if (!Array.isArray(resources) || !resources.length || !resourceUsages) return [];
  const intervals = new Map();
  for (const c of liveCues) {
    if (c.status === 'SKIPPED') continue; // 跳过项不占用
    const usages = (resourceUsages.get(c.id) || []).filter((u) => u.usage > 0);
    if (!usages.length) continue;
    // 已完成：实际执行时段；已开始：实际开始 → 顺延推算/预计结束；未开始：顺延后待执行时段
    intervals.set(c.id, { code: c.code, start: c.schedStart, end: c.schedEnd, status: c.status, usages });
  }
  return scanResourceWindows(resources, intervals)
    .filter((w) => w.cues.some((c) => c.status !== 'DONE')) // 仅有已完成项的超额不告警
    .map((w) => ({
      resourceId: w.resourceId, resource: w.resource, capacity: w.capacity,
      start: w.start, end: w.end, startText: w.startText, endText: w.endText,
      used: w.used, over: w.over, key: w.key,
      cues: w.cues.map((c) => ({ cueRef: c.cueRef, code: c.code, usage: c.usage, status: c.status })),
      message: resourceWindowMessage(w),
    }));
}

/**
 * 共享资源告警对照（顺延预演）：按「资源 + 相关提示项集合」为稳定键，
 * 区分新增（🔴）/ 消失（🟢）/ 持续（🟠，持续项给变更前后两条消息）。口径与现场一致。
 */
function diffResourceAlerts(baselineAlerts, scenarioAlerts) {
  const added = [];
  const removed = [];
  const kept = [];
  for (const sc of scenarioAlerts) {
    const bc = (baselineAlerts || []).find((b) => b.key === sc.key && b.resourceId === sc.resourceId);
    if (!bc) added.push(sc);
    else kept.push({ baseline: bc, scenario: sc });
  }
  for (const bc of baselineAlerts || []) {
    if (!(scenarioAlerts || []).some((s) => s.key === bc.key && s.resourceId === bc.resourceId)) removed.push(bc);
  }
  return {
    resourceAlertsAdded: added,
    resourceAlertsRemoved: removed,
    resourceAlertsKept: kept,
    summary: {
      baselineResourceAlertCount: (baselineAlerts || []).length,
      scenarioResourceAlertCount: (scenarioAlerts || []).length,
      resourceAddedCount: added.length,
      resourceRemovedCount: removed.length,
      resourceKeptCount: kept.length,
    },
  };
}

/**
 * 发布前计划校验。
 * cues: [{id, code, position, plannedStart, duration}]
 * deps: [{from, to}]
 * resources: [{id, name, capacity}]（联排共享资源；可为空——旧版/无资源数据时不校验）
 * resourceUsages: Map(cueId -> [{resourceId, usage}])，按提示项的计划半开时段累计
 * 返回 { ok, errors: [{ type, message, codes: [] }] }
 */
function validatePlan(cues, deps, resources, resourceUsages) {
  const errors = [];
  const byId = new Map(cues.map((c) => [c.id, c]));

  // 1) 依赖关系环
  const { cycle } = topoAnalyze(cues, deps);
  if (cycle) {
    errors.push({
      type: 'CYCLE',
      codes: cycle.map((id) => (byId.get(id) || {}).code || `#${id}`),
      message: `前置依赖存在环：${cycle.map((id) => (byId.get(id) || {}).code || `#${id}`).join(' → ')}`,
    });
  }

  // 2) 前置项计划结束不晚于后项计划开始
  const depBad = [];
  for (const d of deps) {
    const a = byId.get(d.from);
    const b = byId.get(d.to);
    if (!a || !b) continue;
    if (a.plannedStart + a.duration > b.plannedStart) {
      depBad.push({ a, b });
    }
  }
  if (depBad.length) {
    errors.push({
      type: 'DEP_ORDER',
      codes: [...new Set(depBad.flatMap((x) => [x.a.code, x.b.code]))],
      message: depBad
        .map(({ a, b }) => {
          const aEnd = minToTime(a.plannedStart + a.duration);
          return `前置「${a.code}」计划结束 ${aEnd} 晚于后项「${b.code}」开始 ${minToTime(b.plannedStart)}`;
        })
        .join('；'),
    });
  }

  // 3) 同岗位时段不重叠（半开区间：首尾相接允许）
  const byPosition = new Map();
  for (const c of cues) {
    if (!byPosition.has(c.position)) byPosition.set(c.position, []);
    byPosition.get(c.position).push(c);
  }
  const overlapBad = [];
  for (const [position, list] of byPosition) {
    const sorted = [...list].sort((a, b) => a.plannedStart - b.plannedStart || a.id - b.id);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i];
        const b = sorted[j];
        if (b.plannedStart >= a.plannedStart + a.duration) continue;
        if (halfOpenOverlap(a.plannedStart, a.plannedStart + a.duration,
                            b.plannedStart, b.plannedStart + b.duration)) {
          overlapBad.push({ position, a, b });
        }
      }
    }
  }
  if (overlapBad.length) {
    errors.push({
      type: 'POSITION_OVERLAP',
      codes: [...new Set(overlapBad.flatMap((x) => [x.a.code, x.b.code]))],
      message: overlapBad
        .map(({ position, a, b }) =>
          `岗位「${position}」时段冲突：「${a.code}」(${minToTime(a.plannedStart)}-${minToTime(a.plannedStart + a.duration)}) 与「${b.code}」(${minToTime(b.plannedStart)}-${minToTime(b.plannedStart + b.duration)})`)
        .join('；'),
    });
  }

  // 4) 共享资源：按计划半开时段累计同一资源占用，超出容量时列明资源、超额时段与相关提示项
  if (Array.isArray(resources) && resources.length && resourceUsages) {
    const planIntervals = new Map();
    for (const c of cues) {
      const us = (resourceUsages.get(c.id) || []).filter((u) => u.usage > 0);
      if (us.length) planIntervals.set(c.id, { code: c.code, start: c.plannedStart, end: c.plannedStart + c.duration, usages: us });
    }
    for (const w of scanResourceWindows(resources, planIntervals)) {
      errors.push({
        type: 'RESOURCE_OVERLOAD',
        resource: w.resource,
        capacity: w.capacity,
        startText: w.startText,
        endText: w.endText,
        used: w.used,
        over: w.over,
        codes: w.cues.map((c) => c.code),
        message: `共享资源「${w.resource}」容量 ${w.capacity} 在 ${w.startText}-${w.endText} 被占用 ${w.used}（超额 ${w.over}），相关提示项：${w.cues
          .map((c) => `「${c.code}」占 ${c.usage}`).join('、')}`,
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * 联排中断（停排）对「已开始未完成项」结束时刻的顺延量：
 * 实际开始之后发生的每段已完成停排，整段时长都顺延（停排前填写的预计结束同样顺延）；
 * 实际开始之前的停排与该提示项执行无关，不计入。调用方另需把结果托底到最近恢复时刻。
 * 进行中的停排（resumeMinute 为 null）不计入（恢复时刻尚未登记，恢复后再重算）。
 */
function runningEndShift(segments, actualStart) {
  let n = 0;
  for (const s of segments || []) {
    if (s.resumeMinute === null || s.resumeMinute === undefined) continue;
    if (s.pauseMinute >= actualStart) n += s.resumeMinute - s.pauseMinute;
  }
  return n;
}

// 各段停排中对排期形成「不得早于」下界的时刻：最近一次恢复时刻；停排进行中为本次停排开始时刻
function interruptionHoldMinute(segments) {
  let hold = null;
  let activePause = null;
  for (const s of segments || []) {
    if (s.resumeMinute === null || s.resumeMinute === undefined) {
      activePause = s.pauseMinute;
    } else {
      hold = Math.max(hold ?? s.resumeMinute, s.resumeMinute);
    }
  }
  return { holdMinute: hold, activePauseMinute: activePause };
}

/**
 * 现场联排：结合登记的实际/预计时间重算尚未开始项。
 * publishedCues: [{id(=cueRef), code, title, position, plannedStart, duration}]
 * deps: [{from, to}]（以 cueRef 表示）
 * regs: Map/object keyed by cueRef -> {actualStart, actualEnd, estimatedEnd, skipped, rowVer, updatedBy, updatedAt}
 * interruptions: [{pauseMinute, resumeMinute(null=进行中)}]，联排停排记录
 *
 * 舞监标记为跳过的项：状态 SKIPPED，不产生待执行时段，不参与前置顺延与岗位冲突，
 * 其他项仍按现有前置与登记规则重算。
 * 联排中断规则：
 * - 实际登记时间（实际开始/完成）永不改变；已完成项不做顺延；
 * - 已开始未完成项：按时长推算结束与停排前填写的预计结束顺延中断重叠分钟，且不得早于最近恢复时刻；
 * - 未开始项：重算开始不得早于最近恢复时刻（停排中为本次停排时刻）；其预计结束已在停排时清除。
 * 返回 { cues: [...], conflicts: [{position,a,b,message}], orderProblem: null|message }
 */
function computeLive(publishedCues, deps, regMap, interruptions) {
  const segments = interruptions || [];
  const { holdMinute, activePauseMinute } = interruptionHoldMinute(segments);
  const byId = new Map(publishedCues.map((c) => [c.id, c]));
  const preds = new Map();
  publishedCues.forEach((c) => preds.set(c.id, []));
  for (const d of deps) {
    if (preds.has(d.to) && byId.has(d.from)) preds.get(d.to).push(d.from);
  }

  const { order } = topoAnalyze(
    publishedCues.map((c) => ({ id: c.id })),
    deps.map((d) => ({ from: d.from, to: d.to }))
  );

  const calc = new Map();
  if (!order) {
    return { cues: [], conflicts: [], orderProblem: '已发布数据检测到依赖环，无法重算' };
  }

  // 联排中断：将「时刻 + 顺延规则」应用到已开始项与未开始项
  // 已开始未完成项：实际开始之后的每段已完成停排整段顺延推算/预计结束，且不早于最近恢复时刻
  const shiftRunningEnd = (actualStart, rawEnd) => {
    let nt = rawEnd + runningEndShift(segments, actualStart);
    if (holdMinute !== null) nt = Math.max(nt, holdMinute);
    return nt;
  };

  for (const id of order) {
    const cue = byId.get(id);
    const r = regMap.get(id) || {};
    const as = r.actualStart ?? null;
    const ae = r.actualEnd ?? null;
    const ee = r.estimatedEnd ?? null;
    const skipped = r.skipped === true || r.skipped === 1;

    let status, schedStart, schedEnd, effStart, pauseShift = 0, pauseHold = null;

    if (skipped) {
      // 已跳过：只展示，不产生待执行时段；其前置约束对后项不再生效（前置不可执行导致本项一同跳过）
      status = 'SKIPPED';
      schedStart = null;
      schedEnd = null;
    } else if (ae !== null) {
      // 已完成：实际登记时间永不改变，不顺延
      status = 'DONE';
      schedStart = as;
      schedEnd = ae;
    } else if (as !== null) {
      status = 'RUNNING';
      schedStart = as;
      // 已开始未完成：按时长推算结束 / 停排前预计结束顺延实际开始后的中断分钟，且不得早于最近恢复时刻
      const rawEnd = ee !== null ? ee : as + cue.duration;
      const end = shiftRunningEnd(as, rawEnd);
      pauseShift = end - rawEnd;
      schedEnd = end;
    } else {
      status = 'PENDING';
      let start = cue.plannedStart; // 开始时刻不得早于原计划
      for (const p of preds.get(id)) {
        const pc = calc.get(p);
        // 已跳过的前置不计入待执行时段：不约束后项开始
        if (pc && pc.status !== 'SKIPPED') start = Math.max(start, pc.schedEnd);
      }
      // 联排中断：未开始项重算开始不得早于最近恢复时刻（停排进行中为本次停排开始时刻）
      let held = false;
      if (holdMinute !== null && start < holdMinute) { start = holdMinute; held = true; }
      if (activePauseMinute !== null && start < activePauseMinute) { start = activePauseMinute; held = true; }
      pauseHold = held ? start : null;
      effStart = start;
      schedStart = start;
      // 未开始项原有预计结束已在停排时清除：无预计结束时按重算开始 + 时长推算
      schedEnd = ee !== null ? ee : start + cue.duration;
    }

    calc.set(id, {
      ...cue,
      status,
      actualStart: as,
      actualEnd: ae,
      estimatedEnd: ee,
      skipped,
      schedStart,
      schedEnd,
      pauseShift,
      pauseHold,
      interrupted: pauseShift > 0 || pauseHold !== null,
      delayed: status === 'PENDING' && schedStart > cue.plannedStart,
      rowVer: r.rowVer ?? 1,
      updatedBy: r.updatedBy ?? null,
      updatedAt: r.updatedAt ?? null,
    });
  }

  // 顺延之后的岗位冲突：跳过项不计入，且至少一方未完成
  const conflicts = [];
  const byPosition = new Map();
  for (const c of calc.values()) {
    if (c.status === 'SKIPPED') continue;
    if (!byPosition.has(c.position)) byPosition.set(c.position, []);
    byPosition.get(c.position).push(c);
  }
  for (const [position, list] of byPosition) {
    const sorted = [...list].sort((a, b) => a.schedStart - b.schedStart || a.id - b.id);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i];
        const b = sorted[j];
        if (b.schedStart >= a.schedEnd) continue;
        if (halfOpenOverlap(a.schedStart, a.schedEnd, b.schedStart, b.schedEnd)
            && (a.status !== 'DONE' || b.status !== 'DONE')) {
          conflicts.push({
            position,
            aRef: a.id,
            bRef: b.id,
            codes: [a.code, b.code],
            message: `岗位「${position}」执行时段冲突：「${a.code}」(${minToTime(a.schedStart)}-${minToTime(a.schedEnd)}) 与「${b.code}」(${minToTime(b.schedStart)}-${minToTime(b.schedEnd)})`,
          });
        }
      }
    }
  }

  // 按计划开始时间返回，便于现场阅读
  const cues = [...calc.values()].sort((a, b) => a.plannedStart - b.plannedStart || a.id - b.id);
  return { cues, conflicts, orderProblem: null };
}

const EXPLAIN_STATUS_LABEL = { PENDING: '未开始', RUNNING: '已开始', DONE: '已完成', SKIPPED: '已跳过' };

/**
 * 排期开始来源解释（只读）。与现场重算共用同一 computeLive 结果，保证与同一版本的重算一致。
 *
 * 以目标项原计划开始为基线：
 * - 列出所有「结束时刻 = 最终最大约束时刻」的直接前置；同一最大时刻由多条路径共同决定时全部展示；
 * - 沿尚未开始的前置逐层追溯其结束时刻来源：实际完成 / 预计结束 / 按时长推算；
 * - 已跳过前置不构成约束（单独列出）；原计划本身决定开始时 decidedByPlan=true（无需顺延）；
 * - 目标已开始 / 已完成 / 已跳过时 applicable=false 并给出明确原因。
 *
 * publishedCues / deps / regMap 与 computeLive 入参相同；
 * cueRef 为目标提示项引用；skipReasons 可选 Map(cueRef -> 跳过原因)，仅用于展示。
 */
function explainSchedule(publishedCues, deps, regMap, cueRef, skipReasons, interruptions) {
  const live = computeLive(publishedCues, deps, regMap, interruptions);
  if (live.orderProblem) {
    return { applicable: false, reason: `已发布数据检测到依赖环，无法重算：${live.orderProblem}` };
  }
  const byId = new Map(live.cues.map((c) => [c.id, c]));
  const target = byId.get(cueRef);
  if (!target) return { notFound: true };

  const predsOf = new Map();
  publishedCues.forEach((c) => predsOf.set(c.id, []));
  for (const d of deps) {
    if (predsOf.has(d.to) && byId.has(d.from)) predsOf.get(d.to).push(d.from);
  }

  const brief = (c) => ({
    cueRef: c.id,
    code: c.code,
    title: c.title,
    position: c.position,
    status: c.status,
    statusLabel: EXPLAIN_STATUS_LABEL[c.status] || c.status,
  });

  if (target.status !== 'PENDING') {
    const reason = target.status === 'RUNNING'
      ? `「${target.code}」已于 ${minToTime(target.actualStart)} 实际开始，排期开始即实际开始，无需顺延解释`
      : target.status === 'DONE'
        ? `「${target.code}」已完成（实际开始 ${minToTime(target.actualStart)}，实际完成 ${minToTime(target.actualEnd)}），不存在待解释的排期开始`
        : `「${target.code}」已被舞监标记为跳过，不产生排期开始时刻（已跳过前置不构成约束）`;
    return {
      applicable: false,
      cue: {
        ...brief(target),
        plannedStartText: minToTime(target.plannedStart),
        plannedEndText: minToTime(target.plannedStart + target.duration),
        actualStartText: minToTime(target.actualStart),
        actualEndText: minToTime(target.actualEnd),
      },
      reason,
    };
  }

  // 单个前置的结束时刻来源；未开始且按时长推算时继续向下追溯其重算开始的形成
  function traceNode(p, stack) {
    const node = { ...brief(p), end: p.schedEnd, endText: minToTime(p.schedEnd) };
    const shiftNote = p.pauseShift > 0 ? `（含联排中断顺延 ${p.pauseShift} 分钟）` : '';
    if (p.status === 'DONE') {
      node.endSource = 'actual';
      node.endSourceLabel = '实际完成';
      node.endDetail = `实际开始 ${minToTime(p.actualStart)}，实际完成 ${minToTime(p.actualEnd)}`;
    } else if (p.estimatedEnd !== null && p.estimatedEnd !== undefined) {
      node.endSource = 'estimated';
      node.endSourceLabel = '预计结束';
      node.endDetail = `${p.status === 'RUNNING' ? '已开始，' : ''}登记的预计结束 ${minToTime(p.estimatedEnd)}${p.pauseShift > 0 ? `，联排中断顺延后为 ${minToTime(p.schedEnd)}` : ''}`;
    } else if (p.status === 'RUNNING') {
      node.endSource = 'duration';
      node.endSourceLabel = '按时长推算';
      node.endDetail = `实际开始 ${minToTime(p.actualStart)} + 时长 ${p.duration} 分${shiftNote}`;
    } else {
      node.endSource = 'duration';
      node.endSourceLabel = '按时长推算';
      node.endDetail = `重算开始 ${minToTime(p.schedStart)} + 时长 ${p.duration} 分`;
      if (!stack.includes(p.id)) node.start = startExplain(p, stack.concat(p.id));
    }
    return node;
  }

  // 某未开始项的重算开始如何形成：原计划为基线，达到最终最大时刻的直接前置全部列出
  function startExplain(cue, stack) {
    const maxTime = cue.schedStart;
    const decidedByPlan = maxTime === cue.plannedStart;
    const constraints = [];
    const skippedPreds = [];
    const otherPreds = [];
    for (const pid of predsOf.get(cue.id) || []) {
      const p = byId.get(pid);
      if (!p) continue;
      if (p.status === 'SKIPPED') {
        // 已跳过前置不构成约束
        skippedPreds.push({
          ...brief(p),
          skipReason: skipReasons && skipReasons.get(pid) ? String(skipReasons.get(pid)) : null,
        });
      } else if (p.schedEnd === maxTime) {
        // 达到最终最大约束时刻的直接前置：多条路径共同决定时全部展示，不任意取舍
        constraints.push(traceNode(p, stack));
      } else {
        otherPreds.push({ ...brief(p), end: p.schedEnd, endText: minToTime(p.schedEnd) });
      }
    }
    return {
      plannedStart: cue.plannedStart,
      plannedStartText: minToTime(cue.plannedStart),
      schedStart: maxTime,
      schedStartText: minToTime(maxTime),
      decidedByPlan,
      delayed: maxTime > cue.plannedStart,
      constraints,
      skippedPreds,
      otherPreds,
    };
  }

  const start = startExplain(target, [target.id]);
  const delayMinutes = target.schedStart - target.plannedStart;
  // 联排中断：重算开始若被最近恢复时刻（或停排中本次停排时刻）托住，给出说明
  let interruptionHold = null;
  const segs = (interruptions || []);
  const lastResume = segs.filter((x) => x.resumeMinute !== null && x.resumeMinute !== undefined)
    .reduce((m, x) => Math.max(m, x.resumeMinute), null);
  const activeSeg = segs.find((x) => x.resumeMinute === null || x.resumeMinute === undefined);
  if (target.schedStart === lastResume && lastResume !== null) {
    interruptionHold = { type: 'resume', holdMinute: lastResume, holdText: minToTime(lastResume),
      detail: `重算开始不早于最近恢复时刻 ${minToTime(lastResume)}（联排中断恢复后排期托底）` };
  } else if (activeSeg && target.schedStart === activeSeg.pauseMinute) {
    interruptionHold = { type: 'pause', holdMinute: activeSeg.pauseMinute, holdText: minToTime(activeSeg.pauseMinute),
      detail: `联排停排中：未开始项暂以本次停排时刻 ${minToTime(activeSeg.pauseMinute)} 为最早开始，恢复后按恢复时刻重算` };
  }
  const summary = start.decidedByPlan
    ? `「${target.code}」按原计划 ${minToTime(target.plannedStart)} 开始，无需顺延`
      + (start.constraints.length ? `；另有 ${start.constraints.length} 条前置结束时刻恰与原计划相同（未造成顺延）` : '')
    : `「${target.code}」重算开始 ${minToTime(target.schedStart)}，较原计划 ${minToTime(target.plannedStart)} 顺延 ${delayMinutes} 分钟；`
      + `达到最终约束时刻 ${minToTime(target.schedStart)} 的直接前置共 ${start.constraints.length} 条，全部展示`;

  return {
    applicable: true,
    cue: {
      ...brief(target),
      plannedStart: target.plannedStart,
      plannedStartText: minToTime(target.plannedStart),
      plannedEndText: minToTime(target.plannedStart + target.duration),
      duration: target.duration,
      schedStart: target.schedStart,
      schedStartText: minToTime(target.schedStart),
      schedEnd: target.schedEnd,
      schedEndText: minToTime(target.schedEnd),
      estimatedEndText: minToTime(target.estimatedEnd),
      delayed: target.delayed,
    },
    baselineText: minToTime(target.plannedStart),
    maxTimeText: minToTime(target.schedStart),
    delayMinutes,
    decidedByPlan: start.decidedByPlan,
    delayed: start.delayed,
    constraints: start.constraints,
    skippedPreds: start.skippedPreds,
    otherPreds: start.otherPreds,
    interruptionHold,
    summary,
  };
}

const WHATIF_STATUS_LABEL = { PENDING: '未开始', RUNNING: '已开始', DONE: '已完成', SKIPPED: '已跳过' };

/**
 * 现场顺延预演（只读）：以同一次读取的已发布计划 + 登记快照为基线，
 * 将全部假设预计结束一次性套用后按现有前置与跳过规则重算，
 * 给出逐项「待执行开始 / 结束」差异与同岗位冲突的新增 / 消失 / 仍存在对照。
 *
 * 入参与 computeLive 相同，另含：
 *   assumptions: [{cueRef, estimatedEnd}]（已解析为分钟数；允许把未开始项既有预计结束改为更早，
 *                只要不早于预演出的开始；重算不早于原计划等规则完全沿用 computeLive）
 *   resources / resourceUsages: 发布时冻结的共享资源与提示项占用；传入时一并给出资源告警的
 *                新增 / 消失 / 持续对照（口径与现场 liveResourceAlerts 一致）；旧版无资源数据时可省略
 *
 * 返回：
 *   { errors: [{cueRef, code, reason}] }  存在无效假设时调用方应整体拒绝（不产出任何结果）
 *   或 { baseline, scenario, cues, conflictsAdded, conflictsRemoved, conflictsKept, summary,
 *        baselineResourceAlerts, scenarioResourceAlerts, resourceAlertsAdded,
 *        resourceAlertsRemoved, resourceAlertsKept }
 */
function simulateWhatIf(publishedCues, deps, regMap, assumptions, interruptions, resources, resourceUsages) {
  const baseline = computeLive(publishedCues, deps, regMap, interruptions);
  if (baseline.orderProblem) return { orderProblem: baseline.orderProblem };

  // 预演登记：一次性套用全部假设（只改预计结束；不动实际开始/完成、跳过状态与计划）
  const whatReg = new Map();
  for (const [ref, r] of regMap.entries()) whatReg.set(ref, { ...r });
  for (const a of assumptions) {
    const r = whatReg.get(a.cueRef);
    if (r) whatReg.set(a.cueRef, { ...r, estimatedEnd: a.estimatedEnd });
  }

  // 全部假设同时生效后的重算结果（联排中断顺延规则保持一致）
  const scenario = computeLive(publishedCues, deps, whatReg, interruptions);

  const baseByRef = new Map(baseline.cues.map((c) => [c.id, c]));
  const scenByRef = new Map(scenario.cues.map((c) => [c.id, c]));

  // 无效假设整体拒绝：已完成 / 已跳过不可预演；已开始项不得早于实际开始；
  // 未开始项不得早于预演（全部假设套用后）算出的开始。
  const errors = [];
  for (const a of assumptions) {
    const base = baseByRef.get(a.cueRef);
    const scen = scenByRef.get(a.cueRef);
    if (!base || !scen) {
      errors.push({ cueRef: a.cueRef, code: base?.code || null, reason: `提示项引用 ${a.cueRef} 不存在` });
      continue;
    }
    if (base.status === 'DONE') {
      errors.push({ cueRef: a.cueRef, code: base.code, reason: `「${base.code}」已完成，不能再填写假设预计结束` });
      continue;
    }
    if (base.status === 'SKIPPED') {
      errors.push({ cueRef: a.cueRef, code: base.code, reason: `「${base.code}」已跳过，不能填写假设预计结束` });
      continue;
    }
    if (base.status === 'RUNNING') {
      if (a.estimatedEnd < base.actualStart) {
        errors.push({
          cueRef: a.cueRef, code: base.code,
          reason: `「${base.code}」已开始：假设预计结束 ${minToTime(a.estimatedEnd)} 早于实际开始 ${minToTime(base.actualStart)}`,
        });
      }
      continue;
    }
    // PENDING：下界是「全部假设套用后」自身的重算开始（不能用基线值，否则同批前置假设无法生效）
    if (a.estimatedEnd < scen.schedStart) {
      errors.push({
        cueRef: a.cueRef, code: base.code,
        reason: `「${base.code}」未开始：假设预计结束 ${minToTime(a.estimatedEnd)} 早于预演算出的开始 ${minToTime(scen.schedStart)}`,
      });
    }
  }
  if (errors.length) return { errors };

  // 冲突以「岗位 + 双方提示项引用」为稳定键：逐项对照消息（时刻随假设变化），区分新增 / 消失 / 仍存在
  const conflictKey = (c) => `${c.position}|${[c.aRef, c.bRef].sort((x, y) => x - y).join('#')}`;
  const baseConflicts = new Map(baseline.conflicts.map((c) => [conflictKey(c), c]));
  const scenConflicts = new Map(scenario.conflicts.map((c) => [conflictKey(c), c]));
  const conflictsAdded = [];
  const conflictsRemoved = [];
  const conflictsKept = [];
  for (const [key, sc] of scenConflicts) {
    const bc = baseConflicts.get(key);
    if (!bc) conflictsAdded.push(sc);
    else conflictsKept.push({ baseline: bc, scenario: sc });
  }
  for (const [key, bc] of baseConflicts) {
    if (!scenConflicts.has(key)) conflictsRemoved.push(bc);
  }

  // 共享资源告警对照（口径与现场一致：跳过项不占用，仅已完成项构成的超额不告警）
  const baselineResourceAlerts = liveResourceAlerts(resources || [], baseline.cues, resourceUsages || new Map());
  const scenarioResourceAlerts = liveResourceAlerts(resources || [], scenario.cues, resourceUsages || new Map());
  const resourceDiff = diffResourceAlerts(baselineResourceAlerts, scenarioResourceAlerts);

  const assumedSet = new Set(assumptions.map((a) => a.cueRef));
  const cues = scenario.cues
    .slice()
    .sort((a, b) => a.plannedStart - b.plannedStart || a.id - b.id)
    .map((c) => {
      const b = baseByRef.get(c.id);
      const isActive = c.status !== 'SKIPPED';
      const startDelta = isActive ? c.schedStart - b.schedStart : 0;
      const endDelta = isActive ? c.schedEnd - b.schedEnd : 0;
      return {
        cueRef: c.id,
        code: c.code,
        title: c.title,
        position: c.position,
        status: c.status,
        statusLabel: WHATIF_STATUS_LABEL[c.status] || c.status,
        assumed: assumedSet.has(c.id),
        plannedStart: c.plannedStart,
        plannedStartText: minToTime(c.plannedStart),
        plannedEndText: minToTime(c.plannedStart + c.duration),
        baselineStartText: isActive ? minToTime(b.schedStart) : null,
        baselineEndText: isActive ? minToTime(b.schedEnd) : null,
        scenarioStartText: isActive ? minToTime(c.schedStart) : null,
        scenarioEndText: isActive ? minToTime(c.schedEnd) : null,
        startDeltaMinutes: startDelta,
        endDeltaMinutes: endDelta,
        changed: isActive && (startDelta !== 0 || endDelta !== 0),
        delayed: c.delayed === true,
      };
    });

  const changedCount = cues.filter((c) => c.changed).length;
  return {
    baseline,
    scenario,
    cues,
    conflictsAdded,
    conflictsRemoved,
    conflictsKept,
    baselineResourceAlerts,
    scenarioResourceAlerts,
    resourceAlertsAdded: resourceDiff.resourceAlertsAdded,
    resourceAlertsRemoved: resourceDiff.resourceAlertsRemoved,
    resourceAlertsKept: resourceDiff.resourceAlertsKept,
    summary: {
      cueCount: cues.length,
      assumedCount: assumptions.length,
      changedCount,
      baselineConflictCount: baseline.conflicts.length,
      scenarioConflictCount: scenario.conflicts.length,
      addedCount: conflictsAdded.length,
      removedCount: conflictsRemoved.length,
      keptCount: conflictsKept.length,
      ...resourceDiff.summary,
    },
  };
}

/**
 * 复盘计算（只读）：按冻结计划、现场登记与停排记录逐项给出执行复盘。
 *
 * 入参与 computeLive 相同（publishedCues / deps / regMap / interruptions）。
 * deps 仅用于保持入参一致（复盘本身不重算排期，实际开始相对计划的偏差直接用登记值）。
 *
 * 逐项结论：
 * - DONE         本版完成（本版登记同时有实际开始与实际完成，且不是交接自旧版的完成项）
 * - DONE_HANDOVER 交接自旧版的完成项（实际开始/完成随发布交接带入）：单独标识，不计入本版完成汇总
 * - SKIPPED      已跳过
 * - RUNNING      进行中（有实际开始、无实际完成）
 * - PENDING      未开始（无实际开始、无实际完成、未跳过）
 *
 * 完成项给出：
 * - startDeltaMinutes  实际开始相对计划开始的有符号分钟偏差（正=晚开始，负=提前）
 * - actualDurationMinutes    实际持续分钟（实际完成 - 实际开始）
 * - netDurationMinutes       扣除停排后的净执行分钟
 * 净执行只扣「实际起止区间」与「已结束停排段」（半开 [pause, resume)）的交集；
 * 多段停排重叠分钟只扣一次（先求并集再与实际区间相交）。进行中的停排不扣（尚未结束）。
 * 未完成项（跳过 / 进行中 / 未开始）实际持续与净执行分钟为空。
 *
 * 返回 { cues: [...], positions: [...], totals: {...}, counts: {...} }
 */
function computeReview(publishedCues, deps, regMap, interruptions) {
  // 已结束停排段（进行中的停排无恢复时刻，不扣净执行）
  const closed = (interruptions || [])
    .filter((s) => s.resumeMinute !== null && s.resumeMinute !== undefined)
    .map((s) => ({ start: s.pauseMinute, end: s.resumeMinute }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);

  // 停排段求并集（多段重叠/相接的分钟只扣一次）
  const merged = [];
  for (const seg of closed) {
    const last = merged[merged.length - 1];
    if (last && seg.start <= last.end) {
      last.end = Math.max(last.end, seg.end);
    } else {
      merged.push({ start: seg.start, end: seg.end });
    }
  }

  // [aStart, aEnd) 与已结束停排并集的交集分钟数
  const deductedMinutes = (aStart, aEnd) => {
    let n = 0;
    for (const s of merged) {
      const lo = Math.max(aStart, s.start);
      const hi = Math.min(aEnd, s.end);
      if (lo < hi) n += hi - lo;
    }
    return n;
  };

  // 按岗位聚合（仅本版完成项计入）：完成数、净执行分钟、开始偏差之和
  const posMap = new Map();
  const ensurePos = (position) => {
    if (!posMap.has(position)) {
      posMap.set(position, { position, doneCount: 0, netDurationMinutes: 0, startDeltaSum: 0 });
    }
    return posMap.get(position);
  };

  const sources = new Map();
  for (const [ref, r] of regMap.entries()) sources.set(ref, r);

  const cues = publishedCues
    .slice()
    .sort((a, b) => a.plannedStart - b.plannedStart || a.id - b.id)
    .map((cue) => {
      const r = sources.get(cue.id) || {};
      const as = r.actualStart ?? null;
      const ae = r.actualEnd ?? null;
      const skipped = r.skipped === true || r.skipped === 1;
      const handover = r.sourceVersionId != null;

      let status;
      if (skipped) status = 'SKIPPED';
      else if (ae !== null && as !== null) status = handover ? 'DONE_HANDOVER' : 'DONE';
      else if (as !== null) status = 'RUNNING';
      else status = 'PENDING';

      const base = {
        cueRef: cue.id,
        code: cue.code,
        title: cue.title,
        position: cue.position,
        plannedStart: cue.plannedStart,
        plannedStartText: minToTime(cue.plannedStart),
        plannedEndText: minToTime(cue.plannedStart + cue.duration),
        plannedDuration: cue.duration,
        status,
        actualStart: as,
        actualStartText: minToTime(as),
        actualEnd: ae,
        actualEndText: minToTime(ae),
        rowVer: r.rowVer ?? 1,
        handover: handover
          ? { sourceVersionId: r.sourceVersionId, sourceCueRef: r.sourceCueRef }
          : null,
      };

      const isDoneThisVersion = status === 'DONE';
      if (!isDoneThisVersion && status !== 'DONE_HANDOVER') {
        // 跳过 / 进行中 / 未开始：实际持续与净执行分钟为空
        return {
          ...base,
          startDeltaMinutes: null,
          actualDurationMinutes: null,
          netDurationMinutes: null,
          deductedPauseMinutes: null,
          countedInSummary: false,
        };
      }

      const actualDuration = ae - as;
      const deducted = isDoneThisVersion ? deductedMinutes(as, ae) : 0;
      const item = {
        ...base,
        startDeltaMinutes: as - cue.plannedStart,
        actualDurationMinutes: actualDuration,
        netDurationMinutes: isDoneThisVersion ? actualDuration - deducted : null,
        deductedPauseMinutes: deducted,
        countedInSummary: isDoneThisVersion,
      };
      if (isDoneThisVersion) {
        const p = ensurePos(cue.position);
        p.doneCount += 1;
        p.netDurationMinutes += item.netDurationMinutes;
        p.startDeltaSum += item.startDeltaMinutes;
      }
      return item;
    });

  const positions = [...posMap.values()].sort((a, b) => a.position.localeCompare(b.position, 'zh-Hans-CN'));
  const totals = {
    doneCount: positions.reduce((n, p) => n + p.doneCount, 0),
    netDurationMinutes: positions.reduce((n, p) => n + p.netDurationMinutes, 0),
    startDeltaSum: positions.reduce((n, p) => n + p.startDeltaSum, 0),
  };
  const counts = {
    total: cues.length,
    done: cues.filter((c) => c.status === 'DONE').length,
    doneHandover: cues.filter((c) => c.status === 'DONE_HANDOVER').length,
    running: cues.filter((c) => c.status === 'RUNNING').length,
    pending: cues.filter((c) => c.status === 'PENDING').length,
    skipped: cues.filter((c) => c.status === 'SKIPPED').length,
  };
  return { cues, positions, totals, counts };
}

module.exports = {
  timeToMin, minToTime, topoAnalyze, validatePlan, computeLive, explainSchedule, simulateWhatIf,
  computeReview, runningEndShift, interruptionHoldMinute,
  scanResourceWindows, liveResourceAlerts, diffResourceAlerts,
};
