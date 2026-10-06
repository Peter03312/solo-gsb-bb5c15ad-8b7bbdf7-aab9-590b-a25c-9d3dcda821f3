'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'cueboard.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('sm', 'operator')),
  position   TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- 当前可编辑草稿（全局只有一份）
CREATE TABLE IF NOT EXISTS draft_cues (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT NOT NULL,
  title      TEXT NOT NULL DEFAULT '',
  position   TEXT NOT NULL,
  planned_start INTEGER NOT NULL,   -- 当日 00:00 起的分钟数
  duration   INTEGER NOT NULL,      -- 分钟
  needs_release INTEGER NOT NULL DEFAULT 0, -- 1：需放行（双人签认后才能登记实际开始）
  row_ver    INTEGER NOT NULL DEFAULT 1,
  UNIQUE(code)
);

CREATE TABLE IF NOT EXISTS draft_deps (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  from_cue  INTEGER NOT NULL REFERENCES draft_cues(id) ON DELETE CASCADE,
  to_cue    INTEGER NOT NULL REFERENCES draft_cues(id) ON DELETE CASCADE,
  UNIQUE(from_cue, to_cue)
);

-- 联排共享资源（舞监在草稿中配置）：名称 + 正整数容量；仍被提示项引用时禁止删除
CREATE TABLE IF NOT EXISTS draft_resources (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT NOT NULL UNIQUE,
  capacity  INTEGER NOT NULL CHECK (capacity > 0)
);

-- 提示项对共享资源的正整数占用量（草稿）；删除提示项时级联清除
CREATE TABLE IF NOT EXISTS draft_cue_resources (
  cue_id       INTEGER NOT NULL REFERENCES draft_cues(id) ON DELETE CASCADE,
  resource_id  INTEGER NOT NULL REFERENCES draft_resources(id),
  usage        INTEGER NOT NULL CHECK (usage > 0),
  PRIMARY KEY (cue_id, resource_id)
);

-- 已发布的只读联排版本
CREATE TABLE IF NOT EXISTS rehearsal_versions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  version_no INTEGER NOT NULL UNIQUE,
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS published_cues (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id      INTEGER NOT NULL REFERENCES rehearsal_versions(id) ON DELETE CASCADE,
  cue_ref         INTEGER NOT NULL,          -- 指向当时的 draft cue id
  code            TEXT NOT NULL,
  title           TEXT NOT NULL DEFAULT '',
  position        TEXT NOT NULL,
  planned_start   INTEGER NOT NULL,
  duration        INTEGER NOT NULL,
  needs_release   INTEGER NOT NULL DEFAULT 0, -- 发布时自草稿冻结：1 需放行
  UNIQUE(version_id, cue_ref)
);

CREATE TABLE IF NOT EXISTS published_deps (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id  INTEGER NOT NULL REFERENCES rehearsal_versions(id) ON DELETE CASCADE,
  from_ref    INTEGER NOT NULL,
  to_ref      INTEGER NOT NULL,
  UNIQUE(version_id, from_ref, to_ref)
);

-- 发布时冻结的共享资源（容量随版本冻结；草稿后续修改不影响旧版）
CREATE TABLE IF NOT EXISTS published_resources (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id  INTEGER NOT NULL REFERENCES rehearsal_versions(id) ON DELETE CASCADE,
  resource_id INTEGER NOT NULL,          -- 发布时的草稿资源 id
  name        TEXT NOT NULL,
  capacity    INTEGER NOT NULL
);

-- 发布时冻结的提示项资源占用
CREATE TABLE IF NOT EXISTS published_cue_resources (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id  INTEGER NOT NULL REFERENCES rehearsal_versions(id) ON DELETE CASCADE,
  cue_ref     INTEGER NOT NULL,
  resource_id INTEGER NOT NULL,          -- 对应草稿资源 id（与 published_resources.resource_id 一致）
  usage       INTEGER NOT NULL
);

-- 现场登记（每个已发布提示项一行，随发布创建）
CREATE TABLE IF NOT EXISTS registrations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id     INTEGER NOT NULL REFERENCES rehearsal_versions(id) ON DELETE CASCADE,
  cue_ref        INTEGER NOT NULL,
  position       TEXT NOT NULL,
  actual_start   INTEGER,                   -- 实际开始（分钟）
  actual_end     INTEGER,                   -- 实际完成（分钟）
  estimated_end  INTEGER,                   -- 预计结束（分钟）
  skipped        INTEGER NOT NULL DEFAULT 0,-- 1：舞监已将该项标记为跳过（依赖链不可执行）
  row_ver        INTEGER NOT NULL DEFAULT 1,
  updated_by     TEXT,
  updated_at     TEXT,
  source_version_id INTEGER,                -- 发布交接：实际时间延续自哪个旧执行版
  source_cue_ref    INTEGER,                -- 发布交接：延续自旧版的哪个提示项引用
  UNIQUE(version_id, cue_ref)
);

-- 依赖链跳过留痕：每个版本每项至多一条（已跳过项再次出现在链中只展示、不重复留痕）
CREATE TABLE IF NOT EXISTS registration_skips (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id     INTEGER NOT NULL REFERENCES rehearsal_versions(id) ON DELETE CASCADE,
  cue_ref        INTEGER NOT NULL,          -- 被跳过的提示项引用
  root_cue_ref   INTEGER NOT NULL,          -- 触发本次操作的根提示项（沿其后继传播）
  reason         TEXT NOT NULL,             -- 非空原因
  skipped_by     TEXT NOT NULL,             -- 操作者（舞监）
  skipped_at     TEXT NOT NULL,             -- 操作时间
  UNIQUE(version_id, cue_ref)
);

-- 舞监现场登记更正历史（一次更正可能产生级联两条）
CREATE TABLE IF NOT EXISTS registration_corrections (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id     INTEGER NOT NULL REFERENCES rehearsal_versions(id) ON DELETE CASCADE,
  cue_ref        INTEGER NOT NULL,
  field          TEXT NOT NULL CHECK (field IN ('actual_start', 'actual_end', 'estimated_end')),
  old_value      INTEGER,                   -- 更正前（分钟），NULL 表示原本未登记
  new_value      INTEGER,                   -- 更正后（分钟），NULL 表示清除
  reason         TEXT NOT NULL,
  cascaded       INTEGER NOT NULL DEFAULT 0,-- 1：清除开始时级联清除完成
  group_id       INTEGER,                   -- 同一次更正：级联行指向主行 id；主行为 NULL（排序用 COALESCE）
  corrected_by   TEXT NOT NULL,
  corrected_at   TEXT NOT NULL
);

-- 岗位代班：现场临时换人（按版本记录，启用/撤销均留痕，旧版只读可查）
CREATE TABLE IF NOT EXISTS position_deputies (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id     INTEGER NOT NULL REFERENCES rehearsal_versions(id) ON DELETE CASCADE,
  position       TEXT NOT NULL,
  deputy_user_id INTEGER NOT NULL REFERENCES users(id),
  deputy_username     TEXT NOT NULL,   -- 冗余保存账号与姓名，账号后续变化不影响历史展示
  deputy_display_name TEXT NOT NULL,
  active         INTEGER NOT NULL DEFAULT 1,  -- 1 在任；0 已撤销
  enabled_by     TEXT NOT NULL,
  enabled_at     TEXT NOT NULL,
  revoked_by     TEXT,
  revoked_at     TEXT
);

-- 双人放行签认：需放行提示项须「执行人签认就绪 + 舞监签认可执行」两类有效签认齐备才能登记实际开始。
-- 每次签认记录签认人、时间、目标登记行版本与直接前置项登记行版本快照（关联表）；
-- 目标或任一直接前置项登记行变化、代班变更导致签认人失去登记权时，签认置为失效（active=0，保留记录供回看）。
CREATE TABLE IF NOT EXISTS release_signoffs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id     INTEGER NOT NULL REFERENCES rehearsal_versions(id) ON DELETE CASCADE,
  cue_ref        INTEGER NOT NULL,          -- 目标提示项引用
  kind           TEXT NOT NULL CHECK (kind IN ('operator', 'sm')), -- operator 执行人就绪 / sm 舞监可执行
  signer_user_id INTEGER NOT NULL,
  signer_username     TEXT NOT NULL,   -- 冗余保存账号与姓名，账号后续变化不影响历史展示
  signer_display_name TEXT NOT NULL,
  signed_at      TEXT NOT NULL,
  target_row_ver INTEGER NOT NULL,      -- 签认时目标登记行版本
  active         INTEGER NOT NULL DEFAULT 1,  -- 1 有效；0 已失效
  invalidated_reason TEXT,              -- 失效原因（登记行变化 / 代班变更）
  invalidated_at TEXT
);

-- 联排中断（停排/恢复）：按版本记录每段停排；同版至多一段进行中（resume_minute IS NULL）。
-- 停排时登记当日 HH:MM（分钟）与非空原因，恢复时补记恢复时刻；记录永久留存，供历史版回看。
CREATE TABLE IF NOT EXISTS rehearsal_interruptions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id    INTEGER NOT NULL REFERENCES rehearsal_versions(id) ON DELETE CASCADE,
  pause_minute  INTEGER NOT NULL,          -- 停排开始时刻（当日 00:00 起分钟数）
  reason        TEXT NOT NULL,             -- 非空停排原因
  paused_by     TEXT NOT NULL,             -- 停排操作人（舞监）
  paused_at     TEXT NOT NULL,             -- 停排操作时间戳
  resume_minute INTEGER,                   -- 恢复时刻（NULL = 停排进行中）
  resumed_by    TEXT,
  resumed_at    TEXT
);

-- 复盘封存（每版至多一条）：封存时把所见执行版复盘预览（明细 + 岗位汇总）作为不可变快照整体保存，
-- 同时留存封存所依据的登记行版本与停排状态（basis）；封存后任何登记更正、交接、发布新版均不得改写。
CREATE TABLE IF NOT EXISTS rehearsal_reviews (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id     INTEGER NOT NULL UNIQUE REFERENCES rehearsal_versions(id) ON DELETE CASCADE,
  note           TEXT NOT NULL DEFAULT '',
  detail_json    TEXT NOT NULL,             -- 封存时的逐项明细快照
  summary_json   TEXT NOT NULL,             -- 封存时的岗位汇总与本版合计快照
  basis_json     TEXT NOT NULL,             -- 封存核对依据：全部登记行版本 + 已结束停排段 + 执行版 id
  sealed_by      TEXT NOT NULL,             -- 封存操作者（舞监）
  sealed_at      TEXT NOT NULL              -- 封存时间
);

-- 顺延变更待确认：岗位登记、舞监更正、跳过链、停排、恢复使当前执行版某个「未开始、未跳过」提示项的
-- 重算开始时刻在同次操作前后发生变化时，为该项所属岗位留一条待确认记录；未变化或已跳过项不留。
-- 记录冻结版本、提示项（编号、说明、岗位）、变更前后时刻、触发操作与时间；同次操作影响多项分别留痕；
-- 操作事务整体失败回滚，不产生任何记录。执行账号只能查看并确认当前有权负责岗位（含代班）的记录；
-- 确认须携带所见记录的行版本（record_version），确认后仅推进本行版本（row_ver=2），不重复留痕、不改动登记；
-- 版本归档或岗位权限变化时旧提交被拒绝。旧联排版本只读回看；发布新版不承接待确认（记录随版本保存，不迁移）。
CREATE TABLE IF NOT EXISTS schedule_change_notices (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id       INTEGER NOT NULL REFERENCES rehearsal_versions(id) ON DELETE CASCADE,
  cue_ref          INTEGER NOT NULL,          -- 变更发生时该提示项引用
  code             TEXT NOT NULL,             -- 冻结：提示项编号
  title            TEXT NOT NULL DEFAULT '',  -- 冻结：提示项说明
  position         TEXT NOT NULL,             -- 冻结：所属岗位（权限判定以此为准）
  before_start     INTEGER NOT NULL,          -- 变更前重算开始（分钟）
  after_start      INTEGER NOT NULL,          -- 变更后重算开始（分钟）
  trigger_action   TEXT NOT NULL,             -- register/correct/skip/pause/resume
  trigger_detail   TEXT NOT NULL,             -- 触发操作的可读说明（冻结）
  trigger_cue_ref  INTEGER,                   -- 直接操作的提示项引用（停排/恢复为 NULL）
  trigger_cue_code TEXT,                      -- 直接操作的提示项编号（停排/恢复为 NULL）
  triggered_by     TEXT NOT NULL,             -- 触发操作者（显示名）
  triggered_at     TEXT NOT NULL,             -- 触发操作时间戳
  acknowledged_by  TEXT,                      -- 确认人（显示名，NULL=未确认）
  acknowledged_by_username TEXT,              -- 确认人账号
  acknowledged_at  TEXT,
  row_ver          INTEGER NOT NULL DEFAULT 1 -- 1 待确认；确认后推进为 2（乐观锁，防止旧提交误确认）
);

-- 签认时直接前置项登记行版本快照（任一变化即失效）
CREATE TABLE IF NOT EXISTS release_signoff_preds (
  signoff_id  INTEGER NOT NULL REFERENCES release_signoffs(id) ON DELETE CASCADE,
  cue_ref     INTEGER NOT NULL,          -- 直接前置提示项引用
  row_ver     INTEGER NOT NULL           -- 签认时该前置的登记行版本
);

CREATE INDEX IF NOT EXISTS idx_pcues_version ON published_cues(version_id);
CREATE INDEX IF NOT EXISTS idx_pres_version ON published_resources(version_id);
CREATE INDEX IF NOT EXISTS idx_pcr_version ON published_cue_resources(version_id);
CREATE INDEX IF NOT EXISTS idx_reg_version ON registrations(version_id);
CREATE INDEX IF NOT EXISTS idx_corr_version ON registration_corrections(version_id);
CREATE INDEX IF NOT EXISTS idx_deputies_version ON position_deputies(version_id);
CREATE INDEX IF NOT EXISTS idx_skips_version ON registration_skips(version_id);
CREATE INDEX IF NOT EXISTS idx_signoffs_version ON release_signoffs(version_id);
CREATE INDEX IF NOT EXISTS idx_notices_version ON schedule_change_notices(version_id);
CREATE INDEX IF NOT EXISTS idx_notices_pending
  ON schedule_change_notices(version_id, position) WHERE row_ver = 1;
CREATE INDEX IF NOT EXISTS idx_interruptions_version ON rehearsal_interruptions(version_id);
-- 同一版本至多一段进行中的停排（部分唯一索引：resume_minute IS NULL 即进行中）
CREATE UNIQUE INDEX IF NOT EXISTS idx_interruptions_active
  ON rehearsal_interruptions(version_id) WHERE resume_minute IS NULL;
CREATE INDEX IF NOT EXISTS idx_signoff_preds_signoff ON release_signoff_preds(signoff_id);
CREATE INDEX IF NOT EXISTS idx_signoff_preds_cue ON release_signoff_preds(cue_ref);
-- 每个版本每个岗位至多一名在任代班（部分唯一索引）
CREATE UNIQUE INDEX IF NOT EXISTS idx_deputies_active
  ON position_deputies(version_id, position) WHERE active = 1;
`);

// 幂等迁移：旧库的 registrations 表没有交接来源列时补齐（CREATE TABLE IF NOT EXISTS 不会改既有表）
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) db.exec(ddl);
}
ensureColumn('registrations', 'source_version_id',
  'ALTER TABLE registrations ADD COLUMN source_version_id INTEGER');
ensureColumn('registrations', 'source_cue_ref',
  'ALTER TABLE registrations ADD COLUMN source_cue_ref INTEGER');
ensureColumn('registrations', 'skipped',
  'ALTER TABLE registrations ADD COLUMN skipped INTEGER NOT NULL DEFAULT 0');
ensureColumn('draft_cues', 'needs_release',
  'ALTER TABLE draft_cues ADD COLUMN needs_release INTEGER NOT NULL DEFAULT 0');
ensureColumn('published_cues', 'needs_release',
  'ALTER TABLE published_cues ADD COLUMN needs_release INTEGER NOT NULL DEFAULT 0');

function getMeta(key, fallback = null) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setMeta(key, value) {
  db.prepare(
    `INSERT INTO meta(key, value) VALUES(?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, String(value));
}

module.exports = { db, getMeta, setMeta, DB_PATH };
