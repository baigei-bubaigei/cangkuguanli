import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer, isIPv4 } from "node:net";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { hashPassword } from "../src/auth/password.js";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const apiDirectory = fileURLToPath(new URL("..", import.meta.url));
const migrationCli = fileURLToPath(new URL("../scripts/migrate.js", import.meta.url));
const nextCli = fileURLToPath(new URL("../../../node_modules/next/dist/bin/next", import.meta.url));
const accountPrefix = `issue36-${process.pid}-${randomBytes(5).toString("hex")}`;
const adminAccount = `${accountPrefix}-admin`;
const disabledAdminAccount = `${accountPrefix}-disabled-admin`;
const employeeAccount = `${accountPrefix}-employee`;
const disabledEmployeeAccount = `${accountPrefix}-disabled-employee`;
const adminPassword = "restore-test-admin-password";
const employeePassword = "restore-test-employee-password";
const sourceDatabase = `${accountPrefix.replaceAll("-", "_")}_source`;
const restoredDatabase = `${accountPrefix.replaceAll("-", "_")}_restored`;
const archivePathName = "warehouse.backup";
let temporaryDirectory;
let pgDataDirectory;
let pgDataDirectoryLinux;
let pgLogFile;
let postgresBinDirectory;
let postgresUser;
let postgresPort;
let postgresHost;
let postgresClientHost;
let sourceUrl;
let restoredUrl;
let sourcePool;
let restoredPool;
let sourceSnapshot;
let restoredSnapshot;
let restoredSnapshotAfterQueries;
let serverProcess;
let baseUrl;
let apiOutput = "";
let pgClusterInitialized = false;
let pgDataDirectoryCreated = false;

function wslPostgresEnvironment(environment) {
  if (process.platform !== "win32") return environment;
  const wslEnvironment = new Set((environment.WSLENV ?? "").split(":").filter(Boolean));
  for (const name of ["PGHOST", "PGPORT", "PGUSER", "PGDATABASE", "PGOPTIONS", "PGSSLMODE", "PGSSLCERT", "PGSSLKEY", "PGSSLROOTCERT", "PGAPPNAME"]) {
    const existing = [...wslEnvironment].filter((variable) => variable.split("/")[0].toLowerCase() === name.toLowerCase());
    if (environment[name]) {
      if (existing.length === 0) wslEnvironment.add(`${name}/u`);
    } else {
      existing.forEach((variable) => wslEnvironment.delete(variable));
    }
  }
  environment.WSLENV = [...wslEnvironment].join(":");
  return environment;
}

function windowsPostgresEnvironment(databaseUrl) {
  const url = new URL(databaseUrl);
  const environment = { ...process.env };
  delete environment.TEST_DATABASE_URL;
  environment.PGHOST = url.hostname;
  environment.PGPORT = url.port;
  environment.PGUSER = decodeURIComponent(url.username);
  environment.PGDATABASE = decodeURIComponent(url.pathname.slice(1));
  delete environment.PGPASSWORD;
  for (const [parameter, variable] of Object.entries({
    sslmode: "PGSSLMODE",
    sslcert: "PGSSLCERT",
    sslkey: "PGSSLKEY",
    sslrootcert: "PGSSLROOTCERT",
    options: "PGOPTIONS",
    application_name: "PGAPPNAME",
  })) {
    const value = url.searchParams.get(parameter);
    if (value) environment[variable] = value;
    else delete environment[variable];
  }
  return wslPostgresEnvironment(environment);
}

function runPostgresTool(tool, args, env = process.env) {
  const executable = process.platform === "win32" ? `${postgresBinDirectory}/${tool}` : join(postgresBinDirectory, tool);
  const command = process.platform === "win32" ? "wsl.exe" : executable;
  const commandArguments = process.platform === "win32"
    ? ["--distribution", "Ubuntu", "--exec", executable, ...args]
    : args;
  return spawnSync(command, commandArguments, { env, encoding: "utf8" });
}

function assertCommandSucceeded(result, description) {
  if (result.status !== 0) {
    throw new Error(`${description} failed (exit ${result.status ?? result.signal ?? "unknown"}): ${result.stderr || result.stdout}`);
  }
}

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

function databaseUrl(databaseName) {
  return `postgresql://${encodeURIComponent(postgresUser)}@${postgresHost}:${postgresPort}/${databaseName}`;
}

function runNpmScript(script, args, env) {
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, "run this test through npm so it can invoke the public database commands");
  return spawnSync(process.execPath, [npmCli, "run", script, "--", ...args], {
    cwd: repositoryRoot,
    env,
    encoding: "utf8",
  });
}

async function createSourceFixtures() {
  const [adminHash, employeeHash] = await Promise.all([
    hashPassword(adminPassword),
    hashPassword(employeePassword),
  ]);
  const admin = await sourcePool.query(
    `INSERT INTO admin_accounts (account, display_name, password_hash, status)
     VALUES ($1, '恢复验收管理员', $2, 'active'),
            ($3, '停用管理员', $2, 'disabled')
     RETURNING id, account`,
    [adminAccount, adminHash, disabledAdminAccount],
  );
  const employee = await sourcePool.query(
    `INSERT INTO employee_accounts (account, display_name, password_hash, status)
     VALUES ($1, '恢复验收员工', $2, 'active'),
            ($3, '停用员工', $2, 'disabled')
     RETURNING id, account`,
    [employeeAccount, employeeHash, disabledEmployeeAccount],
  );
  const adminId = admin.rows[0].id;
  const employeeId = employee.rows[0].id;
  await sourcePool.query(
    "INSERT INTO admin_sessions (token_hash, admin_account_id) VALUES ($1, $2)",
    [randomBytes(32).toString("hex"), adminId],
  );
  await sourcePool.query(
    "INSERT INTO employee_sessions (token_hash, employee_account_id) VALUES ($1, $2)",
    [randomBytes(32).toString("hex"), employeeId],
  );

  const warehouse = await sourcePool.query(
    "INSERT INTO warehouses (name) VALUES ($1) RETURNING id",
    [`${accountPrefix}-仓库`],
  );
  const locations = await Promise.all(["A-01", "A-02"].map((name) => sourcePool.query(
    "INSERT INTO locations (warehouse_id, name) VALUES ($1, $2) RETURNING id",
    [warehouse.rows[0].id, name],
  )));
  const firstProduct = await sourcePool.query(
    `INSERT INTO product_specs
       (product_name, spec, material, color, category, category_name, note, per_case_count)
     VALUES ($1, '标准规格', '铝合金', '黑色', '家居', '灯具', '六件包装', 6)
     RETURNING id`,
    [`${accountPrefix}-产品`],
  );
  const secondProduct = await sourcePool.query(
    `INSERT INTO product_specs
       (product_name, spec, material, color, category, category_name, note, per_case_count)
     VALUES ($1, '标准规格', '铝合金', '黑色', '家居', '灯具', '四件包装', 4)
     RETURNING id`,
    [`${accountPrefix}-产品`],
  );
  const productId = firstProduct.rows[0].id;
  const secondProductId = secondProduct.rows[0].id;
  const firstLocationId = locations[0].rows[0].id;
  const secondLocationId = locations[1].rows[0].id;
  await sourcePool.query(
    `INSERT INTO product_spec_locations (product_spec_id, location_id, case_count, loose_count)
     VALUES ($1, $2, 3, 1), ($3, $4, 2, 3)`,
    [productId, firstLocationId, secondProductId, secondLocationId],
  );

  const transaction = await sourcePool.query(
    `INSERT INTO inventory_transactions
       (operation_type, product_spec_id, location_id, case_count, loose_count,
        actual_occurred_at, actor_account, source_system, note)
     VALUES ('inbound', $1, $2, 2, 1, '2026-10-17T08:00:00Z', $3, 'admin', '恢复验收入库')
     RETURNING id`,
    [productId, firstLocationId, adminAccount],
  );
  const transactionId = transaction.rows[0].id;
  await sourcePool.query(
    `INSERT INTO inventory_transaction_corrections
       (transaction_id, actor_account_snapshot, actor_display_name_snapshot,
        source_system, before_content, after_content)
     VALUES ($1, $2, '恢复验收管理员', 'admin',
             '{"caseCount":1,"looseCount":1}', '{"caseCount":2,"looseCount":1}')`,
    [transactionId, adminAccount],
  );
  const batch = await sourcePool.query("SELECT nextval('initial_inventory_import_batch_id_seq')::text AS id");
  const batchId = batch.rows[0].id;
  await sourcePool.query(
    `INSERT INTO system_operation_logs
       (actor_admin_account_id, actor_account_snapshot, actor_display_name_snapshot,
        source_system, operation_type, target_type, target_id, operation_content)
     VALUES ($1, $2, '恢复验收管理员', 'admin', 'initial_inventory_import',
             'initial_inventory_import_batch', $3::bigint,
             jsonb_build_object('batchId', $3::bigint::text, 'result', 'success', 'importedRows', 2))`,
    [adminId, adminAccount, batchId],
  );
  await sourcePool.query(
    `INSERT INTO system_operation_logs
       (actor_employee_account_id, actor_account_snapshot, actor_display_name_snapshot,
        source_system, operation_type, target_type, target_id, operation_content)
     VALUES ($1, $2, '恢复验收员工', 'employee', 'inventory_query',
             'inventory', $3::bigint, '{"operation":"inventory_query"}'::jsonb)`,
    [employeeId, employeeAccount, productId],
  );
  await sourcePool.query(
    `INSERT INTO inventory_request_idempotency
       (source_system, actor_account, request_scope, idempotency_key, payload_hash,
        response_status, response_body)
     VALUES ('admin', $1, 'inbound', $2, $3, 201, $4::jsonb)`,
    [adminAccount, randomBytes(16).toString("hex"), "b".repeat(64), JSON.stringify({ transactionId: String(transactionId) })],
  );
}

async function snapshot(pool) {
  const result = await pool.query(`
    SELECT jsonb_build_object(
      'admin_accounts', (SELECT jsonb_agg(to_jsonb(item) ORDER BY id) FROM admin_accounts AS item),
      'admin_sessions', (SELECT jsonb_agg(to_jsonb(item) ORDER BY token_hash) FROM admin_sessions AS item),
      'employee_accounts', (SELECT jsonb_agg(to_jsonb(item) ORDER BY id) FROM employee_accounts AS item),
      'employee_sessions', (SELECT jsonb_agg(to_jsonb(item) ORDER BY token_hash) FROM employee_sessions AS item),
      'product_specs', (SELECT jsonb_agg(to_jsonb(item) ORDER BY id) FROM product_specs AS item),
      'warehouses', (SELECT jsonb_agg(to_jsonb(item) ORDER BY id) FROM warehouses AS item),
      'locations', (SELECT jsonb_agg(to_jsonb(item) ORDER BY id) FROM locations AS item),
      'product_spec_locations', (SELECT jsonb_agg(to_jsonb(item) ORDER BY product_spec_id, location_id) FROM product_spec_locations AS item),
      'inventory_transactions', (SELECT jsonb_agg(to_jsonb(item) ORDER BY id) FROM inventory_transactions AS item),
      'inventory_transaction_corrections', (SELECT jsonb_agg(to_jsonb(item) ORDER BY id) FROM inventory_transaction_corrections AS item),
      'system_operation_logs', (SELECT jsonb_agg(to_jsonb(item) ORDER BY id) FROM system_operation_logs AS item),
      'inventory_request_idempotency', (SELECT jsonb_agg(to_jsonb(item) ORDER BY id) FROM inventory_request_idempotency AS item),
      'schema_migrations', (SELECT jsonb_agg(to_jsonb(item) ORDER BY name) FROM schema_migrations AS item),
      'import_batch_sequence', (SELECT jsonb_build_object('lastValue', last_value::text, 'isCalled', is_called)
                                FROM initial_inventory_import_batch_id_seq)
    ) AS records,
    jsonb_build_object(
      'adminSessionAccountLinks', (SELECT count(*) FROM admin_sessions s JOIN admin_accounts a ON a.id = s.admin_account_id),
      'employeeSessionAccountLinks', (SELECT count(*) FROM employee_sessions s JOIN employee_accounts a ON a.id = s.employee_account_id),
      'productWarehouseLocationLinks', (
        SELECT count(*) FROM product_spec_locations psl
        JOIN product_specs p ON p.id = psl.product_spec_id
        JOIN locations l ON l.id = psl.location_id
        JOIN warehouses w ON w.id = l.warehouse_id
      ),
      'transactionProductLocationLinks', (
        SELECT count(*) FROM inventory_transactions t
        JOIN product_spec_locations psl
          ON psl.product_spec_id = t.product_spec_id AND psl.location_id = t.location_id
      ),
      'correctionTransactionLinks', (
        SELECT count(*) FROM inventory_transaction_corrections c
        JOIN inventory_transactions t ON t.id = c.transaction_id
      ),
      'adminOperationLogLinks', (
        SELECT count(*) FROM system_operation_logs l
        JOIN admin_accounts a ON a.id = l.actor_admin_account_id
        WHERE l.actor_admin_account_id IS NOT NULL
      ),
      'employeeOperationLogLinks', (
        SELECT count(*) FROM system_operation_logs l
        JOIN employee_accounts e ON e.id = l.actor_employee_account_id
        WHERE l.actor_employee_account_id IS NOT NULL
      ),
      'importBatchLogLinks', (
        SELECT count(*) FROM system_operation_logs
        WHERE target_type = 'initial_inventory_import_batch'
          AND operation_content->>'batchId' = target_id::text
      )
    ) AS associations
  `);
  return result.rows[0];
}

function assertSourceContainsRecoveryData(value) {
  assert.equal(value.records.admin_accounts.length, 2);
  assert.deepEqual(value.records.admin_accounts.map(({ status }) => status).sort(), ["active", "disabled"]);
  assert.equal(value.records.employee_accounts.length, 2);
  assert.deepEqual(value.records.employee_accounts.map(({ status }) => status).sort(), ["active", "disabled"]);
  assert.equal(value.records.product_specs.length, 2);
  assert.deepEqual(value.records.product_specs.map(({ per_case_count }) => per_case_count).sort(), [4, 6]);
  assert.equal(value.records.product_spec_locations.length, 2);
  assert.equal(value.records.inventory_transactions.length, 1);
  assert.equal(value.records.inventory_transaction_corrections.length, 1);
  assert.equal(value.records.system_operation_logs.length, 2);
  assert.equal(value.records.schema_migrations.length, 12);
  assert.deepEqual(value.associations, {
    adminSessionAccountLinks: 1,
    employeeSessionAccountLinks: 1,
    productWarehouseLocationLinks: 2,
    transactionProductLocationLinks: 1,
    correctionTransactionLinks: 1,
    adminOperationLogLinks: 1,
    employeeOperationLogLinks: 1,
    importBatchLogLinks: 1,
  });
}

async function waitForApi() {
  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    if (serverProcess.exitCode !== null) {
      throw new Error(`Next.js stopped before becoming ready: ${lastError ?? apiOutput.slice(-1000)}`);
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
  throw new Error(`Next.js did not become ready: ${lastError ?? apiOutput.slice(-1000)}`);
}

async function startApi() {
  const port = await availablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  apiOutput = "";
  serverProcess = spawn(
    process.execPath,
    [nextCli, "dev", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: apiDirectory,
      env: { ...process.env, DATABASE_URL: restoredUrl, NEXT_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  serverProcess.stdout.on("data", (chunk) => { apiOutput += chunk.toString(); });
  serverProcess.stderr.on("data", (chunk) => { apiOutput += chunk.toString(); });
  await waitForApi();
}

async function stopApi() {
  if (!serverProcess || serverProcess.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(serverProcess.pid), "/T", "/F"], { encoding: "utf8" });
  } else {
    serverProcess.kill("SIGTERM");
  }
  await new Promise((resolve) => {
    if (serverProcess.exitCode !== null) return resolve();
    serverProcess.once("exit", resolve);
    setTimeout(resolve, 5000).unref();
  });
  serverProcess = null;
}

async function login(system, account, password) {
  const response = await fetch(`${baseUrl}/api/${system}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ account, password }),
  });
  assert.equal(response.status, 200, `${system} login should work against the restored database`);
  const cookieName = system === "admin" ? "admin_session" : "employee_session";
  const setCookie = response.headers.getSetCookie().find((value) => value.startsWith(`${cookieName}=`));
  assert.ok(setCookie, `${system} login should set its own session cookie`);
  return setCookie.split(";", 1)[0];
}

async function assertSystemsCanUseRestoredDatabase() {
  const adminCookie = await login("admin", adminAccount, adminPassword);
  const employeeCookie = await login("employee", employeeAccount, employeePassword);
  const [adminInventoryResponse, employeeInventoryResponse, adminCatalogResponse, employeeCatalogResponse] = await Promise.all([
    fetch(`${baseUrl}/api/inventory`, { headers: { Cookie: adminCookie } }),
    fetch(`${baseUrl}/api/inventory`, { headers: { Cookie: employeeCookie } }),
    fetch(`${baseUrl}/api/catalog/products`, { headers: { Cookie: adminCookie } }),
    fetch(`${baseUrl}/api/catalog/products`, { headers: { Cookie: employeeCookie } }),
  ]);
  for (const response of [adminInventoryResponse, employeeInventoryResponse, adminCatalogResponse, employeeCatalogResponse]) {
    assert.equal(response.status, 200);
  }
  const [adminInventory, employeeInventory, adminCatalog, employeeCatalog] = await Promise.all([
    adminInventoryResponse.json(), employeeInventoryResponse.json(),
    adminCatalogResponse.json(), employeeCatalogResponse.json(),
  ]);
  assert.deepEqual(employeeInventory, adminInventory);
  assert.deepEqual(employeeCatalog, adminCatalog);

  const product = adminInventory.products.find((item) => item.name === `${accountPrefix}-产品` && item.perCase === 6);
  assert.ok(product, "restored product packaging should appear in inventory queries");
  assert.equal(product.totalCases, 3);
  assert.equal(product.totalLoose, 1);
  assert.deepEqual(product.locations.map(({ warehouse, spot, cases, loose }) => ({ warehouse, spot, cases, loose })), [
    { warehouse: `${accountPrefix}-仓库`, spot: "A-01", cases: 3, loose: 1 },
  ]);

  const restoredSpecifications = adminCatalog
    .filter((item) => item.name === `${accountPrefix}-产品`)
    .map(({ material, color, perCase, cases, loose }) => ({ material, color, perCase, cases, loose }))
    .sort((left, right) => left.perCase - right.perCase);
  assert.deepEqual(restoredSpecifications, [
    { material: "铝合金", color: "黑色", perCase: 4, cases: 2, loose: 3 },
    { material: "铝合金", color: "黑色", perCase: 6, cases: 3, loose: 1 },
  ]);

  const adminLogsResponse = await fetch(`${baseUrl}/api/admin/system-logs`, { headers: { Cookie: adminCookie } });
  const employeeLogsResponse = await fetch(`${baseUrl}/api/employee/system-logs`, { headers: { Cookie: employeeCookie } });
  assert.equal(adminLogsResponse.status, 200);
  assert.equal(employeeLogsResponse.status, 200);
  const [adminLogs, employeeLogs] = await Promise.all([adminLogsResponse.json(), employeeLogsResponse.json()]);
  assert.deepEqual(adminLogs.records.map(({ sourceSystem }) => sourceSystem).sort(), ["admin", "employee"]);
  assert.deepEqual(employeeLogs.records.map(({ sourceSystem }) => sourceSystem), ["employee"]);

  const historyResponse = await fetch(`${baseUrl}/api/inventory/history?type=inbound`, {
    headers: { Cookie: adminCookie },
  });
  assert.equal(historyResponse.status, 200);
  const history = await historyResponse.json();
  const restoredTransaction = history.records.find((record) => record.note === "恢复验收入库");
  assert.ok(restoredTransaction, "restored transaction should appear in inventory history");
  assert.equal(restoredTransaction.corrections.length, 1);
  assert.deepEqual(restoredTransaction.corrections[0].after, { caseCount: 2, looseCount: 1 });

  const disabledAdminLogin = await fetch(`${baseUrl}/api/admin/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ account: disabledAdminAccount, password: adminPassword }),
  });
  const disabledEmployeeLogin = await fetch(`${baseUrl}/api/employee/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ account: disabledEmployeeAccount, password: employeePassword }),
  });
  assert.equal(disabledAdminLogin.status, 401);
  assert.equal(disabledEmployeeLogin.status, 401);
}

before(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "cangkuguanli-restore-"));

  if (process.platform === "win32") {
    const binResult = spawnSync("wsl.exe", ["--distribution", "Ubuntu", "--exec", "pg_config", "--bindir"], { encoding: "utf8" });
    assertCommandSucceeded(binResult, "Could not locate native PostgreSQL tools in Ubuntu WSL");
    postgresBinDirectory = binResult.stdout.trim();
    const userResult = spawnSync("wsl.exe", ["--distribution", "Ubuntu", "--exec", "id", "-un"], { encoding: "utf8" });
    assertCommandSucceeded(userResult, "Could not determine the Ubuntu WSL account");
    postgresUser = userResult.stdout.trim();
    const addressResult = spawnSync("wsl.exe", ["--distribution", "Ubuntu", "--exec", "hostname", "-I"], { encoding: "utf8" });
    assertCommandSucceeded(addressResult, "Could not determine the Ubuntu WSL address");
    postgresHost = addressResult.stdout.trim().split(/\s+/).find(isIPv4);
    assert.ok(postgresHost, "Ubuntu WSL should have an IPv4 address for the isolated test cluster");
    const routeResult = spawnSync("wsl.exe", ["--distribution", "Ubuntu", "--exec", "ip", "route", "show", "default"], { encoding: "utf8" });
    assertCommandSucceeded(routeResult, "Could not determine the Windows-to-WSL test route");
    postgresClientHost = routeResult.stdout.match(/^default via (\S+)/m)?.[1];
    assert.ok(postgresClientHost && isIPv4(postgresClientHost), "Ubuntu WSL should have a local Windows gateway address");
    const dataDirectoryResult = spawnSync(
      "wsl.exe",
      ["--distribution", "Ubuntu", "--exec", "mktemp", "-d", "/tmp/cangkuguanli-restore-XXXXXX"],
      { encoding: "utf8" },
    );
    assertCommandSucceeded(dataDirectoryResult, "Could not create an isolated Ubuntu PostgreSQL data directory");
    pgDataDirectoryLinux = dataDirectoryResult.stdout.trim();
    assert.match(pgDataDirectoryLinux, /^\/tmp\/cangkuguanli-restore-[A-Za-z0-9]+$/);
    pgDataDirectoryCreated = true;
  } else {
    const binResult = spawnSync("pg_config", ["--bindir"], { encoding: "utf8" });
    assertCommandSucceeded(binResult, "Could not locate native PostgreSQL tools");
    postgresBinDirectory = binResult.stdout.trim();
    const userResult = spawnSync("id", ["-un"], { encoding: "utf8" });
    assertCommandSucceeded(userResult, "Could not determine the PostgreSQL test account");
    postgresUser = userResult.stdout.trim();
    postgresHost = "127.0.0.1";
    postgresClientHost = "127.0.0.1";
    pgDataDirectory = join(temporaryDirectory, "postgres-data");
    await mkdir(pgDataDirectory);
    pgDataDirectoryLinux = pgDataDirectory;
    pgDataDirectoryCreated = true;
  }

  postgresPort = await availablePort();
  const init = runPostgresTool("initdb", ["--pgdata", pgDataDirectoryLinux, "--username", postgresUser, "--auth-local=trust", "--auth-host=trust"]);
  assertCommandSucceeded(init, "Could not create the isolated PostgreSQL test cluster");
  pgClusterInitialized = true;

  if (process.platform === "win32") {
    const authentication = spawnSync(
      "wsl.exe",
      [
        "--distribution", "Ubuntu", "--exec", "sh", "-c",
        `printf 'host all all ${postgresHost}/32 trust\\nhost all all ${postgresClientHost}/32 trust\\n' >> '${pgDataDirectoryLinux}/pg_hba.conf'`,
      ],
      { encoding: "utf8" },
    );
    assertCommandSucceeded(authentication, "Could not configure the isolated cluster for local Windows test connections");
  }

  pgLogFile = process.platform === "win32" ? `${pgDataDirectoryLinux}/postgres.log` : join(pgDataDirectoryLinux, "postgres.log");
  const start = runPostgresTool("pg_ctl", [
    "--pgdata", pgDataDirectoryLinux,
    "--log", pgLogFile,
    "--options", `-h ${postgresHost} -p ${postgresPort} -k ${pgDataDirectoryLinux}`,
    "--wait", "start",
  ]);
  if (start.status !== 0) {
    const log = process.platform === "win32"
      ? spawnSync("wsl.exe", ["--distribution", "Ubuntu", "--exec", "cat", pgLogFile], { encoding: "utf8" })
      : { stdout: "" };
    throw new Error(`Could not start the isolated PostgreSQL test cluster: ${log.stdout || start.stderr || start.stdout}`);
  }

  const clusterEnvironment = wslPostgresEnvironment({
    ...process.env,
    PGHOST: postgresHost,
    PGPORT: String(postgresPort),
    PGUSER: postgresUser,
    PGSSLMODE: "disable",
  });
  const databaseNames = [sourceDatabase, restoredDatabase];
  for (const name of databaseNames) {
    const created = runPostgresTool("createdb", [name], clusterEnvironment);
    assertCommandSucceeded(created, `Could not create isolated database ${name}`);
  }
  sourceUrl = databaseUrl(sourceDatabase);
  restoredUrl = databaseUrl(restoredDatabase);

  const migrations = spawnSync(process.execPath, [migrationCli], {
    cwd: apiDirectory,
    env: { ...process.env, DATABASE_URL: sourceUrl, TEST_DATABASE_URL: undefined },
    encoding: "utf8",
  });
  assertCommandSucceeded(migrations, "PostgreSQL source database migrations");
  sourcePool = new Pool({ connectionString: sourceUrl });
  await createSourceFixtures();
  sourceSnapshot = await snapshot(sourcePool);
  assertSourceContainsRecoveryData(sourceSnapshot);

  const shimDirectory = join(temporaryDirectory, "postgres-tools");
  await mkdir(shimDirectory);
  await writeFile(
    join(shimDirectory, "pg_dump.cmd"),
    `@echo off\r\nwsl.exe --distribution Ubuntu --exec ${postgresBinDirectory}/pg_dump %*\r\n`,
    "utf8",
  );
  await writeFile(
    join(shimDirectory, "pg_restore.cmd"),
    `@echo off\r\nwsl.exe --distribution Ubuntu --exec ${postgresBinDirectory}/pg_restore %*\r\n`,
    "utf8",
  );
  const backupEnvironment = windowsPostgresEnvironment(sourceUrl);
  backupEnvironment.DATABASE_URL = sourceUrl;
  const pathVariable = Object.keys(backupEnvironment).find((name) => name.toLowerCase() === "path") ?? "PATH";
  backupEnvironment[pathVariable] = `${shimDirectory};${backupEnvironment[pathVariable]}`;
  const archivePath = join(temporaryDirectory, archivePathName);
  const backup = runNpmScript("db:backup", ["--output", archivePath], backupEnvironment);
  assertCommandSucceeded(backup, "Verified PostgreSQL backup creation");

  const restoreEnvironment = windowsPostgresEnvironment(restoredUrl);
  restoreEnvironment.DATABASE_URL = restoredUrl;
  restoreEnvironment[pathVariable] = `${shimDirectory};${restoreEnvironment[pathVariable]}`;
  const restore = runNpmScript("db:restore", ["--input", archivePath], restoreEnvironment);
  assertCommandSucceeded(restore, "PostgreSQL database restore");

  restoredPool = new Pool({ connectionString: restoredUrl });
  restoredSnapshot = await snapshot(restoredPool);
  assert.deepEqual(restoredSnapshot, sourceSnapshot);
});

after(async () => {
  try {
    await stopApi();
  } finally {
    try {
      if (sourcePool) await sourcePool.end();
    } finally {
      try {
        if (restoredPool) await restoredPool.end();
      } finally {
        try {
          if (pgClusterInitialized && pgDataDirectoryLinux) {
            runPostgresTool("pg_ctl", ["--pgdata", pgDataDirectoryLinux, "--wait", "--mode", "fast", "stop"]);
          }
        } finally {
          try {
            if (pgDataDirectoryCreated && process.platform === "win32"
              && /^\/tmp\/cangkuguanli-restore-[A-Za-z0-9]+$/.test(pgDataDirectoryLinux ?? "")) {
              spawnSync("wsl.exe", ["--distribution", "Ubuntu", "--exec", "rm", "-rf", "--", pgDataDirectoryLinux], { encoding: "utf8" });
            }
          } finally {
            if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
          }
        }
      }
    }
  }
});

test("a PostgreSQL backup restores usable warehouse systems and survives database restart", async () => {
  await startApi();
  await assertSystemsCanUseRestoredDatabase();
  restoredSnapshotAfterQueries = await snapshot(restoredPool);
  await stopApi();

  await sourcePool.end();
  sourcePool = null;
  await restoredPool.end();
  restoredPool = null;
  const stopped = runPostgresTool("pg_ctl", ["--pgdata", pgDataDirectoryLinux, "--wait", "--mode", "fast", "stop"]);
  assertCommandSucceeded(stopped, "Stopping the isolated PostgreSQL test cluster");
  const started = runPostgresTool("pg_ctl", [
    "--pgdata", pgDataDirectoryLinux,
    "--log", pgLogFile,
    "--options", `-h ${postgresHost} -p ${postgresPort} -k ${pgDataDirectoryLinux}`,
    "--wait", "start",
  ]);
  assertCommandSucceeded(started, "Restarting the isolated PostgreSQL test cluster");

  sourcePool = new Pool({ connectionString: sourceUrl });
  restoredPool = new Pool({ connectionString: restoredUrl });
  const afterRestartSource = await snapshot(sourcePool);
  const afterRestartRestore = await snapshot(restoredPool);
  assert.deepEqual(afterRestartSource, sourceSnapshot);
  assert.deepEqual(afterRestartRestore, restoredSnapshotAfterQueries);
  await sourcePool.end();
  sourcePool = null;
  await restoredPool.end();
  restoredPool = null;

  await startApi();
  await assertSystemsCanUseRestoredDatabase();
});
