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
const testSchema = `issue27_import_${process.pid}_${randomBytes(6).toString("hex")}`;
const isolatedDatabaseUrl = new URL(testDatabaseUrl);
isolatedDatabaseUrl.searchParams.set("options", `-c search_path=${testSchema}`);

const apiDirectory = fileURLToPath(new URL("..", import.meta.url));
const nextCli = fileURLToPath(new URL("../../../node_modules/next/dist/bin/next", import.meta.url));
const migrationCli = fileURLToPath(new URL("../scripts/migrate.js", import.meta.url));
const accountPrefix = `t17-test-${process.pid}-${Date.now()}`;
const password = "test-only-initial-import-password";
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

function assertIsolatedConnection(client) {
  return client.query(
    `SELECT current_schema() AS schema,
            current_schemas(false) @> ARRAY[$1]::name[] AS contains_schema,
            cardinality(current_schemas(false)) AS schema_count,
            'public' = ANY(current_schemas(false)) AS contains_public`,
    [testSchema],
  ).then((result) => {
    assert.equal(result.rows[0].schema, testSchema);
    assert.equal(result.rows[0].contains_schema, true);
    assert.equal(result.rows[0].schema_count, 1);
    assert.equal(result.rows[0].contains_public, false);
  });
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

async function postJson(path, body, cookie) {
  return request(path, {
    method: "POST",
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
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
    [adminAccount, "初始库存测试管理员", passwordHash],
  );
  await queryDatabase(
    `INSERT INTO employee_accounts (account, display_name, password_hash)
     VALUES ($1, $2, $3)`,
    [employeeAccount, "初始库存测试员工", passwordHash],
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

test("admin submits grouped initial inventory and appends to manual and earlier imports", async () => {
  const anonymous = await postJson("/api/admin/initial-inventory/imports", { rows: [] });
  assert.equal(anonymous.status, 401);

  const employeeCookie = await login("employee", employeeAccount);
  const employeeWrite = await postJson("/api/admin/initial-inventory/imports", { rows: [] }, employeeCookie);
  assert.equal(employeeWrite.status, 403);

  const adminCookie = await login("admin", adminAccount);
  const productIdentity = {
    productName: `${accountPrefix}-灯具`,
    spec: "E27",
    material: "铝合金",
    color: "白色",
  };
  const warehouse = `${accountPrefix}-一号仓`;
  const spot = "A-01";
  const productResponse = await postJson("/api/catalog/products", {
    name: productIdentity.productName,
    spec: productIdentity.spec,
    material: productIdentity.material,
    color: productIdentity.color,
    perCase: 6,
    warehouse,
    spot,
    category: "灯具",
    categoryName: "室内",
    note: "保留产品备注",
  }, adminCookie);
  assert.equal(productResponse.status, 201);
  const existingProduct = await productResponse.json();

  const inboundResponse = await postJson("/api/inventory/inbound", {
    productSpecId: existingProduct.id,
    locationId: existingProduct.locationId,
    cases: 2,
    loose: 1,
    actualOccurredAt: new Date().toISOString(),
  }, adminCookie);
  assert.equal(inboundResponse.status, 201);

  const importRows = [
    { ...productIdentity, perCase: 6, category: "灯具", categoryName: "室内", note: "保留产品备注", warehouse, spot, cases: 1, loose: 2 },
    { ...productIdentity, perCase: 6, category: "灯具", categoryName: "室内", note: "保留产品备注", warehouse, spot, cases: 2, loose: 3 },
    { ...productIdentity, perCase: 4, category: "灯具", categoryName: "室内", note: "另一包装", warehouse, spot, cases: 1, loose: 4 },
    { ...productIdentity, material: "塑料", perCase: 6, warehouse, spot, cases: 1, loose: 0 },
    { ...productIdentity, color: "黑色", perCase: 6, warehouse, spot, cases: 1, loose: 0 },
    { productName: null, spec: "", material: null, color: "", perCase: 2, warehouse, spot: "B-02", cases: 1, loose: 1 },
    { productName: "", spec: null, material: "", color: null, perCase: 2, warehouse, spot: "B-02", cases: 2, loose: 3 },
  ];

  const firstImport = await postJson("/api/admin/initial-inventory/imports", { rows: importRows }, adminCookie);
  assert.equal(firstImport.status, 201);
  assert.deepEqual(await firstImport.json(), { receivedRows: 7, importedRows: 5 });

  const catalogResponse = await request("/api/catalog/products", { headers: { Cookie: adminCookie } });
  assert.equal(catalogResponse.status, 200);
  const catalog = await catalogResponse.json();
  const sixPack = catalog.find((product) => product.id === existingProduct.id);
  assert.deepEqual({ cases: sixPack.cases, loose: sixPack.loose }, { cases: 5, loose: 6 });
  assert.equal(catalog.filter((product) => product.name === productIdentity.productName && product.perCase === 4).length, 1);
  const fourPack = catalog.find((product) => product.name === productIdentity.productName && product.perCase === 4);
  assert.deepEqual({ cases: fourPack.cases, loose: fourPack.loose }, { cases: 1, loose: 4 });
  assert.deepEqual(
    { category: fourPack.category, categoryName: fourPack.categoryName, note: fourPack.note },
    { category: "灯具", categoryName: "室内", note: "另一包装" },
  );
  assert.deepEqual(
    catalog.filter((product) => product.name === productIdentity.productName && product.perCase === 6)
      .map(({ material, color, cases, loose }) => ({ material, color, cases, loose }))
      .sort((left, right) => `${left.material}-${left.color}`.localeCompare(`${right.material}-${right.color}`)),
    [
      { material: "铝合金", color: "白色", cases: 5, loose: 6 },
      { material: "铝合金", color: "黑色", cases: 1, loose: 0 },
      { material: "塑料", color: "白色", cases: 1, loose: 0 },
    ].sort((left, right) => `${left.material}-${left.color}`.localeCompare(`${right.material}-${right.color}`)),
  );
  assert.equal(catalog.filter((product) => product.name === "" && product.spec === "" && product.material === "" && product.color === "" && product.perCase === 2).length, 1);
  const blankIdentityProduct = catalog.find((product) => product.name === "" && product.perCase === 2);
  assert.deepEqual({ cases: blankIdentityProduct.cases, loose: blankIdentityProduct.loose }, { cases: 3, loose: 4 });

  const repeatImport = await postJson("/api/admin/initial-inventory/imports", { rows: importRows }, adminCookie);
  assert.equal(repeatImport.status, 201);
  const afterRepeat = await request("/api/catalog/products", { headers: { Cookie: adminCookie } });
  const repeatedCatalog = await afterRepeat.json();
  const repeatedSixPack = repeatedCatalog.find((product) => product.id === existingProduct.id);
  assert.deepEqual({ cases: repeatedSixPack.cases, loose: repeatedSixPack.loose }, { cases: 8, loose: 11 });

  const history = await request("/api/inventory/history?type=initial", { headers: { Cookie: adminCookie } });
  assert.equal(history.status, 200);
  const historyRecords = (await history.json()).records;
  assert.equal(historyRecords.length, 10);
  assert.ok(historyRecords.every((record) => record.operationType === "initial" && record.sourceSystem === "admin" && record.actor.account === adminAccount));
  assert.equal(historyRecords.filter((record) => record.product.id === existingProduct.id).length, 2);
  const importLogs = await queryDatabase(
    `SELECT operation_type, source_system, operation_content
       FROM system_operation_logs
      WHERE actor_account_snapshot = $1 AND operation_type = 'initial_inventory_import'
      ORDER BY id`,
    [adminAccount],
  );
  assert.equal(importLogs.rowCount, 10);
  assert.deepEqual(importLogs.rows[0].operation_content.sourceRows, [1, 2]);
});

test("invalid rows reject the entire batch and a stock capacity conflict rolls back earlier rows", async () => {
  const adminCookie = await login("admin", adminAccount);
  const invalidResponse = await postJson("/api/admin/initial-inventory/imports", {
    rows: [
      { productName: `${accountPrefix}-不会写入`, spec: "S1", material: "", color: "", perCase: 2, warehouse: `${accountPrefix}-仓`, spot: "A-01", cases: 1, loose: 0 },
      { productName: `${accountPrefix}-无效行`, spec: "S2", material: "", color: "", perCase: 2, warehouse: `${accountPrefix}-仓`, spot: "A-02", cases: -1, loose: 0 },
    ],
  }, adminCookie);
  assert.equal(invalidResponse.status, 400);

  const invalidBatchProducts = await queryDatabase(
    "SELECT count(*)::integer AS count FROM product_specs WHERE product_name = $1",
    [`${accountPrefix}-不会写入`],
  );
  assert.equal(invalidBatchProducts.rows[0].count, 0);

  const boundaryResponse = await postJson("/api/catalog/products", {
    name: `${accountPrefix}-库存上限`,
    spec: "S3",
    perCase: 2,
    warehouse: `${accountPrefix}-上限仓`,
    spot: "MAX",
  }, adminCookie);
  assert.equal(boundaryResponse.status, 201);
  const boundaryProduct = await boundaryResponse.json();
  await queryDatabase(
    `UPDATE product_spec_locations
        SET case_count = 2147483647
      WHERE product_spec_id = $1 AND location_id = $2`,
    [boundaryProduct.id, boundaryProduct.locationId],
  );

  const rollbackResponse = await postJson("/api/admin/initial-inventory/imports", {
    rows: [
      { productName: `${accountPrefix}-回滚首行`, spec: "S4", material: "", color: "", perCase: 2, warehouse: `${accountPrefix}-回滚仓`, spot: "A-01", cases: 1, loose: 0 },
      { productName: `${accountPrefix}-库存上限`, spec: "S3", material: "", color: "", perCase: 2, warehouse: `${accountPrefix}-上限仓`, spot: "MAX", cases: 1, loose: 0 },
    ],
  }, adminCookie);
  assert.equal(rollbackResponse.status, 409);

  const rolledBackProduct = await queryDatabase(
    "SELECT count(*)::integer AS count FROM product_specs WHERE product_name = $1",
    [`${accountPrefix}-回滚首行`],
  );
  assert.equal(rolledBackProduct.rows[0].count, 0);
  const rolledBackHistory = await queryDatabase(
    `SELECT count(*)::integer AS count
       FROM inventory_transactions t
       JOIN product_specs p ON p.id = t.product_spec_id
      WHERE t.actor_account = $1 AND p.product_name = $2`,
    [adminAccount, `${accountPrefix}-回滚首行`],
  );
  assert.equal(rolledBackHistory.rows[0].count, 0);
  const unchangedMaximum = await queryDatabase(
    `SELECT case_count FROM product_spec_locations
      WHERE product_spec_id = $1 AND location_id = $2`,
    [boundaryProduct.id, boundaryProduct.locationId],
  );
  assert.equal(unchangedMaximum.rows[0].case_count, 2147483647);
});
