import { database } from "./db.js";

const sourceSystems = new Set(["admin", "employee"]);

export async function querySystemOperationLogs(request, { employeeOnly = false } = {}) {
  const searchParams = new URL(request.url).searchParams;
  const requestedSource = searchParams.get("source") || null;
  if (!employeeOnly && requestedSource && !sourceSystems.has(requestedSource)) {
    return { error: "来源系统筛选值无效。", status: 400 };
  }

  const sourceSystem = employeeOnly ? "employee" : requestedSource;
  const actorAccount = searchParams.get("actorAccount")?.trim() || null;
  const keyword = (searchParams.get("q") || "").trim();
  const client = await database().connect();
  try {
    const actors = await client.query(
      `SELECT DISTINCT actor_account_snapshot AS account,
              actor_display_name_snapshot AS "displayName"
         FROM system_operation_logs
        WHERE ($1::TEXT IS NULL OR source_system = $1)
        ORDER BY "displayName", account`,
      [employeeOnly ? "employee" : null],
    );
    const result = await client.query(
      `SELECT id::TEXT AS id,
              actor_account_snapshot AS "actorAccount",
              actor_display_name_snapshot AS "actorDisplayName",
              source_system AS "sourceSystem",
              operation_type AS "operationType",
              target_type AS "targetType",
              target_id::TEXT AS "targetId",
              operation_content AS content,
              recorded_at AS "recordedAt"
         FROM system_operation_logs
        WHERE ($1::TEXT IS NULL OR source_system = $1)
          AND ($2::TEXT IS NULL OR actor_account_snapshot = $2)
          AND (
            $3 = ''
            OR POSITION(LOWER($3) IN LOWER(actor_account_snapshot)) > 0
            OR POSITION(LOWER($3) IN LOWER(actor_display_name_snapshot)) > 0
            OR POSITION(LOWER($3) IN LOWER(operation_type)) > 0
            OR POSITION(LOWER($3) IN LOWER(target_type)) > 0
            OR POSITION(LOWER($3) IN LOWER(operation_content::TEXT)) > 0
          )
        ORDER BY recorded_at DESC, id DESC`,
      [sourceSystem, actorAccount, keyword],
    );

    return {
      records: result.rows.map((row) => ({
        ...row,
        recordedAt: row.recordedAt.toISOString(),
      })),
      actors: actors.rows,
    };
  } finally {
    client.release();
  }
}
