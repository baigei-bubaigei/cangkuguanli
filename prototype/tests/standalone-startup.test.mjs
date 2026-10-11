import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Window } from "happy-dom";

const html = await readFile(new URL("../../仓库管理系统_双击打开.html", import.meta.url), "utf8");

function boot(t) {
  const window = new Window({
    url: "file:///E:/warehouse/preview.html",
    settings: { enableJavaScriptEvaluation: true, disableCSSFileLoading: true, disableJavaScriptFileLoading: true, suppressInsecureJavaScriptEnvironmentWarning: true },
  });
  // innerHTML leaves scripts inert; execute the actual delivered inline scripts in order.
  window.document.documentElement.innerHTML = html.slice(html.indexOf("<head>"), html.lastIndexOf("</html>"));
  const errors = [];
  window.addEventListener("error", (event) => errors.push(event.message));
  for (const script of window.document.querySelectorAll("script")) window.eval(script.textContent);
  t.after(async () => {
    await window.happyDOM.abort();
    assert.deepEqual(errors, [], "the inline bundle must not throw at runtime");
  });
  assert.ok(window.document.querySelector(".portal-choices"));
  return window;
}
function click(window, selector) {
  const element = window.document.querySelector(selector);
  assert.ok(element, `missing control: ${selector}`);
  assert.equal(element.disabled, false, `disabled control: ${selector}`);
  element.click();
}
function action(window, name, attrs = "") { click(window, `[data-action="${name}"]${attrs}`); }
function submit(window, formName, values = {}) {
  const form = window.document.querySelector(`form[data-form="${formName}"]`);
  assert.ok(form);
  for (const [name, value] of Object.entries(values)) {
    const field = form.querySelector(`[name="${name}"]`);
    assert.ok(field, `missing field: ${name}`);
    field.value = String(value);
  }
  form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
}
function login(window, system = "employee", account = system === "admin" ? "admin01" : "staff01") {
  action(window, "select-system", `[data-system="${system}"]`);
  submit(window, "login", { account, password: "demo123" });
  assert.ok(window.document.querySelector(".app-shell"), "demo login must open the system");
}
function totals(window, product = "sku-a") {
  return [...window.document.querySelectorAll(`[data-product-id="${product}"] .quantity-pair strong`)].map((x) => Number(x.firstChild.textContent));
}
function navigate(window, page) { action(window, "navigate", `[data-page="${page}"]`); }
function filter(window, name, value) {
  const control = window.document.querySelector(`[data-filter="${name}"]`);
  assert.ok(control, `missing filter: ${name}`);
  control.value = value;
  control.dispatchEvent(new window.Event(control.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
}

test("HTML contains visible entrances and no framework or external assets", (t) => {
  assert.match(html.split("<script>")[0], /进入员工系统登录/);
  assert.match(html.split("<script>")[0], /进入管理员系统登录/);
  assert.doesNotMatch(html, /\breact\b/i);
  assert.doesNotMatch(html, /<script[^>]+(?:src=|type="module")|<link[^>]+rel="stylesheet"/i);
  boot(t);
});

test("separate logins reject an employee account at the admin entrance", (t) => {
  const w = boot(t);
  action(w, "select-system", '[data-system="admin"]');
  submit(w, "login", { account: "staff01", password: "demo123" });
  assert.equal(w.document.querySelector(".app-shell"), null);
  assert.match(w.document.querySelector(".form-error").textContent, /不属于当前系统/);
  submit(w, "login", { account: "admin01", password: "demo123" });
  assert.ok(w.document.querySelector('[data-page="accounts"]'));
  assert.equal(w.document.querySelector('[data-page="initial"]'), null);
  action(w, "logout"); login(w);
  assert.equal(w.document.querySelector('[data-page="accounts"]'), null);
  assert.equal(w.document.querySelector('[data-page="import"]'), null);
  assert.equal(w.document.querySelector('[data-page="initial"]'), null);
});

test("stock operations validate quantities, move, split and share stock across portals", (t) => {
  const w = boot(t); login(w);
  assert.deepEqual(totals(w), [3, 9]);
  action(w, "transaction", '[data-operation="入库"]');
  submit(w, "modal", { cases: 2, loose: 1 });
  assert.deepEqual(totals(w), [5, 10]);
  action(w, "transaction", '[data-operation="出库"]');
  submit(w, "modal", { cases: 99, loose: 0 });
  assert.match(w.document.querySelector(".modal .form-error").textContent, /库存不足/);
  action(w, "close-modal");
  assert.deepEqual(totals(w), [5, 10]);
  action(w, "transaction", '[data-operation="移动货位"]');
  submit(w, "modal", { cases: 1, loose: 1 });
  assert.deepEqual(totals(w), [5, 10]);
  action(w, "transaction", '[data-operation="拆件"]');
  submit(w, "modal", { cases: 1 });
  assert.deepEqual(totals(w), [4, 14]);
  action(w, "expand", '[data-product="sku-a"]');
  assert.deepEqual([...w.document.querySelectorAll(".location-quantity")].map((x) => x.textContent), ["3 件 5 个", "1 件 9 个"]);
  action(w, "logout"); login(w, "admin");
  assert.deepEqual(totals(w), [4, 14]);
  navigate(w, "history");
  assert.match(w.document.querySelector(".history-table").textContent, /员工系统/);
});

test("correction reverses the old effect and preserves before and after values", (t) => {
  const w = boot(t); login(w);
  action(w, "transaction", '[data-operation="入库"]');
  submit(w, "modal", { cases: 2, loose: 0, note: "更正测试" });
  assert.deepEqual(totals(w), [5, 9]);
  navigate(w, "history"); action(w, "correction");
  submit(w, "modal", { cases: 1, loose: 0, note: "核对后更正" });
  action(w, "record-history");
  assert.match(w.document.querySelector(".audit-entry").textContent, /修改前：增加 2 件 0 个/);
  assert.match(w.document.querySelector(".audit-entry").textContent, /修改后：增加 1 件 0 个/);
  action(w, "close-modal"); navigate(w, "inventory");
  assert.deepEqual(totals(w), [4, 9]);
});

test("catalog forms preserve independent fields and escape user content", (t) => {
  const w = boot(t); login(w); navigate(w, "catalog"); action(w, "add-product");
  submit(w, "modal", { name: "<img src=x onerror=alert(1)>", spec: "新规格", category: "商品类别", categoryName: "类别名称", note: "独立备注", perCase: 4, warehouse: "三号仓库", spot: "Z01" });
  assert.match(w.document.querySelector(".catalog-table").textContent, /<img src=x onerror=alert\(1\)>/);
  assert.equal(w.document.querySelector(".catalog-table img"), null);
  const row = [...w.document.querySelectorAll(".catalog-table tbody tr")].at(-1);
  assert.match(row.textContent, /商品类别类别名称新规格4 个 \/ 件独立备注/);
  row.querySelector('[data-action="add-location"]').click();
  submit(w, "modal", { warehouse: "三号仓库", spot: "Z02" });
  assert.match([...w.document.querySelectorAll(".catalog-table tbody tr")].at(-1).textContent, /2 个/);
});

test("employee accounts can be created and disabled in the admin demo", (t) => {
  const w = boot(t); login(w, "admin"); navigate(w, "accounts"); action(w, "add-user");
  submit(w, "modal", { name: "新员工", account: "staff04" });
  assert.match(w.document.querySelector(".accounts-table").textContent, /staff04/);
  action(w, "logout"); login(w, "employee", "staff04");
  assert.match(w.document.querySelector(".user-copy").textContent, /新员工/);
  action(w, "logout"); login(w, "admin"); navigate(w, "accounts");
  action(w, "toggle-user"); action(w, "logout");
  action(w, "select-system", '[data-system="employee"]');
  submit(w, "login", { account: "staff04", password: "demo123" });
  assert.equal(w.document.querySelector(".app-shell"), null);
});

test("import requires row review and completion leaves ordinary inbound available", (t) => {
  const w = boot(t); login(w, "admin"); navigate(w, "import"); action(w, "load-preview");
  assert.equal(w.document.querySelector('[data-action="submit-import"]').disabled, true);
  for (const id of ["import-1", "import-2", "import-3"]) action(w, "review-import", `[data-row="${id}"]`);
  assert.equal(w.document.querySelector('[data-action="submit-import"]').disabled, false);
  action(w, "submit-import");
  assert.match(w.document.querySelector(".import-closed").textContent, /初始化已完成/);
  navigate(w, "inventory");
  assert.equal(w.document.querySelectorAll(".inventory-row").length, 2);
  action(w, "logout"); login(w);
  const productId = w.document.querySelector(".inventory-row").dataset.productId;
  action(w, "transaction", '[data-operation="入库"]');
  submit(w, "modal", { cases: 1, loose: 0 });
  assert.deepEqual(totals(w, productId), [4, 1]);
  action(w, "logout"); login(w, "admin"); navigate(w, "import");
  assert.match(w.document.querySelector(".import-closed").textContent, /初始化已完成/);
});

test("manual stock uses inbound and admin completion closes only the Excel import", (t) => {
  const w = boot(t); login(w);
  action(w, "transaction", '[data-operation="入库"]');
  submit(w, "modal", { cases: 2, loose: 0, note: "首次台账录入" });
  assert.deepEqual(totals(w), [5, 9]);
  action(w, "logout"); login(w, "admin"); navigate(w, "import");
  action(w, "finish-initial"); submit(w, "modal");
  assert.match(w.document.querySelector(".import-closed").textContent, /Excel 导入已关闭/);
  navigate(w, "inventory");
  assert.deepEqual(totals(w), [5, 9]);
  action(w, "transaction", '[data-operation="入库"]');
  submit(w, "modal", { cases: 1, loose: 0 });
  assert.deepEqual(totals(w), [6, 9]);
});

test("mobile menu toggles and navigation closes it", (t) => {
  const w = boot(t); login(w); action(w, "menu");
  assert.ok(w.document.querySelector(".sidebar-open"));
  navigate(w, "history"); assert.equal(w.document.querySelector(".sidebar-open"), null);
});

test("admin sees live employee operation logs and can filter them; employee sees only employee logs", (t) => {
  const w = boot(t); login(w, "employee", "staff02");
  action(w, "transaction", '[data-operation="入库"]');
  submit(w, "modal", { cases: 1, loose: 0 });
  navigate(w, "systemLogs");
  assert.doesNotMatch(w.document.querySelector(".system-log-table").textContent, /管理员系统/);
  assert.equal(w.document.querySelector('[data-filter="logSystem"]'), null);
  action(w, "logout"); login(w, "admin"); navigate(w, "systemLogs");
  const allLogs = w.document.querySelector(".system-log-table").textContent;
  assert.match(allLogs, /登记入库陈员工staff02员工系统/);
  assert.match(allLogs, /周管理员admin01管理员系统/);
  filter(w, "logSystem", "员工系统");
  assert.ok([...w.document.querySelectorAll(".system-log-table tbody tr")].every((row) => row.cells[2].textContent === "员工系统"));
  filter(w, "logActor", "陈员工");
  filter(w, "logQuery", "staff02");
  assert.ok([...w.document.querySelectorAll(".system-log-table tbody tr")].every((row) => row.cells[1].textContent === "陈员工staff02"));
  filter(w, "logQuery", "登记入库");
  assert.equal(w.document.querySelectorAll(".system-log-table tbody tr").length, 1);
  filter(w, "logQuery", "没有这条日志");
  assert.ok(w.document.querySelector(".system-log-table .empty-cell"));
  filter(w, "logQuery", ""); filter(w, "logActor", "全部操作人"); filter(w, "logSystem", "管理员系统");
  assert.ok([...w.document.querySelectorAll(".system-log-table tbody tr")].every((row) => row.cells[2].textContent === "管理员系统"));
  action(w, "logout"); login(w); navigate(w, "systemLogs");
  assert.doesNotMatch(w.document.querySelector(".system-log-table").textContent, /管理员系统/);
  assert.match(w.document.querySelector(".system-log-table").textContent, /登记入库陈员工staff02员工系统/);
});
