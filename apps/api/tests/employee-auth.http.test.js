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
const accountPrefix = `t02-test-${process.pid}-${Date.now()}`;
const employeePassword = "test-only-existing-employee-password";
const disabledPassword = "test-only-disabled-employee-password";
const adminPassword = "test-only-cross-system-admin-password";
let pool;
let serverProcess;
let baseUrl;
let activeEmployee;
let disabledEmployee;
let credentiallessEmployee;
let adminAccount;

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

async function login(system, account, password, claims = {}) {
  return request(`/api/${system}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...claims, account, password }),
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
  activeEmployee = `${accountPrefix}-active`;
  disabledEmployee = `${accountPrefix}-disabled`;
  credentiallessEmployee = `${accountPrefix}-credentialless`;
  adminAccount = `${accountPrefix}-admin`;

  const [activeHash, disabledHash, adminHash] = await Promise.all([
    hashPassword(employeePassword),
    hashPassword(disabledPassword),
    hashPassword(adminPassword),
  ]);
  await pool.query(
    `INSERT INTO employee_accounts (account, display_name, password_hash, status)
     VALUES ($1, $2, $3, 'active'), ($4, $5, $6, 'disabled')`,
    [activeEmployee, "测试员工", activeHash, disabledEmployee, "停用员工", disabledHash],
  );
  await pool.query(
    `INSERT INTO employee_accounts (account, display_name)
     VALUES ($1, $2)`,
    [credentiallessEmployee, "未设置凭据员工"],
  );
  await pool.query(
    `INSERT INTO admin_accounts (account, display_name, password_hash, status)
     VALUES ($1, $2, $3, 'active')`,
    [adminAccount, "边界测试管理员", adminHash],
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
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill();
  }
  if (pool) {
    await pool.query(
      "DELETE FROM system_operation_logs WHERE actor_account_snapshot = ANY($1::text[])",
      [[adminAccount, activeEmployee, disabledEmployee, credentiallessEmployee].filter(Boolean)],
    );
    await pool.query(
      "DELETE FROM admin_accounts WHERE account = $1",
      [adminAccount],
    );
    await pool.query(
      "DELETE FROM employee_accounts WHERE account = ANY($1::text[])",
      [[activeEmployee, disabledEmployee, credentiallessEmployee].filter(Boolean)],
    );
    await pool.end();
  }
});

test("an existing employee can log in, retain identity after refresh, and log out", async () => {
  const response = await login("employee", activeEmployee, employeePassword);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    account: activeEmployee,
    displayName: "测试员工",
  });

  const cookie = cookieFrom(response, "employee_session");
  const firstSession = await request("/api/employee/auth/session", {
    headers: { Cookie: cookie },
  });
  assert.equal(firstSession.status, 200);
  assert.deepEqual(await firstSession.json(), {
    account: activeEmployee,
    displayName: "测试员工",
  });

  const refreshedSession = await request("/api/employee/auth/session", {
    headers: { Cookie: cookie },
  });
  assert.equal(refreshedSession.status, 200);
  assert.deepEqual(await refreshedSession.json(), {
    account: activeEmployee,
    displayName: "测试员工",
  });

  const logout = await request("/api/employee/auth/session", {
    method: "DELETE",
    headers: { Cookie: cookie },
  });
  assert.equal(logout.status, 204);

  const afterLogout = await request("/api/employee/auth/session", {
    headers: { Cookie: cookie },
  });
  assert.equal(afterLogout.status, 401);

  const logs = await pool.query(
    `SELECT operation_type, source_system, target_type, target_id::TEXT AS target_id,
            operation_content
       FROM system_operation_logs
      WHERE actor_account_snapshot = $1
      ORDER BY id`,
    [activeEmployee],
  );
  assert.deepEqual(logs.rows.map(({ operation_type, source_system, target_type, operation_content }) => ({
    operationType: operation_type,
    sourceSystem: source_system,
    targetType: target_type,
    content: operation_content,
  })), [
    {
      operationType: "login",
      sourceSystem: "employee",
      targetType: "employee_account",
      content: { action: "登录" },
    },
    {
      operationType: "logout",
      sourceSystem: "employee",
      targetType: "employee_account",
      content: { action: "退出" },
    },
  ]);
  assert.equal(logs.rows[0].target_id, logs.rows[1].target_id);
});

test("employee and administrator sessions cannot cross the independent system boundary", async () => {
  const forgedAdminQuery = new URLSearchParams({
    account: adminAccount,
    displayName: "伪造管理员身份",
    role: "admin",
    system: "admin",
    sourceSystem: "admin",
  });
  const forgedEmployeeQuery = new URLSearchParams({
    account: activeEmployee,
    displayName: "伪造员工身份",
    role: "employee",
    system: "employee",
    sourceSystem: "employee",
  });

  const anonymousEmployeeSession = await request(
    `/api/employee/auth/session?${forgedAdminQuery}`,
  );
  assert.equal(anonymousEmployeeSession.status, 401);

  const anonymousAdminSession = await request(
    `/api/admin/auth/session?${forgedEmployeeQuery}`,
  );
  assert.equal(anonymousAdminSession.status, 401);

  const employeeResponse = await login("employee", activeEmployee, employeePassword, {
    accountId: adminAccount,
    displayName: "伪造员工身份",
    role: "admin",
    sourceSystem: "admin",
    system: "admin",
  });
  assert.equal(employeeResponse.status, 200);
  assert.deepEqual(await employeeResponse.json(), {
    account: activeEmployee,
    displayName: "测试员工",
  });
  const employeeCookie = cookieFrom(employeeResponse, "employee_session");
  const employeeSession = await request(
    `/api/employee/auth/session?${forgedAdminQuery}`,
    {
      headers: { Cookie: employeeCookie },
    },
  );
  assert.equal(employeeSession.status, 200);
  assert.deepEqual(await employeeSession.json(), {
    account: activeEmployee,
    displayName: "测试员工",
  });

  const adminFromEmployeeSession = await request(
    `/api/admin/auth/session?${forgedAdminQuery}`,
    {
      headers: { Cookie: employeeCookie },
    },
  );
  assert.equal(adminFromEmployeeSession.status, 401);

  const adminResponse = await login("admin", adminAccount, adminPassword, {
    accountId: activeEmployee,
    displayName: "伪造管理员身份",
    role: "employee",
    sourceSystem: "employee",
    system: "employee",
  });
  assert.equal(adminResponse.status, 200);
  assert.deepEqual(await adminResponse.json(), {
    account: adminAccount,
    displayName: "边界测试管理员",
  });
  const adminCookie = cookieFrom(adminResponse, "admin_session");
  const adminSession = await request(
    `/api/admin/auth/session?${forgedEmployeeQuery}`,
    {
      headers: { Cookie: adminCookie },
    },
  );
  assert.equal(adminSession.status, 200);
  assert.deepEqual(await adminSession.json(), {
    account: adminAccount,
    displayName: "边界测试管理员",
  });

  const employeeFromAdminSession = await request(
    `/api/employee/auth/session?${forgedEmployeeQuery}`,
    {
      headers: { Cookie: adminCookie },
    },
  );
  assert.equal(employeeFromAdminSession.status, 401);

  await request("/api/employee/auth/session", { method: "DELETE", headers: { Cookie: employeeCookie } });
  await request("/api/admin/auth/session", { method: "DELETE", headers: { Cookie: adminCookie } });
});

test("wrong passwords and disabled employee accounts cannot log in", async () => {
  const wrongPassword = await login("employee", activeEmployee, "not-the-password");
  assert.equal(wrongPassword.status, 401);
  assert.equal(wrongPassword.headers.has("set-cookie"), false);

  const disabled = await login("employee", disabledEmployee, disabledPassword);
  assert.equal(disabled.status, 401);
  assert.equal(disabled.headers.has("set-cookie"), false);

  const credentialless = await login("employee", credentiallessEmployee, "any-password");
  assert.equal(credentialless.status, 401);
  assert.equal(credentialless.headers.has("set-cookie"), false);

  const failedAccountLogs = await pool.query(
    `SELECT operation_type FROM system_operation_logs
      WHERE actor_account_snapshot = ANY($1::TEXT[])
      ORDER BY id`,
    [[disabledEmployee, credentiallessEmployee]],
  );
  assert.deepEqual(failedAccountLogs.rows, []);
});
