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

function requestCorrection(transactionId, correction, cookie, sourceSystem) {
  return request("/api/inventory/history/" + transactionId, {
    method: "PATCH",
    headers: {
      Cookie: cookie,
      "Content-Type": "application/json",
      "X-Inventory-Source-System": sourceSystem
        ?? (cookie.startsWith("employee_session=") ? "employee" : "admin"),
      "Idempotency-Key": randomBytes(16).toString("hex"),
    },
    body: JSON.stringify(correction),
  });
}

function requestInventory(cookie) {
  return request("/api/inventory", { headers: { Cookie: cookie } });
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
    headers: { Cookie: cookie, "Content-Type": "application/json", "Idempotency-Key": randomBytes(16).toString("hex") },
    body: JSON.stringify(transaction),
  });
}

function requestOutbound(transaction, cookie) {
  return request("/api/inventory/outbound", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json", "Idempotency-Key": randomBytes(16).toString("hex") },
    body: JSON.stringify(transaction),
  });
}

function requestMove(transaction, cookie) {
  return request("/api/inventory/move", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json", "Idempotency-Key": randomBytes(16).toString("hex") },
    body: JSON.stringify(transaction),
  });
}

function requestSplit(transaction, cookie) {
  return request("/api/inventory/split", {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json", "Idempotency-Key": randomBytes(16).toString("hex") },
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
      revisionId: null,
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
      corrections: [],
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
  const moveResponse = await requestMove({
      productSpecId: createdProduct.id,
      sourceLocationId: createdProduct.locationId,
      targetLocationId: createdSecondLocation.locationId,
      cases: 1,
      loose: 1,
      actualOccurredAt: moveAt,
    }, adminCookie);
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
    revisionId: null,
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
    corrections: [],
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

test("admin and employee can correct supported inventory entries without losing their before and after history", async () => {
  const adminCookie = await login("admin", adminAccount);
  const employeeCookie = await login("employee", employeeAccount);
  const product = {
    name: accountPrefix + " 更正产品",
    category: "木制品",
    categoryName: "家具",
    spec: "四个一件",
    perCase: 4,
    note: "",
    warehouse: accountPrefix + " 更正仓库",
    spot: "A 位",
  };
  const productResponse = await requestProduct(product, adminCookie);
  assert.equal(productResponse.status, 201);
  const createdProduct = await productResponse.json();
  const secondLocationResponse = await requestLocation({
    productSpecId: createdProduct.id,
    warehouse: product.warehouse,
    spot: "B 位",
  }, employeeCookie);
  assert.equal(secondLocationResponse.status, 201);
  const secondLocation = await secondLocationResponse.json();

  const anonymousCorrection = await requestCorrection("1", {
    expectedRevision: null,
    cases: 1,
  }, "");
  assert.equal(anonymousCorrection.status, 401);

  const inboundResponse = await requestInbound({
    productSpecId: createdProduct.id,
    locationId: createdProduct.locationId,
    cases: 5,
    loose: 4,
    actualOccurredAt: "2026-10-14T10:00:00.000Z",
  }, adminCookie);
  assert.equal(inboundResponse.status, 201);
  const inbound = await inboundResponse.json();
  const mismatchedSourceCookie = await requestCorrection(inbound.transactionId, {
    expectedRevision: null,
    cases: 4,
  }, adminCookie, "employee");
  assert.equal(mismatchedSourceCookie.status, 401);

  const inboundCorrectionResponse = await requestCorrection(inbound.transactionId, {
    expectedRevision: null,
    cases: 4,
    loose: 3,
    actualOccurredAt: "2026-10-14T09:45:00.000Z",
  }, adminCookie + "; " + employeeCookie, "employee");
  assert.equal(inboundCorrectionResponse.status, 200);

  const staleInboundCorrection = await requestCorrection(inbound.transactionId, {
    expectedRevision: null,
    cases: 3,
    loose: 3,
  }, adminCookie);
  assert.equal(staleInboundCorrection.status, 409);
  assert.match((await staleInboundCorrection.json()).error, /已被其他人更正/);

  const additionalInboundResponse = await requestInbound({
    productSpecId: createdProduct.id,
    locationId: createdProduct.locationId,
    cases: 2,
    loose: 0,
    actualOccurredAt: "2026-10-14T11:00:00.000Z",
  }, adminCookie);
  assert.equal(additionalInboundResponse.status, 201);
  const additionalInbound = await additionalInboundResponse.json();

  const outboundResponse = await requestOutbound({
    productSpecId: createdProduct.id,
    locationId: createdProduct.locationId,
    cases: 1,
    loose: 1,
    actualOccurredAt: "2026-10-14T12:00:00.000Z",
  }, employeeCookie);
  assert.equal(outboundResponse.status, 201);
  const outbound = await outboundResponse.json();
  const outboundCorrectionResponse = await requestCorrection(outbound.transactionId, {
    expectedRevision: null,
    cases: 2,
    loose: 1,
  }, adminCookie);
  assert.equal(outboundCorrectionResponse.status, 200);
  const outboundCorrection = await outboundCorrectionResponse.json();
  const excessiveOutboundCorrection = await requestCorrection(outbound.transactionId, {
    expectedRevision: outboundCorrection.correction.id,
    cases: 20,
    loose: 1,
  }, employeeCookie);
  assert.equal(excessiveOutboundCorrection.status, 409);
  assert.match((await excessiveOutboundCorrection.json()).error, /库存不足/);
  const inventoryAfterRejectedCorrectionResponse = await requestInventory(adminCookie);
  assert.equal(inventoryAfterRejectedCorrectionResponse.status, 200);
  const inventoryAfterRejectedCorrection = await inventoryAfterRejectedCorrectionResponse.json();
  const productAfterRejectedCorrection = inventoryAfterRejectedCorrection.products.find((item) => item.id === createdProduct.id);
  assert.equal(productAfterRejectedCorrection.locations.find((location) => location.id === createdProduct.locationId).cases, 4);
  assert.equal(productAfterRejectedCorrection.locations.find((location) => location.id === createdProduct.locationId).loose, 2);

  const moveResponse = await requestMove({
    productSpecId: createdProduct.id,
    sourceLocationId: createdProduct.locationId,
    targetLocationId: secondLocation.locationId,
    cases: 1,
    loose: 1,
    actualOccurredAt: "2026-10-14T13:00:00.000Z",
    note: "原备注",
  }, employeeCookie);
  assert.equal(moveResponse.status, 201);
  const move = await moveResponse.json();
  const moveCorrectionResponse = await requestCorrection(move.transactionId, {
    expectedRevision: null,
    cases: 1,
    loose: 2,
    actualOccurredAt: "2026-10-14T13:15:00.000Z",
    note: "更正后的备注",
  }, adminCookie);
  assert.equal(moveCorrectionResponse.status, 200);

  const splitResponse = await requestSplit({
    productSpecId: createdProduct.id,
    locationId: createdProduct.locationId,
    cases: 1,
    actualOccurredAt: "2026-10-14T14:00:00.000Z",
  }, employeeCookie);
  assert.equal(splitResponse.status, 201);
  const split = await splitResponse.json();
  const splitCorrectionResponse = await requestCorrection(split.transactionId, {
    expectedRevision: null,
    cases: 2,
  }, adminCookie);
  assert.equal(splitCorrectionResponse.status, 200);

  const inventoryResponse = await requestInventory(employeeCookie);
  assert.equal(inventoryResponse.status, 200);
  const inventory = await inventoryResponse.json();
  const correctedProduct = inventory.products.find((item) => item.id === createdProduct.id);
  assert.equal(correctedProduct.totalCases, 2);
  assert.equal(correctedProduct.totalLoose, 10);
  assert.deepEqual(correctedProduct.locations.map(({ id, cases, loose }) => ({ id, cases, loose })), [
    { id: createdProduct.locationId, cases: 1, loose: 8 },
    { id: secondLocation.locationId, cases: 1, loose: 2 },
  ]);

  const historyResponse = await requestHistory(employeeCookie);
  assert.equal(historyResponse.status, 200);
  const history = await historyResponse.json();
  const correctedInbound = history.records.find((record) => record.id === inbound.transactionId);
  assert.equal(correctedInbound.cases, 4);
  assert.equal(correctedInbound.loose, 3);
  assert.equal(correctedInbound.actualOccurredAt, "2026-10-14T09:45:00.000Z");
  assert.equal(correctedInbound.actor.account, adminAccount);
  assert.equal(correctedInbound.corrections.length, 1);
  assert.equal(correctedInbound.revisionId, correctedInbound.corrections[0].id);
  assert.equal(correctedInbound.corrections[0].actor.account, employeeAccount);
  assert.equal(correctedInbound.corrections[0].actor.displayName, "T12 测试员工");
  assert.equal(correctedInbound.corrections[0].sourceSystem, "employee");
  assert.equal(correctedInbound.corrections[0].before.cases, 5);
  assert.equal(correctedInbound.corrections[0].before.loose, 4);
  assert.equal(correctedInbound.corrections[0].after.cases, 4);
  assert.equal(correctedInbound.corrections[0].after.loose, 3);
  assert.equal(typeof correctedInbound.corrections[0].correctedAt, "string");

  const correctedOutbound = history.records.find((record) => record.id === outbound.transactionId);
  assert.equal(correctedOutbound.cases, 2);
  assert.equal(correctedOutbound.loose, 1);
  const correctedMove = history.records.find((record) => record.id === move.transactionId);
  assert.equal(correctedMove.cases, 1);
  assert.equal(correctedMove.loose, 2);
  assert.equal(correctedMove.note, "更正后的备注");
  assert.equal(correctedMove.corrections[0].before.note, "原备注");
  assert.equal(correctedMove.corrections[0].after.note, "更正后的备注");
  assert.equal(correctedMove.corrections[0].actor.account, adminAccount);
  assert.equal(correctedMove.corrections[0].sourceSystem, "admin");
  const correctedSplit = history.records.find((record) => record.id === split.transactionId);
  assert.equal(correctedSplit.cases, 2);
  assert.equal(correctedSplit.loose, 8);

  const concurrentResults = await Promise.all([
    requestCorrection(additionalInbound.transactionId, {
      expectedRevision: null,
      cases: 1,
    }, employeeCookie),
    requestCorrection(additionalInbound.transactionId, {
      expectedRevision: null,
      cases: 3,
    }, adminCookie),
  ]);
  assert.deepEqual(concurrentResults.map((response) => response.status).sort(), [200, 409]);
  const afterConcurrentHistoryResponse = await requestHistory(adminCookie);
  assert.equal(afterConcurrentHistoryResponse.status, 200);
  const afterConcurrentHistory = await afterConcurrentHistoryResponse.json();
  const concurrentWinner = afterConcurrentHistory.records.find((record) => record.id === additionalInbound.transactionId);
  assert.equal(concurrentWinner.corrections.length, 1);
  assert.ok(concurrentWinner.cases === 1 || concurrentWinner.cases === 3);
  const afterConcurrentInventoryResponse = await requestInventory(adminCookie);
  assert.equal(afterConcurrentInventoryResponse.status, 200);
  const afterConcurrentInventory = await afterConcurrentInventoryResponse.json();
  const finalProduct = afterConcurrentInventory.products.find((item) => item.id === createdProduct.id);
  assert.equal(finalProduct.locations.find((location) => location.id === createdProduct.locationId).cases,
    concurrentWinner.cases === 1 ? 0 : 2);
  assert.equal(concurrentWinner.actor.account, adminAccount);
});
