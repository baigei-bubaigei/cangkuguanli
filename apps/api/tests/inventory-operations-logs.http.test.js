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

const testSchema = `issue29_inventory_logs_${process.pid}_${randomBytes(6).toString("hex")}`;
const isolatedDatabaseUrl = new URL(testDatabaseUrl);
isolatedDatabaseUrl.searchParams.set("options", `-c search_path=${testSchema}`);
const apiDirectory = fileURLToPath(new URL("..", import.meta.url));
const nextCli = fileURLToPath(new URL("../../../node_modules/next/dist/bin/next", import.meta.url));
const migrationCli = fileURLToPath(new URL("../scripts/migrate.js", import.meta.url));
const accountPrefix = `t19-test-${process.pid}-${Date.now()}`;
const password = "test-only-inventory-logs-password";
let pool;
let serverProcess;
let baseUrl;
let adminAccount;
let employeeAccount;
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

function request(path, options = {}) {
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

function post(path, body, cookie) {
  return request(path, {
    method: "POST",
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      "Content-Type": "application/json",
      "Idempotency-Key": randomBytes(16).toString("hex"),
    },
    body: JSON.stringify(body),
  });
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

async function logsForTransaction(transactionId) {
  return queryDatabase(
    `SELECT log.source_system, log.operation_type, log.target_type,
            log.target_id::text AS target_id,
            log.actor_admin_account_id::text AS actor_admin_account_id,
            log.actor_employee_account_id::text AS actor_employee_account_id,
            log.actor_account_snapshot, log.actor_display_name_snapshot,
            log.operation_content, log.recorded_at,
            tx.recorded_at AS transaction_recorded_at
       FROM system_operation_logs AS log
       JOIN inventory_transactions AS tx
         ON log.target_type = 'inventory_transaction'
        AND log.target_id = tx.id
      WHERE tx.id = $1
      ORDER BY log.id`,
    [transactionId],
  );
}

before(async () => {
  const bootstrapDatabaseUrl = new URL(testDatabaseUrl);
  bootstrapDatabaseUrl.searchParams.set("options", `-c search_path=${testSchema},pg_catalog`);
  const bootstrapPool = new Pool({ connectionString: bootstrapDatabaseUrl.toString() });
  const bootstrapClient = await bootstrapPool.connect();
  try {
    const bootstrapGuard = await bootstrapClient.query(
      "SELECT 'public' = ANY(current_schemas(false)) AS contains_public",
    );
    assert.equal(bootstrapGuard.rows[0].contains_public, false);
    await bootstrapClient.query(`CREATE SCHEMA "${testSchema}"`);
    schemaCreated = true;
  } finally {
    bootstrapClient.release();
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
  const guardClient = await pool.connect();
  try {
    await assertIsolatedConnection(guardClient);
  } finally {
    guardClient.release();
  }

  adminAccount = `${accountPrefix}-admin`;
  employeeAccount = `${accountPrefix}-employee`;
  const passwordHash = await hashPassword(password);
  await queryDatabase(
    `INSERT INTO admin_accounts (account, display_name, password_hash)
     VALUES ($1, $2, $3)`,
    [adminAccount, "库存日志测试管理员", passwordHash],
  );
  await queryDatabase(
    `INSERT INTO employee_accounts (account, display_name, password_hash)
     VALUES ($1, $2, $3)`,
    [employeeAccount, "库存日志测试员工", passwordHash],
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
  if (serverProcess && serverProcess.exitCode === null) {
    const serverExit = new Promise((resolve) => serverProcess.once("exit", resolve));
    serverProcess.kill();
    await serverExit;
  }
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

    const cleanupVerificationUrl = new URL(testDatabaseUrl);
    cleanupVerificationUrl.searchParams.set("options", "-c search_path=pg_catalog");
    const verificationPool = new Pool({ connectionString: cleanupVerificationUrl.toString() });
    try {
      const verification = await verificationPool.query(
        `SELECT count(*)::INTEGER AS count,
                'public' = ANY(current_schemas(false)) AS contains_public
           FROM pg_catalog.pg_namespace
          WHERE nspname = $1`,
        [testSchema],
      );
      assert.equal(verification.rows[0].contains_public, false);
      assert.equal(verification.rows[0].count, 0);
    } finally {
      await verificationPool.end();
    }
  }
});

test("inventory operations are linked to durable admin and employee system logs", async () => {
  const adminCookie = await login("admin", adminAccount);
  const employeeCookie = await login("employee", employeeAccount);
  const productResponse = await post("/api/catalog/products", {
    name: `${accountPrefix} 库存业务日志商品`,
    category: "类别",
    categoryName: "分类",
    spec: "四个一件",
    perCase: 4,
    note: "",
    warehouse: `${accountPrefix} 日志仓库`,
    spot: "A 位",
  }, adminCookie);
  assert.equal(productResponse.status, 201);
  const product = await productResponse.json();

  const targetLocationResponse = await post("/api/catalog/products/locations", {
    productSpecId: product.id,
    warehouse: `${accountPrefix} 日志仓库`,
    spot: "B 位",
  }, employeeCookie);
  assert.equal(targetLocationResponse.status, 201);
  const targetLocation = await targetLocationResponse.json();
  const actualOccurredAt = "2026-10-16T04:03:02.000Z";

  const inboundResponse = await post("/api/inventory/inbound", {
    productSpecId: product.id,
    locationId: product.locationId,
    cases: 3,
    loose: 2,
    actualOccurredAt,
    note: "库存盘点补录",
  }, employeeCookie);
  assert.equal(inboundResponse.status, 201);
  const inbound = await inboundResponse.json();

  const outboundResponse = await post("/api/inventory/outbound", {
    productSpecId: product.id,
    locationId: product.locationId,
    cases: 1,
    loose: 1,
    actualOccurredAt,
    note: "售后寄件",
  }, adminCookie);
  assert.equal(outboundResponse.status, 201);
  const outbound = await outboundResponse.json();

  const moveResponse = await post("/api/inventory/move", {
    productSpecId: product.id,
    sourceLocationId: product.locationId,
    targetLocationId: targetLocation.locationId,
    cases: 1,
    loose: 0,
    note: "调整存放位置",
    actualOccurredAt,
  }, employeeCookie);
  assert.equal(moveResponse.status, 201);
  const move = await moveResponse.json();

  const splitResponse = await post("/api/inventory/split", {
    productSpecId: product.id,
    locationId: product.locationId,
    cases: 1,
    actualOccurredAt,
    note: "拆件安装",
  }, adminCookie);
  assert.equal(splitResponse.status, 201);
  const split = await splitResponse.json();

  const adminId = await queryDatabase(
    "SELECT id::text AS id FROM admin_accounts WHERE account = $1",
    [adminAccount],
  );
  const employeeId = await queryDatabase(
    "SELECT id::text AS id FROM employee_accounts WHERE account = $1",
    [employeeAccount],
  );
  const expectedLogs = [
    {
      transaction: inbound,
      sourceSystem: "employee",
      actorAdminId: null,
      actorEmployeeId: employeeId.rows[0].id,
      actorAccount: employeeAccount,
      actorDisplayName: "库存日志测试员工",
      operationType: "inventory_inbound",
      content: {
        productSpecId: product.id,
        locationId: product.locationId,
        cases: 3,
        loose: 2,
        note: "库存盘点补录",
        actualOccurredAt,
      },
    },
    {
      transaction: outbound,
      sourceSystem: "admin",
      actorAdminId: adminId.rows[0].id,
      actorEmployeeId: null,
      actorAccount: adminAccount,
      actorDisplayName: "库存日志测试管理员",
      operationType: "inventory_outbound",
      content: {
        productSpecId: product.id,
        locationId: product.locationId,
        cases: 1,
        loose: 1,
        note: "售后寄件",
        actualOccurredAt,
      },
    },
    {
      transaction: move,
      sourceSystem: "employee",
      actorAdminId: null,
      actorEmployeeId: employeeId.rows[0].id,
      actorAccount: employeeAccount,
      actorDisplayName: "库存日志测试员工",
      operationType: "inventory_move",
      content: {
        productSpecId: product.id,
        sourceLocationId: product.locationId,
        targetLocationId: targetLocation.locationId,
        cases: 1,
        loose: 0,
        note: "调整存放位置",
        actualOccurredAt,
      },
    },
    {
      transaction: split,
      sourceSystem: "admin",
      actorAdminId: adminId.rows[0].id,
      actorEmployeeId: null,
      actorAccount: adminAccount,
      actorDisplayName: "库存日志测试管理员",
      operationType: "inventory_split",
      content: {
        productSpecId: product.id,
        locationId: product.locationId,
        casesSplit: 1,
        perCase: 4,
        looseAdded: 4,
        note: "拆件安装",
        actualOccurredAt,
      },
    },
  ];

  for (const expected of expectedLogs) {
    const logs = await logsForTransaction(expected.transaction.transactionId);
    assert.equal(logs.rowCount, 1);
    assert.deepEqual({
      sourceSystem: logs.rows[0].source_system,
      operationType: logs.rows[0].operation_type,
      targetType: logs.rows[0].target_type,
      targetId: logs.rows[0].target_id,
      actorAdminId: logs.rows[0].actor_admin_account_id,
      actorEmployeeId: logs.rows[0].actor_employee_account_id,
      actorAccount: logs.rows[0].actor_account_snapshot,
      actorDisplayName: logs.rows[0].actor_display_name_snapshot,
      content: logs.rows[0].operation_content,
    }, {
      sourceSystem: expected.sourceSystem,
      operationType: expected.operationType,
      targetType: "inventory_transaction",
      targetId: expected.transaction.transactionId,
      actorAdminId: expected.actorAdminId,
      actorEmployeeId: expected.actorEmployeeId,
      actorAccount: expected.actorAccount,
      actorDisplayName: expected.actorDisplayName,
      content: expected.content,
    });
    assert.ok(logs.rows[0].recorded_at instanceof Date);
    assert.equal(logs.rows[0].recorded_at.toISOString(), logs.rows[0].transaction_recorded_at.toISOString());
  }
});

test("inventory failures and operation log failures do not leave successful business records", async () => {
  const adminCookie = await login("admin", adminAccount);
  const productResponse = await post("/api/catalog/products", {
    name: `${accountPrefix} 失败回滚商品`,
    category: "类别",
    categoryName: "分类",
    spec: "四个一件",
    perCase: 4,
    note: "",
    warehouse: `${accountPrefix} 失败仓库`,
    spot: "A 位",
  }, adminCookie);
  assert.equal(productResponse.status, 201);
  const product = await productResponse.json();
  const actualOccurredAt = "2026-10-16T04:03:02.000Z";

  const insufficientOutbound = await post("/api/inventory/outbound", {
    productSpecId: product.id,
    locationId: product.locationId,
    cases: 1,
    loose: 0,
    actualOccurredAt,
  }, adminCookie);
  assert.equal(insufficientOutbound.status, 409);
  const failedTransactionCount = await queryDatabase(
    "SELECT COUNT(*)::INTEGER AS count FROM inventory_transactions WHERE product_spec_id = $1",
    [product.id],
  );
  const failedLogCount = await queryDatabase(
    "SELECT COUNT(*)::INTEGER AS count FROM system_operation_logs WHERE target_type = 'inventory_transaction'",
  );
  assert.equal(failedTransactionCount.rows[0].count, 0);
  assert.equal(failedLogCount.rows[0].count, 4);

  await queryDatabase(`
    CREATE FUNCTION issue29_reject_inventory_log() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.operation_type = 'inventory_inbound' THEN
        RAISE EXCEPTION 'simulated operation log write failure';
      END IF;
      RETURN NEW;
    END;
    $$
  `);
  await queryDatabase(`
    CREATE TRIGGER issue29_reject_inventory_log
    BEFORE INSERT ON system_operation_logs
    FOR EACH ROW EXECUTE FUNCTION issue29_reject_inventory_log()
  `);

  const failedLogInbound = await post("/api/inventory/inbound", {
    productSpecId: product.id,
    locationId: product.locationId,
    cases: 2,
    loose: 1,
    actualOccurredAt,
  }, adminCookie);
  assert.equal(failedLogInbound.status, 500);
  const afterFailure = await queryDatabase(
    `SELECT location.case_count, location.loose_count,
            (SELECT COUNT(*)::INTEGER FROM inventory_transactions WHERE product_spec_id = $1) AS transaction_count,
            (SELECT COUNT(*)::INTEGER FROM system_operation_logs
              WHERE target_type = 'inventory_transaction'
                AND target_id IN (SELECT id FROM inventory_transactions WHERE product_spec_id = $1)) AS log_count
       FROM product_spec_locations AS location
      WHERE location.product_spec_id = $1
        AND location.location_id = $2`,
    [product.id, product.locationId],
  );
  assert.deepEqual(afterFailure.rows[0], {
    case_count: 0,
    loose_count: 0,
    transaction_count: 0,
    log_count: 0,
  });
  await queryDatabase("DROP TRIGGER issue29_reject_inventory_log ON system_operation_logs");
  await queryDatabase("DROP FUNCTION issue29_reject_inventory_log()");
});

test("concurrent admin and employee outbounds cannot consume the same last loose item", async () => {
  const adminCookie = await login("admin", adminAccount);
  const employeeCookie = await login("employee", employeeAccount);
  const productResponse = await post("/api/catalog/products", {
    name: `${accountPrefix} 并发库存商品`,
    category: "类别",
    categoryName: "分类",
    spec: "四个一件",
    perCase: 4,
    note: "",
    warehouse: `${accountPrefix} 并发仓库`,
    spot: "A 位",
  }, adminCookie);
  assert.equal(productResponse.status, 201);
  const product = await productResponse.json();
  const actualOccurredAt = "2026-10-16T04:03:02.000Z";

  const inboundResponse = await post("/api/inventory/inbound", {
    productSpecId: product.id,
    locationId: product.locationId,
    cases: 0,
    loose: 1,
    actualOccurredAt,
  }, adminCookie);
  assert.equal(inboundResponse.status, 201);

  const lockClient = await pool.connect();
  let lockOpen = false;
  try {
    await assertIsolatedConnection(lockClient);
    await lockClient.query("BEGIN");
    lockOpen = true;
    const inventory = await lockClient.query(
      `SELECT case_count, loose_count
         FROM product_spec_locations
        WHERE product_spec_id = $1
          AND location_id = $2
        FOR UPDATE`,
      [product.id, product.locationId],
    );
    assert.deepEqual(inventory.rows[0], { case_count: 0, loose_count: 1 });

    const submissions = [
      post("/api/inventory/outbound", {
        productSpecId: product.id,
        locationId: product.locationId,
        cases: 0,
        loose: 1,
        actualOccurredAt,
      }, adminCookie),
      post("/api/inventory/outbound", {
        productSpecId: product.id,
        locationId: product.locationId,
        cases: 0,
        loose: 1,
        actualOccurredAt,
      }, employeeCookie),
    ];

    let observedWaiters = 0;
    let waitError;
    try {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const waiters = await queryDatabase(
          `SELECT COUNT(*)::INTEGER AS count
             FROM pg_stat_activity
            WHERE pid <> pg_backend_pid()
              AND datname = current_database()
              AND wait_event_type = 'Lock'
              AND query LIKE '%product_spec_locations%'`,
        );
        observedWaiters = waiters.rows[0].count;
        if (observedWaiters === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(observedWaiters, 2, "both HTTP submissions should be waiting on the locked inventory row");
    } catch (error) {
      waitError = error;
    } finally {
      await lockClient.query("ROLLBACK");
      lockOpen = false;
    }

    const results = await Promise.allSettled(submissions);
    if (waitError) throw waitError;

    const responses = results.map((result) => {
      assert.equal(result.status, "fulfilled");
      return result.value;
    });
    assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
  } finally {
    if (lockOpen) await lockClient.query("ROLLBACK");
    lockClient.release();
  }

  const finalState = await queryDatabase(
    `SELECT location.case_count, location.loose_count,
            (SELECT COUNT(*)::INTEGER
               FROM inventory_transactions
              WHERE product_spec_id = $1) AS transaction_count,
            (SELECT COUNT(*)::INTEGER
               FROM system_operation_logs AS log
               JOIN inventory_transactions AS tx
                 ON log.target_type = 'inventory_transaction'
                AND log.target_id = tx.id
              WHERE tx.product_spec_id = $1) AS log_count
       FROM product_spec_locations AS location
      WHERE location.product_spec_id = $1
        AND location.location_id = $2`,
    [product.id, product.locationId],
  );
  assert.deepEqual(finalState.rows[0], {
    case_count: 0,
    loose_count: 0,
    transaction_count: 2,
    log_count: 2,
  });
});
