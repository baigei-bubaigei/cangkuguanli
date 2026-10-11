import {
  INITIAL_RECORDS, INITIAL_SYSTEM_LOGS, INITIAL_USERS, SYSTEM_INFO, NAV_ITEMS,
  cloneProducts, makeId, localInputTime, formatTime, getTotals, quantityText,
  findProduct, findLocation, getLocationLabel, applyRecordEffect, summarizeRecord,
} from "./domain.js";

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[char]);
const h = escapeHtml;
const dataAttrs = (params) => Object.entries(params).map(([key, value]) => `data-${key}="${h(value)}"`).join(" ");
const button = (label, action, params = {}, variant = "button-outline") => `<button type="button" class="button ${variant}" data-action="${h(action)}" ${dataAttrs(params)}>${h(label)}</button>`;
const textButton = (label, action, params = {}) => `<button type="button" class="text-button" data-action="${h(action)}" ${dataAttrs(params)}>${h(label)}</button>`;
const brand = '<div class="brand-lockup"><span class="brand-mark">仓</span><span>仓库管理</span></div>';
const options = (items, selected) => items.map((item) => {
  const value = typeof item === "object" ? item.value : item;
  const label = typeof item === "object" ? item.label : item;
  return `<option value="${h(value)}" ${String(value) === String(selected) ? "selected" : ""}>${h(label)}</option>`;
}).join("");
const field = (label, name, value = "", type = "text", extra = "") => `<label>${h(label)}<input name="${h(name)}" type="${type}" value="${h(value)}" ${extra}></label>`;
const selectField = (label, name, items, selected) => `<label>${h(label)}<select name="${h(name)}">${options(items, selected)}</select></label>`;
const heading = (title, description, actions = "", kicker = "共享库存 · 本地演示") => `<div class="page-heading"><div><p class="eyebrow">${h(kicker)}</p><h1>${h(title)}</h1><p class="page-description">${h(description)}</p></div>${actions ? `<div class="page-heading-actions">${actions}</div>` : ""}</div>`;
const table = (className, columns, rows) => `<div class="table-wrap"><table class="${className}"><thead><tr>${columns.map((x) => `<th>${h(x)}</th>`).join("")}</tr></thead><tbody>${rows || `<tr><td colspan="${columns.length}" class="empty-cell">没有符合条件的记录。</td></tr>`}</tbody></table></div>`;

export function portalMarkup() {
  return `<main class="portal-page"><header class="portal-topbar">${brand}<span class="portal-caption">库存共用 · 系统独立</span></header>
    <section class="portal-content"><p class="eyebrow">WAREHOUSE OPERATIONS · 本地演示</p><h1>每天的库存，<br>从清楚开始。</h1>
    <p class="portal-intro">选择一个独立系统入口。两套系统办理的库存业务会汇入同一套库存记录。</p>
    <div class="portal-choices"><article class="portal-choice"><div class="portal-choice-top"><span>EMPLOYEE PORTAL</span><span>01</span></div><h2>员工系统</h2><p>查看库存、办理日常业务、维护产品与货位。</p>${button("进入员工系统登录", "select-system", { system: "employee" }, "button-primary button-wide")}</article>
    <article class="portal-choice portal-choice-admin"><div class="portal-choice-top"><span>ADMIN PORTAL</span><span>02</span></div><h2>管理员系统</h2><p>办理库存业务，并管理员工账号与初始库存导入。</p>${button("进入管理员系统登录", "select-system", { system: "admin" }, "button-dark button-wide")}</article></div>
    <p class="portal-footnote">纯静态交互演示 · 数据仅在本次打开期间有效，刷新后恢复示例库存。</p></section></main>`;
}

export function startApp(root = document.getElementById("root")) {
  if (!root) throw new Error("找不到页面容器。");
  const state = {
    screen: "portal", system: "employee", page: "inventory", actor: "林员工", account: "staff01",
    products: cloneProducts(), records: JSON.parse(JSON.stringify(INITIAL_RECORDS)),
    logs: INITIAL_SYSTEM_LOGS.map((x) => ({ ...x })), users: INITIAL_USERS.map((x) => ({ ...x })),
    query: "", warehouse: "全部仓库", historyQuery: "", type: "全部类型", source: "全部系统",
    logSystem: "全部系统", logActor: "全部操作人", logQuery: "",
    expanded: "", mobileOpen: false, modal: null, filename: "", importRows: [], initialized: false,
  };
  const isAdmin = () => state.system === "admin";
  const systemName = () => SYSTEM_INFO[state.system].name;
  const titleMap = { inventory: "库存查询", history: "库存业务记录", catalog: "产品与货位", accounts: "员工账号", import: "初始库存导入", systemLogs: "系统操作日志" };
  let toastTimer;

  function log(action) {
    state.logs.unshift({ id: makeId("sys"), action, actor: state.actor, account: state.account, system: systemName(), time: localInputTime() });
  }
  function toast(message) {
    const box = root.querySelector(".toast-message");
    if (!box) return;
    box.textContent = message;
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.hidden = true; }, 2800);
  }
  function formError(form, message) {
    const box = form.querySelector(".form-error");
    if (box) { box.textContent = message; box.hidden = false; }
  }
  function loginMarkup() {
    const info = SYSTEM_INFO[state.system];
    return `<main class="login-page"><div class="login-side">${brand}<div class="login-message"><p class="eyebrow">${isAdmin() ? "ADMIN PORTAL" : "EMPLOYEE PORTAL"}</p><h1>${info.name}<br>独立登录入口</h1><p>库存数据共用，账号与系统操作记录分别管理。</p></div><span class="login-side-foot">纯静态本地演示</span></div>
    <section class="login-panel">${textButton("返回系统入口", "portal")}<div class="login-form-wrap"><p class="eyebrow">独立登录</p><h2>登录${info.name}</h2><p class="muted">演示账号：${info.account}，密码：demo123。仅用于体验界面。</p>
    <form data-form="login" class="form-stack">${field("账号", "account", info.account, "text", 'required autocomplete="username"')}${field("密码", "password", "demo123", "password", 'required autocomplete="current-password"')}<p class="form-error" role="alert" hidden></p><button type="submit" class="button ${isAdmin() ? "button-dark" : "button-primary"} button-wide">登录${info.name}</button></form><div class="login-separator"><span>当前入口</span></div><div class="login-entry-name">${info.name}<span>· 独立演示账号</span></div></div></section></main>`;
  }
  function sidebarMarkup() {
    const nav = [...NAV_ITEMS.slice(0, 3),
      ...(isAdmin() ? [{ id: "accounts", label: "员工账号", group: "记录与管理" }, { id: "import", label: "初始库存导入", group: "记录与管理" }] : []), NAV_ITEMS[3]];
    return `${state.mobileOpen ? '<button class="mobile-scrim" type="button" data-action="close-menu" aria-label="关闭菜单"></button>' : ""}<aside class="sidebar ${state.mobileOpen ? "sidebar-open" : ""}"><div class="sidebar-brand">${brand}<span class="system-badge ${isAdmin() ? "system-badge-admin" : ""}">${systemName()}</span></div><nav class="nav-scroll" aria-label="系统导航">${[...new Set(nav.map((x) => x.group))].map((group) => `<div class="nav-group"><p class="nav-group-title">${group}</p>${nav.filter((x) => x.group === group).map((x) => `<button type="button" data-action="navigate" data-page="${x.id}" class="nav-link ${state.page === x.id ? "nav-link-active" : ""}" ${state.page === x.id ? 'aria-current="page"' : ""}><span>${x.label}</span>${x.id === "import" ? '<span class="nav-mini-tag">仅初始化</span>' : ""}</button>`).join("")}</div>`).join("")}</nav><div class="sidebar-bottom"><div class="user-block"><span class="avatar ${isAdmin() ? "avatar-admin" : ""}">${h(state.actor[0])}</span><span class="user-copy"><strong>${h(state.actor)}</strong><small>${h(state.account)}</small></span><span class="online-dot" title="演示在线"></span></div>${button("退出当前系统", "logout", {}, "logout-button")}</div></aside>`;
  }
  function inventoryMarkup() {
    const warehouses = [...new Set(state.products.flatMap((p) => p.locations.map((l) => l.warehouse)))];
    const filtered = state.products.filter((p) => `${p.name} ${p.spec} ${p.category} ${p.categoryName} ${p.locations.map((l) => l.spot).join(" ")}`.toLowerCase().includes(state.query.toLowerCase()) && (state.warehouse === "全部仓库" || p.locations.some((l) => l.warehouse === state.warehouse)));
    const rows = filtered.map((p) => {
      const total = getTotals(p), expanded = state.expanded === p.id;
      return `<tr class="inventory-row" data-product-id="${h(p.id)}"><td><button type="button" class="product-name-button" data-action="expand" data-product="${h(p.id)}" aria-expanded="${expanded}">${h(p.name)}</button><span class="product-spec">${h(p.spec)}</span></td><td><span class="ratio-value">${p.perCase}</span><span class="muted"> 个 / 件</span></td><td><button type="button" class="location-toggle" data-action="expand" data-product="${h(p.id)}" aria-expanded="${expanded}">${p.locations.length} 个货位 <span>${expanded ? "收起" : "查看"}</span></button></td><td><div class="quantity-pair"><strong>${total.cases}<small>件</small></strong><strong>${total.loose}<small>个</small></strong></div></td><td class="row-action-cell">${textButton("登记", "transaction", { operation: "入库", product: p.id })}</td></tr>
      ${expanded ? `<tr class="location-detail-row"><td colspan="5"><div class="location-detail"><div class="location-detail-head"><span>货位明细</span><span>每件 ${p.perCase} 个</span></div>${p.locations.map((l) => `<div class="location-line"><span class="location-name"><small>${h(l.warehouse)}</small>${h(l.spot)}</span><span class="location-quantity">${quantityText(l.cases, l.loose)}</span><span class="location-actions">${textButton("入库", "transaction", { operation: "入库", product: p.id, location: l.id })}${textButton("出库", "transaction", { operation: "出库", product: p.id, location: l.id })}</span></div>`).join("")}</div></td></tr>` : ""}`;
    }).join("");
    return heading("库存查询", "按规格查看总库存和各货位数量，散个保持现场状态。", `<div class="action-row">${["入库", "出库", "移动货位", "拆件"].map((operation) => button(operation === "移动货位" ? "移位" : operation, "transaction", { operation }, operation === "入库" ? "button-primary" : "button-outline")).join("")}</div>`) + `<div class="overview-strip"><div><span>演示数据</span><strong>${state.products.length} 个规格</strong></div><div class="overview-divider"></div><div><span>库存分布</span><strong>${state.products.reduce((n, p) => n + p.locations.length, 0)} 个货位记录</strong></div><div class="overview-note">两套系统共用库存 · 当前入口：${systemName()}</div></div><section class="data-panel"><div class="table-toolbar"><div><h2>产品库存</h2><p>共 ${filtered.length} 条规格记录</p></div><div class="filters"><label class="search-field"><span class="sr-only">搜索产品</span><input data-filter="query" value="${h(state.query)}" placeholder="搜索产品、规格或货位"></label><label><span class="sr-only">选择仓库</span><select data-filter="warehouse">${options(["全部仓库", ...warehouses], state.warehouse)}</select></label></div></div>${table("inventory-table", ["产品与规格", "每件个数", "货位分布", "当前库存", "操作"], rows)}<div class="panel-footer"><span>跨货位分别汇总整件与散个，不自动折算。</span><span>演示数据</span></div></section>`;
  }
  function historyMarkup() {
    const filtered = state.records.filter((r) => {
      const p = findProduct(state.products, r.productId);
      return (state.type === "全部类型" || state.type === r.type) && (state.source === "全部系统" || state.source === r.sourceSystem) && `${p?.name} ${p?.spec} ${r.actor} ${r.note} ${getLocationLabel(state.products, r.productId, r.locationId || r.fromLocationId)}`.toLowerCase().includes(state.historyQuery.toLowerCase());
    });
    const rows = filtered.map((r) => {
      const p = findProduct(state.products, r.productId);
      return `<tr><td><span class="type-label type-${r.kind}">${h(r.type)}</span>${r.editHistory?.length ? '<small class="edited-mark">已更正</small>' : ""}</td><td><strong>${h(p?.name)}</strong><small>${h(p?.spec)}</small></td><td class="record-summary">${h(summarizeRecord(r, state.products))}<small>${h(r.note)}</small></td><td>${h(r.kind === "move" ? `${findLocation(state.products, r.productId, r.fromLocationId)?.spot} → ${findLocation(state.products, r.productId, r.toLocationId)?.spot}` : getLocationLabel(state.products, r.productId, r.locationId))}</td><td>${h(formatTime(r.occurredAt))}<small>登记 ${h(formatTime(r.createdAt))}</small></td><td><strong>${h(r.actor)}</strong><small>${h(r.sourceSystem)}</small></td><td>${r.kind !== "init" ? textButton("更正", "correction", { record: r.id }) : ""}${r.editHistory?.length ? textButton("修改记录", "record-history", { record: r.id }) : ""}</td></tr>`;
    }).join("");
    return heading("库存业务记录", "两套系统共用业务历史，每条记录注明发生端。", "", "共享业务历史") + `<section class="data-panel"><div class="history-toolbar"><div class="segmented-control" aria-label="筛选业务类型">${["全部类型", "入库", "出库", "移动货位", "拆件", "初始库存"].map((type) => `<button type="button" data-action="type-filter" data-type="${type}" class="${state.type === type ? "segment-active" : ""}">${type}</button>`).join("")}</div><div class="filters history-filters"><label class="search-field"><span class="sr-only">搜索业务记录</span><input data-filter="historyQuery" value="${h(state.historyQuery)}" placeholder="搜索产品、货位或操作人"></label><label><span class="sr-only">筛选来源系统</span><select data-filter="source">${options(["全部系统", "员工系统", "管理员系统"], state.source)}</select></label></div></div>${table("history-table", ["业务类型", "产品与规格", "变动内容", "货位", "实际发生时间", "操作人 / 来源", "操作"], rows)}<div class="panel-footer"><span>更正保留修改前后内容、修改人及时间。</span><span>${filtered.length} 条记录</span></div></section>`;
  }
  function catalogMarkup() {
    return heading("产品与货位", "类别、类别名称和备注分别保留；包装数量变化时另建规格。", button("新增产品规格", "add-product", {}, "button-primary"), "基础资料") + `<section class="data-panel"><div class="table-toolbar"><div><h2>产品规格</h2><p>两套系统维护同一套基础资料。</p></div><span class="soft-pill">共用基础资料</span></div>${table("catalog-table", ["产品名称", "商品类别", "类别名称", "规格", "每件个数", "备注", "货位", "操作"], state.products.map((p) => `<tr><td><strong>${h(p.name)}</strong></td><td>${h(p.category || "—")}</td><td>${h(p.categoryName || "—")}</td><td>${h(p.spec)}</td><td>${p.perCase} 个 / 件</td><td class="catalog-note">${h(p.note || "—")}</td><td>${p.locations.length} 个</td><td>${textButton("新增货位", "add-location", { product: p.id })}</td></tr>`).join(""))}</section>`;
  }
  function accountsMarkup() {
    return heading("员工账号", "管理员系统维护员工账号；管理员与员工使用独立入口。", button("新增员工账号", "add-user", {}, "button-dark"), "管理员专属") + `<section class="data-panel"><div class="table-toolbar"><div><h2>账号列表</h2><p>新建演示账号的密码为 demo123。</p></div><span class="soft-pill">员工系统账号</span></div>${table("accounts-table", ["员工", "登录账号", "状态", "创建日期", "操作"], state.users.map((u) => `<tr><td><strong>${h(u.name)}</strong></td><td>${h(u.account)}</td><td><span class="status-pill ${u.status === "启用" ? "status-active" : "status-inactive"}">${u.status}</span></td><td>${h(u.createdAt)}</td><td>${textButton(u.status === "启用" ? "停用账号" : "启用账号", "toggle-user", { user: u.id })}</td></tr>`).join(""))}</section>`;
  }
  function logsMarkup() {
    const visible = state.logs.filter((x) => isAdmin() || x.system === "员工系统");
    const accountFor = (x) => x.account || (x.system === "管理员系统" ? "admin01" : state.users.find((u) => u.name === x.actor)?.account || "—");
    const logs = visible.filter((x) => (!isAdmin() || state.logSystem === "全部系统" || x.system === state.logSystem)
      && (state.logActor === "全部操作人" || x.actor === state.logActor)
      && `${x.action} ${x.actor} ${accountFor(x)}`.toLowerCase().includes(state.logQuery.toLowerCase()));
    const actors = [...new Set(visible.map((x) => x.actor))];
    const filters = `<div class="filters log-filters"><label class="search-field"><span class="sr-only">搜索操作内容或账号</span><input data-filter="logQuery" value="${h(state.logQuery)}" placeholder="搜索操作内容或账号"></label>${isAdmin() ? `<label><span class="sr-only">筛选日志来源系统</span><select data-filter="logSystem">${options(["全部系统", "员工系统", "管理员系统"], state.logSystem)}</select></label>` : ""}<label><span class="sr-only">筛选操作人</span><select data-filter="logActor">${options(["全部操作人", ...actors], state.logActor)}</select></label></div>`;
    return heading("系统操作日志", isAdmin() ? "查看管理员和员工两端的登录及操作记录，可按来源系统、操作人及账号查询。" : "查看员工端的登录及操作记录，可按操作人及账号查询。", "", isAdmin() ? "管理员 · 全部系统日志" : "员工端日志") + `<section class="data-panel"><div class="table-toolbar"><div><h2>${isAdmin() ? "全部系统操作记录" : "员工系统操作记录"}</h2><p>${logs.length} 条符合条件的记录，均注明来源系统。</p></div>${filters}</div>${table("system-log-table", ["操作内容", "操作人 / 账号", "来源系统", "操作时间"], logs.map((x) => `<tr><td><strong>${h(x.action)}</strong></td><td><strong>${h(x.actor)}</strong><small>${h(accountFor(x))}</small></td><td>${h(x.system)}</td><td>${h(formatTime(x.time))}</td></tr>`).join(""))}</section>`;
  }
  function closedInitializationMarkup() {
    return '<section class="import-closed"><p class="eyebrow">初始化已完成</p><h2>初始库存 Excel 导入已关闭</h2><p>库存手工登记继续通过入库、出库、移动货位和拆件办理。</p><span class="soft-pill">管理员系统专属功能</span></section>';
  }
  function importMarkup() {
    const ready = state.importRows.length && state.importRows.every((r) => r.status !== "pending") && state.importRows.some((r) => r.status === "confirmed");
    return heading("初始库存导入", "首次手工录入使用入库；Excel 需逐行核对后导入，初始化完成后关闭。", state.initialized ? "" : button("确认完成初始化", "finish-initial", {}, "button-dark"), "管理员专属 · 初始化前开放") + (state.initialized ? closedInitializationMarkup() : `<section class="import-upload-panel"><div class="import-upload-copy"><p class="eyebrow">第一步 · 选择文件</p><h2>库存模板导入流程</h2><p>商品类别、类别名称和备注分别保留；疑似重复行不自动累加。</p></div><div class="upload-control"><label class="button button-outline file-button">选择 Excel 文件<input data-upload="excel" type="file" accept=".xlsx,.xls,.csv"></label><span class="file-name">${h(state.filename || "尚未选择文件")}</span>${textButton("载入演示预览", "load-preview")}</div><p class="prototype-note">静态原型只展示文件名；下方使用模拟数据演示核对过程，不解析或修改 Excel 文件。</p></section>${state.importRows.length ? `<section class="data-panel"><div class="table-toolbar"><div><p class="eyebrow">第二步 · 逐行核对</p><h2>导入预览</h2></div><span class="status-pill ${ready ? "status-active" : "status-warning"}">${ready ? "可提交演示数据" : `${state.importRows.filter((r) => r.status === "pending").length} 行待处理`}</span></div>${table("import-table", ["原行号", "产品名称", "商品类别", "类别名称", "备注", "规格 / 每件个数", "仓库 / 货位", "当前库存", "核对"], state.importRows.map((r) => `<tr class="${r.status === "excluded" ? "import-row-excluded" : ""}"><td>${r.rowNumber}</td><td>${h(r.name)}</td><td>${h(r.category)}</td><td>${h(r.categoryName)}</td><td>${h(r.note)}</td><td>${h(r.spec)}<small>${r.perCase} 个 / 件</small></td><td>${h(r.warehouse)}<small>${h(r.spot)}</small></td><td>${quantityText(r.cases, r.loose)}</td><td>${r.status === "pending" ? textButton(r.duplicate ? "排除疑似重复" : "确认此行", "review-import", { row: r.id }) : `<span class="status-pill ${r.status === "confirmed" ? "status-active" : "status-inactive"}">${r.status === "confirmed" ? "已核对" : "已排除"}</span>`}</td></tr>`).join(""))}<div class="import-submit-row"><p>演示导入会替换本次体验中的初始库存。</p><button class="button button-primary" type="button" data-action="submit-import" ${ready ? "" : "disabled"}>确认导入演示数据</button></div></section>` : ""}`);
  }
  function render() {
    const focused = document.activeElement;
    const filter = focused?.dataset.filter;
    const cursor = focused?.selectionStart;
    if (state.screen === "portal") root.innerHTML = portalMarkup();
    else if (state.screen === "login") root.innerHTML = loginMarkup();
    else {
      const pages = { inventory: inventoryMarkup, history: historyMarkup, catalog: catalogMarkup, accounts: accountsMarkup, import: importMarkup, systemLogs: logsMarkup };
      if (!isAdmin() && ["accounts", "import"].includes(state.page)) state.page = "inventory";
      root.innerHTML = `<div class="app-shell">${sidebarMarkup()}<div class="main-column"><header class="app-topbar">${button("菜单", "menu", {}, "mobile-menu-button")}<div class="breadcrumb"><span>${systemName()}</span><span class="crumb-divider">/</span><strong>${titleMap[state.page]}</strong></div><div class="topbar-right"><span class="demo-pill">演示数据 · 本地有效</span><span class="topbar-date">${formatTime(localInputTime()).slice(0, 10)}</span><span class="avatar topbar-avatar ${isAdmin() ? "avatar-admin" : ""}">${h(state.actor[0])}</span></div></header><main class="page-content">${pages[state.page]()}</main></div></div><div class="toast-message" role="status" hidden></div>${state.modal ? modalMarkup() : ""}`;
    }
    for (const select of root.querySelectorAll("select[data-filter]")) select.value = state[select.dataset.filter];
    if (state.modal) {
      for (const select of root.querySelectorAll('[role="dialog"] select[name]')) {
        const value = state.modal.values[select.name];
        if (value !== undefined) select.value = String(value);
      }
    }
    if (filter) {
      const next = root.querySelector(`[data-filter="${filter}"]`);
      next?.focus();
      if (next?.type === "text" && cursor !== null) next.setSelectionRange(cursor, cursor);
    }
  }
  function productOptions() { return state.products.map((p) => ({ value: p.id, label: `${p.name} · ${p.spec}` })); }
  function modalMarkup() {
    const m = state.modal, v = m.values;
    let title = "", description = "", fields = "", submit = "保存", extra = "";
    if (m.type === "transaction") {
      const p = findProduct(state.products, v.productId), locations = p?.locations || [];
      const l = locations.find((x) => x.id === v.locationId);
      title = `登记${m.operation}`; description = "提交后更新演示库存，并记录来源系统。"; submit = "确认登记";
      fields = selectField("产品规格", "productId", productOptions(), v.productId) + selectField(m.operation === "移动货位" ? "原货位" : "货位", "locationId", locations.map((x) => ({ value: x.id, label: `${x.warehouse} · ${x.spot}（${quantityText(x.cases, x.loose)}）` })), v.locationId);
      if (m.operation === "移动货位") {
        const targets = locations.filter((x) => x.id !== v.locationId);
        fields += selectField("目标货位", "targetLocationId", targets.length ? targets.map((x) => ({ value: x.id, label: `${x.warehouse} · ${x.spot}` })) : [{ value: "", label: "请先新增另一个货位" }], v.targetLocationId);
        if (!targets.length) extra = "disabled";
      }
      fields += m.operation === "拆件" ? field("拆开件数", "cases", v.cases, "number", 'min="1" step="1" required') + `<div class="calculation-preview"><span>拆件预览</span><strong data-split-preview>${Number(v.cases || 0)} 件 → 增加 ${Number(v.cases || 0) * (p?.perCase || 0)} 个散个</strong><small>每件 ${p?.perCase || 0} 个，不自动折回整件。</small></div>` : `<div class="form-two-column">${field("整件数", "cases", v.cases, "number", 'min="0" step="1"')}${field("散个数", "loose", v.loose, "number", 'min="0" step="1"')}</div>`;
      fields += `<p class="available-note">当前货位可用：${quantityText(l?.cases, l?.loose)}。</p>` + field("实际发生时间", "occurredAt", v.occurredAt, "datetime-local", "required") + field("备注（可选）", "note", v.note);
    } else if (m.type === "correction") {
      const r = state.records.find((x) => x.id === m.recordId);
      title = "更正库存业务记录"; description = `${findProduct(state.products, r.productId)?.name} · ${r.type} · 更正后重新校验库存`; submit = "保存更正";
      fields = `<p class="available-note">原记录：${h(summarizeRecord(r, state.products))}；${h(r.note || "无备注")}</p>` + (r.kind === "split" ? field("拆开件数", "cases", v.cases, "number", 'min="1" step="1" required') : `<div class="form-two-column">${field("整件数", "cases", v.cases, "number", 'min="0" step="1"')}${field("散个数", "loose", v.loose, "number", 'min="0" step="1"')}</div>`) + field("实际发生时间", "occurredAt", v.occurredAt, "datetime-local", "required") + field("备注", "note", v.note);
    } else if (m.type === "add-product") {
      title = "新增产品规格"; description = "商品类别、类别名称和备注分别保存。"; submit = "保存规格";
      fields = field("产品名称", "name", v.name, "text", "required") + field("规格名称", "spec", v.spec, "text", "required") + `<div class="form-two-column">${field("商品类别", "category", v.category)}${field("类别名称", "categoryName", v.categoryName)}</div>` + field("备注", "note", v.note) + selectField("每件个数", "perCase", [2, 4, 6].map((n) => ({ value: n, label: `${n} 个 / 件` })), v.perCase) + field("仓库", "warehouse", v.warehouse, "text", "required") + field("货位", "spot", v.spot, "text", "required");
    } else if (m.type === "add-location") {
      title = "新增货位"; description = "为现有规格增加货位，库存从 0 件 0 个开始。";
      fields = selectField("产品规格", "productId", productOptions(), v.productId) + field("仓库", "warehouse", v.warehouse, "text", "required") + field("货位名称", "spot", v.spot, "text", "required");
    } else if (m.type === "add-user") {
      title = "新增员工账号"; description = "此账号仅用于员工系统。演示密码为 demo123。";
      fields = field("员工姓名", "name", v.name, "text", "required") + field("登录账号", "account", v.account, "text", "required");
    } else if (m.type === "finish-initial") {
      title = "确认完成初始化"; description = "完成后关闭 Excel 初始库存导入，入库等日常操作继续使用。"; submit = "确认完成";
      fields = '<p>请核对所有规格及货位库存。手工录入通过入库办理；未提交的 Excel 预览不会写入库存。</p>';
    } else if (m.type === "record-history") {
      const r = state.records.find((x) => x.id === m.recordId);
      title = "修改记录"; description = "原业务保留，修改前后内容独立记录。";
      fields = r.editHistory.map((x) => `<article class="audit-entry"><strong>${h(x.by)} · ${h(x.system)} · ${h(formatTime(x.at))}</strong><p>修改前：${h(x.before)}</p><p>修改后：${h(x.after)}</p></article>`).join("");
    }
    return `<div class="modal-backdrop" data-backdrop><section class="modal" role="dialog" aria-modal="true" aria-label="${h(title)}"><div class="modal-header"><div><h2>${h(title)}</h2><p>${h(description)}</p></div>${button("关闭", "close-modal", {}, "button-quiet")}</div>${m.type === "record-history" ? `<div class="modal-form">${fields}</div>` : `<form data-form="modal" class="form-stack modal-form">${fields}<p class="form-error" role="alert" hidden></p><div class="modal-actions">${button("取消", "close-modal", {}, "button-quiet")}<button type="submit" class="button button-primary" ${extra}>${submit}</button></div></form>`}</section></div>`;
  }
  function openModal(type, data = {}) {
    if (["add-user", "finish-initial"].includes(type) && !isAdmin()) return;
    const p = findProduct(state.products, data.product || state.products[0]?.id);
    const l = p?.locations.find((x) => x.id === data.location) || p?.locations[0];
    let values = { productId: p?.id || "", locationId: l?.id || "", targetLocationId: p?.locations.find((x) => x.id !== l?.id)?.id || "", cases: "", loose: "", occurredAt: localInputTime(), note: "" };
    if (type === "correction") {
      const r = state.records.find((x) => x.id === data.record);
      if (!r || r.kind === "init") return;
      values = { cases: r.kind === "split" ? r.splitCases : r.cases, loose: r.loose, occurredAt: r.occurredAt, note: r.note };
    }
    if (type === "add-product") values = { name: "", spec: "", category: "", categoryName: "", note: "", perCase: 4, warehouse: "一号仓库", spot: "" };
    if (type === "add-location") values = { productId: p?.id || "", warehouse: "", spot: "" };
    if (type === "add-user") values = { name: "", account: "" };
    state.modal = { type, values, operation: data.operation, recordId: data.record, productId: p?.id, locationId: l?.id };
    render();
    root.querySelector('[role="dialog"] input, [role="dialog"] select, [role="dialog"] button')?.focus();
  }
  function saveTransaction(v, operation) {
    const p = findProduct(state.products, v.productId);
    if (!p) return "请先选择产品规格。";
    const l = findLocation(state.products, p.id, v.locationId);
    if (!l) return "请选择有效货位。";
    const cases = Number(v.cases || 0), loose = Number(v.loose || 0);
    if (![cases, loose].every((n) => Number.isInteger(n) && n >= 0)) return "数量必须是非负整数。";
    if (!v.occurredAt || Number.isNaN(new Date(v.occurredAt).getTime())) return "请填写实际发生时间。";
    let record = { id: makeId("record"), productId: p.id, locationId: l.id, cases, loose, occurredAt: v.occurredAt, createdAt: localInputTime(), actor: state.actor, sourceSystem: systemName(), note: v.note.trim(), editHistory: [] };
    if (operation !== "拆件" && cases + loose === 0) return "整件与散个至少一项大于 0。";
    if (operation === "入库") record = { ...record, kind: "in", type: operation };
    else if (operation === "出库") record = { ...record, kind: "out", type: operation };
    else if (operation === "移动货位") {
      if (l.id === v.targetLocationId || !findLocation(state.products, p.id, v.targetLocationId)) return "请选择不同的有效目标货位。";
      record = { ...record, kind: "move", type: operation, fromLocationId: l.id, toLocationId: v.targetLocationId };
    } else if (operation === "拆件") {
      if (!Number.isInteger(cases) || cases <= 0) return "拆开件数必须是大于 0 的整数。";
      record = { ...record, kind: "split", type: operation, cases: 0, loose: 0, splitCases: cases, perCase: p.perCase };
    } else return "无效业务类型。";
    const result = applyRecordEffect(state.products, record);
    if (result.error) return `该货位库存不足。当前可用：${quantityText(l.cases, l.loose)}。`;
    state.products = result.products; state.records.unshift(record); log(`登记${operation}`);
    return "";
  }
  function saveCorrection(v, id) {
    const r = state.records.find((x) => x.id === id);
    if (!r || r.kind === "init") return "找不到可更正的业务记录。";
    const cases = Number(v.cases || 0), loose = Number(v.loose || 0);
    if (![cases, loose].every((n) => Number.isInteger(n) && n >= 0) || (r.kind === "split" ? cases <= 0 : cases + loose <= 0)) return "请输入有效的非负整数数量，变动不能为零。";
    if (!v.occurredAt || Number.isNaN(new Date(v.occurredAt).getTime())) return "请填写实际发生时间。";
    const undo = applyRecordEffect(state.products, r, -1);
    if (undo.error) return undo.error;
    const changed = { ...r, cases: r.kind === "split" ? 0 : cases, loose: r.kind === "split" ? 0 : loose, splitCases: r.kind === "split" ? cases : r.splitCases, occurredAt: v.occurredAt, note: v.note.trim() };
    const result = applyRecordEffect(undo.products, changed);
    if (result.error) return result.error;
    const describe = (x) => `${summarizeRecord(x, state.products)}；${formatTime(x.occurredAt)}；${x.note || "无备注"}`;
    changed.editHistory = [...(r.editHistory || []), { at: localInputTime(), by: state.actor, system: systemName(), before: describe(r), after: describe(changed) }];
    state.products = result.products; state.records = state.records.map((x) => x.id === id ? changed : x); log("更正库存业务记录");
    return "";
  }
  function saveModal(v) {
    const m = state.modal;
    if (!m) return "";
    if (m.type === "transaction") return saveTransaction(v, m.operation);
    if (m.type === "correction") return saveCorrection(v, m.recordId);
    if (m.type === "add-product") {
      for (const key of ["name", "spec", "warehouse", "spot"]) if (!v[key]?.trim()) return "请填写产品名称、规格、仓库及货位。";
      if (state.products.some((p) => p.name === v.name.trim() && p.spec === v.spec.trim())) return "该产品规格已存在，请新增货位或使用不同规格。";
      if (![2, 4, 6].includes(Number(v.perCase))) return "请选择有效的每件个数。";
      state.products.push({ id: makeId("sku"), name: v.name.trim(), spec: v.spec.trim(), category: v.category.trim(), categoryName: v.categoryName.trim(), note: v.note.trim(), perCase: Number(v.perCase), locations: [{ id: makeId("location"), warehouse: v.warehouse.trim(), spot: v.spot.trim(), cases: 0, loose: 0 }] });
      log("新增产品规格与货位");
    } else if (m.type === "add-location") {
      const p = findProduct(state.products, v.productId);
      if (!p || !v.warehouse?.trim() || !v.spot?.trim()) return "请选择规格并填写仓库、货位。";
      if (p.locations.some((l) => l.warehouse === v.warehouse.trim() && l.spot.toLowerCase() === v.spot.trim().toLowerCase())) return "该规格已经存在这个货位。";
      p.locations.push({ id: makeId("location"), warehouse: v.warehouse.trim(), spot: v.spot.trim(), cases: 0, loose: 0 }); log("新增货位");
    } else if (m.type === "add-user") {
      if (!isAdmin()) return "请使用管理员系统。";
      if (!v.name?.trim() || !v.account?.trim()) return "请填写员工姓名和账号。";
      if (v.account.trim().toLowerCase() === "admin01" || state.users.some((u) => u.account.toLowerCase() === v.account.trim().toLowerCase())) return "该账号已存在或属于管理员。";
      state.users.unshift({ id: makeId("user"), name: v.name.trim(), account: v.account.trim(), status: "启用", createdAt: localInputTime().slice(0, 10) }); log("新增员工账号");
    } else if (m.type === "finish-initial") {
      if (!isAdmin()) return "请使用管理员系统。";
      state.initialized = true; log("确认完成库存初始化");
    }
    return "";
  }
  function loadPreview() {
    if (!isAdmin() || state.initialized) return;
    state.importRows = [
      { id: "import-1", rowNumber: 2, name: "示例商品 A", category: "类别示例 A", categoryName: "类别名称 A", note: "原行备注", spec: "标准规格", perCase: 4, warehouse: "一号仓库", spot: "A区 · 01架", cases: 3, loose: 1, duplicate: false, status: "pending" },
      { id: "import-2", rowNumber: 3, name: "示例商品 B", category: "类别示例 B", categoryName: "类别名称 B", note: "分别保留", spec: "小包装", perCase: 2, warehouse: "一号仓库", spot: "A区 · 02架", cases: 8, loose: 0, duplicate: false, status: "pending" },
      { id: "import-3", rowNumber: 4, name: "示例商品 A", category: "类别示例 A", categoryName: "类别名称 A", note: "疑似重复行", spec: "标准规格", perCase: 4, warehouse: "一号仓库", spot: "A区 · 01架", cases: 3, loose: 1, duplicate: true, status: "pending" },
    ];
  }
  root.addEventListener("click", (event) => {
    if (event.target.matches("[data-backdrop]")) { state.modal = null; render(); return; }
    const target = event.target.closest("[data-action]");
    if (!target || !root.contains(target) || target.disabled) return;
    const d = target.dataset;
    if (d.action === "select-system") { state.system = d.system; state.screen = "login"; }
    else if (d.action === "portal") state.screen = "portal";
    else if (d.action === "logout") { log("退出系统"); state.screen = "portal"; state.mobileOpen = false; state.modal = null; }
    else if (state.screen !== "app") return;
    else if (d.action === "navigate") {
      if (!titleMap[d.page] || (!isAdmin() && ["accounts", "import"].includes(d.page))) return;
      state.page = d.page; state.mobileOpen = false; state.modal = null; log(`查看${titleMap[d.page]}`);
    } else if (d.action === "menu") state.mobileOpen = !state.mobileOpen;
    else if (d.action === "close-menu") state.mobileOpen = false;
    else if (d.action === "expand") state.expanded = state.expanded === d.product ? "" : d.product;
    else if (d.action === "type-filter") state.type = d.type;
    else if (d.action === "close-modal") state.modal = null;
    else if (["transaction", "correction", "record-history", "add-product", "add-location", "add-user", "finish-initial"].includes(d.action)) {
      if (d.action === "finish-initial" && state.initialized) return;
      openModal(d.action, d); return;
    } else if (d.action === "toggle-user" && isAdmin()) {
      const user = state.users.find((u) => u.id === d.user);
      if (user) { user.status = user.status === "启用" ? "停用" : "启用"; log("调整员工账号状态"); }
    } else if (d.action === "load-preview") loadPreview();
    else if (d.action === "review-import" && isAdmin() && !state.initialized) {
      const row = state.importRows.find((r) => r.id === d.row);
      if (row) row.status = row.duplicate ? "excluded" : "confirmed";
    } else if (d.action === "submit-import" && isAdmin() && !state.initialized) {
      if (!state.importRows.length || state.importRows.some((r) => r.status === "pending")) return;
      const accepted = state.importRows.filter((r) => r.status === "confirmed");
      if (!accepted.length) return;
      state.products = accepted.map((r) => ({ id: makeId("imported"), name: r.name, category: r.category, categoryName: r.categoryName, spec: r.spec, note: r.note, perCase: r.perCase, locations: [{ id: makeId("location"), warehouse: r.warehouse, spot: r.spot, cases: r.cases, loose: r.loose }] }));
      state.records = state.products.map((p) => ({ id: makeId("initial"), kind: "init", type: "初始库存", productId: p.id, locationId: p.locations[0].id, cases: p.locations[0].cases, loose: p.locations[0].loose, actor: state.actor, sourceSystem: systemName(), occurredAt: localInputTime(), createdAt: localInputTime(), note: "演示初始化导入", editHistory: [] }));
      state.initialized = true; log("完成初始库存演示导入");
    }
    render();
  });
  root.addEventListener("submit", (event) => {
    const form = event.target.closest("form[data-form]");
    if (!form) return;
    event.preventDefault();
    const v = Object.fromEntries(new FormData(form).entries());
    if (form.dataset.form === "login") {
      const account = (v.account || "").trim();
      const user = state.users.find((u) => u.account === account);
      const valid = v.password === "demo123" && (isAdmin() ? account === "admin01" : user?.status === "启用");
      if (!valid) { formError(form, "账号或密码不正确、账号已停用，或不属于当前系统。"); return; }
      state.actor = isAdmin() ? "周管理员" : user.name; state.account = account; state.screen = "app"; state.page = "inventory";
      state.logSystem = "全部系统"; state.logActor = "全部操作人"; state.logQuery = "";
      log("登录系统"); render();
    } else if (form.dataset.form === "modal" && state.screen === "app") {
      const error = saveModal(v);
      if (error) { formError(form, error); return; }
      state.modal = null; render(); toast("已保存，本次演示数据已更新。");
    }
  });
  function updateControl(event) {
    const input = event.target;
    if (input.dataset.filter) { state[input.dataset.filter] = input.value; render(); return; }
    if (input.dataset.upload) { state.filename = input.files?.[0]?.name || ""; render(); return; }
    if (!state.modal || !input.closest('form[data-form="modal"]') || !input.name) return;
    state.modal.values[input.name] = input.value;
    if (input.tagName === "SELECT" && state.modal.type === "transaction" && ["productId", "locationId"].includes(input.name)) {
      const v = state.modal.values, p = findProduct(state.products, v.productId);
      if (input.name === "productId") v.locationId = p?.locations[0]?.id || "";
      v.targetLocationId = p?.locations.find((l) => l.id !== v.locationId)?.id || "";
      render();
    } else if (input.name === "cases" && state.modal.operation === "拆件") {
      const v = state.modal.values, p = findProduct(state.products, v.productId);
      const preview = root.querySelector("[data-split-preview]");
      if (preview) preview.textContent = `${Number(v.cases || 0)} 件 → 增加 ${Number(v.cases || 0) * (p?.perCase || 0)} 个散个`;
    }
  }
  root.addEventListener("input", (event) => { if (event.target.tagName !== "SELECT" && event.target.type !== "file") updateControl(event); });
  root.addEventListener("change", (event) => { if (event.target.tagName === "SELECT" || event.target.type === "file") updateControl(event); });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && (state.modal || state.mobileOpen)) { state.modal = null; state.mobileOpen = false; render(); }
    if (event.key !== "Tab" || !state.modal) return;
    const focusable = [...root.querySelectorAll('[role="dialog"] button:not([disabled]), [role="dialog"] input, [role="dialog"] select')];
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  render();
  return { getSnapshot: () => JSON.parse(JSON.stringify(state)) };
}
