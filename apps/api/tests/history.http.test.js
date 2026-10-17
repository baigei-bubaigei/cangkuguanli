import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { hashPassword } from "../src/auth/password.js";

const configuredDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!configuredDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL must point to a PostgreSQL database for isolated-schema testing.");
}

const apiDirectory = fileURLToPath(new URL("..", import.meta.url));
const nextCli = fileURLToPath(new URL("../../../node_modules/next/dist/bin/next", import.meta.url));
const migrationCli = fileURLToPath(new URL("../scripts/migrate.js", import.meta.url));
const schemaName = "codex_issue22_" + randomBytes(8).toString("hex");
const accountPrefix = "issue22-" + process.pid + "-" + Date.now() + "-" + randomBytes(4).toString("hex");
const password = "issue22-test-only-password";
let isolatedDatabaseUrl;
let schemaCreated = false;
let pool;
let serverProcess;
let baseUrl;
let adminAccount;
let employeeAccount;

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

function databaseUrlForSchema(url, schema) {
  const result = new URL(url);
  result.searchParams.set("options", "-csearch_path=" + schema);
  return result.toString();
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

function requestHistory(cookie, filters = "") {
  return request("/api/inventory/history" + filters, {
    headers: cookie ? { Cookie: cookie } : {},
  });
}

function requestProduct(product, cookie) {
  return request("/api/catalog/products", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify(product),
  });
}

function requestLocation(location, cookie) {
  return request("/api/catalog/products/locations", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify(location),
  });
}

function requestInbound(transaction, cookie) {
  return request("/api/inventory/inbound", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify(transaction),
  });
}

function requestOutbound(transaction, cookie) {
  return request("/api/inventory/outbound", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify(transaction),
  });
}

function requestMove(transaction, cookie) {
  return request("/api/inventory/move", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify(transaction),
  });
}

function requestSplit(transaction, cookie) {
  return request("/api/inventory/split", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify(transaction),
  });
}

before(async () => {
  const bootstrapPool = new Pool({
    connectionString: configuredDatabaseUrl,
    options: "-c search_path=pg_catalog",
  });
  try {
    const searchPath = await bootstrapPool.query(
      "SELECT current_schema() AS schema_name, to_json(current_schemas(false)) AS schemas, current_setting('search_path') AS path",
    );
    assert.equal(searchPath.rows[0].schema_name, "pg_catalog");
    assert.deepEqual(searchPath.rows[0].schemas, ["pg_catalog"]);
    assert.equal(searchPath.rows[0].schemas.includes("public"), false);

    await bootstrapPool.query(`CREATE SCHEMA "${schemaName}"`);
    schemaCreated = true;
  } finally {
    await bootstrapPool.end();
  }

  isolatedDatabaseUrl = databaseUrlForSchema(configuredDatabaseUrl, schemaName);
  pool = new Pool({ connectionString: isolatedDatabaseUrl });
  const isolatedSearchPath = await pool.query(
    "SELECT current_schema() AS schema_name, to_json(current_schemas(false)) AS schemas, current_setting('search_path') AS path",
  );
  assert.equal(isolatedSearchPath.rows[0].schema_name, schemaName);
  assert.deepEqual(isolatedSearchPath.rows[0].schemas, [schemaName]);
  assert.equal(isolatedSearchPath.rows[0].schemas.includes("public"), false);

  const migrations = spawnSync(process.execPath, [migrationCli], {
    cwd: apiDirectory,
    env: { ...process.env, DATABASE_URL: isolatedDatabaseUrl },
    encoding: "utf8",
  });
  if (migrations.status !== 0) {
    throw new Error("PostgreSQL migrations failed: " + (migrations.stderr || migrations.stdout));
  }

  adminAccount = accountPrefix + "-admin";
  employeeAccount = accountPrefix + "-employee";
  const passwordHash = await hashPassword(password);
  await pool.query(
    "INSERT INTO admin_accounts (account, display_name, password_hash) VALUES ($1, $2, $3)",
    [adminAccount, "T12 测试管理员", passwordHash],
  );
  await pool.query(
    "INSERT INTO employee_accounts (account, display_name, password_hash) VALUES ($1, $2, $3)",
    [employeeAccount, "T12 测试员工", passwordHash],
  );

  const port = await availablePort();
  baseUrl = "http://127.0.0.1:" + port;
  serverProcess = spawn(
    process.execPath,
    [nextCli, "dev", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: apiDirectory,
      env: { ...process.env, DATABASE_URL: isolatedDatabaseUrl },
      stdio: "ignore",
      windowsHide: true,
    },
  );
  await waitForApi();
});

after(async () => {
  if (serverProcess && serverProcess.exitCode === null) serverProcess.kill();
  if (pool) await pool.end();

  if (schemaCreated) {
    const cleanupPool = new Pool({
      connectionString: configuredDatabaseUrl,
      options: "-c search_path=pg_catalog",
    });
    try {
      const searchPath = await cleanupPool.query(
        "SELECT current_schema() AS schema_name, to_json(current_schemas(false)) AS schemas",
      );
      assert.equal(searchPath.rows[0].schema_name, "pg_catalog");
      assert.deepEqual(searchPath.rows[0].schemas, ["pg_catalog"]);
      assert.match(schemaName, /^codex_issue22_[0-9a-f]{16}$/);
      await cleanupPool.query(`DROP SCHEMA "${schemaName}" CASCADE`);
    } finally {
      await cleanupPool.end();
    }
  }
});

test("admin and employee can read the same inbound business record with its history context", async () => {
  const anonymous = await requestHistory();
  assert.equal(anonymous.status, 401);

  const adminCookie = await login("admin", adminAccount);
  const employeeCookie = await login("employee", employeeAccount);
  const product = {
    name: accountPrefix + " 历史产品",
    category: "木制品",
    categoryName: "家具",
    spec: "四个一件",
    perCase: 4,
    note: "",
    warehouse: accountPrefix + " 仓库",
    spot: "A 位",
  };
  const productResponse = await requestProduct(product, adminCookie);
  assert.equal(productResponse.status, 201);
  const createdProduct = await productResponse.json();

  const actualOccurredAt = "2026-10-16T10:15:00.000Z";
  const inboundResponse = await requestInbound({
    productSpecId: createdProduct.id,
    locationId: createdProduct.locationId,
    cases: 3,
    loose: 2,
    actualOccurredAt,
  }, adminCookie);
  assert.equal(inboundResponse.status, 201);
  const inbound = await inboundResponse.json();

  const adminResponse = await requestHistory(adminCookie);
  assert.equal(adminResponse.status, 200);
  assert.equal(adminResponse.headers.get("cache-control"), "no-store");
  const adminHistory = await adminResponse.json();
  assert.deepEqual(adminHistory, {
    records: [{
      id: inbound.transactionId,
      operationType: "inbound",
      product: {
        id: createdProduct.id,
        name: product.name,
        spec: product.spec,
        perCase: product.perCase,
      },
      cases: 3,
      loose: 2,
      location: {
        id: createdProduct.locationId,
        warehouse: product.warehouse,
        spot: product.spot,
      },
      targetLocation: null,
      actualOccurredAt,
      recordedAt: inbound.recordedAt,
      actor: { account: adminAccount, displayName: "T12 测试管理员" },
      sourceSystem: "admin",
      note: "",
    }],
  });

  const employeeResponse = await requestHistory(employeeCookie);
  assert.equal(employeeResponse.status, 200);
  assert.deepEqual(await employeeResponse.json(), adminHistory);

  const secondLocation = {
    productSpecId: createdProduct.id,
    warehouse: product.warehouse,
    spot: "B 位",
  };
  const locationResponse = await requestLocation(secondLocation, employeeCookie);
  assert.equal(locationResponse.status, 201);
  const createdSecondLocation = await locationResponse.json();

  const outboundAt = "2026-10-16T11:15:00.000Z";
  const outboundResponse = await requestOutbound({
    productSpecId: createdProduct.id,
    locationId: createdProduct.locationId,
    cases: 1,
    loose: 1,
    actualOccurredAt: outboundAt,
  }, employeeCookie);
  assert.equal(outboundResponse.status, 201);
  const outbound = await outboundResponse.json();

  const moveAt = "2026-10-16T12:15:00.000Z";
  const moveResponse = await request("/api/inventory/move", {
    method: "POST",
    headers: { Cookie: adminCookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      productSpecId: createdProduct.id,
      sourceLocationId: createdProduct.locationId,
      targetLocationId: createdSecondLocation.locationId,
      cases: 1,
      loose: 1,
      actualOccurredAt: moveAt,
    }),
  });
  assert.equal(moveResponse.status, 201);
  const move = await moveResponse.json();

  const splitAt = "2026-10-16T13:15:00.000Z";
  const splitResponse = await requestSplit({
    productSpecId: createdProduct.id,
    locationId: createdProduct.locationId,
    cases: 1,
    actualOccurredAt: splitAt,
  }, employeeCookie);
  assert.equal(splitResponse.status, 201);
  const split = await splitResponse.json();

  const allAdminResponse = await requestHistory(adminCookie);
  assert.equal(allAdminResponse.status, 200);
  const allAdminHistory = await allAdminResponse.json();
  const allEmployeeResponse = await requestHistory(employeeCookie);
  assert.equal(allEmployeeResponse.status, 200);
  assert.deepEqual(await allEmployeeResponse.json(), allAdminHistory);
  assert.deepEqual(allAdminHistory.records.map((record) => record.id), [
    split.transactionId,
    move.transactionId,
    outbound.transactionId,
    inbound.transactionId,
  ]);
  assert.deepEqual(allAdminHistory.records[0], {
    id: split.transactionId,
    operationType: "split",
    product: {
      id: createdProduct.id,
      name: product.name,
      spec: product.spec,
      perCase: product.perCase,
    },
    cases: 1,
    loose: 4,
    location: {
      id: createdProduct.locationId,
      warehouse: product.warehouse,
      spot: product.spot,
    },
    targetLocation: null,
    actualOccurredAt: splitAt,
    recordedAt: split.recordedAt,
    actor: { account: employeeAccount, displayName: "T12 测试员工" },
    sourceSystem: "employee",
    note: "",
  });
  assert.equal(allAdminHistory.records[1].operationType, "move");
  assert.equal(allAdminHistory.records[1].sourceSystem, "admin");
  assert.deepEqual(allAdminHistory.records[1].targetLocation, {
    id: createdSecondLocation.locationId,
    warehouse: product.warehouse,
    spot: secondLocation.spot,
  });

  const moveOnlyResponse = await requestHistory(adminCookie, "?type=move");
  assert.equal(moveOnlyResponse.status, 200);
  assert.deepEqual((await moveOnlyResponse.json()).records.map((record) => record.id), [move.transactionId]);

  const employeeOnlyResponse = await requestHistory(adminCookie, "?source=employee");
  assert.equal(employeeOnlyResponse.status, 200);
  assert.deepEqual((await employeeOnlyResponse.json()).records.map((record) => record.id), [
    split.transactionId,
    outbound.transactionId,
  ]);

  const keywordResponse = await requestHistory(employeeCookie, "?q=" + encodeURIComponent("T12 测试员工"));
  assert.equal(keywordResponse.status, 200);
  assert.deepEqual((await keywordResponse.json()).records.map((record) => record.id), [
    split.transactionId,
    outbound.transactionId,
  ]);

  const noResultsResponse = await requestHistory(adminCookie, "?type=initial");
  assert.equal(noResultsResponse.status, 200);
  assert.deepEqual(await noResultsResponse.json(), { records: [] });
});
