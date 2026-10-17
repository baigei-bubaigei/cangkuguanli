import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { hashPassword } from "../src/auth/password.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL must point to a dedicated PostgreSQL test database.");
}

const apiDirectory = fileURLToPath(new URL("..", import.meta.url));
const nextCli = fileURLToPath(new URL("../../../node_modules/next/dist/bin/next", import.meta.url));
const migrationCli = fileURLToPath(new URL("../scripts/migrate.js", import.meta.url));
const accountPrefix = `t04-test-${process.pid}-${Date.now()}`;
const password = "test-only-product-catalog-password";
let pool;
let serverProcess;
let baseUrl;
let adminAccount;
let employeeAccount;
const productNames = new Set();
const warehouseNames = new Set();

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForApi() {
  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    if (serverProcess.exitCode !== null) {
      throw new Error(`Next.js stopped before becoming ready: ${lastError ?? "no server response"}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/admin/auth/session`);
      if (response.status === 401) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Next.js did not become ready: ${lastError ?? "no server response"}`);
}

async function request(path, options = {}) {
  return fetch(`${baseUrl}${path}`, options);
}

async function login(system, account) {
  const response = await request(`/api/${system}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ account, password }),
  });
  assert.equal(response.status, 200);
  const cookieName = system === "admin" ? "admin_session" : "employee_session";
  const setCookie = response.headers.getSetCookie().find((value) => value.startsWith(`${cookieName}=`));
  assert.ok(setCookie, `login response should set ${cookieName}`);
  return setCookie.split(";", 1)[0];
}

function requestProduct(method, product, cookie) {
  return request("/api/catalog/products", {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(product ? { "Content-Type": "application/json" } : {}),
    },
    ...(product ? { body: JSON.stringify(product) } : {}),
  });
}

function requestLocation(location, cookie) {
  return request("/api/catalog/products/locations", {
    method: "POST",
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(location ? { "Content-Type": "application/json" } : {}),
    },
    ...(location ? { body: JSON.stringify(location) } : {}),
  });
}

function visibleFields(products) {
  return products.map(({ name, category, categoryName, spec, perCase, note, warehouse, spot }) => ({
    name, category, categoryName, spec, perCase, note, warehouse, spot,
  }));
}

before(async () => {
  const migrations = spawnSync(process.execPath, [migrationCli], {
    cwd: apiDirectory,
    env: { ...process.env, DATABASE_URL: testDatabaseUrl },
    encoding: "utf8",
  });
  if (migrations.status !== 0) {
    throw new Error(`PostgreSQL migrations failed: ${migrations.stderr || migrations.stdout}`);
  }

  pool = new Pool({ connectionString: testDatabaseUrl });
  adminAccount = `${accountPrefix}-admin`;
  employeeAccount = `${accountPrefix}-employee`;
  const passwordHash = await hashPassword(password);
  await pool.query(
    `INSERT INTO admin_accounts (account, display_name, password_hash)
     VALUES ($1, $2, $3)`,
    [adminAccount, "规格测试管理员", passwordHash],
  );
  await pool.query(
    `INSERT INTO employee_accounts (account, display_name, password_hash)
     VALUES ($1, $2, $3)`,
    [employeeAccount, "规格测试员工", passwordHash],
  );

  const port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(
    process.execPath,
    [nextCli, "dev", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: apiDirectory,
      env: { ...process.env, DATABASE_URL: testDatabaseUrl },
      stdio: "ignore",
      windowsHide: true,
    },
  );
  await waitForApi();
});

after(async () => {
  if (serverProcess && serverProcess.exitCode === null) serverProcess.kill();
  if (pool) {
    await pool.query("DELETE FROM product_specs WHERE product_name = ANY($1::text[])", [[...productNames]]);
    await pool.query("DELETE FROM locations WHERE warehouse_id IN (SELECT id FROM warehouses WHERE name = ANY($1::text[]))", [[...warehouseNames]]);
    await pool.query("DELETE FROM warehouses WHERE name = ANY($1::text[])", [[...warehouseNames]]);
    await pool.query("DELETE FROM admin_accounts WHERE account = $1", [adminAccount]);
    await pool.query("DELETE FROM employee_accounts WHERE account = $1", [employeeAccount]);
    await pool.end();
  }
});

test("admin and employee create and query the same persisted product specifications", async () => {
  const anonymousRead = await request("/api/catalog/products");
  assert.equal(anonymousRead.status, 401);
  const anonymousWrite = await requestProduct("POST", {
    name: "未授权商品", spec: "规格", perCase: 2, warehouse: "仓库", spot: "货位",
  });
  assert.equal(anonymousWrite.status, 401);

  const adminCookie = await login("admin", adminAccount);
  const employeeCookie = await login("employee", employeeAccount);
  const firstProduct = {
    name: `${accountPrefix} 同步商品`,
    category: "类别甲",
    categoryName: "分类名称甲",
    spec: "四个一件",
    perCase: 4,
    note: "备注甲",
    warehouse: `${accountPrefix} 仓库甲`,
    spot: "货位甲",
  };
  productNames.add(firstProduct.name);
  warehouseNames.add(firstProduct.warehouse);
  const createdByAdmin = await requestProduct("POST", firstProduct, adminCookie);
  assert.equal(createdByAdmin.status, 201);
  const adminCreatedProduct = await createdByAdmin.json();
  assert.deepEqual(visibleFields([adminCreatedProduct]), [firstProduct]);
  assert.match(adminCreatedProduct.id, /^\d+$/);
  assert.match(adminCreatedProduct.locationId, /^\d+$/);

  const afterRefresh = await requestProduct("GET", undefined, employeeCookie);
  assert.equal(afterRefresh.status, 200);
  const employeeProducts = await afterRefresh.json();
  assert.deepEqual(visibleFields(employeeProducts), [firstProduct]);
  assert.equal(employeeProducts[0].id, adminCreatedProduct.id);
  assert.equal(employeeProducts[0].locationId, adminCreatedProduct.locationId);

  const secondProduct = {
    name: `${accountPrefix} 同步商品`,
    category: "类别乙",
    categoryName: "分类名称乙",
    spec: "四个一件",
    perCase: 2,
    note: "备注乙",
    warehouse: `${accountPrefix} 仓库乙`,
    spot: "货位乙",
  };
  warehouseNames.add(secondProduct.warehouse);
  const createdByEmployee = await requestProduct("POST", secondProduct, employeeCookie);
  assert.equal(createdByEmployee.status, 201);
  assert.deepEqual(visibleFields([await createdByEmployee.json()]), [secondProduct]);

  const adminSeesBoth = await requestProduct("GET", undefined, adminCookie);
  assert.equal(adminSeesBoth.status, 200);
  assert.deepEqual(visibleFields(await adminSeesBoth.json()), [firstProduct, secondProduct]);
});

test("blank category fields remain separate and item count is limited to 2, 4, or 6", async () => {
  const employeeCookie = await login("employee", employeeAccount);
  const blankCategories = {
    name: `${accountPrefix} 空分类商品`,
    category: "",
    categoryName: "",
    spec: "六个一件",
    perCase: 6,
    note: "",
    warehouse: `${accountPrefix} 空分类仓库`,
    spot: "货位",
  };
  productNames.add(blankCategories.name);
  warehouseNames.add(blankCategories.warehouse);
  const created = await requestProduct("POST", blankCategories, employeeCookie);
  assert.equal(created.status, 201);
  assert.deepEqual(visibleFields([await created.json()]), [blankCategories]);

  const invalidCount = await requestProduct("POST", { ...blankCategories, perCase: 3 }, employeeCookie);
  assert.equal(invalidCount.status, 400);
  assert.deepEqual(visibleFields(await (await requestProduct("GET", undefined, employeeCookie)).json()), [
    {
      name: `${accountPrefix} 同步商品`, category: "类别甲", categoryName: "分类名称甲", spec: "四个一件", perCase: 4,
      note: "备注甲", warehouse: `${accountPrefix} 仓库甲`, spot: "货位甲",
    },
    {
      name: `${accountPrefix} 同步商品`, category: "类别乙", categoryName: "分类名称乙", spec: "四个一件", perCase: 2,
      note: "备注乙", warehouse: `${accountPrefix} 仓库乙`, spot: "货位乙",
    },
    blankCategories,
  ]);
});

test("admin and employee add persisted zero-stock locations to existing specifications", async () => {
  const adminCookie = await login("admin", adminAccount);
  const employeeCookie = await login("employee", employeeAccount);
  const product = {
    name: `${accountPrefix} 货位测试商品`,
    category: "类别",
    categoryName: "类别名称",
    spec: "四个一件",
    perCase: 4,
    note: "",
    warehouse: `${accountPrefix} 原仓库`,
    spot: "原货位",
  };
  productNames.add(product.name);
  warehouseNames.add(product.warehouse);
  const createdProductResponse = await requestProduct("POST", product, adminCookie);
  assert.equal(createdProductResponse.status, 201);
  const createdProduct = await createdProductResponse.json();

  const employeeLocation = {
    productSpecId: createdProduct.id,
    warehouse: `${accountPrefix} 新仓库甲`,
    spot: "新增货位甲",
  };
  warehouseNames.add(employeeLocation.warehouse);
  const employeeAddedLocationResponse = await requestLocation(employeeLocation, employeeCookie);
  assert.equal(employeeAddedLocationResponse.status, 201);
  const employeeAddedLocation = await employeeAddedLocationResponse.json();
  assert.deepEqual(
    { warehouse: employeeAddedLocation.warehouse, spot: employeeAddedLocation.spot, cases: employeeAddedLocation.cases, loose: employeeAddedLocation.loose },
    { warehouse: employeeLocation.warehouse, spot: employeeLocation.spot, cases: 0, loose: 0 },
  );

  const adminLocation = {
    productSpecId: createdProduct.id,
    warehouse: `${accountPrefix} 新仓库乙`,
    spot: "新增货位乙",
  };
  warehouseNames.add(adminLocation.warehouse);
  const adminAddedLocationResponse = await requestLocation(adminLocation, adminCookie);
  assert.equal(adminAddedLocationResponse.status, 201);
  const adminAddedLocation = await adminAddedLocationResponse.json();
  assert.equal(adminAddedLocation.cases, 0);
  assert.equal(adminAddedLocation.loose, 0);

  const employeeSeesLocations = await requestProduct("GET", undefined, employeeCookie);
  assert.equal(employeeSeesLocations.status, 200);
  const employeeCatalog = await employeeSeesLocations.json();
  assert.deepEqual(
    employeeCatalog.filter((item) => item.id === createdProduct.id).map(({ warehouse, spot, cases, loose }) => ({ warehouse, spot, cases, loose })),
    [
      { warehouse: product.warehouse, spot: product.spot, cases: 0, loose: 0 },
      { warehouse: employeeLocation.warehouse, spot: employeeLocation.spot, cases: 0, loose: 0 },
      { warehouse: adminLocation.warehouse, spot: adminLocation.spot, cases: 0, loose: 0 },
    ],
  );

  const duplicateLocationResponse = await requestLocation({ ...employeeLocation, spot: employeeLocation.spot.toLowerCase() }, adminCookie);
  assert.equal(duplicateLocationResponse.status, 409);

  const missingProductResponse = await requestLocation({ ...employeeLocation, productSpecId: "9223372036854775807" }, adminCookie);
  assert.equal(missingProductResponse.status, 404);
});
