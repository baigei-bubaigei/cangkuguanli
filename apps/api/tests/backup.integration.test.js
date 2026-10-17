import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { Pool } from "pg";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL must point to a PostgreSQL database for isolated-schema testing.");
}

const testSchema = `issue35_backup_${process.pid}_${randomBytes(6).toString("hex")}`;
const isolatedDatabaseUrl = new URL(testDatabaseUrl);
isolatedDatabaseUrl.searchParams.set("options", `-c search_path=${testSchema}`);
const bootstrapDatabaseUrl = new URL(testDatabaseUrl);
bootstrapDatabaseUrl.searchParams.set("options", "-c search_path=pg_catalog");
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const apiDirectory = fileURLToPath(new URL("..", import.meta.url));
const migrationCli = fileURLToPath(new URL("../scripts/migrate.js", import.meta.url));
const accountPrefix = `issue35-${process.pid}-${randomBytes(4).toString("hex")}`;
const fixture = {};
let pool;
let schemaCreated = false;
let temporaryDirectory;

function postgresEnvironment(databaseUrl) {
  const url = new URL(databaseUrl);
  const environment = { ...process.env };
  const mappings = {
    host: "PGHOST",
    port: "PGPORT",
    user: "PGUSER",
    password: "PGPASSWORD",
    sslmode: "PGSSLMODE",
    sslcert: "PGSSLCERT",
    sslkey: "PGSSLKEY",
    sslrootcert: "PGSSLROOTCERT",
    options: "PGOPTIONS",
    application_name: "PGAPPNAME",
  };
  environment.PGHOST = url.hostname.replace(/^\[|\]$/g, "");
  environment.PGPORT = url.port || "5432";
  environment.PGUSER = decodeURIComponent(url.username);
  environment.PGPASSWORD = decodeURIComponent(url.password);
  environment.PGDATABASE = decodeURIComponent(url.pathname.slice(1));
  for (const [parameter, variable] of Object.entries(mappings)) {
    const value = url.searchParams.get(parameter);
    if (value) {
      environment[variable] = value;
    }
  }
  const wslEnvironment = new Set((environment.WSLENV ?? "").split(":").filter(Boolean));
  for (const name of [
    "PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE", "PGOPTIONS",
    "PGSSLMODE", "PGSSLCERT", "PGSSLKEY", "PGSSLROOTCERT", "PGAPPNAME",
  ]) {
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

async function createFixtures() {
  const admin = await pool.query(
    `INSERT INTO admin_accounts (account, display_name, password_hash, status)
     VALUES ($1, $2, $3, 'active') RETURNING id`,
    [`${accountPrefix}-admin`, "备份测试管理员", "backup-test-hash"],
  );
  const disabledAdmin = await pool.query(
    `INSERT INTO admin_accounts (account, display_name, password_hash, status)
     VALUES ($1, $2, $3, 'disabled') RETURNING id`,
    [`${accountPrefix}-disabled-admin`, "停用管理员", "backup-test-hash"],
  );
  const employee = await pool.query(
    `INSERT INTO employee_accounts (account, display_name, password_hash, status)
     VALUES ($1, $2, $3, 'active') RETURNING id`,
    [`${accountPrefix}-employee`, "备份测试员工", "backup-test-hash"],
  );
  const disabledEmployee = await pool.query(
    `INSERT INTO employee_accounts (account, display_name, status)
     VALUES ($1, $2, 'disabled') RETURNING id`,
    [`${accountPrefix}-disabled-employee`, "停用员工"],
  );
  fixture.adminId = admin.rows[0].id;
  fixture.employeeId = employee.rows[0].id;
  fixture.account = `${accountPrefix}-admin`;

  await pool.query(
    "INSERT INTO admin_sessions (token_hash, admin_account_id) VALUES ($1, $2)",
    [randomUUID(), fixture.adminId],
  );
  await pool.query(
    "INSERT INTO employee_sessions (token_hash, employee_account_id) VALUES ($1, $2)",
    [randomUUID(), fixture.employeeId],
  );

  const warehouse = await pool.query(
    "INSERT INTO warehouses (name) VALUES ($1) RETURNING id",
    [`${accountPrefix}-仓库`],
  );
  const locations = await Promise.all(["A-01", "A-02"].map((name) => pool.query(
    "INSERT INTO locations (warehouse_id, name) VALUES ($1, $2) RETURNING id",
    [warehouse.rows[0].id, name],
  )));
  const firstProduct = await pool.query(
    `INSERT INTO product_specs
       (product_name, spec, category, category_name, note, per_case_count, material, color)
     VALUES ($1, '规格一', 'cat-a', '测试分类', '备份产品', 2, '铝合金', '黑色')
     RETURNING id`,
    [`${accountPrefix}-同一产品`],
  );
  const secondProduct = await pool.query(
    `INSERT INTO product_specs
       (product_name, spec, category, category_name, note, per_case_count, material, color)
     VALUES ($1, '规格一', 'cat-a', '测试分类', '不同包装规格', 4, '铝合金', '黑色')
     RETURNING id`,
    [`${accountPrefix}-同一产品`],
  );
  fixture.productId = firstProduct.rows[0].id;
  fixture.secondProductId = secondProduct.rows[0].id;
  fixture.locationId = locations[0].rows[0].id;
  await pool.query(
    `INSERT INTO product_spec_locations (product_spec_id, location_id, case_count, loose_count)
     VALUES ($1, $2, 3, 1), ($3, $4, 0, 0)`,
    [fixture.productId, fixture.locationId, fixture.secondProductId, locations[1].rows[0].id],
  );

  const transaction = await pool.query(
    `INSERT INTO inventory_transactions
       (operation_type, product_spec_id, location_id, case_count, loose_count,
        actual_occurred_at, actor_account, source_system, note)
     VALUES ('inbound', $1, $2, 2, 1, '2026-10-17T08:00:00Z', $3, 'admin', '备份库存记录')
     RETURNING id`,
    [fixture.productId, fixture.locationId, fixture.account],
  );
  fixture.transactionId = transaction.rows[0].id;
  await pool.query(
    `INSERT INTO inventory_transaction_corrections
       (transaction_id, actor_account_snapshot, actor_display_name_snapshot,
        source_system, before_content, after_content)
     VALUES ($1, $2, '备份测试管理员', 'admin',
             '{"caseCount":1,"looseCount":1}',
             '{"caseCount":2,"looseCount":1}')`,
    [fixture.transactionId, fixture.account],
  );

  const batch = await pool.query(
    "SELECT nextval('initial_inventory_import_batch_id_seq')::text AS id",
  );
  fixture.batchId = batch.rows[0].id;
  await pool.query(
    `INSERT INTO system_operation_logs
       (actor_admin_account_id, actor_account_snapshot, actor_display_name_snapshot,
        source_system, operation_type, target_type, target_id, operation_content)
     VALUES
       ($1, $2, '备份测试管理员', 'admin', 'inbound', 'inventory_transaction', $3,
        '{"operation":"inbound"}'::jsonb),
       ($1, $2, '备份测试管理员', 'admin', 'initial_inventory_import',
        'initial_inventory_import_batch', $4::bigint,
        jsonb_build_object('batchId', $4::bigint::text, 'result', 'success', 'importedRows', 1))`,
    [fixture.adminId, fixture.account, fixture.transactionId, fixture.batchId],
  );
  await pool.query(
    `INSERT INTO inventory_request_idempotency
       (source_system, actor_account, request_scope, idempotency_key, payload_hash,
        response_status, response_body)
     VALUES ('admin', $1, 'inbound', $2, $3, 201, $4::jsonb)`,
    [fixture.account, randomUUID(), "a".repeat(64), JSON.stringify({ transactionId: fixture.transactionId })],
  );

  assert.ok(disabledAdmin.rows[0].id);
  assert.ok(disabledEmployee.rows[0].id);
}

async function snapshot() {
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
      'operationLogAdminLinks', (
        SELECT count(*) FROM system_operation_logs l
        JOIN admin_accounts a ON a.id = l.actor_admin_account_id
        WHERE l.actor_admin_account_id IS NOT NULL
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

function assertExpectedSnapshot(value) {
  const records = value.records;
  assert.equal(records.admin_accounts.length, 2);
  assert.deepEqual(records.admin_accounts.map(({ status }) => status).sort(), ["active", "disabled"]);
  assert.equal(records.employee_accounts.length, 2);
  assert.deepEqual(records.employee_accounts.map(({ status }) => status).sort(), ["active", "disabled"]);
  assert.equal(records.admin_sessions.length, 1);
  assert.equal(records.employee_sessions.length, 1);
  assert.equal(records.product_specs.length, 2);
  assert.deepEqual(records.product_specs.map(({ per_case_count }) => per_case_count).sort(), [2, 4]);
  assert.equal(records.warehouses.length, 1);
  assert.equal(records.locations.length, 2);
  assert.equal(records.product_spec_locations.length, 2);
  assert.equal(records.inventory_transactions.length, 1);
  assert.equal(records.inventory_transaction_corrections.length, 1);
  assert.equal(records.system_operation_logs.length, 2);
  assert.equal(records.inventory_request_idempotency.length, 1);
  assert.equal(records.schema_migrations.length, 12);
  assert.deepEqual(value.associations, {
    adminSessionAccountLinks: 1,
    employeeSessionAccountLinks: 1,
    productWarehouseLocationLinks: 2,
    transactionProductLocationLinks: 1,
    correctionTransactionLinks: 1,
    operationLogAdminLinks: 2,
    importBatchLogLinks: 1,
  });
}

function assertCommandSucceeded(result, message) {
  if (result.status !== 0) {
    throw new Error(`${message} (exit ${result.status ?? result.signal ?? "unknown"}): ${result.stderr || result.stdout}`);
  }
}

async function dropTestSchema() {
  const cleanupPool = new Pool({ connectionString: bootstrapDatabaseUrl.toString() });
  try {
    await cleanupPool.query(`DROP SCHEMA IF EXISTS "${testSchema}" CASCADE`);
  } finally {
    await cleanupPool.end();
  }
}

before(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "cangkuguanli-backup-"));
  const bootstrapPool = new Pool({ connectionString: bootstrapDatabaseUrl.toString() });
  try {
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
  assertCommandSucceeded(migrations, "PostgreSQL migrations failed");

  pool = new Pool({ connectionString: isolatedDatabaseUrl.toString() });
  const connection = await pool.connect();
  try {
    const result = await connection.query("SELECT current_schema() AS schema");
    assert.equal(result.rows[0].schema, testSchema);
  } finally {
    connection.release();
  }
  await createFixtures();
});

after(async () => {
  try {
    if (pool) await pool.end();
  } finally {
    try {
      if (schemaCreated) await dropTestSchema();
    } finally {
      if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
});

test("PostgreSQL backup preserves warehouse records and their associations", async () => {
  const source = await snapshot();
  assertExpectedSnapshot(source);

  const shimDirectory = join(temporaryDirectory, "postgres-tools");
  await mkdir(shimDirectory);
  await writeFile(
    join(shimDirectory, "pg_dump.cmd"),
    "@echo off\r\nwsl.exe --distribution Ubuntu --exec /usr/bin/pg_dump %*\r\n",
    "utf8",
  );
  const archivePath = join(temporaryDirectory, "warehouse.backup");
  const backupEnvironment = {
    ...postgresEnvironment(isolatedDatabaseUrl.toString()),
    DATABASE_URL: isolatedDatabaseUrl.toString(),
    PGSSLMODE: "",
  };
  const pathVariable = Object.keys(backupEnvironment).find((name) => name.toLowerCase() === "path") ?? "PATH";
  backupEnvironment[pathVariable] = `${shimDirectory};${backupEnvironment[pathVariable]}`;
  const backup = spawnSync(process.execPath, [
    process.env.npm_execpath,
    "run", "db:backup", "--", "--output", archivePath,
  ], {
    cwd: repositoryRoot,
    env: backupEnvironment,
    encoding: "utf8",
  });
  assertCommandSucceeded(backup, "Backup command failed");

  await pool.end();
  pool = null;
  await dropTestSchema();
  schemaCreated = true;
  const restoreBootstrapPool = new Pool({ connectionString: bootstrapDatabaseUrl.toString() });
  try {
    await restoreBootstrapPool.query(`CREATE SCHEMA "${testSchema}"`);
  } finally {
    await restoreBootstrapPool.end();
  }

  const toolEnvironment = postgresEnvironment(testDatabaseUrl);
  const archivePathResult = spawnSync(
    "wsl.exe",
    ["--distribution", "Ubuntu", "--exec", "wslpath", "-a", archivePath],
    { env: toolEnvironment, encoding: "utf8" },
  );
  assertCommandSucceeded(archivePathResult, "Could not resolve the local backup path for PostgreSQL restore");
  const restore = spawnSync(
    "wsl.exe",
    [
      "--distribution", "Ubuntu", "--exec", "/usr/bin/pg_restore",
      "--exit-on-error", "--single-transaction", "--schema", testSchema,
      "--dbname", toolEnvironment.PGDATABASE,
      archivePathResult.stdout.trim(),
    ],
    { env: toolEnvironment, encoding: "utf8" },
  );
  assertCommandSucceeded(restore, "PostgreSQL backup restore failed");

  pool = new Pool({ connectionString: isolatedDatabaseUrl.toString() });
  const restored = await snapshot();
  assertExpectedSnapshot(restored);
  assert.deepEqual(restored, source);
});
