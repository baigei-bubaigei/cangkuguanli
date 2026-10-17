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
const accountPrefix = `t14-test-${process.pid}-${Date.now()}`;
const employeePassword = "test-only-existing-employee-password";
const newEmployeePassword = "test-only-new-employee-password";
const adminPassword = "test-only-employee-account-admin-password";
let pool;
let serverProcess;
let baseUrl;
let adminAccount;
let existingEmployeeAccount;

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

function cookieFrom(response, name) {
  const setCookie = response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`));
  assert.ok(setCookie, `login response should set ${name}`);
  assert.match(setCookie, /HttpOnly/i);
  return setCookie.split(";", 1)[0];
}

before(async () => {
  const migrations = spawnSync(process.execPath, [migrationCli], {
    cwd: apiDirectory,
    env: { ...process.env, DATABASE_URL: testDatabaseUrl },
    encoding: "utf8",
  });
  if (migrations.status !== 0) {
    throw new Error(`PostgreSQL migrations failed: ${migrations.stderr || migrations.stdout}`);
  }

  pool = new Pool({ connectionString: testDatabaseUrl });
  adminAccount = `${accountPrefix}-admin`;
  existingEmployeeAccount = `${accountPrefix}-employee`;
  const [adminHash, employeeHash] = await Promise.all([
    hashPassword(adminPassword),
    hashPassword(employeePassword),
  ]);
  await pool.query(
    `INSERT INTO admin_accounts (account, display_name, password_hash)
     VALUES ($1, $2, $3)`,
    [adminAccount, "账号管理测试管理员", adminHash],
  );
  await pool.query(
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
    await pool.query("DELETE FROM admin_accounts WHERE account = $1", [adminAccount]);
    await pool.query("DELETE FROM employee_accounts WHERE account LIKE $1", [`${accountPrefix}%`]);
    await pool.end();
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

  const disabledResponse = await request(togglePath, {
    method: "PATCH",
    headers: { Cookie: adminCookie, "Content-Type": "application/json" },
    body: JSON.stringify({ status: "disabled" }),
  });
  assert.equal(disabledResponse.status, 200);
  assert.equal((await disabledResponse.json()).status, "disabled");

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

  const enabledLogin = await login("employee", existingEmployeeAccount, employeePassword);
  assert.equal(enabledLogin.status, 200);
  await request("/api/employee/auth/session", {
    method: "DELETE",
    headers: { Cookie: cookieFrom(enabledLogin, "employee_session") },
  });
  await request("/api/employee/auth/session", { method: "DELETE", headers: { Cookie: employeeCookie } });
  await request("/api/admin/auth/session", { method: "DELETE", headers: { Cookie: adminCookie } });
});
