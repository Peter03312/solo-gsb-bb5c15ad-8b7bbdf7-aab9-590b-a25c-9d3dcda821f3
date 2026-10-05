'use strict';

// 启动初始化：幂等建表 + 首次启动播种账号与示例草稿。
const { db, getMeta, setMeta } = require('./db');
const { hashPassword } = require('./auth');
const { timeToMin } = require('./scheduling');

const DEFAULT_USERS = [
  { username: 'sm', display_name: '舞监', role: 'sm', position: null, password: 'sm12345' },
  { username: 'light', display_name: '灯光执行', role: 'operator', position: '灯光', password: 'light123' },
  { username: 'sound', display_name: '音响执行', role: 'operator', position: '音响', password: 'sound123' },
  { username: 'props', display_name: '道具执行', role: 'operator', position: '道具', password: 'props123' },
];

const SEED_POSITIONS = ['灯光', '音响', '道具'];

// 示例共享资源（容量为正整数）；占用按各提示项计划半开时段累计，配置后示例草稿仍可直接发布
const SEED_RESOURCES = [
  { name: '无线麦', capacity: 2 },
  { name: '升降台', capacity: 1 },
];

// 提示项 -> [{资源名, 占用量}]
const SEED_CUE_RESOURCES = {
  L1: [{ resource: '无线麦', usage: 1 }],
  S1: [{ resource: '无线麦', usage: 1 }],
  S2: [{ resource: '无线麦', usage: 1 }],
  L2: [{ resource: '无线麦', usage: 1 }],
  L3: [{ resource: '无线麦', usage: 1 }, { resource: '升降台', usage: 1 }],
  P1: [{ resource: '升降台', usage: 1 }],
};

// 可直接发布的示例联排计划（依赖关系满足顺序，同岗位互不重叠）
const SEED_CUES = [
  { code: 'L1', title: '开场灯光就位', position: '灯光', start: '19:00', duration: 5 },
  { code: 'S1', title: '开场音乐', position: '音响', start: '19:05', duration: 3, deps: ['L1'] },
  { code: 'P1', title: '一桌二椅', position: '道具', start: '19:05', duration: 6, deps: ['L1'] },
  { code: 'L2', title: '追光主角上场', position: '灯光', start: '19:10', duration: 8, deps: ['S1'] },
  { code: 'S2', title: '风声效果', position: '音响', start: '19:12', duration: 5, deps: ['S1'] },
  { code: 'L3', title: '落幕收光', position: '灯光', start: '19:20', duration: 4, deps: ['L2'] },
];

function seedUsers() {
  const insert = db.prepare(
    `INSERT INTO users(username, display_name, password_hash, role, position)
     VALUES (@username, @display_name, @password_hash, @role, @position)`
  );
  let count = 0;
  for (const u of DEFAULT_USERS) {
    const exists = db.prepare('SELECT 1 FROM users WHERE username = ?').get(u.username);
    if (exists) continue;
    insert.run({
      username: u.username,
      display_name: u.display_name,
      password_hash: hashPassword(u.password),
      role: u.role,
      position: u.position,
    });
    count += 1;
  }
  return count;
}

function seedDraft() {
  const cueCount = db.prepare('SELECT COUNT(*) AS n FROM draft_cues').get().n;
  if (cueCount > 0) return false;

  const insertCue = db.prepare(
    `INSERT INTO draft_cues(code, title, position, planned_start, duration)
     VALUES (@code, @title, @position, @planned_start, @duration)`
  );
  const insertDep = db.prepare(
    'INSERT INTO draft_deps(from_cue, to_cue) VALUES (?, ?)'
  );
  const insertResource = db.prepare(
    'INSERT INTO draft_resources(name, capacity) VALUES (?, ?)'
  );
  const insertCueResource = db.prepare(
    'INSERT INTO draft_cue_resources(cue_id, resource_id, usage) VALUES (?, ?, ?)'
  );

  const tx = db.transaction((cues) => {
    const codeToId = new Map();
    for (const c of cues) {
      const info = insertCue.run({
        code: c.code,
        title: c.title,
        position: c.position,
        planned_start: timeToMin(c.start),
        duration: c.duration,
      });
      codeToId.set(c.code, info.lastInsertRowid);
    }
    for (const c of cues) {
      for (const pre of c.deps || []) {
        insertDep.run(codeToId.get(pre), codeToId.get(c.code));
      }
    }
    const resNameToId = new Map();
    for (const r of SEED_RESOURCES) {
      const info = insertResource.run(r.name, r.capacity);
      resNameToId.set(r.name, info.lastInsertRowid);
    }
    for (const [code, usages] of Object.entries(SEED_CUE_RESOURCES)) {
      for (const u of usages) {
        insertCueResource.run(codeToId.get(code), resNameToId.get(u.resource), u.usage);
      }
    }
  });
  tx(SEED_CUES);
  return true;
}

function init() {
  if (getMeta('initialized') !== '1') {
    const seededUsers = seedUsers();
    const seededDraft = seedDraft();
    if (getMeta('positions') === null) setMeta('positions', JSON.stringify(SEED_POSITIONS));
    setMeta('draft_version', getMeta('draft_version', '0'));
    setMeta('initialized', '1');
    return { firstRun: true, seededUsers, seededDraft };
  }
  seedUsers(); // 补齐升级后新增的默认账号
  return { firstRun: false, seededUsers: 0, seededDraft: false };
}

if (require.main === module) {
  const result = init();
  // eslint-disable-next-line no-console
  console.log('[initdb]', result.firstRun ? '首次初始化完成' : '数据库已就绪', result);
}

module.exports = { init, SEED_POSITIONS };
