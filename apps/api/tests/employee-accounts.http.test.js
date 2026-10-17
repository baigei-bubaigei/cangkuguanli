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
const testSchema = `issue30_employee_accounts_${process.pid}_${randomBytes(6).toString("hex")}`;
const isolatedDatabaseUrl = new URL(testDatabaseUrl);
isolatedDatabaseUrl.searchParams.set("options", `-c search_path=${testSchema}`);

const apiDirectory = fileURLToPath(new URL("..", import.meta.url));
const nextCli = fileURLToPath(new URL("../../../node_modules/next/dist/bin/next", import.meta.url));
const migrationCli = fileURLToPath(new URL("../scripts/migrate.js", import.meta.url));
const accountPrefix = `t14-test-${process.pid}-${Date.now()}`;
const employeePassword = "test-only-existing-employee-password";
const newEmployeePassword = "test-only-new-employee-password";
const adminPassword = "test-only-employee-account-admin-password";
let pool;
let serverProcess;
let baseUrl;
let adminAccount;
let existingEmployeeAccount;
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
      const response = await fetch(`${baseUrl}/api/employee/auth/session`);
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

async function login(system, account, password) {
  return request(`/api/${system}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ account, password }),
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

async function logsForEmployee(employeeId) {
  return queryDatabase(
    `SELECT source_system, operation_type, target_type, target_id::text AS target_id,
            actor_admin_account_id::text AS actor_admin_account_id,
            actor_employee_account_id::text AS actor_employee_account_id,
            actor_account_snapshot, actor_display_name_snapshot, operation_content, recorded_at
       FROM system_operation_logs
      WHERE target_type = 'employee_account' AND target_id = $1
      ORDER BY id`,
    [employeeId],
  );
}

function cookieFrom(response, name) {
  const setCookie = response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`));
  assert.ok(setCookie, `login response should set ${name}`);
  assert.match(setCookie, /HttpOnly/i);
  return setCookie.split(";", 1)[0];
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
  existingEmployeeAccount = `${accountPrefix}-employee`;
  const [adminHash, employeeHash] = await Promise.all([
    hashPassword(adminPassword),
    hashPassword(employeePassword),
  ]);
  await queryDatabase(
    `INSERT INTO admin_accounts (account, display_name, password_hash)
     VALUES ($1, $2, $3)`,
    [adminAccount, "账号管理测试管理员", adminHash],
  );
  await queryDatabase(
    `INSERT INTO employee_accounts (account, display_name, password_hash)
     VALUES ($1, $2, $3)`,
    [existingEmployeeAccount, "已存在员工", employeeHash],
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
    await queryDatabase("DELETE FROM admin_accounts WHERE account = $1", [adminAccount]);
    await queryDatabase("DELETE FROM employee_accounts WHERE account LIKE $1", [`${accountPrefix}%`]);
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

test("only administrators can create and list persisted employee accounts", async () => {
  const anonymousList = await request("/api/admin/employees");
  assert.equal(anonymousList.status, 401);

  const anonymousCreate = await request("/api/admin/employees", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ account: `${accountPrefix}-forbidden`, displayName: "未授权员工" }),
  });
  assert.equal(anonymousCreate.status, 401);

  const employeeLogin = await login("employee", existingEmployeeAccount, employeePassword);
  assert.equal(employeeLogin.status, 200);
  const employeeCookie = cookieFrom(employeeLogin, "employee_session");
  const employeeList = await request("/api/admin/employees", {
    headers: { Cookie: employeeCookie },
  });
  assert.equal(employeeList.status, 401);
  const employeeCreate = await request("/api/admin/employees", {
    method: "POST",
    headers: { Cookie: employeeCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ account: `${accountPrefix}-forbidden`, displayName: "未授权员工" }),
  });
  assert.equal(employeeCreate.status, 401);

  const adminLogin = await login("admin", adminAccount, adminPassword);
  assert.equal(adminLogin.status, 200);
  const adminCookie = cookieFrom(adminLogin, "admin_session");

  const missingFields = await request("/api/admin/employees", {
    method: "POST",
    headers: { Cookie: adminCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ account: "  ", displayName: "" }),
  });
  assert.equal(missingFields.status, 400);

  const duplicateEmployee = await request("/api/admin/employees", {
    method: "POST",
    headers: { Cookie: adminCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ account: existingEmployeeAccount.toUpperCase(), displayName: "重复员工" }),
  });
  assert.equal(duplicateEmployee.status, 409);

  const duplicateAdministrator = await request("/api/admin/employees", {
    method: "POST",
    headers: { Cookie: adminCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ account: adminAccount.toUpperCase(), displayName: "重复管理员" }),
  });
  assert.equal(duplicateAdministrator.status, 409);

  const createdAccount = `${accountPrefix}-created`;
  const createdResponse = await request("/api/admin/employees", {
    method: "POST",
    headers: { Cookie: adminCookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      account: createdAccount,
      displayName: "新建员工",
      password: "must-not-be-used",
      status: "disabled",
    }),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(created.employee.account, createdAccount);
  assert.equal(created.employee.displayName, "新建员工");
  assert.equal(created.employee.status, "active");
  assert.ok(created.employee.createdAt);
  assert.equal(typeof created.temporaryPassword, "string");
  assert.ok(created.temporaryPassword.length > 0);
  assert.notEqual(created.temporaryPassword, "demo123");
  assert.equal(Object.hasOwn(created.employee, "passwordHash"), false);

  const persistedList = await request("/api/admin/employees", {
    headers: { Cookie: adminCookie },
  });
  assert.equal(persistedList.status, 200);
  const listed = (await persistedList.json()).find((employee) => employee.account === createdAccount);
  assert.ok(listed, "created employee should remain in the list after a new request");
  assert.equal(listed.displayName, "新建员工");
  assert.equal(listed.status, "active");
  assert.equal(Object.hasOwn(listed, "passwordHash"), false);
  assert.equal(Object.hasOwn(listed, "temporaryPassword"), false);
  const employeeLogs = await logsForEmployee(created.employee.id);
  const adminIdentity = await queryDatabase(
    "SELECT id::text AS id FROM admin_accounts WHERE account = $1",
    [adminAccount],
  );
  assert.equal(employeeLogs.rowCount, 1);
  assert.deepEqual({
    sourceSystem: employeeLogs.rows[0].source_system,
    operationType: employeeLogs.rows[0].operation_type,
    adminActorId: employeeLogs.rows[0].actor_admin_account_id,
    employeeActorId: employeeLogs.rows[0].actor_employee_account_id,
    actorAccount: employeeLogs.rows[0].actor_account_snapshot,
    actorDisplayName: employeeLogs.rows[0].actor_display_name_snapshot,
    targetType: employeeLogs.rows[0].target_type,
    targetId: employeeLogs.rows[0].target_id,
    content: employeeLogs.rows[0].operation_content,
  }, {
    sourceSystem: "admin",
    operationType: "employee_account_created",
    adminActorId: adminIdentity.rows[0].id,
    employeeActorId: null,
    actorAccount: adminAccount,
    actorDisplayName: "账号管理测试管理员",
    targetType: "employee_account",
    targetId: created.employee.id,
    content: {
      account: createdAccount,
      displayName: "新建员工",
      status: "active",
    },
  });
  assert.ok(employeeLogs.rows[0].recorded_at instanceof Date);

  const duplicateCreated = await request("/api/admin/employees", {
    method: "POST",
    headers: { Cookie: adminCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ account: createdAccount.toUpperCase(), displayName: "重复新建员工" }),
  });
  assert.equal(duplicateCreated.status, 409);

  const temporaryLogin = await login("employee", createdAccount, created.temporaryPassword);
  assert.equal(temporaryLogin.status, 200);
  assert.deepEqual(await temporaryLogin.json(), {
    account: createdAccount,
    displayName: "新建员工",
    mustChangePassword: true,
  });
  const temporaryCookie = cookieFrom(temporaryLogin, "employee_session");

  const pendingSession = await request("/api/employee/auth/session", {
    headers: { Cookie: temporaryCookie },
  });
  assert.equal(pendingSession.status, 200);
  assert.equal((await pendingSession.json()).mustChangePassword, true);

  const pendingBusinessRequest = await request("/api/catalog/products", {
    headers: { Cookie: temporaryCookie },
  });
  assert.equal(pendingBusinessRequest.status, 401);

  const samePassword = await request("/api/employee/auth/password", {
    method: "POST",
    headers: { Cookie: temporaryCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ password: created.temporaryPassword }),
  });
  assert.equal(samePassword.status, 400);

  const changedPassword = await request("/api/employee/auth/password", {
    method: "POST",
    headers: { Cookie: temporaryCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ password: newEmployeePassword }),
  });
  assert.equal(changedPassword.status, 204);

  const refreshedSession = await request("/api/employee/auth/session", {
    headers: { Cookie: temporaryCookie },
  });
  assert.equal(refreshedSession.status, 200);
  assert.deepEqual(await refreshedSession.json(), {
    account: createdAccount,
    displayName: "新建员工",
  });

  const nowAllowedBusinessRequest = await request("/api/catalog/products", {
    headers: { Cookie: temporaryCookie },
  });
  assert.equal(nowAllowedBusinessRequest.status, 200);

  const oldPasswordLogin = await login("employee", createdAccount, created.temporaryPassword);
  assert.equal(oldPasswordLogin.status, 401);
  const newPasswordLogin = await login("employee", createdAccount, newEmployeePassword);
  assert.equal(newPasswordLogin.status, 200);
  assert.deepEqual(await newPasswordLogin.json(), {
    account: createdAccount,
    displayName: "新建员工",
  });

  await request("/api/employee/auth/session", { method: "DELETE", headers: { Cookie: temporaryCookie } });
  await request("/api/employee/auth/session", { method: "DELETE", headers: { Cookie: employeeCookie } });
  await request("/api/admin/auth/session", { method: "DELETE", headers: { Cookie: adminCookie } });
});

test("administrators can enable and disable employee accounts, including existing sessions", async () => {
  const adminLogin = await login("admin", adminAccount, adminPassword);
  assert.equal(adminLogin.status, 200);
  const adminCookie = cookieFrom(adminLogin, "admin_session");

  const employeeLogin = await login("employee", existingEmployeeAccount, employeePassword);
  assert.equal(employeeLogin.status, 200);
  const employeeCookie = cookieFrom(employeeLogin, "employee_session");

  const initialList = await request("/api/admin/employees", {
    headers: { Cookie: adminCookie },
  });
  assert.equal(initialList.status, 200);
  const employee = (await initialList.json()).find((item) => item.account === existingEmployeeAccount);
  assert.ok(employee, "the employee should be available from the administrator list");
  assert.equal(employee.status, "active");
  assert.equal((await logsForEmployee(employee.id)).rowCount, 0);

  const togglePath = `/api/admin/employees/${employee.id}`;
  const employeeToggle = await request(togglePath, {
    method: "PATCH",
    headers: { Cookie: employeeCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ status: "disabled" }),
  });
  assert.equal(employeeToggle.status, 401);

  const anonymousToggle = await request(togglePath, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "disabled" }),
  });
  assert.equal(anonymousToggle.status, 401);

  const invalidStatus = await request(togglePath, {
    method: "PATCH",
    headers: { Cookie: adminCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ status: "pending" }),
  });
  assert.equal(invalidStatus.status, 400);

  const unknownEmployee = await request("/api/admin/employees/9223372036854775807", {
    method: "PATCH",
    headers: { Cookie: adminCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ status: "disabled" }),
  });
  assert.equal(unknownEmployee.status, 404);

  await queryDatabase(`
    CREATE FUNCTION issue30_reject_employee_status_log() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.operation_type = 'employee_account_status_changed' THEN
        RAISE EXCEPTION 'simulated operation log write failure';
      END IF;
      RETURN NEW;
    END;
    $$
  `);
  await queryDatabase(`
    CREATE TRIGGER issue30_reject_employee_status_log
    BEFORE INSERT ON system_operation_logs
    FOR EACH ROW EXECUTE FUNCTION issue30_reject_employee_status_log()
  `);
  const failedDisable = await request(togglePath, {
    method: "PATCH",
    headers: { Cookie: adminCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ status: "disabled" }),
  });
  assert.equal(failedDisable.status, 500);
  const statusAfterFailedLog = await queryDatabase(
    "SELECT status FROM employee_accounts WHERE id = $1",
    [employee.id],
  );
  assert.equal(statusAfterFailedLog.rows[0].status, "active");
  assert.equal((await logsForEmployee(employee.id)).rowCount, 0);
  await queryDatabase("DROP TRIGGER issue30_reject_employee_status_log ON system_operation_logs");
  await queryDatabase("DROP FUNCTION issue30_reject_employee_status_log()");

  const disabledResponse = await request(togglePath, {
    method: "PATCH",
    headers: { Cookie: adminCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ status: "disabled" }),
  });
  assert.equal(disabledResponse.status, 200);
  assert.equal((await disabledResponse.json()).status, "disabled");
  const disabledLogs = await logsForEmployee(employee.id);
  const adminIdentity = await queryDatabase(
    "SELECT id::text AS id FROM admin_accounts WHERE account = $1",
    [adminAccount],
  );
  assert.equal(disabledLogs.rowCount, 1);
  assert.deepEqual({
    sourceSystem: disabledLogs.rows[0].source_system,
    operationType: disabledLogs.rows[0].operation_type,
    adminActorId: disabledLogs.rows[0].actor_admin_account_id,
    employeeActorId: disabledLogs.rows[0].actor_employee_account_id,
    actorAccount: disabledLogs.rows[0].actor_account_snapshot,
    actorDisplayName: disabledLogs.rows[0].actor_display_name_snapshot,
    content: disabledLogs.rows[0].operation_content,
  }, {
    sourceSystem: "admin",
    operationType: "employee_account_status_changed",
    adminActorId: adminIdentity.rows[0].id,
    employeeActorId: null,
    actorAccount: adminAccount,
    actorDisplayName: "账号管理测试管理员",
    content: {
      account: existingEmployeeAccount,
      displayName: "已存在员工",
      beforeStatus: "active",
      afterStatus: "disabled",
    },
  });
  assert.ok(disabledLogs.rows[0].recorded_at instanceof Date);

  const refreshedList = await request("/api/admin/employees", {
    headers: { Cookie: adminCookie },
  });
  assert.equal(refreshedList.status, 200);
  assert.equal(
    (await refreshedList.json()).find((item) => item.account === existingEmployeeAccount).status,
    "disabled",
  );

  const existingBusinessSession = await request("/api/catalog/products", {
    headers: { Cookie: employeeCookie },
  });
  assert.equal(existingBusinessSession.status, 401);
  const existingInventorySession = await request("/api/inventory", {
    headers: { Cookie: employeeCookie },
  });
  assert.equal(existingInventorySession.status, 401);

  const disabledSession = await request("/api/employee/auth/session", {
    headers: { Cookie: employeeCookie },
  });
  assert.equal(disabledSession.status, 401);

  const disabledLogin = await login("employee", existingEmployeeAccount, employeePassword);
  assert.equal(disabledLogin.status, 401);
  assert.equal(disabledLogin.headers.has("set-cookie"), false);

  const enabledResponse = await request(togglePath, {
    method: "PATCH",
    headers: { Cookie: adminCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ status: "active" }),
  });
  assert.equal(enabledResponse.status, 200);
  assert.equal((await enabledResponse.json()).status, "active");
  const statusLogs = await logsForEmployee(employee.id);
  assert.equal(statusLogs.rowCount, 2);
  assert.deepEqual(statusLogs.rows.map(({ operation_content: content }) => ({
    beforeStatus: content.beforeStatus,
    afterStatus: content.afterStatus,
  })), [
    { beforeStatus: "active", afterStatus: "disabled" },
    { beforeStatus: "disabled", afterStatus: "active" },
  ]);

  const enabledLogin = await login("employee", existingEmployeeAccount, employeePassword);
  assert.equal(enabledLogin.status, 200);
  await request("/api/employee/auth/session", {
    method: "DELETE",
    headers: { Cookie: cookieFrom(enabledLogin, "employee_session") },
  });
  await request("/api/employee/auth/session", { method: "DELETE", headers: { Cookie: employeeCookie } });
  await request("/api/admin/auth/session", { method: "DELETE", headers: { Cookie: adminCookie } });
});
