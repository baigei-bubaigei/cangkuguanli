const DEMO_PRODUCTS = [
  {
    id: "sku-a",
    name: "示例商品 A",
    category: "类别示例 A",
    categoryName: "类别名称 A",
    note: "仅用于界面演示",
    spec: "标准规格",
    perCase: 4,
    locations: [
      { id: "a-01", warehouse: "一号仓库", spot: "A区 · 01架", cases: 3, loose: 1 },
      { id: "a-02", warehouse: "一号仓库", spot: "B区 · 03架", cases: 0, loose: 8 },
    ],
  },
  {
    id: "sku-b",
    name: "示例商品 B",
    category: "类别示例 B",
    categoryName: "类别名称 B",
    note: "包装状态按现场记录",
    spec: "小包装",
    perCase: 2,
    locations: [
      { id: "b-01", warehouse: "一号仓库", spot: "A区 · 02架", cases: 8, loose: 0 },
    ],
  },
  {
    id: "sku-c",
    name: "示例商品 C",
    category: "类别示例 C",
    categoryName: "类别名称 C",
    note: "散个演示",
    spec: "大包装",
    perCase: 6,
    locations: [
      { id: "c-01", warehouse: "二号仓库", spot: "C区 · 01架", cases: 0, loose: 12 },
      { id: "c-02", warehouse: "二号仓库", spot: "地面区", cases: 2, loose: 2 },
    ],
  },
  {
    id: "sku-d",
    name: "示例商品 D",
    category: "类别示例 D",
    categoryName: "类别名称 D",
    note: "另一种产品规格",
    spec: "常规规格",
    perCase: 4,
    locations: [
      { id: "d-01", warehouse: "二号仓库", spot: "D区 · 02架", cases: 5, loose: 3 },
    ],
  },
];

const INITIAL_RECORDS = [
  {
    id: "record-a1",
    kind: "in",
    type: "入库",
    productId: "sku-b",
    locationId: "b-01",
    cases: 2,
    loose: 0,
    occurredAt: "2026-10-10T10:42",
    createdAt: "2026-10-10T10:43",
    actor: "林员工",
    sourceSystem: "员工系统",
    note: "日常补货",
    editHistory: [],
  },
  {
    id: "record-a2",
    kind: "out",
    type: "出库",
    productId: "sku-c",
    locationId: "c-01",
    cases: 0,
    loose: 3,
    occurredAt: "2026-10-09T16:15",
    createdAt: "2026-10-09T16:18",
    actor: "周管理员",
    sourceSystem: "管理员系统",
    note: "按单领用",
    editHistory: [],
  },
  {
    id: "record-a3",
    kind: "move",
    type: "移动货位",
    productId: "sku-a",
    fromLocationId: "a-01",
    toLocationId: "a-02",
    cases: 0,
    loose: 2,
    occurredAt: "2026-10-09T14:26",
    createdAt: "2026-10-09T14:26",
    actor: "林员工",
    sourceSystem: "员工系统",
    note: "整理货位",
    editHistory: [],
  },
];

const INITIAL_SYSTEM_LOGS = [
  { id: "sys-1", action: "登录系统", actor: "林员工", system: "员工系统", time: "2026-10-10T09:05" },
  { id: "sys-2", action: "查看库存查询", actor: "林员工", system: "员工系统", time: "2026-10-10T09:12" },
  { id: "sys-3", action: "员工账号状态调整", actor: "周管理员", system: "管理员系统", time: "2026-10-09T17:08" },
  { id: "sys-4", action: "登录系统", actor: "周管理员", system: "管理员系统", time: "2026-10-09T08:51" },
];

const INITIAL_USERS = [
  { id: "user-1", name: "林员工", account: "staff01", status: "启用", createdAt: "2026-09-18" },
  { id: "user-2", name: "陈员工", account: "staff02", status: "启用", createdAt: "2026-09-21" },
  { id: "user-3", name: "吴员工", account: "staff03", status: "停用", createdAt: "2026-09-26" },
];

const SYSTEM_INFO = {
  employee: { name: "员工系统", user: "林员工", account: "staff01" },
  admin: { name: "管理员系统", user: "周管理员", account: "admin01" },
};

const NAV_ITEMS = [
  { id: "inventory", label: "库存查询", group: "库存工作区" },
  { id: "history", label: "库存业务记录", group: "库存工作区" },
  { id: "catalog", label: "产品与货位", group: "基础资料" },
  { id: "systemLogs", label: "系统操作日志", group: "记录与管理" },
];

function cloneProducts() {
  return DEMO_PRODUCTS.map((product) => ({
    ...product,
    locations: product.locations.map((location) => ({ ...location })),
  }));
}

function makeId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
}

function localInputTime(date = new Date()) {
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function getTotals(product) {
  return product.locations.reduce(
    (total, location) => ({
      cases: total.cases + Number(location.cases || 0),
      loose: total.loose + Number(location.loose || 0),
    }),
    { cases: 0, loose: 0 },
  );
}

function quantityText(cases, loose) {
  return `${Number(cases || 0)} 件 ${Number(loose || 0)} 个`;
}

function findProduct(products, productId) {
  return products.find((product) => product.id === productId);
}

function findLocation(products, productId, locationId) {
  return findProduct(products, productId)?.locations.find((location) => location.id === locationId);
}

function getLocationLabel(products, productId, locationId) {
  const location = findLocation(products, productId, locationId);
  return location ? `${location.warehouse} · ${location.spot}` : "—";
}

function effectsForRecord(record, direction = 1) {
  const cases = Number(record.cases || 0);
  const loose = Number(record.loose || 0);
  if (record.kind === "in") return [{ id: record.locationId, cases, loose }];
  if (record.kind === "out") return [{ id: record.locationId, cases: -cases, loose: -loose }];
  if (record.kind === "move") {
    return [
      { id: record.fromLocationId, cases: -cases, loose: -loose },
      { id: record.toLocationId, cases, loose },
    ];
  }
  if (record.kind === "split") {
    const splitCases = Number(record.splitCases || 0);
    const looseToAdd = splitCases * Number(record.perCase || 0);
    return [{ id: record.locationId, cases: -splitCases, loose: looseToAdd }];
  }
  return [];
}

function applyRecordEffect(products, record, direction = 1) {
  const deltas = effectsForRecord(record, direction);
  let error = "";
  const updated = products.map((product) => ({
    ...product,
    locations: product.locations.map((location) => {
      const delta = deltas.find((item) => item.id === location.id);
      if (!delta || product.id !== record.productId) return location;
      const cases = Number(location.cases || 0) + delta.cases * direction;
      const loose = Number(location.loose || 0) + delta.loose * direction;
      if (cases < 0 || loose < 0) error = "更正后会造成货位库存不足，未保存本次更正。";
      return { ...location, cases, loose };
    }),
  }));
  return { products: updated, error };
}

function summarizeRecord(record, products) {
  if (record.kind === "in") return `增加 ${quantityText(record.cases, record.loose)}`;
  if (record.kind === "out") return `减少 ${quantityText(record.cases, record.loose)}`;
  if (record.kind === "move") {
    return `${quantityText(record.cases, record.loose)} · ${findLocation(products, record.productId, record.fromLocationId)?.spot || "原货位"} → ${findLocation(products, record.productId, record.toLocationId)?.spot || "目标货位"}`;
  }
  if (record.kind === "split") {
    return `拆开 ${record.splitCases} 件 · 增加 ${record.splitCases * record.perCase} 个散个`;
  }
  if (record.kind === "init") return `初始库存 ${quantityText(record.cases, record.loose)}`;
  return "—";
}


export { DEMO_PRODUCTS, INITIAL_RECORDS, INITIAL_SYSTEM_LOGS, INITIAL_USERS, SYSTEM_INFO, NAV_ITEMS, cloneProducts, makeId, localInputTime, formatTime, getTotals, quantityText, findProduct, findLocation, getLocationLabel, applyRecordEffect, summarizeRecord };
