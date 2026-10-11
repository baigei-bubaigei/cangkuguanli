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
const accountPrefix = `t01-test-${process.pid}-${Date.now()}`;
const adminPassword = "test-only-existing-admin-password";
const disabledPassword = "test-only-disabled-admin-password";
let pool;
let serverProcess;
let baseUrl;
let activeAccount;
let disabledAccount;

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

async function login(account, password) {
  return request("/api/admin/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ account, password }),
  });
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

  activeAccount = `${accountPrefix}-active`;
  disabledAccount = `${accountPrefix}-disabled`;
  const [activeHash, disabledHash] = await Promise.all([
    hashPassword(adminPassword),
    hashPassword(disabledPassword),
  ]);
  await pool.query(
    `INSERT INTO admin_accounts (account, display_name, password_hash, status)
     VALUES ($1, $2, $3, 'active'), ($4, $5, $6, 'disabled')`,
    [activeAccount, "测试管理员", activeHash, disabledAccount, "停用管理员", disabledHash],
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
    if (activeAccount || disabledAccount) {
      await pool.query(
        "DELETE FROM admin_accounts WHERE account = ANY($1::text[])",
        [[activeAccount, disabledAccount].filter(Boolean)],
      );
    }
    await pool.end();
  }
});

test("an existing administrator can log in, keep the session after refresh, and log out", async () => {
  const response = await login(activeAccount, adminPassword);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    account: activeAccount,
    displayName: "测试管理员",
  });

  const setCookie = response.headers.getSetCookie()[0];
  assert.match(setCookie, /^admin_session=/);
  assert.match(setCookie, /HttpOnly/i);
  const cookie = setCookie.split(";", 1)[0];

  const firstSession = await request("/api/admin/auth/session", {
    headers: { Cookie: cookie },
  });
  assert.equal(firstSession.status, 200);
  assert.deepEqual(await firstSession.json(), {
    account: activeAccount,
    displayName: "测试管理员",
  });

  const refreshedSession = await request("/api/admin/auth/session", {
    headers: { Cookie: cookie },
  });
  assert.equal(refreshedSession.status, 200);

  const logout = await request("/api/admin/auth/session", {
    method: "DELETE",
    headers: { Cookie: cookie },
  });
  assert.equal(logout.status, 204);

  const afterLogout = await request("/api/admin/auth/session", {
    headers: { Cookie: cookie },
  });
  assert.equal(afterLogout.status, 401);
});

test("wrong passwords and disabled administrator accounts cannot log in", async () => {
  const wrongPassword = await login(activeAccount, "not-the-password");
  assert.equal(wrongPassword.status, 401);

  const disabled = await login(disabledAccount, disabledPassword);
  assert.equal(disabled.status, 401);
  assert.equal(disabled.headers.has("set-cookie"), false);
});
