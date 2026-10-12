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
    await pool.query("DELETE FROM product_specs WHERE product_name = ANY($1::text[])", [[...productNames]]);
    await pool.query(
      "DELETE FROM locations WHERE warehouse_id IN (SELECT id FROM warehouses WHERE name = ANY($1::text[]))",
      [[...warehouseNames]],
    );
    await pool.query("DELETE FROM warehouses WHERE name = ANY($1::text[])", [[...warehouseNames]]);
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