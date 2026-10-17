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
const testSchema = `issue30_products_${process.pid}_${randomBytes(6).toString("hex")}`;
const isolatedDatabaseUrl = new URL(testDatabaseUrl);
isolatedDatabaseUrl.searchParams.set("options", `-c search_path=${testSchema}`);

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
let schemaCreated = false;
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

async function logsForTarget(targetType, targetId) {
  return queryDatabase(
    `SELECT source_system, operation_type, target_type, target_id::text AS target_id,
            actor_admin_account_id::text AS actor_admin_account_id,
            actor_employee_account_id::text AS actor_employee_account_id,
            actor_account_snapshot, actor_display_name_snapshot, operation_content, recorded_at
       FROM system_operation_logs
      WHERE target_type = $1 AND target_id = $2
      ORDER BY id`,
    [targetType, targetId],
  );
}

function visibleFields(products) {
  return products.map(({ name, material, color, category, categoryName, spec, perCase, note, warehouse, spot }) => ({
    name, material, color, category, categoryName, spec, perCase, note, warehouse, spot,
  }));
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
    [adminAccount, "规格测试管理员", passwordHash],
  );
  await queryDatabase(
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
      env: { ...process.env, DATABASE_URL: isolatedDatabaseUrl.toString() },
      stdio: "ignore",
      windowsHide: true,
    },
  );
  await waitForApi();
});

after(async () => {
  if (serverProcess && serverProcess.exitCode === null) serverProcess.kill();
  if (pool) {
    const operationLogTable = await queryDatabase("SELECT to_regclass('system_operation_logs') AS table_name");
    if (operationLogTable.rows[0].table_name) {
      await queryDatabase("DELETE FROM system_operation_logs WHERE actor_account_snapshot LIKE $1", [`${accountPrefix}%`]);
    }
    await queryDatabase("DELETE FROM product_specs WHERE product_name = ANY($1::text[])", [[...productNames]]);
    await queryDatabase("DELETE FROM locations WHERE warehouse_id IN (SELECT id FROM warehouses WHERE name = ANY($1::text[]))", [[...warehouseNames]]);
    await queryDatabase("DELETE FROM warehouses WHERE name = ANY($1::text[])", [[...warehouseNames]]);
    await queryDatabase("DELETE FROM admin_accounts WHERE account = $1", [adminAccount]);
    await queryDatabase("DELETE FROM employee_accounts WHERE account = $1", [employeeAccount]);
    await pool.end();
  }
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
    material: "铝合金",
    color: "白色",
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
  const adminProductLogs = await logsForTarget("product_spec", adminCreatedProduct.id);
  const adminIdentity = await queryDatabase(
    "SELECT id::text AS id FROM admin_accounts WHERE account = $1",
    [adminAccount],
  );
  assert.equal(adminProductLogs.rowCount, 1);
  assert.deepEqual({
    sourceSystem: adminProductLogs.rows[0].source_system,
    operationType: adminProductLogs.rows[0].operation_type,
    targetType: adminProductLogs.rows[0].target_type,
    targetId: adminProductLogs.rows[0].target_id,
    adminActorId: adminProductLogs.rows[0].actor_admin_account_id,
    employeeActorId: adminProductLogs.rows[0].actor_employee_account_id,
    actorAccount: adminProductLogs.rows[0].actor_account_snapshot,
    actorDisplayName: adminProductLogs.rows[0].actor_display_name_snapshot,
    content: adminProductLogs.rows[0].operation_content,
  }, {
    sourceSystem: "admin",
    operationType: "product_spec_created",
    targetType: "product_spec",
    targetId: adminCreatedProduct.id,
    adminActorId: adminIdentity.rows[0].id,
    employeeActorId: null,
    actorAccount: adminAccount,
    actorDisplayName: "规格测试管理员",
    content: {
      productName: firstProduct.name,
      material: firstProduct.material,
      color: firstProduct.color,
      spec: firstProduct.spec,
      category: firstProduct.category,
      categoryName: firstProduct.categoryName,
      perCaseCount: firstProduct.perCase,
      note: firstProduct.note,
      warehouse: firstProduct.warehouse,
      spot: firstProduct.spot,
    },
  });
  assert.ok(adminProductLogs.rows[0].recorded_at instanceof Date);

  const afterRefresh = await requestProduct("GET", undefined, employeeCookie);
  assert.equal(afterRefresh.status, 200);
  const employeeProducts = await afterRefresh.json();
  assert.deepEqual(visibleFields(employeeProducts), [firstProduct]);
  assert.equal(employeeProducts[0].id, adminCreatedProduct.id);
  assert.equal(employeeProducts[0].locationId, adminCreatedProduct.locationId);

  const secondProduct = {
    name: `${accountPrefix} 同步商品`,
    material: "铝合金",
    color: "白色",
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
  const employeeCreatedProduct = await createdByEmployee.json();
  assert.deepEqual(visibleFields([employeeCreatedProduct]), [secondProduct]);
  const employeeProductLogs = await logsForTarget("product_spec", employeeCreatedProduct.id);
  const employeeIdentity = await queryDatabase(
    "SELECT id::text AS id FROM employee_accounts WHERE account = $1",
    [employeeAccount],
  );
  assert.equal(employeeProductLogs.rowCount, 1);
  assert.deepEqual({
    sourceSystem: employeeProductLogs.rows[0].source_system,
    operationType: employeeProductLogs.rows[0].operation_type,
    targetId: employeeProductLogs.rows[0].target_id,
    adminActorId: employeeProductLogs.rows[0].actor_admin_account_id,
    employeeActorId: employeeProductLogs.rows[0].actor_employee_account_id,
    actorAccount: employeeProductLogs.rows[0].actor_account_snapshot,
    actorDisplayName: employeeProductLogs.rows[0].actor_display_name_snapshot,
    productName: employeeProductLogs.rows[0].operation_content.productName,
  }, {
    sourceSystem: "employee",
    operationType: "product_spec_created",
    targetId: employeeCreatedProduct.id,
    adminActorId: null,
    employeeActorId: employeeIdentity.rows[0].id,
    actorAccount: employeeAccount,
    actorDisplayName: "规格测试员工",
    productName: secondProduct.name,
  });
  assert.ok(employeeProductLogs.rows[0].recorded_at instanceof Date);

  const differentMaterial = {
    ...firstProduct,
    material: "塑料",
    perCase: 4,
    warehouse: `${accountPrefix} 仓库丙`,
    spot: "货位丙",
  };
  warehouseNames.add(differentMaterial.warehouse);
  assert.equal((await requestProduct("POST", differentMaterial, employeeCookie)).status, 201);

  const differentColor = {
    ...firstProduct,
    color: "黑色",
    perCase: 4,
    warehouse: `${accountPrefix} 仓库丁`,
    spot: "货位丁",
  };
  warehouseNames.add(differentColor.warehouse);
  assert.equal((await requestProduct("POST", differentColor, employeeCookie)).status, 201);

  const adminSeesBoth = await requestProduct("GET", undefined, adminCookie);
  assert.equal(adminSeesBoth.status, 200);
  assert.deepEqual(visibleFields(await adminSeesBoth.json()), [firstProduct, secondProduct, differentMaterial, differentColor]);
});

test("blank category fields remain separate and item count is limited to 2, 4, or 6", async () => {
  const employeeCookie = await login("employee", employeeAccount);
  const blankCategories = {
    name: "",
    material: "",
    color: "",
    category: "",
    categoryName: "",
    spec: "",
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

  const nullIdentityDuplicate = await requestProduct("POST", {
    ...blankCategories,
    name: null,
    material: null,
    color: null,
    spec: null,
    warehouse: `${accountPrefix} 不同仓库`,
    spot: "其他货位",
  }, employeeCookie);
  assert.equal(nullIdentityDuplicate.status, 409);

  const invalidCount = await requestProduct("POST", { ...blankCategories, perCase: 3 }, employeeCookie);
  assert.equal(invalidCount.status, 400);
  assert.deepEqual(visibleFields(await (await requestProduct("GET", undefined, employeeCookie)).json()), [
    {
      name: `${accountPrefix} 同步商品`, material: "铝合金", color: "白色", category: "类别甲", categoryName: "分类名称甲", spec: "四个一件", perCase: 4,
      note: "备注甲", warehouse: `${accountPrefix} 仓库甲`, spot: "货位甲",
    },
    {
      name: `${accountPrefix} 同步商品`, material: "铝合金", color: "白色", category: "类别乙", categoryName: "分类名称乙", spec: "四个一件", perCase: 2,
      note: "备注乙", warehouse: `${accountPrefix} 仓库乙`, spot: "货位乙",
    },
    {
      name: `${accountPrefix} 同步商品`, material: "塑料", color: "白色", category: "类别甲", categoryName: "分类名称甲", spec: "四个一件", perCase: 4,
      note: "备注甲", warehouse: `${accountPrefix} 仓库丙`, spot: "货位丙",
    },
    {
      name: `${accountPrefix} 同步商品`, material: "铝合金", color: "黑色", category: "类别甲", categoryName: "分类名称甲", spec: "四个一件", perCase: 4,
      note: "备注甲", warehouse: `${accountPrefix} 仓库丁`, spot: "货位丁",
    },
    blankCategories,
  ]);
});

test("admin and employee add persisted zero-stock locations to existing specifications", async () => {
  const adminCookie = await login("admin", adminAccount);
  const employeeCookie = await login("employee", employeeAccount);
  const product = {
    name: `${accountPrefix} 货位测试商品`,
    material: "塑料",
    color: "黑色",
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
  const employeeLocationLogs = await logsForTarget("location", employeeAddedLocation.locationId);
  const employeeIdentity = await queryDatabase(
    "SELECT id::text AS id FROM employee_accounts WHERE account = $1",
    [employeeAccount],
  );
  assert.equal(employeeLocationLogs.rowCount, 1);
  assert.deepEqual({
    sourceSystem: employeeLocationLogs.rows[0].source_system,
    operationType: employeeLocationLogs.rows[0].operation_type,
    adminActorId: employeeLocationLogs.rows[0].actor_admin_account_id,
    employeeActorId: employeeLocationLogs.rows[0].actor_employee_account_id,
    actorAccount: employeeLocationLogs.rows[0].actor_account_snapshot,
    actorDisplayName: employeeLocationLogs.rows[0].actor_display_name_snapshot,
    content: employeeLocationLogs.rows[0].operation_content,
  }, {
    sourceSystem: "employee",
    operationType: "location_created",
    adminActorId: null,
    employeeActorId: employeeIdentity.rows[0].id,
    actorAccount: employeeAccount,
    actorDisplayName: "规格测试员工",
    content: {
      productSpecId: createdProduct.id,
      productName: product.name,
      material: product.material,
      color: product.color,
      spec: product.spec,
      perCaseCount: product.perCase,
      warehouse: employeeLocation.warehouse,
      spot: employeeLocation.spot,
    },
  });
  assert.ok(employeeLocationLogs.rows[0].recorded_at instanceof Date);

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
  const adminLocationLogs = await logsForTarget("location", adminAddedLocation.locationId);
  assert.equal(adminLocationLogs.rowCount, 1);
  assert.equal(adminLocationLogs.rows[0].source_system, "admin");
  assert.equal(adminLocationLogs.rows[0].operation_type, "location_created");
  assert.equal(adminLocationLogs.rows[0].actor_account_snapshot, adminAccount);
  assert.equal(adminLocationLogs.rows[0].actor_display_name_snapshot, "规格测试管理员");
  assert.equal(adminLocationLogs.rows[0].operation_content.spot, adminLocation.spot);
  assert.ok(adminLocationLogs.rows[0].recorded_at instanceof Date);

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
  const duplicateLocationLogs = await queryDatabase(
    `SELECT COUNT(*)::INTEGER AS count
       FROM system_operation_logs
      WHERE operation_type = 'location_created'
        AND operation_content->>'productSpecId' = $1
        AND operation_content->>'warehouse' = $2
        AND LOWER(operation_content->>'spot') = LOWER($3)`,
    [createdProduct.id, employeeLocation.warehouse, employeeLocation.spot],
  );
  assert.equal(duplicateLocationLogs.rows[0].count, 1);

  const missingProductResponse = await requestLocation({ ...employeeLocation, productSpecId: "9223372036854775807" }, adminCookie);
  assert.equal(missingProductResponse.status, 404);
});

test("a failed product log rolls back the product and its initial location", async () => {
  const adminCookie = await login("admin", adminAccount);
  const product = {
    name: `${accountPrefix} 日志失败回滚商品`,
    material: "不锈钢",
    color: "银色",
    category: "类别",
    categoryName: "分类名称",
    spec: "四个一件",
    perCase: 4,
    note: "",
    warehouse: `${accountPrefix} 日志失败回滚仓库`,
    spot: "货位",
  };
  productNames.add(product.name);
  warehouseNames.add(product.warehouse);

  await queryDatabase(`
    CREATE FUNCTION issue30_reject_product_log() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.operation_type = 'product_spec_created' THEN
        RAISE EXCEPTION 'simulated operation log write failure';
      END IF;
      RETURN NEW;
    END;
    $$
  `);
  await queryDatabase(`
    CREATE TRIGGER issue30_reject_product_log
    BEFORE INSERT ON system_operation_logs
    FOR EACH ROW EXECUTE FUNCTION issue30_reject_product_log()
  `);

  const response = await requestProduct("POST", product, adminCookie);
  assert.equal(response.status, 500);
  const products = await queryDatabase(
    "SELECT COUNT(*)::INTEGER AS count FROM product_specs WHERE product_name = $1",
    [product.name],
  );
  const warehouses = await queryDatabase(
    "SELECT COUNT(*)::INTEGER AS count FROM warehouses WHERE name = $1",
    [product.warehouse],
  );
  const logs = await queryDatabase(
    "SELECT COUNT(*)::INTEGER AS count FROM system_operation_logs WHERE operation_content->>'productName' = $1",
    [product.name],
  );
  assert.equal(products.rows[0].count, 0);
  assert.equal(warehouses.rows[0].count, 0);
  assert.equal(logs.rows[0].count, 0);

  await queryDatabase("DROP TRIGGER issue30_reject_product_log ON system_operation_logs");
  await queryDatabase("DROP FUNCTION issue30_reject_product_log()");
});
