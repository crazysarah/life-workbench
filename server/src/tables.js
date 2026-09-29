'use strict';

/**
 * 六张业务表的定义。
 * key   —— 接口路径里用的英文标识，同时是数据库里的 table_key
 * name  —— 中文名，用于提示文案
 * fields—— 字段中文名，和历史数据保持一致（前端 merge* 函数按中文键读取）
 *
 * 注意：字段名是中文，SQLite 侧统一以 JSON 存储，不做列绑定，
 * 所以后续增删字段无需迁移表结构。
 */
const TABLES = [
  { key: 'money', name: '收支表', fields: ['日期', '分类', '金额', '备注'] },
  { key: 'habit', name: '习惯打卡表', fields: ['日期', '习惯', '数值', '备注'] },
  { key: 'plan', name: '日程表', fields: ['日期', '内容', '类型', '状态'] },
  { key: 'fitness', name: '健身记录表', fields: ['日期', '体重', '体脂率', '备注'] },
  { key: 'shopping', name: '待买清单表', fields: ['物品名称', '数量', '预估价格', '是否已买', '备注'] },
  { key: 'media', name: '书影音收藏表', fields: ['标题', '类型', '状态', '评分', '短评'] }
];

const TABLE_MAP = TABLES.reduce(function (acc, t) {
  acc[t.key] = t;
  return acc;
}, {});

function isValidTable(key) {
  return Object.prototype.hasOwnProperty.call(TABLE_MAP, key);
}

function tableName(key) {
  return TABLE_MAP[key] ? TABLE_MAP[key].name : key;
}

/**
 * 把 SDK 风格的属性包装值拍平：
 *   { "日期": { date: "2026-09-01" }, "金额": { currency: 25 } }
 *   -> { "日期": "2026-09-01", "金额": 25 }
 * 只认单键且键名在白名单里的包装，其余原样透传。
 */
const WRAPPERS = ['text', 'number', 'date', 'currency', 'select', 'multiSelect'];

function flattenProperties(props) {
  const out = {};
  if (!props || typeof props !== 'object') return out;
  Object.keys(props).forEach(function (k) {
    const v = props[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const keys = Object.keys(v);
      if (keys.length === 1 && WRAPPERS.indexOf(keys[0]) >= 0) {
        out[k] = v[keys[0]];
        return;
      }
    }
    out[k] = v;
  });
  return out;
}

module.exports = { TABLES, TABLE_MAP, isValidTable, tableName, flattenProperties };
