'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

/**
 * 单表设计：所有业务记录落在 records 表。
 *   record_id  TEXT  主键
 *   table_key  TEXT  业务表标识（money / habit / ...）
 *   props      TEXT  业务字段的 JSON（键是中文名）
 *
 * 为什么不建六张固定列的表：
 * 字段名是中文且六张表各不相同，固定列需要六组建表语句 + 六组 CRUD，
 * 加字段还要迁移。JSON 单表一套 CRUD 全覆盖，后续加模块零迁移，
 * 查询用 json_extract 一样能下推。
 */
/**
 * 打不开数据库时给出可执行的诊断，而不是只丢一个 SQLITE_CANTOPEN。
 * 最常见的场景：宿主机目录挂到 /data，宿主目录属主是 root，
 * 而容器里跑的是 node（uid 1000）→ 写不进去。
 */
function explainCannotOpen(file, dir) {
  const lines = ['', '[life-workbench] 打不开数据库文件：' + file, ''];

  let targetIsDir = false;
  try {
    const f = fs.statSync(file);
    targetIsDir = f.isDirectory();
    lines.push('  目标路径已存在，是' + (targetIsDir ? '一个目录' : '文件（不是目录，所以不是这个原因）'));
  } catch (e) {
    // 文件不存在是正常的，首次启动就是这情况
  }

  try {
    const s = fs.statSync(dir);
    const owner = process.platform === 'linux' ? 'uid=' + s.uid + ' gid=' + s.gid + ' ' : '';
    lines.push('  数据目录 ' + dir + '：' + owner + 'mode=' + (s.mode & 0o777).toString(8).padStart(3, '0'));
  } catch (e) {
    lines.push('  数据目录 ' + dir + '：读不到（' + (e.code || e.message) + '）');
  }

  if (process.platform === 'linux' && typeof process.getuid === 'function') {
    lines.push('  当前进程身份：uid=' + process.getuid() + ' gid=' + process.getgid());
  }
  lines.push('');

  if (targetIsDir) {
    lines.push('  → DB_FILE 指向了一个目录。改成目录下的文件名即可，例如：');
    lines.push('     ' + path.join(file, 'workbench.db'));
    lines.push('');
    return lines.join('\n');
  }

  lines.push('  最常见的原因：把宿主机目录挂到 /data 时，宿主目录的属主不是运行用户。');
  lines.push('  docker 自动创建的目录属于 root:root，容器里的 node 是 uid 1000，写不进去；');
  lines.push('  而且挂载会覆盖镜像里对 /data 的授权，所以镜像层面修不了。');
  lines.push('');
  lines.push('  三种解法，任选其一：');
  lines.push('    1) 改用 docker 卷（推荐）：让 .env 的 DATA_VOLUME 留空，再 docker compose up -d');
  lines.push('    2) 修正宿主目录属主：mkdir -p data && sudo chown -R 1000:1000 data');
  lines.push('    3) 让容器以 root 运行：docker-compose.yml 的 api 下加一行 user: "0:0"');
  lines.push('');
  return lines.join('\n');
}

function openDatabase(file) {
  const abs = path.resolve(file);
  const dir = path.dirname(abs);

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    throw new Error(
      '[life-workbench] 建不了数据库目录 ' + dir + '：' + e.message + '\n' +
      '  → 检查 DB_FILE 的上层路径是否存在、是否被当成文件占了。'
    );
  }

  let db;
  try {
    db = new Database(abs);
  } catch (e) {
    // better-sqlite3 会把扩展码拼在后面（SQLITE_CANTOPEN_ISDIR 等），所以用前缀匹配
    if (e && typeof e.code === 'string' && e.code.indexOf('SQLITE_CANTOPEN') === 0) {
      console.error(explainCannotOpen(abs, dir));
    }
    throw e;
  }
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  db.exec([
    'CREATE TABLE IF NOT EXISTS records (',
    '  record_id  TEXT PRIMARY KEY,',
    '  table_key  TEXT NOT NULL,',
    '  props      TEXT NOT NULL,',
    '  created_at INTEGER NOT NULL,',
    '  updated_at INTEGER NOT NULL',
    ');',
    'CREATE INDEX IF NOT EXISTS idx_records_table ON records(table_key);',
    'CREATE INDEX IF NOT EXISTS idx_records_table_updated ON records(table_key, updated_at);'
  ].join('\n'));

  return db;
}

function newRecordId() {
  return 'rec' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
}

/** 把数据库行转成前端要的形状：{ record_id, ...中文字段 } */
function rowToRecord(row) {
  let props = {};
  try {
    props = JSON.parse(row.props);
  } catch (e) {
    props = {};
  }
  const out = { record_id: row.record_id, _created_at: row.created_at, _updated_at: row.updated_at };
  Object.keys(props).forEach(function (k) {
    out[k] = props[k];
  });
  return out;
}

function createStore(db) {
  const stmtInsert = db.prepare(
    'INSERT INTO records (record_id, table_key, props, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  );
  const stmtSelectByTable = db.prepare(
    'SELECT * FROM records WHERE table_key = ? ORDER BY updated_at DESC, record_id DESC LIMIT ? OFFSET ?'
  );
  const stmtSelectOne = db.prepare('SELECT * FROM records WHERE record_id = ? AND table_key = ?');
  const stmtExists = db.prepare('SELECT record_id FROM records WHERE record_id = ?');
  const stmtUpdate = db.prepare('UPDATE records SET props = ?, updated_at = ? WHERE record_id = ? AND table_key = ?');
  const stmtDelete = db.prepare('DELETE FROM records WHERE record_id = ? AND table_key = ?');
  const stmtDeleteAll = db.prepare('DELETE FROM records WHERE table_key = ?');
  const stmtCount = db.prepare('SELECT COUNT(*) AS n FROM records WHERE table_key = ?');
  const stmtCounts = db.prepare('SELECT table_key, COUNT(*) AS n FROM records GROUP BY table_key');

  return {
    list(table, limit, offset) {
      return stmtSelectByTable.all(table, limit, offset).map(rowToRecord);
    },
    get(table, recordId) {
      const row = stmtSelectOne.get(recordId, table);
      return row ? rowToRecord(row) : null;
    },
    count(table) {
      return stmtCount.get(table).n;
    },
    counts() {
      const out = {};
      stmtCounts.all().forEach(function (r) {
        out[r.table_key] = r.n;
      });
      return out;
    },
    add(table, props) {
      let id = newRecordId();
      // 极小概率碰撞，重试几次
      for (let i = 0; i < 5 && stmtExists.get(id); i++) id = newRecordId();
      const now = Date.now();
      stmtInsert.run(id, table, JSON.stringify(props || {}), now, now);
      return id;
    },
    update(table, recordId, props) {
      const row = stmtSelectOne.get(recordId, table);
      if (!row) return false;
      let current = {};
      try {
        current = JSON.parse(row.props);
      } catch (e) {
        current = {};
      }
      // 合并而非整体替换：前端 PATCH 只带变更字段
      const merged = Object.assign({}, current, props || {});
      return stmtUpdate.run(JSON.stringify(merged), Date.now(), recordId, table).changes > 0;
    },
    remove(table, recordId) {
      return stmtDelete.run(recordId, table).changes > 0;
    },
    clear(table) {
      return stmtDeleteAll.run(table).changes;
    },
    importRows(table, rows) {
      const insertMany = db.transaction(function (list) {
        const now = Date.now();
        let n = 0;
        list.forEach(function (props) {
          let id = newRecordId();
          while (stmtExists.get(id)) id = newRecordId();
          stmtInsert.run(id, table, JSON.stringify(props || {}), now, now);
          n++;
        });
        return n;
      });
      return insertMany(rows);
    }
  };
}

module.exports = { openDatabase, createStore, newRecordId, rowToRecord };
