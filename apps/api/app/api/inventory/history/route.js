import { NextResponse } from "next/server";
import { hasCatalogSession } from "../../../../src/auth/catalog-auth.js";
import { database } from "../../../../src/db.js";

export const runtime = "nodejs";

const operationTypes = new Set(["inbound", "outbound", "move", "split", "initial"]);
const sourceSystems = new Set(["admin", "employee"]);

function historyRecord(row) {
  const corrections = row.corrections;
  return {
    id: String(row.id),
    revisionId: corrections.length ? corrections[corrections.length - 1].id : null,
    operationType: row.operation_type,
    product: {
      id: String(row.product_spec_id),
      name: row.product_name,
      spec: row.spec,
      perCase: row.per_case_count,
    },
    cases: row.case_count,
    loose: row.loose_count,
    location: {
      id: String(row.location_id),
      warehouse: row.warehouse_name,
      spot: row.location_name,
    },
    targetLocation: row.target_location_id === null ? null : {
      id: String(row.target_location_id),
      warehouse: row.target_warehouse_name,
      spot: row.target_location_name,
    },
    actualOccurredAt: row.actual_occurred_at.toISOString(),
    recordedAt: row.recorded_at.toISOString(),
    actor: {
      account: row.actor_account,
      displayName: row.actor_display_name,
    },
    sourceSystem: row.source_system,
    note: row.note,
    corrections,
  };
}

export async function GET(request) {
  if (!await hasCatalogSession(request)) {
    return NextResponse.json({ error: "需要登录后查询业务历史。" }, {
      status: 401,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const searchParams = new URL(request.url).searchParams;
  const type = searchParams.get("type") || null;
  const source = searchParams.get("source") || null;
  const keyword = (searchParams.get("q") || "").trim();
  if ((type && !operationTypes.has(type)) || (source && !sourceSystems.has(source))) {
    return NextResponse.json({ error: "业务类型或来源系统筛选值无效。" }, { status: 400 });
  }

  const client = await database().connect();
  try {
    const result = await client.query(
      `SELECT t.id, t.operation_type, t.product_spec_id, t.location_id, t.target_location_id,
              t.case_count, t.loose_count, t.actual_occurred_at, t.recorded_at,
              t.actor_account, t.source_system, t.note,
              p.product_name, p.spec, p.per_case_count,
              w.name AS warehouse_name, l.name AS location_name,
              tw.name AS target_warehouse_name, tl.name AS target_location_name,
              COALESCE(
                CASE WHEN t.source_system = 'admin' THEN aa.display_name ELSE ea.display_name END,
                t.actor_account
              ) AS actor_display_name
         FROM inventory_transactions t
         JOIN product_specs p ON p.id = t.product_spec_id
         JOIN locations l ON l.id = t.location_id
         JOIN warehouses w ON w.id = l.warehouse_id
         LEFT JOIN locations tl ON tl.id = t.target_location_id
         LEFT JOIN warehouses tw ON tw.id = tl.warehouse_id
         LEFT JOIN admin_accounts aa ON t.source_system = 'admin' AND aa.account = t.actor_account
         LEFT JOIN employee_accounts ea ON t.source_system = 'employee' AND ea.account = t.actor_account
        WHERE ($1::TEXT IS NULL OR t.operation_type = $1)
          AND ($2::TEXT IS NULL OR t.source_system = $2)
          AND (
            $3 = ''
            OR POSITION(LOWER($3) IN LOWER(p.product_name)) > 0
            OR POSITION(LOWER($3) IN LOWER(p.spec)) > 0
            OR POSITION(LOWER($3) IN LOWER(w.name || ' · ' || l.name)) > 0
            OR POSITION(LOWER($3) IN LOWER(t.actor_account)) > 0
            OR POSITION(LOWER($3) IN LOWER(COALESCE(aa.display_name, ea.display_name, ''))) > 0
            OR POSITION(LOWER($3) IN LOWER(t.note)) > 0
          )
        ORDER BY t.actual_occurred_at DESC, t.recorded_at DESC, t.id DESC`,
      [type, source, keyword],
    );

    const correctionsByTransaction = new Map(result.rows.map((row) => [String(row.id), []]));
    if (result.rows.length) {
      const correctionsResult = await client.query(
        `SELECT transaction_id, id, actor_account_snapshot, actor_display_name_snapshot,
                source_system, corrected_at, before_content, after_content
           FROM inventory_transaction_corrections
          WHERE transaction_id = ANY($1::BIGINT[])
          ORDER BY transaction_id, id`,
        [result.rows.map((row) => row.id)],
      );
      for (const correction of correctionsResult.rows) {
        correctionsByTransaction.get(String(correction.transaction_id)).push({
          id: String(correction.id),
          actor: {
            account: correction.actor_account_snapshot,
            displayName: correction.actor_display_name_snapshot,
          },
          sourceSystem: correction.source_system,
          correctedAt: correction.corrected_at.toISOString(),
          before: correction.before_content,
          after: correction.after_content,
        });
      }
    }

    return NextResponse.json({
      records: result.rows.map((row) => historyRecord({
        ...row,
        corrections: correctionsByTransaction.get(String(row.id)),
      })),
    }, {
      headers: { "Cache-Control": "no-store" },
    });
  } finally {
    client.release();
  }
}
