/*
 * 科目智能匹配（纯前端 / 离线）
 * 根据流水「摘要」文本，匹配关键字自动归入对应「用途分类（会计科目）」。
 * UMD：浏览器挂 window.CatMatch；Node 测试用 module.exports。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.CatMatch = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  // 默认匹配规则：数组顺序即优先级（命中靠前的先返回）。
  // cat1 对应「用途分类」一级（与 internal.js 的 DEFAULT_CATS 对齐）；cat2 为可选二级。
  var DEFAULT_RULES = [
    { kw: ['工资', '薪资', '薪酬', '发薪', '薪金', 'salary', 'payroll'], cat1: '工资薪酬', cat2: '', note: '工资/薪酬', enabled: true },
    { kw: ['社保', '公积金', '五险一金'], cat1: '工资薪酬', cat2: '', note: '社保公积金并入工资薪酬', enabled: true },
    { kw: ['房租', '租金', '物业', '写字楼', '商铺'], cat1: '房租物业', cat2: '', note: '房租/物业', enabled: true },
    { kw: ['餐饮', '餐费', '饭', '午餐', '晚饭', '晚餐', '招待', '请客', '聚餐', '宴', '酒席'], cat1: '餐饮招待', cat2: '', note: '餐饮招待', enabled: true },
    { kw: ['差旅', '出差', '住宿', '酒店', '宾馆', '机票', '火车票', '船票'], cat1: '差旅费', cat2: '', note: '差旅费', enabled: true },
    { kw: ['打车', '滴滴', '的士', '出租', '高铁', '动车', '地铁', '公交', '大巴', '加油', '油费', '过路', '停车', '交通', 'uber', 'taxi'], cat1: '交通出行', cat2: '', note: '交通出行', enabled: true },
    { kw: ['办公', '文具', '打印', '耗材', '纸张', '硒鼓', '墨盒'], cat1: '办公用品', cat2: '', note: '办公用品', enabled: true },
    { kw: ['广告', '宣传', '推广', '营销', '海报', 'banner', '策划', '文案'], cat1: '广告宣传', cat2: '', note: '广告宣传', enabled: true },
    { kw: ['材料', '原料', '辅料', '采购', '钢材', '水泥'], cat1: '材料采购', cat2: '', note: '材料采购', enabled: true },
    { kw: ['设备', '电脑', '打印机', '固定资产', '机器', '机床', '服务器'], cat1: '设备购置', cat2: '', note: '设备购置', enabled: true },
    { kw: ['税', '发票', '缴款', '缴纳', '规费', '手续费', '税费'], cat1: '税费', cat2: '', note: '税费', enabled: true },
    { kw: ['利息', '理财', '收益', '存款'], cat1: '利息收入', cat2: '', note: '利息收入', enabled: true }
  ];

  function norm(s) { return (s == null ? '' : String(s)).toLowerCase(); }

  // 纯函数：根据摘要文本匹配分类规则，返回 {cat1, cat2, kw, rule} 或 null
  function match(text, rules) {
    var t = norm(text);
    if (!t) return null;
    var list = (rules && rules.length) ? rules : DEFAULT_RULES;
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      if (r && r.enabled === false) continue;
      var kws = (r && r.kw) || [];
      for (var j = 0; j < kws.length; j++) {
        var k = norm(kws[j]);
        if (k && t.indexOf(k) >= 0) {
          return { cat1: r.cat1 || '', cat2: r.cat2 || '', kw: kws[j], rule: r };
        }
      }
    }
    return null;
  }

  // 过滤掉引用了「不存在的分类」的规则（分类被重命名/删除后自动失效，避免误填）
  function filterValid(rules, validCat1) {
    if (!validCat1 || !validCat1.length) return rules;
    var set = {};
    validCat1.forEach(function (c) { set[c] = 1; });
    return (rules || []).filter(function (r) { return r && set[r.cat1]; });
  }

  return { DEFAULT_RULES: DEFAULT_RULES, match: match, filterValid: filterValid, norm: norm };
});
