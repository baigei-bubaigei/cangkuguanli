import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import { hashPassword } from "../src/auth/password.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL must point to a PostgreSQL database for isolated-schema testing.");
}

const testSchema = `issue34_idempotency_${process.pid}_${randomBytes(6).toString("hex")}`;
const isolatedDatabaseUrl = new URL(testDatabaseUrl);
isolatedDatabaseUrl.searchParams.set("options", `-c search_path=${testSchema}`);
const apiDirectory = fileURLToPath(new URL("..", import.meta.url));
const nextCli = fileURLToPath(new URL("../../../node_modules/next/dist/bin/next", import.meta.url));
const migrationCli = fileURLToPath(new URL("../scripts/migrate.js", import.meta.url));
const accountPrefix = `issue34-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`;
const password = "test-only-idempotency-password";
let pool;
let serverProcess;
let baseUrl;
let adminAccount;
let schemaCreated = false;

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

async function assertIsolatedConnection(client) {
  const result = await client.query(
    `SELECT current_schema() AS schema,
            current_schemas(false) @> ARRAY[$1]::name[] AS contains_schema,
            cardinality(current_schemas(false)) AS schema_count,
            'public' = ANY(current_schemas(false)) AS contains_public`,
    [testSchema],
  );
  assert.equal(result.rows[0].schema, testSchema);
  assert.equal(result.rows[0].contains_schema, true);
  assert.equal(result.rows[0].schema_count, 1);
  assert.equal(result.rows[0].contains_public, false);
}

async function queryDatabase(sql, values = []) {
  const client = await pool.connect();
  try {
    await assertIsolatedConnection(client);
    return await client.query(sql, values);
  } finally {
    client.release();
  }
}

function needsIdempotencyKey(path, method) {
  if (method === "POST") {
    return [
      "/api/inventory/inbound",
      "/api/inventory/outbound",
      "/api/inventory/move",
      "/api/inventory/split",
      "/api/admin/initial-inventory/imports",
    ].includes(path);
  }
  return method === "PATCH" && /^\/api\/inventory\/history\/\d+$/.test(path);
}

function request(path, options = {}) {
  const method = (options.method ?? "GET").toUpperCase();
  const headers = new Headers(options.headers);
  if (needsIdempotencyKey(new URL(path, "http://localhost").pathname, method)
    && !headers.has("Idempotency-Key")) {
    headers.set("Idempotency-Key", randomUUID());
  }
  return fetch(`${baseUrl}${path}`, { ...options, headers });
}

function postJson(path, body, cookie, idempotencyKey) {
  return request(path, {
    method: "POST",
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      "Content-Type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  });
}

function patchJson(path, body, cookie, idempotencyKey) {
  return request(path, {
    method: "PATCH",
    headers: {
      Cookie: cookie,
      "Content-Type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function login() {
  const response = await request("/api/admin/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ account: adminAccount, password }),
  });
  assert.equal(response.status, 200);
  const setCookie = response.headers.getSetCookie().find((value) => value.startsWith("admin_session="));
  assert.ok(setCookie, "login response should set admin_session");
  return setCookie.split(";", 1)[0];
}

before(async () => {
  const bootstrapPool = new Pool({
    connectionString: testDatabaseUrl,
    options: "-c search_path=pg_catalog",
  });
  try {
    const safePath = await bootstrapPool.query(
      "SELECT current_schema() AS schema, 'public' = ANY(current_schemas(false)) AS contains_public",
    );
    assert.equal(safePath.rows[0].schema, "pg_catalog");
    assert.equal(safePath.rows[0].contains_public, false);
    await bootstrapPool.query(`CREATE SCHEMA "${testSchema}"`);
    schemaCreated = true;
  } finally {
    await bootstrapPool.end();
  }

  const migrations = spawnSync(process.execPath, [migrationCli], {
    cwd: apiDirectory,
    env: { ...process.env, DATABASE_URL: isolatedDatabaseUrl.toString() },
    encoding: "utf8",
  });
  if (migrations.status !== 0) {
    throw new Error(`PostgreSQL migrations failed: ${migrations.stderr || migrations.stdout}`);
  }

  pool = new Pool({ connectionString: isolatedDatabaseUrl.toString() });
  const client = await pool.connect();
  try {
    await assertIsolatedConnection(client);
  } finally {
    client.release();
  }

  adminAccount = `${accountPrefix}-admin`;
  await queryDatabase(
    `INSERT INTO admin_accounts (account, display_name, password_hash)
     VALUES ($1, $2, $3)`,
    [adminAccount, "幂等测试管理员", await hashPassword(password)],
  );

  const port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(
    process.execPath,
    [nextCli, "dev", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: apiDirectory,
      env: { ...process.env, DATABASE_URL: isolatedDatabaseUrl.toString() },
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
    const cleanupPool = new Pool({ connectionString: isolatedDatabaseUrl.toString() });
    const client = await cleanupPool.connect();
    try {
      await assertIsolatedConnection(client);
      await client.query(`DROP SCHEMA "${testSchema}" CASCADE`);
    } finally {
      client.release();
      await cleanupPool.end();
    }
  }
});

test("inventory operations, corrections, and imports replay once by submission identity", async () => {
  const adminCookie = await login();
  const productName = `${accountPrefix}-产品`;
  const warehouse = `${accountPrefix}-仓库`;
  const productResponse = await postJson("/api/catalog/products", {
    name: productName,
    category: "测试类别",
    categoryName: "测试类别名",
    spec: "6个一件",
    material: "测试材质",
    color: "测试颜色",
    perCase: 6,
    warehouse,
    spot: "A-01",
  }, adminCookie);
  assert.equal(productResponse.status, 201);
  const product = await productResponse.json();

  const targetLocationResponse = await postJson("/api/catalog/products/locations", {
    productSpecId: product.id,
    warehouse,
    spot: "B-01",
  }, adminCookie);
  assert.equal(targetLocationResponse.status, 201);
  const targetLocation = await targetLocationResponse.json();

  const inbound = (payload, key) => postJson("/api/inventory/inbound", payload, adminCookie, key);
  const outbound = (payload, key) => postJson("/api/inventory/outbound", payload, adminCookie, key);
  const move = (payload, key) => postJson("/api/inventory/move", payload, adminCookie, key);
  const split = (payload, key) => postJson("/api/inventory/split", payload, adminCookie, key);

  const initialInbound = {
    productSpecId: product.id,
    locationId: product.locationId,
    cases: 10,
    loose: 2,
    actualOccurredAt: "2026-10-17T09:00:00.000Z",
  };
  const missingKey = await fetch(`${baseUrl}/api/inventory/inbound`, {
    method: "POST",
    headers: { Cookie: adminCookie, "Content-Type": "application/json" },
    body: JSON.stringify(initialInbound),
  });
  assert.equal(missingKey.status, 400);
  const initialInboundResponse = await inbound(initialInbound, randomUUID());
  assert.equal(initialInboundResponse.status, 201);

  const inboundKey = randomUUID();
  const inboundPayload = {
    ...initialInbound,
    cases: 2,
    loose: 1,
    actualOccurredAt: "2026-10-17T09:10:00.000Z",
  };
  const inboundResults = await Promise.all([
    inbound(inboundPayload, inboundKey),
    inbound(inboundPayload, inboundKey),
  ]);
  assert.deepEqual(inboundResults.map((response) => response.status), [201, 201]);
  const [inboundResult, inboundReplay] = await Promise.all(inboundResults.map((response) => response.json()));
  assert.deepEqual(inboundReplay, inboundResult);
  const changedInbound = await inbound({ ...inboundPayload, cases: 4 }, inboundKey);
  assert.equal(changedInbound.status, 409);
  const malformedChangedInbound = await request("/api/inventory/inbound", {
    method: "POST",
    headers: {
      Cookie: adminCookie,
      "Content-Type": "application/json",
      "Idempotency-Key": inboundKey,
    },
    body: "{",
  });
  assert.equal(malformedChangedInbound.status, 409);

  const outboundKey = randomUUID();
  const outboundPayload = {
    ...initialInbound,
    cases: 1,
    loose: 1,
    actualOccurredAt: "2026-10-17T09:20:00.000Z",
  };
  const outboundResults = await Promise.all([
    outbound(outboundPayload, outboundKey),
    outbound(outboundPayload, outboundKey),
  ]);
  assert.deepEqual(outboundResults.map((response) => response.status), [201, 201]);
  const [outboundResult, outboundReplay] = await Promise.all(outboundResults.map((response) => response.json()));
  assert.deepEqual(outboundReplay, outboundResult);

  const moveKey = randomUUID();
  const movePayload = {
    productSpecId: product.id,
    sourceLocationId: product.locationId,
    targetLocationId: targetLocation.locationId,
    cases: 2,
    loose: 0,
    actualOccurredAt: "2026-10-17T09:30:00.000Z",
    note: "幂等移库",
  };
  const moveResults = await Promise.all([
    move(movePayload, moveKey),
    move(movePayload, moveKey),
  ]);
  assert.deepEqual(moveResults.map((response) => response.status), [201, 201]);
  const [moveResult, moveReplay] = await Promise.all(moveResults.map((response) => response.json()));
  assert.deepEqual(moveReplay, moveResult);

  const splitKey = randomUUID();
  const splitPayload = {
    productSpecId: product.id,
    locationId: product.locationId,
    cases: 1,
    actualOccurredAt: "2026-10-17T09:40:00.000Z",
  };
  const splitResults = await Promise.all([
    split(splitPayload, splitKey),
    split(splitPayload, splitKey),
  ]);
  assert.deepEqual(splitResults.map((response) => response.status), [201, 201]);
  const [splitResult, splitReplay] = await Promise.all(splitResults.map((response) => response.json()));
  assert.deepEqual(splitReplay, splitResult);

  const failedOutboundKey = randomUUID();
  const failedOutboundPayload = {
    ...initialInbound,
    cases: 20,
    loose: 0,
    actualOccurredAt: "2026-10-17T09:50:00.000Z",
  };
  const rejectedOutbound = await outbound(failedOutboundPayload, failedOutboundKey);
  assert.equal(rejectedOutbound.status, 409);
  const topUpResponse = await inbound({
    ...initialInbound,
    cases: 20,
    loose: 0,
    actualOccurredAt: "2026-10-17T09:55:00.000Z",
  }, randomUUID());
  assert.equal(topUpResponse.status, 201);
  const retryAfterFailure = await outbound(failedOutboundPayload, failedOutboundKey);
  assert.equal(retryAfterFailure.status, 201);
  const retryResult = await retryAfterFailure.json();
  const retryReplay = await outbound(failedOutboundPayload, failedOutboundKey);
  assert.equal(retryReplay.status, 201);
  assert.deepEqual(await retryReplay.json(), retryResult);

  const correctionKey = randomUUID();
  const correctionPayload = { expectedRevision: null, cases: 3, loose: 1 };
  const correctionPath = `/api/inventory/history/${inboundResult.transactionId}`;
  const correctionResponse = await patchJson(correctionPath, correctionPayload, adminCookie, correctionKey);
  assert.equal(correctionResponse.status, 200);
  const correctionResult = await correctionResponse.json();
  const correctionReplay = await patchJson(correctionPath, correctionPayload, adminCookie, correctionKey);
  assert.equal(correctionReplay.status, 200);
  assert.deepEqual(await correctionReplay.json(), correctionResult);
  const changedCorrection = await patchJson(correctionPath, {
    expectedRevision: null,
    cases: 4,
    loose: 1,
  }, adminCookie, correctionKey);
  assert.equal(changedCorrection.status, 409);

  const importRow = {
    productName,
    spec: "6个一件",
    material: "测试材质",
    color: "测试颜色",
    perCase: 6,
    category: "测试类别",
    categoryName: "测试类别名",
    note: null,
    warehouse,
    spot: "A-01",
    cases: 1,
    loose: 3,
  };
  const invalidImportKey = randomUUID();
  const invalidImportPayload = {
    rows: [{ ...importRow, cases: -1 }],
  };
  const importBatchLogsBeforeFailure = await queryDatabase(
    `SELECT count(*)::integer AS count
       FROM system_operation_logs
      WHERE operation_type = 'initial_inventory_import'
        AND target_type = 'initial_inventory_import_batch'
        AND actor_account_snapshot = $1`,
    [adminAccount],
  );
  const invalidImport = await postJson("/api/admin/initial-inventory/imports", invalidImportPayload, adminCookie, invalidImportKey);
  assert.equal(invalidImport.status, 400);
  const invalidImportResult = await invalidImport.json();
  assert.match(invalidImportResult.batchId, /^\d+$/);
  const failedImportBatchLogs = await queryDatabase(
    `SELECT target_id::text AS batch_id, operation_content
       FROM system_operation_logs
      WHERE operation_type = 'initial_inventory_import'
        AND target_type = 'initial_inventory_import_batch'
        AND actor_account_snapshot = $1
      ORDER BY id`,
    [adminAccount],
  );
  assert.equal(
    failedImportBatchLogs.rowCount,
    importBatchLogsBeforeFailure.rows[0].count + 1,
  );
  assert.equal(failedImportBatchLogs.rows.at(-1).batch_id, invalidImportResult.batchId);
  assert.deepEqual(failedImportBatchLogs.rows.at(-1).operation_content, {
    batchId: invalidImportResult.batchId,
    result: "failed",
    receivedRows: 1,
    importedRows: 0,
    error: invalidImportResult.error,
  });

  const invalidImportReplay = await postJson(
    "/api/admin/initial-inventory/imports",
    invalidImportPayload,
    adminCookie,
    invalidImportKey,
  );
  assert.equal(invalidImportReplay.status, 400);
  assert.deepEqual(await invalidImportReplay.json(), invalidImportResult);
  const failedImportReplayLogs = await queryDatabase(
    `SELECT target_id::text AS batch_id
       FROM system_operation_logs
      WHERE operation_type = 'initial_inventory_import'
        AND target_type = 'initial_inventory_import_batch'
        AND actor_account_snapshot = $1
      ORDER BY id`,
    [adminAccount],
  );
  assert.deepEqual(failedImportReplayLogs.rows, [{ batch_id: invalidImportResult.batchId }]);

  const changedFailedImport = await postJson("/api/admin/initial-inventory/imports", {
    rows: [importRow],
  }, adminCookie, invalidImportKey);
  assert.equal(changedFailedImport.status, 409);
  assert.deepEqual((await queryDatabase(
    `SELECT target_id::text AS batch_id
       FROM system_operation_logs
      WHERE operation_type = 'initial_inventory_import'
        AND target_type = 'initial_inventory_import_batch'
        AND actor_account_snapshot = $1
      ORDER BY id`,
    [adminAccount],
  )).rows, [{ batch_id: invalidImportResult.batchId }]);

  const importRetry = await postJson("/api/admin/initial-inventory/imports", {
    rows: [importRow],
  }, adminCookie, randomUUID());
  assert.equal(importRetry.status, 201);
  const retriedImportResult = await importRetry.json();
  assert.deepEqual({ receivedRows: retriedImportResult.receivedRows, importedRows: retriedImportResult.importedRows }, {
    receivedRows: 1,
    importedRows: 1,
  });
  assert.notEqual(retriedImportResult.batchId, invalidImportResult.batchId);

  const importKey = randomUUID();
  const importPayload = { rows: [{ ...importRow, cases: 2, loose: 4 }] };
  const importResponse = await postJson("/api/admin/initial-inventory/imports", importPayload, adminCookie, importKey);
  assert.equal(importResponse.status, 201);
  const importResult = await importResponse.json();
  const importReplay = await postJson("/api/admin/initial-inventory/imports", importPayload, adminCookie, importKey);
  assert.equal(importReplay.status, 201);
  assert.deepEqual(await importReplay.json(), importResult);
  const changedImport = await postJson("/api/admin/initial-inventory/imports", {
    rows: [{ ...importRow, cases: 3, loose: 4 }],
  }, adminCookie, importKey);
  assert.equal(changedImport.status, 409);
  const malformedChangedImport = await request("/api/admin/initial-inventory/imports", {
    method: "POST",
    headers: {
      Cookie: adminCookie,
      "Content-Type": "application/json",
      "Idempotency-Key": importKey,
    },
    body: "{",
  });
  assert.equal(malformedChangedImport.status, 409);

  const inventoryResponse = await request("/api/inventory", { headers: { Cookie: adminCookie } });
  assert.equal(inventoryResponse.status, 200);
  const inventory = await inventoryResponse.json();
  const savedProduct = inventory.products.find((item) => item.id === product.id);
  assert.ok(savedProduct);
  assert.equal(savedProduct.totalCases, 14);
  assert.equal(savedProduct.totalLoose, 15);
  assert.deepEqual(savedProduct.locations.map(({ id, cases, loose }) => ({ id, cases, loose })), [
    { id: product.locationId, cases: 12, loose: 15 },
    { id: targetLocation.locationId, cases: 2, loose: 0 },
  ]);

  const historyResponse = await request("/api/inventory/history", { headers: { Cookie: adminCookie } });
  assert.equal(historyResponse.status, 200);
  const history = await historyResponse.json();
  const productRecords = history.records.filter((record) => record.product.id === product.id);
  assert.equal(productRecords.filter((record) => record.operationType === "initial").length, 2);
  const correctedInbound = productRecords.find((record) => record.id === inboundResult.transactionId);
  assert.equal(correctedInbound.cases, 3);
  assert.equal(correctedInbound.corrections.length, 1);

  const operationCounts = await queryDatabase(
    `SELECT operation_type, count(*)::integer AS count
       FROM inventory_transactions
      WHERE product_spec_id = $1
      GROUP BY operation_type
      ORDER BY operation_type`,
    [product.id],
  );
  assert.deepEqual(operationCounts.rows, [
    { operation_type: "inbound", count: 3 },
    { operation_type: "initial", count: 2 },
    { operation_type: "move", count: 1 },
    { operation_type: "outbound", count: 2 },
    { operation_type: "split", count: 1 },
  ]);

  const operationLogCount = await queryDatabase(
    `SELECT count(*)::integer AS count
       FROM system_operation_logs log
       JOIN inventory_transactions tx
         ON log.target_type = 'inventory_transaction'
        AND log.target_id = tx.id
      WHERE tx.product_spec_id = $1`,
    [product.id],
  );
  assert.equal(operationLogCount.rows[0].count, 10);

  const correctionLogCount = await queryDatabase(
    `SELECT count(*)::integer AS count
       FROM system_operation_logs
      WHERE operation_type = 'inventory_history_corrected'
        AND target_type = 'inventory_transaction' AND target_id = $1`,
    [inboundResult.transactionId],
  );
  assert.equal(correctionLogCount.rows[0].count, 1);

  for (const batchId of [retriedImportResult.batchId, importResult.batchId]) {
    const batchLogCount = await queryDatabase(
      `SELECT count(*)::integer AS count
         FROM system_operation_logs
        WHERE target_type = 'initial_inventory_import_batch'
          AND target_id = $1`,
      [batchId],
    );
    assert.equal(batchLogCount.rows[0].count, 1);
  }

  const correctionCount = await queryDatabase(
    `SELECT count(*)::integer AS count
       FROM inventory_transaction_corrections
      WHERE transaction_id = $1`,
    [inboundResult.transactionId],
  );
  assert.equal(correctionCount.rows[0].count, 1);
});
