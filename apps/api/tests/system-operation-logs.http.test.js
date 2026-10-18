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

const testSchema = `issue32_system_logs_${process.pid}_${randomBytes(6).toString("hex")}`;
const isolatedDatabaseUrl = new URL(testDatabaseUrl);
isolatedDatabaseUrl.searchParams.set("options", `-c search_path=${testSchema}`);
const apiDirectory = fileURLToPath(new URL("..", import.meta.url));
const nextCli = fileURLToPath(new URL("../../../node_modules/next/dist/bin/next", import.meta.url));
const migrationCli = fileURLToPath(new URL("../scripts/migrate.js", import.meta.url));
const accountPrefix = `t22-test-${process.pid}-${Date.now()}`;
const password = "test-only-system-logs-password";
let pool;
let serverProcess;
let baseUrl;
let admins;
let employees;
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

async function insertLog({ actor, sourceSystem, operationType, targetType, targetId, content }) {
  return queryDatabase(
    `INSERT INTO system_operation_logs (
       actor_admin_account_id, actor_employee_account_id,
       actor_account_snapshot, actor_display_name_snapshot, source_system,
       operation_type, target_type, target_id, operation_content
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      sourceSystem === "admin" ? actor.id : null,
      sourceSystem === "employee" ? actor.id : null,
      actor.account,
      actor.displayName,
      sourceSystem,
      operationType,
      targetType,
      targetId,
      content,
    ],
  );
}

async function apiGet(path, cookie) {
  return request(path, { headers: cookie ? { Cookie: cookie } : {} });
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

  const adminHash = await hashPassword(password);
  const employeeHash = await hashPassword(password);
  const adminAccounts = await queryDatabase(
    `INSERT INTO admin_accounts (account, display_name, password_hash)
     VALUES ($1, $2, $3), ($4, $5, $6)
     RETURNING id::text AS id, account, display_name AS "displayName"`,
    [
      `${accountPrefix}-admin-a`, "管理员甲", adminHash,
      `${accountPrefix}-admin-b`, "管理员乙", adminHash,
    ],
  );
  const employeeAccounts = await queryDatabase(
    `INSERT INTO employee_accounts (account, display_name, password_hash)
     VALUES ($1, $2, $3), ($4, $5, $6)
     RETURNING id::text AS id, account, display_name AS "displayName"`,
    [
      `${accountPrefix}-employee-a`, "员工甲", employeeHash,
      `${accountPrefix}-employee-b`, "员工乙", employeeHash,
    ],
  );
  admins = adminAccounts.rows;
  employees = employeeAccounts.rows;

  await insertLog({
    actor: admins[0], sourceSystem: "admin", operationType: "employee_account_created",
    targetType: "employee_account", targetId: 901,
    content: { account: `${accountPrefix}-new-hire`, displayName: "新员工甲" },
  });
  await insertLog({
    actor: admins[1], sourceSystem: "admin", operationType: "product_spec_created",
    targetType: "product_spec", targetId: 902,
    content: { productName: "铜制螺丝", spec: "M8", material: "铜" },
  });
  await insertLog({
    actor: employees[0], sourceSystem: "employee", operationType: "inventory_inbound",
    targetType: "inventory_transaction", targetId: 903,
    content: { productName: "铁螺栓", spec: "M6", cases: 3, loose: 2 },
  });
  await insertLog({
    actor: employees[1], sourceSystem: "employee", operationType: "location_created",
    targetType: "location", targetId: 904,
    content: { warehouse: "北仓", spot: "T-32" },
  });

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

test("administrators can filter both systems' operation logs by source, operator, and content", async () => {
  const adminCookie = await login("admin", admins[0].account);
  const defaultResponse = await apiGet("/api/admin/system-logs", adminCookie);
  assert.equal(defaultResponse.status, 200);
  assert.equal(defaultResponse.headers.get("cache-control"), "no-store");
  const defaultBody = await defaultResponse.json();
  assert.equal(defaultBody.records.length, 5);
  assert.deepEqual(new Set(defaultBody.records.map((record) => record.sourceSystem)), new Set(["admin", "employee"]));
  assert.deepEqual(
    new Set(defaultBody.actors.map((actor) => actor.account)),
    new Set(admins.concat(employees).map((actor) => actor.account)),
  );
  assert.deepEqual(
    Object.keys(defaultBody.records[0]).sort(),
    ["actorAccount", "actorDisplayName", "content", "id", "operationType", "recordedAt", "sourceSystem", "targetId", "targetType"].sort(),
  );

  const employeeSource = await apiGet("/api/admin/system-logs?source=employee", adminCookie);
  assert.deepEqual((await employeeSource.json()).records.map((record) => record.sourceSystem), ["employee", "employee"]);
  const adminSource = await apiGet("/api/admin/system-logs?source=admin", adminCookie);
  assert.deepEqual((await adminSource.json()).records.map((record) => record.sourceSystem), ["admin", "admin", "admin"]);

  const filters = new URLSearchParams({
    source: "employee",
    actorAccount: employees[0].account,
    q: "铁螺栓",
  });
  const filtered = await apiGet(`/api/admin/system-logs?${filters}`, adminCookie);
  const filteredBody = await filtered.json();
  assert.equal(filtered.status, 200);
  assert.equal(filteredBody.records.length, 1);
  assert.equal(filteredBody.records[0].actorAccount, employees[0].account);
  assert.equal(filteredBody.records[0].actorDisplayName, employees[0].displayName);
  assert.equal(filteredBody.records[0].content.productName, "铁螺栓");

  const accountSearch = await apiGet(
    `/api/admin/system-logs?q=${encodeURIComponent(`${accountPrefix}-new-hire`)}`,
    adminCookie,
  );
  const accountSearchBody = await accountSearch.json();
  assert.equal(accountSearchBody.records.length, 1);
  assert.equal(accountSearchBody.records[0].operationType, "employee_account_created");

  const noResults = await apiGet("/api/admin/system-logs?q=no-matching-operation", adminCookie);
  assert.deepEqual((await noResults.json()).records, []);

  const invalidSource = await apiGet("/api/admin/system-logs?source=other", adminCookie);
  assert.equal(invalidSource.status, 400);
});

test("employee log endpoint remains employee-only even when a request asks for administrator logs", async () => {
  const employeeCookie = await login("employee", employees[0].account);
  const response = await apiGet("/api/employee/system-logs?source=admin", employeeCookie);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.records.length, 3);
  assert.deepEqual(new Set(body.records.map((record) => record.sourceSystem)), new Set(["employee"]));
  assert.deepEqual(new Set(body.actors.map((actor) => actor.account)), new Set(employees.map((actor) => actor.account)));

  const forgedFilters = new URLSearchParams({
    source: "admin",
    actorAccount: admins[0].account,
    q: accountPrefix,
  });
  const forgedRequest = await apiGet(`/api/employee/system-logs?${forgedFilters}`, employeeCookie);
  assert.deepEqual((await forgedRequest.json()).records, []);
});

test("each log endpoint rejects the opposite system's session and anonymous requests", async () => {
  const adminCookie = await login("admin", admins[0].account);
  const employeeCookie = await login("employee", employees[0].account);

  assert.equal((await apiGet("/api/admin/system-logs")).status, 401);
  assert.equal((await apiGet("/api/employee/system-logs")).status, 401);
  assert.equal((await apiGet("/api/admin/system-logs", employeeCookie)).status, 401);
  assert.equal((await apiGet("/api/employee/system-logs", adminCookie)).status, 401);
});
