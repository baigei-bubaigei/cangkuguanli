import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
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
const accountPrefix = "t06-test-" + process.pid + "-" + Date.now();
const password = "test-only-inventory-query-password";
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
      throw new Error("Next.js stopped before becoming ready: " + (lastError ?? "no server response"));
    }
    try {
      const response = await fetch(baseUrl + "/api/admin/auth/session");
      if (response.status === 401) return;
      lastError = "HTTP " + response.status;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Next.js did not become ready: " + (lastError ?? "no server response"));
}

async function request(path, options = {}) {
  return fetch(baseUrl + path, options);
}

async function login(system, account) {
  const response = await request("/api/" + system + "/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ account, password }),
  });
  assert.equal(response.status, 200);
  const cookieName = system === "admin" ? "admin_session" : "employee_session";
  const setCookie = response.headers.getSetCookie().find((value) => value.startsWith(cookieName + "="));
  assert.ok(setCookie, "login response should set " + cookieName);
  return setCookie.split(";", 1)[0];
}

function requestInventory(cookie) {
  return request("/api/inventory", {
    headers: cookie ? { Cookie: cookie } : {},
  });
}

function requestProduct(product, cookie) {
  return request("/api/catalog/products", {
    method: "POST",
    headers: {
      Cookie: cookie,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(product),
  });
}

function requestLocation(location, cookie) {
  return request("/api/catalog/products/locations", {
    method: "POST",
    headers: {
      Cookie: cookie,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(location),
  });
}

function requestInbound(transaction, cookie) {
  return request("/api/inventory/inbound", {
    method: "POST",
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      "Content-Type": "application/json",
      "Idempotency-Key": randomBytes(16).toString("hex"),
    },
    body: JSON.stringify(transaction),
  });
}

function requestOutbound(transaction, cookie) {
  return request("/api/inventory/outbound", {
    method: "POST",
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      "Content-Type": "application/json",
      "Idempotency-Key": randomBytes(16).toString("hex"),
    },
    body: JSON.stringify(transaction),
  });
}

function requestSplit(transaction, cookie) {
  return request("/api/inventory/split", {
    method: "POST",
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      "Content-Type": "application/json",
      "Idempotency-Key": randomBytes(16).toString("hex"),
    },
    body: JSON.stringify(transaction),
  });
}

function requestMove(transaction, cookie) {
  return request("/api/inventory/move", {
    method: "POST",
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      "Content-Type": "application/json",
      "Idempotency-Key": randomBytes(16).toString("hex"),
    },
    body: JSON.stringify(transaction),
  });
}

before(async () => {
  const migrations = spawnSync(process.execPath, [migrationCli], {
    cwd: apiDirectory,
    env: { ...process.env, DATABASE_URL: testDatabaseUrl },
    encoding: "utf8",
  });
  if (migrations.status !== 0) {
    throw new Error("PostgreSQL migrations failed: " + (migrations.stderr || migrations.stdout));
  }

  pool = new Pool({ connectionString: testDatabaseUrl });
  adminAccount = accountPrefix + "-admin";
  employeeAccount = accountPrefix + "-employee";
  const passwordHash = await hashPassword(password);
  await pool.query(
    "INSERT INTO admin_accounts (account, display_name, password_hash)\n     VALUES ($1, $2, $3)",
    [adminAccount, "库存查询测试管理员", passwordHash],
  );
  await pool.query(
    "INSERT INTO employee_accounts (account, display_name, password_hash)\n     VALUES ($1, $2, $3)",
    [employeeAccount, "库存查询测试员工", passwordHash],
  );

  const port = await availablePort();
  baseUrl = "http://127.0.0.1:" + port;
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
    await pool.query(
      `DELETE FROM inventory_transactions
        WHERE product_spec_id IN (
          SELECT id FROM product_specs WHERE product_name = ANY($1::text[])
        )`,
      [[...productNames]],
    );
    await pool.query("DELETE FROM product_specs WHERE product_name = ANY($1::text[])", [[...productNames]]);
    await pool.query(
      "DELETE FROM locations WHERE warehouse_id IN (SELECT id FROM warehouses WHERE name = ANY($1::text[]))",
      [[...warehouseNames]],
    );
    await pool.query("DELETE FROM warehouses WHERE name = ANY($1::text[])", [[...warehouseNames]]);
    await pool.query(
      `DELETE FROM system_operation_logs
        WHERE actor_admin_account_id = (SELECT id FROM admin_accounts WHERE account = $1)
           OR actor_employee_account_id = (SELECT id FROM employee_accounts WHERE account = $2)`,
      [adminAccount, employeeAccount],
    );
    await pool.query("DELETE FROM admin_accounts WHERE account = $1", [adminAccount]);
    await pool.query("DELETE FROM employee_accounts WHERE account = $1", [employeeAccount]);
    await pool.end();
  }
});

test("inventory API preserves empty and zero states and shares cross-location totals", async () => {
  const anonymous = await requestInventory();
  assert.equal(anonymous.status, 401);

  const adminCookie = await login("admin", adminAccount);
  const employeeCookie = await login("employee", employeeAccount);
  const emptyAdminResponse = await requestInventory(adminCookie);
  assert.equal(emptyAdminResponse.status, 200);
  const emptyInventory = await emptyAdminResponse.json();
  assert.deepEqual(emptyInventory, { warehouses: [], products: [] });
  const emptyEmployeeResponse = await requestInventory(employeeCookie);
  assert.equal(emptyEmployeeResponse.status, 200);
  assert.deepEqual(await emptyEmployeeResponse.json(), emptyInventory);

  const product = {
    name: accountPrefix + " 跨仓库存",
    category: "木制品",
    categoryName: "家具",
    spec: "四个一件",
    perCase: 4,
    note: "",
    warehouse: accountPrefix + " 仓库 A",
    spot: "A 位",
  };
  productNames.add(product.name);
  warehouseNames.add(product.warehouse);
  const createdResponse = await requestProduct(product, adminCookie);
  assert.equal(createdResponse.status, 201);
  const createdProduct = await createdResponse.json();

  const secondLocation = {
    productSpecId: createdProduct.id,
    warehouse: accountPrefix + " 仓库 B",
    spot: "B 位",
  };
  warehouseNames.add(secondLocation.warehouse);
  const secondLocationResponse = await requestLocation(secondLocation, employeeCookie);
  assert.equal(secondLocationResponse.status, 201);
  const createdSecondLocation = await secondLocationResponse.json();

  const zeroProduct = {
    name: accountPrefix + " 零库存",
    category: "木制品",
    categoryName: "家具",
    spec: "两个一件",
    perCase: 2,
    note: "",
    warehouse: accountPrefix + " 仓库 C",
    spot: "C 位",
  };
  productNames.add(zeroProduct.name);
  warehouseNames.add(zeroProduct.warehouse);
  const zeroProductResponse = await requestProduct(zeroProduct, employeeCookie);
  assert.equal(zeroProductResponse.status, 201);
  const createdZeroProduct = await zeroProductResponse.json();

  await pool.query(
    "UPDATE product_spec_locations\n        SET case_count = 3, loose_count = 1\n      WHERE product_spec_id = $1 AND location_id = $2",
    [createdProduct.id, createdProduct.locationId],
  );
  await pool.query(
    "UPDATE product_spec_locations\n        SET case_count = 0, loose_count = 8\n      WHERE product_spec_id = $1 AND location_id = $2",
    [createdProduct.id, createdSecondLocation.locationId],
  );

  const adminResponse = await requestInventory(adminCookie);
  assert.equal(adminResponse.status, 200);
  const adminInventory = await adminResponse.json();
  const employeeResponse = await requestInventory(employeeCookie);
  assert.equal(employeeResponse.status, 200);
  const employeeInventory = await employeeResponse.json();
  assert.deepEqual(employeeInventory, adminInventory);

  const expectedWarehouses = [product.warehouse, secondLocation.warehouse, zeroProduct.warehouse];
  assert.equal(adminInventory.warehouses.length, expectedWarehouses.length);
  for (const name of expectedWarehouses) assert.ok(adminInventory.warehouses.includes(name));

  const crossWarehouseSummary = adminInventory.products.find((item) => item.id === createdProduct.id);
  assert.deepEqual({
    name: crossWarehouseSummary.name,
    category: crossWarehouseSummary.category,
    categoryName: crossWarehouseSummary.categoryName,
    spec: crossWarehouseSummary.spec,
    perCase: crossWarehouseSummary.perCase,
    totalCases: crossWarehouseSummary.totalCases,
    totalLoose: crossWarehouseSummary.totalLoose,
    locations: crossWarehouseSummary.locations.map((location) => ({
      id: location.id,
      warehouse: location.warehouse,
      spot: location.spot,
      cases: location.cases,
      loose: location.loose,
    })),
  }, {
    name: product.name,
    category: product.category,
    categoryName: product.categoryName,
    spec: product.spec,
    perCase: product.perCase,
    totalCases: 3,
    totalLoose: 9,
    locations: [
      {
        id: createdProduct.locationId,
        warehouse: product.warehouse,
        spot: product.spot,
        cases: 3,
        loose: 1,
      },
      {
        id: createdSecondLocation.locationId,
        warehouse: secondLocation.warehouse,
        spot: secondLocation.spot,
        cases: 0,
        loose: 8,
      },
    ],
  });

  const zeroSummary = adminInventory.products.find((item) => item.id === createdZeroProduct.id);
  assert.equal(zeroSummary.totalCases, 0);
  assert.equal(zeroSummary.totalLoose, 0);
  assert.deepEqual(zeroSummary.locations.map(({ cases, loose }) => ({ cases, loose })), [
    { cases: 0, loose: 0 },
  ]);
});

test("admin and employee inbound transactions save inventory and account context", async () => {
  const adminCookie = await login("admin", adminAccount);
  const employeeCookie = await login("employee", employeeAccount);
  const product = {
    name: accountPrefix + " 入库测试",
    category: "木制品",
    categoryName: "家具",
    spec: "四个一件",
    perCase: 4,
    note: "",
    warehouse: accountPrefix + " 入库仓库 A",
    spot: "A 位",
  };
  productNames.add(product.name);
  warehouseNames.add(product.warehouse);
  const createdResponse = await requestProduct(product, adminCookie);
  assert.equal(createdResponse.status, 201);
  const createdProduct = await createdResponse.json();

  const otherProduct = { ...product, name: accountPrefix + " 另一规格", warehouse: accountPrefix + " 入库仓库 B" };
  productNames.add(otherProduct.name);
  warehouseNames.add(otherProduct.warehouse);
  const otherProductResponse = await requestProduct(otherProduct, employeeCookie);
  assert.equal(otherProductResponse.status, 201);
  const otherCreatedProduct = await otherProductResponse.json();

  const basePayload = {
    productSpecId: createdProduct.id,
    locationId: createdProduct.locationId,
    cases: 2,
    loose: 3,
    actualOccurredAt: "2026-10-12T07:00:00.000Z",
  };
  const anonymousResponse = await requestInbound(basePayload);
  assert.equal(anonymousResponse.status, 401);

  const invalidPayloads = [
    { ...basePayload, cases: 0, loose: 0 },
    { ...basePayload, cases: -1 },
    { ...basePayload, loose: 1.5 },
    { ...basePayload, actualOccurredAt: "不是实际时间" },
  ];
  for (const payload of invalidPayloads) {
    const response = await requestInbound(payload, employeeCookie);
    assert.equal(response.status, 400);
  }

  const wrongLocationResponse = await requestInbound({
    ...basePayload,
    locationId: otherCreatedProduct.locationId,
  }, adminCookie);
  assert.equal(wrongLocationResponse.status, 404);

  const noPartialTransactions = await pool.query(
    `SELECT COUNT(*)::INTEGER AS count
       FROM inventory_transactions
      WHERE product_spec_id = $1`,
    [createdProduct.id],
  );
  assert.equal(noPartialTransactions.rows[0].count, 0);

  const overflowProduct = { ...product, name: accountPrefix + " 整数上限", warehouse: accountPrefix + " 入库仓库 C" };
  productNames.add(overflowProduct.name);
  warehouseNames.add(overflowProduct.warehouse);
  const overflowProductResponse = await requestProduct(overflowProduct, adminCookie);
  assert.equal(overflowProductResponse.status, 201);
  const overflowCreatedProduct = await overflowProductResponse.json();
  await pool.query(
    `UPDATE product_spec_locations
        SET case_count = 2147483647
      WHERE product_spec_id = $1 AND location_id = $2`,
    [overflowCreatedProduct.id, overflowCreatedProduct.locationId],
  );

  const failedSaveResponse = await requestInbound({
    productSpecId: overflowCreatedProduct.id,
    locationId: overflowCreatedProduct.locationId,
    cases: 1,
    loose: 0,
    actualOccurredAt: basePayload.actualOccurredAt,
  }, employeeCookie);
  assert.equal(failedSaveResponse.status, 500);
  const failedInventory = await pool.query(
    `SELECT case_count, loose_count
       FROM product_spec_locations
      WHERE product_spec_id = $1 AND location_id = $2`,
    [overflowCreatedProduct.id, overflowCreatedProduct.locationId],
  );
  assert.deepEqual(failedInventory.rows[0], { case_count: 2147483647, loose_count: 0 });
  const failedTransaction = await pool.query(
    "SELECT COUNT(*)::INTEGER AS count FROM inventory_transactions WHERE product_spec_id = $1",
    [overflowCreatedProduct.id],
  );
  assert.equal(failedTransaction.rows[0].count, 0);

  const employeeOccurredAt = "2026-10-12T07:00:00.000Z";
  const employeeInboundResponse = await requestInbound({
    ...basePayload,
    actualOccurredAt: employeeOccurredAt,
  }, employeeCookie);
  assert.equal(employeeInboundResponse.status, 201);
  const employeeInbound = await employeeInboundResponse.json();
  assert.deepEqual({
    operationType: employeeInbound.operationType,
    productSpecId: employeeInbound.productSpecId,
    locationId: employeeInbound.locationId,
    cases: employeeInbound.cases,
    loose: employeeInbound.loose,
    actualOccurredAt: employeeInbound.actualOccurredAt,
    actorAccount: employeeInbound.actorAccount,
    sourceSystem: employeeInbound.sourceSystem,
    locationCases: employeeInbound.locationCases,
    locationLoose: employeeInbound.locationLoose,
  }, {
    operationType: "inbound",
    productSpecId: createdProduct.id,
    locationId: createdProduct.locationId,
    cases: 2,
    loose: 3,
    actualOccurredAt: employeeOccurredAt,
    actorAccount: employeeAccount,
    sourceSystem: "employee",
    locationCases: 2,
    locationLoose: 3,
  });

  const adminOccurredAt = "2026-10-12T07:05:00.000Z";
  const adminInboundResponse = await requestInbound({
    ...basePayload,
    cases: 1,
    loose: 0,
    actualOccurredAt: adminOccurredAt,
  }, adminCookie);
  assert.equal(adminInboundResponse.status, 201);
  assert.deepEqual(await adminInboundResponse.json(), {
    transactionId: (await pool.query(
      `SELECT id FROM inventory_transactions
        WHERE product_spec_id = $1 AND source_system = 'admin'`,
      [createdProduct.id],
    )).rows[0]?.id?.toString(),
    operationType: "inbound",
    productSpecId: createdProduct.id,
    locationId: createdProduct.locationId,
    cases: 1,
    loose: 0,
    actualOccurredAt: adminOccurredAt,
    recordedAt: (await pool.query(
      `SELECT recorded_at FROM inventory_transactions
        WHERE product_spec_id = $1 AND source_system = 'admin'`,
      [createdProduct.id],
    )).rows[0]?.recorded_at?.toISOString(),
    actorAccount: adminAccount,
    sourceSystem: "admin",
    locationCases: 3,
    locationLoose: 3,
  });

  const adminInventoryResponse = await requestInventory(adminCookie);
  const employeeInventoryResponse = await requestInventory(employeeCookie);
  assert.equal(adminInventoryResponse.status, 200);
  assert.equal(employeeInventoryResponse.status, 200);
  const adminInventory = await adminInventoryResponse.json();
  const employeeInventory = await employeeInventoryResponse.json();
  assert.deepEqual(employeeInventory, adminInventory);
  const savedProduct = adminInventory.products.find((item) => item.id === createdProduct.id);
  assert.equal(savedProduct.totalCases, 3);
  assert.equal(savedProduct.totalLoose, 3);
  assert.deepEqual(savedProduct.locations.map(({ cases, loose }) => ({ cases, loose })), [
    { cases: 3, loose: 3 },
  ]);

  const transactionRows = await pool.query(
    `SELECT operation_type, case_count, loose_count, actual_occurred_at,
            actor_account, source_system, recorded_at
       FROM inventory_transactions
      WHERE product_spec_id = $1
      ORDER BY id`,
    [createdProduct.id],
  );
  assert.deepEqual(transactionRows.rows.map((row) => ({
    operationType: row.operation_type,
    cases: row.case_count,
    loose: row.loose_count,
    actualOccurredAt: row.actual_occurred_at.toISOString(),
    actorAccount: row.actor_account,
    sourceSystem: row.source_system,
    recordedAtIsPresent: row.recorded_at instanceof Date,
  })), [
    {
      operationType: "inbound",
      cases: 2,
      loose: 3,
      actualOccurredAt: employeeOccurredAt,
      actorAccount: employeeAccount,
      sourceSystem: "employee",
      recordedAtIsPresent: true,
    },
    {
      operationType: "inbound",
      cases: 1,
      loose: 0,
      actualOccurredAt: adminOccurredAt,
      actorAccount: adminAccount,
      sourceSystem: "admin",
      recordedAtIsPresent: true,
    },
  ]);
});

test("admin and employee outbound transactions reject shortages and save shared stock changes", async () => {
  const adminCookie = await login("admin", adminAccount);
  const employeeCookie = await login("employee", employeeAccount);
  const product = {
    name: accountPrefix + " 出库测试",
    category: "木制品",
    categoryName: "家具",
    spec: "四个一件",
    perCase: 4,
    note: "",
    warehouse: accountPrefix + " 出库仓库 A",
    spot: "A 位",
  };
  productNames.add(product.name);
  warehouseNames.add(product.warehouse);
  const createdResponse = await requestProduct(product, adminCookie);
  assert.equal(createdResponse.status, 201);
  const createdProduct = await createdResponse.json();

  const otherProduct = {
    ...product,
    name: accountPrefix + " 出库其他规格",
    warehouse: accountPrefix + " 出库仓库 B",
  };
  productNames.add(otherProduct.name);
  warehouseNames.add(otherProduct.warehouse);
  const otherProductResponse = await requestProduct(otherProduct, employeeCookie);
  assert.equal(otherProductResponse.status, 201);
  const otherCreatedProduct = await otherProductResponse.json();

  await pool.query(
    `UPDATE product_spec_locations
        SET case_count = 2, loose_count = 5
      WHERE product_spec_id = $1 AND location_id = $2`,
    [createdProduct.id, createdProduct.locationId],
  );

  const basePayload = {
    productSpecId: createdProduct.id,
    locationId: createdProduct.locationId,
    cases: 1,
    loose: 2,
    actualOccurredAt: "2026-10-12T07:00:00.000Z",
  };
  const anonymousResponse = await requestOutbound(basePayload);
  assert.equal(anonymousResponse.status, 401);

  const invalidPayloads = [
    { ...basePayload, cases: 0, loose: 0 },
    { ...basePayload, cases: -1 },
    { ...basePayload, loose: 1.5 },
    { ...basePayload, actualOccurredAt: "不是实际时间" },
  ];
  for (const payload of invalidPayloads) {
    const response = await requestOutbound(payload, employeeCookie);
    assert.equal(response.status, 400);
  }

  const wrongLocationResponse = await requestOutbound({
    ...basePayload,
    locationId: otherCreatedProduct.locationId,
  }, adminCookie);
  assert.equal(wrongLocationResponse.status, 404);

  for (const payload of [
    { ...basePayload, cases: 3, loose: 0 },
    { ...basePayload, cases: 0, loose: 6 },
  ]) {
    const response = await requestOutbound(payload, employeeCookie);
    assert.equal(response.status, 409);
  }

  const rejectedStock = await pool.query(
    `SELECT case_count, loose_count
       FROM product_spec_locations
      WHERE product_spec_id = $1 AND location_id = $2`,
    [createdProduct.id, createdProduct.locationId],
  );
  assert.deepEqual(rejectedStock.rows[0], { case_count: 2, loose_count: 5 });
  const rejectedTransactions = await pool.query(
    "SELECT COUNT(*)::INTEGER AS count FROM inventory_transactions WHERE product_spec_id = $1",
    [createdProduct.id],
  );
  assert.equal(rejectedTransactions.rows[0].count, 0);

  const employeeOccurredAt = "2026-10-12T07:00:00.000Z";
  const employeeResponse = await requestOutbound({
    ...basePayload,
    actualOccurredAt: employeeOccurredAt,
  }, employeeCookie);
  assert.equal(employeeResponse.status, 201);
  const employeeOutbound = await employeeResponse.json();
  assert.deepEqual({
    operationType: employeeOutbound.operationType,
    productSpecId: employeeOutbound.productSpecId,
    locationId: employeeOutbound.locationId,
    cases: employeeOutbound.cases,
    loose: employeeOutbound.loose,
    actualOccurredAt: employeeOutbound.actualOccurredAt,
    actorAccount: employeeOutbound.actorAccount,
    sourceSystem: employeeOutbound.sourceSystem,
    locationCases: employeeOutbound.locationCases,
    locationLoose: employeeOutbound.locationLoose,
  }, {
    operationType: "outbound",
    productSpecId: createdProduct.id,
    locationId: createdProduct.locationId,
    cases: 1,
    loose: 2,
    actualOccurredAt: employeeOccurredAt,
    actorAccount: employeeAccount,
    sourceSystem: "employee",
    locationCases: 1,
    locationLoose: 3,
  });

  const adminOccurredAt = "2026-10-12T07:05:00.000Z";
  const adminResponse = await requestOutbound({
    ...basePayload,
    cases: 0,
    loose: 1,
    actualOccurredAt: adminOccurredAt,
  }, adminCookie);
  assert.equal(adminResponse.status, 201);
  const adminOutbound = await adminResponse.json();
  assert.deepEqual({
    operationType: adminOutbound.operationType,
    cases: adminOutbound.cases,
    loose: adminOutbound.loose,
    actualOccurredAt: adminOutbound.actualOccurredAt,
    actorAccount: adminOutbound.actorAccount,
    sourceSystem: adminOutbound.sourceSystem,
    locationCases: adminOutbound.locationCases,
    locationLoose: adminOutbound.locationLoose,
  }, {
    operationType: "outbound",
    cases: 0,
    loose: 1,
    actualOccurredAt: adminOccurredAt,
    actorAccount: adminAccount,
    sourceSystem: "admin",
    locationCases: 1,
    locationLoose: 2,
  });

  const concurrentResponses = await Promise.all([
    requestOutbound({ ...basePayload, cases: 1, loose: 0 }, adminCookie),
    requestOutbound({ ...basePayload, cases: 1, loose: 0 }, employeeCookie),
  ]);
  assert.deepEqual(concurrentResponses.map((response) => response.status).sort(), [201, 409]);

  const adminInventoryResponse = await requestInventory(adminCookie);
  const employeeInventoryResponse = await requestInventory(employeeCookie);
  assert.equal(adminInventoryResponse.status, 200);
  assert.equal(employeeInventoryResponse.status, 200);
  const adminInventory = await adminInventoryResponse.json();
  const employeeInventory = await employeeInventoryResponse.json();
  assert.deepEqual(employeeInventory, adminInventory);
  const savedProduct = adminInventory.products.find((item) => item.id === createdProduct.id);
  assert.equal(savedProduct.totalCases, 0);
  assert.equal(savedProduct.totalLoose, 2);
  assert.deepEqual(savedProduct.locations.map(({ cases, loose }) => ({ cases, loose })), [
    { cases: 0, loose: 2 },
  ]);

  const transactionRows = await pool.query(
    `SELECT operation_type, case_count, loose_count, actual_occurred_at,
            actor_account, source_system, recorded_at
       FROM inventory_transactions
      WHERE product_spec_id = $1
      ORDER BY id`,
    [createdProduct.id],
  );
  assert.equal(transactionRows.rowCount, 3);
  assert.deepEqual(transactionRows.rows.slice(0, 2).map((row) => ({
    operationType: row.operation_type,
    cases: row.case_count,
    loose: row.loose_count,
    actualOccurredAt: row.actual_occurred_at.toISOString(),
    actorAccount: row.actor_account,
    sourceSystem: row.source_system,
    recordedAtIsPresent: row.recorded_at instanceof Date,
  })), [
    {
      operationType: "outbound",
      cases: 1,
      loose: 2,
      actualOccurredAt: employeeOccurredAt,
      actorAccount: employeeAccount,
      sourceSystem: "employee",
      recordedAtIsPresent: true,
    },
    {
      operationType: "outbound",
      cases: 0,
      loose: 1,
      actualOccurredAt: adminOccurredAt,
      actorAccount: adminAccount,
      sourceSystem: "admin",
      recordedAtIsPresent: true,
    },
  ]);
  assert.equal(transactionRows.rows[2].operation_type, "outbound");
  assert.equal(transactionRows.rows[2].case_count, 1);
  assert.equal(transactionRows.rows[2].loose_count, 0);
});

test("admin and employee split cases using the saved per-case quantity", async () => {
  const adminCookie = await login("admin", adminAccount);
  const employeeCookie = await login("employee", employeeAccount);
  const product = {
    name: accountPrefix + " 拆件测试",
    category: "木制品",
    categoryName: "家具",
    spec: "六个一件",
    perCase: 6,
    note: "",
    warehouse: accountPrefix + " 拆件仓库 A",
    spot: "A 位",
  };
  productNames.add(product.name);
  warehouseNames.add(product.warehouse);
  const createdResponse = await requestProduct(product, adminCookie);
  assert.equal(createdResponse.status, 201);
  const createdProduct = await createdResponse.json();

  const otherProduct = {
    ...product,
    name: accountPrefix + " 拆件其他规格",
    warehouse: accountPrefix + " 拆件仓库 B",
  };
  productNames.add(otherProduct.name);
  warehouseNames.add(otherProduct.warehouse);
  const otherProductResponse = await requestProduct(otherProduct, employeeCookie);
  assert.equal(otherProductResponse.status, 201);
  const otherCreatedProduct = await otherProductResponse.json();

  await pool.query(
    `UPDATE product_spec_locations
        SET case_count = 2, loose_count = 1
      WHERE product_spec_id = $1 AND location_id = $2`,
    [createdProduct.id, createdProduct.locationId],
  );

  const basePayload = {
    productSpecId: createdProduct.id,
    locationId: createdProduct.locationId,
    cases: 1,
    actualOccurredAt: "2026-10-12T08:00:00.000Z",
  };
  const anonymousResponse = await requestSplit(basePayload);
  assert.equal(anonymousResponse.status, 401);

  const invalidPayloads = [
    { ...basePayload, cases: 0 },
    { ...basePayload, cases: -1 },
    { ...basePayload, cases: 1.5 },
    { ...basePayload, actualOccurredAt: "不是实际时间" },
  ];
  for (const payload of invalidPayloads) {
    const response = await requestSplit(payload, employeeCookie);
    assert.equal(response.status, 400);
  }

  const wrongLocationResponse = await requestSplit({
    ...basePayload,
    locationId: otherCreatedProduct.locationId,
  }, adminCookie);
  assert.equal(wrongLocationResponse.status, 404);

  const shortageResponse = await requestSplit({ ...basePayload, cases: 3 }, employeeCookie);
  assert.equal(shortageResponse.status, 409);
  assert.deepEqual(await shortageResponse.json(), {
    error: "可拆整件不足，当前有 2 件、1 个。",
    availableCases: 2,
    availableLoose: 1,
  });
  const unchangedStock = await pool.query(
    `SELECT case_count, loose_count
       FROM product_spec_locations
      WHERE product_spec_id = $1 AND location_id = $2`,
    [createdProduct.id, createdProduct.locationId],
  );
  assert.deepEqual(unchangedStock.rows[0], { case_count: 2, loose_count: 1 });
  const rejectedTransactions = await pool.query(
    "SELECT COUNT(*)::INTEGER AS count FROM inventory_transactions WHERE product_spec_id = $1",
    [createdProduct.id],
  );
  assert.equal(rejectedTransactions.rows[0].count, 0);

  const employeeOccurredAt = "2026-10-12T08:00:00.000Z";
  const employeeResponse = await requestSplit({
    ...basePayload,
    actualOccurredAt: employeeOccurredAt,
  }, employeeCookie);
  assert.equal(employeeResponse.status, 201);
  const employeeSplit = await employeeResponse.json();
  assert.deepEqual({
    operationType: employeeSplit.operationType,
    productSpecId: employeeSplit.productSpecId,
    locationId: employeeSplit.locationId,
    casesSplit: employeeSplit.casesSplit,
    perCase: employeeSplit.perCase,
    looseAdded: employeeSplit.looseAdded,
    actualOccurredAt: employeeSplit.actualOccurredAt,
    actorAccount: employeeSplit.actorAccount,
    sourceSystem: employeeSplit.sourceSystem,
    locationCases: employeeSplit.locationCases,
    locationLoose: employeeSplit.locationLoose,
  }, {
    operationType: "split",
    productSpecId: createdProduct.id,
    locationId: createdProduct.locationId,
    casesSplit: 1,
    perCase: 6,
    looseAdded: 6,
    actualOccurredAt: employeeOccurredAt,
    actorAccount: employeeAccount,
    sourceSystem: "employee",
    locationCases: 1,
    locationLoose: 7,
  });

  const adminOccurredAt = "2026-10-12T08:05:00.000Z";
  const adminResponse = await requestSplit({
    ...basePayload,
    actualOccurredAt: adminOccurredAt,
  }, adminCookie);
  assert.equal(adminResponse.status, 201);
  const adminSplit = await adminResponse.json();
  assert.deepEqual({
    operationType: adminSplit.operationType,
    casesSplit: adminSplit.casesSplit,
    looseAdded: adminSplit.looseAdded,
    actualOccurredAt: adminSplit.actualOccurredAt,
    actorAccount: adminSplit.actorAccount,
    sourceSystem: adminSplit.sourceSystem,
    locationCases: adminSplit.locationCases,
    locationLoose: adminSplit.locationLoose,
  }, {
    operationType: "split",
    casesSplit: 1,
    looseAdded: 6,
    actualOccurredAt: adminOccurredAt,
    actorAccount: adminAccount,
    sourceSystem: "admin",
    locationCases: 0,
    locationLoose: 13,
  });

  const adminInventoryResponse = await requestInventory(adminCookie);
  const employeeInventoryResponse = await requestInventory(employeeCookie);
  assert.equal(adminInventoryResponse.status, 200);
  assert.equal(employeeInventoryResponse.status, 200);
  const adminInventory = await adminInventoryResponse.json();
  const employeeInventory = await employeeInventoryResponse.json();
  assert.deepEqual(employeeInventory, adminInventory);
  const savedProduct = adminInventory.products.find((item) => item.id === createdProduct.id);
  assert.equal(savedProduct.totalCases, 0);
  assert.equal(savedProduct.totalLoose, 13);
  assert.deepEqual(savedProduct.locations.map(({ cases, loose }) => ({ cases, loose })), [
    { cases: 0, loose: 13 },
  ]);

  const transactionRows = await pool.query(
    `SELECT operation_type, case_count, loose_count, actual_occurred_at,
            actor_account, source_system, recorded_at
       FROM inventory_transactions
      WHERE product_spec_id = $1
      ORDER BY id`,
    [createdProduct.id],
  );
  assert.equal(transactionRows.rowCount, 2);
  assert.deepEqual(transactionRows.rows.map((row) => ({
    operationType: row.operation_type,
    casesSplit: row.case_count,
    looseAdded: row.loose_count,
    actualOccurredAt: row.actual_occurred_at.toISOString(),
    actorAccount: row.actor_account,
    sourceSystem: row.source_system,
    recordedAtIsPresent: row.recorded_at instanceof Date,
  })), [
    {
      operationType: "split",
      casesSplit: 1,
      looseAdded: 6,
      actualOccurredAt: employeeOccurredAt,
      actorAccount: employeeAccount,
      sourceSystem: "employee",
      recordedAtIsPresent: true,
    },
    {
      operationType: "split",
      casesSplit: 1,
      looseAdded: 6,
      actualOccurredAt: adminOccurredAt,
      actorAccount: adminAccount,
      sourceSystem: "admin",
      recordedAtIsPresent: true,
    },
  ]);
});

test("admin and employee move stock between locations atomically and keep both details consistent", async () => {
  const adminCookie = await login("admin", adminAccount);
  const employeeCookie = await login("employee", employeeAccount);
  const product = {
    name: accountPrefix + " 移库测试",
    category: "木制品",
    categoryName: "家具",
    spec: "四个一件",
    perCase: 4,
    note: "",
    warehouse: accountPrefix + " 移库仓库 A",
    spot: "A 位",
  };
  productNames.add(product.name);
  warehouseNames.add(product.warehouse);
  const createdResponse = await requestProduct(product, adminCookie);
  assert.equal(createdResponse.status, 201);
  const createdProduct = await createdResponse.json();

  const targetLocation = {
    productSpecId: createdProduct.id,
    warehouse: accountPrefix + " 移库仓库 B",
    spot: "B 位",
  };
  warehouseNames.add(targetLocation.warehouse);
  const targetResponse = await requestLocation(targetLocation, employeeCookie);
  assert.equal(targetResponse.status, 201);
  const createdTarget = await targetResponse.json();

  const otherProduct = {
    ...product,
    name: accountPrefix + " 移库其他规格",
    warehouse: accountPrefix + " 移库仓库 C",
  };
  productNames.add(otherProduct.name);
  warehouseNames.add(otherProduct.warehouse);
  const otherProductResponse = await requestProduct(otherProduct, employeeCookie);
  assert.equal(otherProductResponse.status, 201);
  const otherCreatedProduct = await otherProductResponse.json();

  await pool.query(
    `UPDATE product_spec_locations
        SET case_count = 3, loose_count = 1
      WHERE product_spec_id = $1 AND location_id = $2`,
    [createdProduct.id, createdProduct.locationId],
  );
  await pool.query(
    `UPDATE product_spec_locations
        SET case_count = 0, loose_count = 8
      WHERE product_spec_id = $1 AND location_id = $2`,
    [createdProduct.id, createdTarget.locationId],
  );

  const basePayload = {
    productSpecId: createdProduct.id,
    sourceLocationId: createdProduct.locationId,
    targetLocationId: createdTarget.locationId,
    cases: 1,
    loose: 1,
    actualOccurredAt: "2026-10-12T09:00:00.000Z",
    note: "整理货位",
  };

  const anonymousResponse = await requestMove(basePayload);
  assert.equal(anonymousResponse.status, 401);

  for (const payload of [
    { ...basePayload, cases: 0, loose: 0 },
    { ...basePayload, cases: -1 },
    { ...basePayload, loose: 1.5 },
    { ...basePayload, targetLocationId: basePayload.sourceLocationId },
    { ...basePayload, actualOccurredAt: "不是实际时间" },
  ]) {
    const response = await requestMove(payload, employeeCookie);
    assert.equal(response.status, 400);
  }

  const invalidLocations = [
    { ...basePayload, sourceLocationId: otherCreatedProduct.locationId },
    { ...basePayload, targetLocationId: otherCreatedProduct.locationId },
    { ...basePayload, sourceLocationId: "999999999999" },
    { ...basePayload, targetLocationId: "999999999999" },
  ];
  for (const payload of invalidLocations) {
    const response = await requestMove(payload, adminCookie);
    assert.equal(response.status, 404);
  }

  for (const payload of [
    { ...basePayload, cases: 4, loose: 0 },
    { ...basePayload, cases: 0, loose: 2 },
  ]) {
    const response = await requestMove(payload, employeeCookie);
    assert.equal(response.status, 409);
  }

  const unchangedLocations = await pool.query(
    `SELECT location_id, case_count, loose_count
       FROM product_spec_locations
      WHERE product_spec_id = $1
        AND location_id = ANY($2::BIGINT[])
      ORDER BY location_id`,
    [createdProduct.id, [createdProduct.locationId, createdTarget.locationId]],
  );
  assert.deepEqual(unchangedLocations.rows.map(({ case_count, loose_count }) => ({ case_count, loose_count })), [
    { case_count: 3, loose_count: 1 },
    { case_count: 0, loose_count: 8 },
  ]);
  const noPartialMoveRecords = await pool.query(
    `SELECT COUNT(*)::INTEGER AS count
       FROM inventory_transactions
      WHERE product_spec_id = $1 AND operation_type = 'move'`,
    [createdProduct.id],
  );
  assert.equal(noPartialMoveRecords.rows[0].count, 0);

  const employeeMoveResponse = await requestMove(basePayload, employeeCookie);
  assert.equal(employeeMoveResponse.status, 201);
  const employeeMove = await employeeMoveResponse.json();
  assert.deepEqual({
    operationType: employeeMove.operationType,
    productSpecId: employeeMove.productSpecId,
    sourceLocationId: employeeMove.sourceLocationId,
    targetLocationId: employeeMove.targetLocationId,
    cases: employeeMove.cases,
    loose: employeeMove.loose,
    note: employeeMove.note,
    actualOccurredAt: employeeMove.actualOccurredAt,
    actorAccount: employeeMove.actorAccount,
    sourceSystem: employeeMove.sourceSystem,
    sourceCases: employeeMove.sourceCases,
    sourceLoose: employeeMove.sourceLoose,
    targetCases: employeeMove.targetCases,
    targetLoose: employeeMove.targetLoose,
  }, {
    operationType: "move",
    productSpecId: createdProduct.id,
    sourceLocationId: createdProduct.locationId,
    targetLocationId: createdTarget.locationId,
    cases: 1,
    loose: 1,
    note: "整理货位",
    actualOccurredAt: basePayload.actualOccurredAt,
    actorAccount: employeeAccount,
    sourceSystem: "employee",
    sourceCases: 2,
    sourceLoose: 0,
    targetCases: 1,
    targetLoose: 9,
  });

  const adminMoveResponse = await requestMove({
    ...basePayload,
    sourceLocationId: createdTarget.locationId,
    targetLocationId: createdProduct.locationId,
    cases: 1,
    loose: 0,
    actualOccurredAt: "2026-10-12T09:05:00.000Z",
    note: "复核后移回",
  }, adminCookie);
  assert.equal(adminMoveResponse.status, 201);
  const adminMove = await adminMoveResponse.json();
  assert.equal(adminMove.sourceSystem, "admin");
  assert.equal(adminMove.actorAccount, adminAccount);
  assert.deepEqual({
    sourceCases: adminMove.sourceCases,
    sourceLoose: adminMove.sourceLoose,
    targetCases: adminMove.targetCases,
    targetLoose: adminMove.targetLoose,
  }, {
    sourceCases: 0,
    sourceLoose: 9,
    targetCases: 3,
    targetLoose: 0,
  });

  const adminInventoryResponse = await requestInventory(adminCookie);
  const employeeInventoryResponse = await requestInventory(employeeCookie);
  assert.equal(adminInventoryResponse.status, 200);
  assert.equal(employeeInventoryResponse.status, 200);
  const adminInventory = await adminInventoryResponse.json();
  const employeeInventory = await employeeInventoryResponse.json();
  assert.deepEqual(employeeInventory, adminInventory);
  const savedProduct = adminInventory.products.find((item) => item.id === createdProduct.id);
  assert.equal(savedProduct.totalCases, 3);
  assert.equal(savedProduct.totalLoose, 9);
  assert.deepEqual(savedProduct.locations.map(({ id, cases, loose }) => ({ id, cases, loose })), [
    { id: createdProduct.locationId, cases: 3, loose: 0 },
    { id: createdTarget.locationId, cases: 0, loose: 9 },
  ]);

  const moveRecords = await pool.query(
    `SELECT operation_type, location_id, target_location_id, case_count, loose_count,
            note, actual_occurred_at, actor_account, source_system, recorded_at
       FROM inventory_transactions
      WHERE product_spec_id = $1 AND operation_type = 'move'
      ORDER BY id`,
    [createdProduct.id],
  );
  assert.equal(moveRecords.rowCount, 2);
  assert.deepEqual(moveRecords.rows.map((row) => ({
    operationType: row.operation_type,
    sourceLocationId: String(row.location_id),
    targetLocationId: String(row.target_location_id),
    cases: row.case_count,
    loose: row.loose_count,
    note: row.note,
    actualOccurredAt: row.actual_occurred_at.toISOString(),
    actorAccount: row.actor_account,
    sourceSystem: row.source_system,
    recordedAtIsPresent: row.recorded_at instanceof Date,
  })), [
    {
      operationType: "move",
      sourceLocationId: createdProduct.locationId,
      targetLocationId: createdTarget.locationId,
      cases: 1,
      loose: 1,
      note: "整理货位",
      actualOccurredAt: basePayload.actualOccurredAt,
      actorAccount: employeeAccount,
      sourceSystem: "employee",
      recordedAtIsPresent: true,
    },
    {
      operationType: "move",
      sourceLocationId: createdTarget.locationId,
      targetLocationId: createdProduct.locationId,
      cases: 1,
      loose: 0,
      note: "复核后移回",
      actualOccurredAt: "2026-10-12T09:05:00.000Z",
      actorAccount: adminAccount,
      sourceSystem: "admin",
      recordedAtIsPresent: true,
    },
  ]);
});
