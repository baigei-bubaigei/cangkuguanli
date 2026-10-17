import { NextResponse } from "next/server";
import { adminSessionCookie, currentAdmin } from "../../../../../src/auth/admin-auth.js";
import { currentCatalogActor } from "../../../../../src/auth/catalog-auth.js";
import { currentEmployee, employeeSessionCookie } from "../../../../../src/auth/employee-auth.js";
import { database } from "../../../../../src/db.js";

export const runtime = "nodejs";

const maxQuantity = 2147483647;
const editableOperationTypes = new Set(["inbound", "outbound", "move", "split"]);

function requiredId(value) {
  return typeof value === "string" && /^[1-9]\d*$/.test(value) ? value : null;
}

function quantity(value) {
  return Number.isInteger(value) && value >= 0 && value <= maxQuantity;
}

function occurredAt(value) {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function invalidRequest() {
  return NextResponse.json({ error: "请检查要更正的数量、实际发生时间或备注。" }, { status: 400 });
}

function inventoryConflict() {
  return NextResponse.json({ error: "更正会使库存不足或超出可记录范围，未保存；请刷新库存后重试。" }, { status: 409 });
}

function transactionContent(transaction) {
  return {
    cases: transaction.case_count,
    loose: transaction.loose_count,
    actualOccurredAt: transaction.actual_occurred_at.toISOString(),
    note: transaction.note,
  };
}

async function correctionActor(request) {
  const sourceSystem = request.headers.get("x-inventory-source-system");
  if (sourceSystem === "admin") {
    const token = request.cookies.get(adminSessionCookie)?.value;
    const admin = token ? await currentAdmin(token) : null;
    return admin ? { account: admin.account, sourceSystem } : null;
  }
  if (sourceSystem === "employee") {
    const token = request.cookies.get(employeeSessionCookie)?.value;
    const employee = token ? await currentEmployee(token) : null;
    return employee ? { account: employee.account, sourceSystem } : null;
  }
  return sourceSystem === null ? currentCatalogActor(request) : null;
}

function sameContent(left, right) {
  return left.cases === right.cases
    && left.loose === right.loose
    && left.actualOccurredAt === right.actualOccurredAt
    && left.note === right.note;
}

async function updateInventory(client, productSpecId, locationId, casesDelta, looseDelta) {
  const inventoryResult = await client.query(
    `SELECT case_count, loose_count
       FROM product_spec_locations
      WHERE product_spec_id = $1
        AND location_id = $2
      FOR UPDATE`,
    [productSpecId, locationId],
  );
  if (!inventoryResult.rowCount) return false;

  const inventory = inventoryResult.rows[0];
  const cases = inventory.case_count + casesDelta;
  const loose = inventory.loose_count + looseDelta;
  if (cases < 0 || loose < 0 || cases > maxQuantity || loose > maxQuantity) return false;

  await client.query(
    `UPDATE product_spec_locations
        SET case_count = $1, loose_count = $2
      WHERE product_spec_id = $3
        AND location_id = $4`,
    [cases, loose, productSpecId, locationId],
  );
  return true;
}

async function updateMoveInventory(client, transaction, casesDelta, looseDelta) {
  const result = await client.query(
    `SELECT location_id, case_count, loose_count
       FROM product_spec_locations
      WHERE product_spec_id = $1
        AND location_id = ANY($2::BIGINT[])
      ORDER BY location_id
      FOR UPDATE`,
    [transaction.product_spec_id, [transaction.location_id, transaction.target_location_id]],
  );
  if (result.rowCount !== 2) return false;

  const locations = new Map(result.rows.map((row) => [String(row.location_id), row]));
  const sourceId = String(transaction.location_id);
  const targetId = String(transaction.target_location_id);
  const source = locations.get(sourceId);
  const target = locations.get(targetId);
  const sourceCases = source.case_count - casesDelta;
  const sourceLoose = source.loose_count - looseDelta;
  const targetCases = target.case_count + casesDelta;
  const targetLoose = target.loose_count + looseDelta;
  if ([sourceCases, sourceLoose, targetCases, targetLoose].some((value) => (
    value < 0 || value > maxQuantity
  ))) return false;

  await client.query(
    `UPDATE product_spec_locations
        SET case_count = CASE
              WHEN location_id = $2::BIGINT THEN $3::INTEGER
              ELSE $5::INTEGER
            END,
            loose_count = CASE
              WHEN location_id = $2::BIGINT THEN $6::INTEGER
              ELSE $7::INTEGER
            END
      WHERE product_spec_id = $1
        AND location_id IN ($2::BIGINT, $4::BIGINT)`,
    [transaction.product_spec_id, sourceId, sourceCases, targetId, targetCases, sourceLoose, targetLoose],
  );
  return true;
}

export async function PATCH(request, { params }) {
  const actor = await correctionActor(request);
  if (!actor) {
    return NextResponse.json({ error: "需要登录后更正业务记录。" }, {
      status: 401,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const { id: rawId } = await params;
  const transactionId = requiredId(rawId);
  if (!transactionId) return invalidRequest();

  let body;
  try {
    body = await request.json();
  } catch {
    return invalidRequest();
  }
  if (!body || typeof body !== "object" || Array.isArray(body)
    || !Object.hasOwn(body, "expectedRevision")
    || (body.expectedRevision !== null && !requiredId(body.expectedRevision))) {
    return invalidRequest();
  }

  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const transactionResult = await client.query(
      `SELECT t.id, t.operation_type, t.product_spec_id, t.location_id, t.target_location_id,
              t.case_count, t.loose_count, t.actual_occurred_at, t.note,
              p.per_case_count
         FROM inventory_transactions t
         JOIN product_specs p ON p.id = t.product_spec_id
        WHERE t.id = $1
        FOR UPDATE OF t`,
      [transactionId],
    );
    if (!transactionResult.rowCount) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "找不到这条业务记录，请刷新后重试。" }, { status: 404 });
    }

    const transaction = transactionResult.rows[0];
    if (!editableOperationTypes.has(transaction.operation_type)) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "初始库存记录暂不支持更正。" }, { status: 409 });
    }

    const latestCorrectionResult = await client.query(
      `SELECT id
         FROM inventory_transaction_corrections
        WHERE transaction_id = $1
        ORDER BY id DESC
        LIMIT 1`,
      [transactionId],
    );
    const currentRevision = latestCorrectionResult.rowCount
      ? String(latestCorrectionResult.rows[0].id)
      : null;
    if (body.expectedRevision !== currentRevision) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "该业务记录已被其他人更正，未覆盖已有内容；请刷新记录后重试。" }, { status: 409 });
    }

    const allowedFields = transaction.operation_type === "move"
      ? new Set(["cases", "loose", "actualOccurredAt", "note"])
      : transaction.operation_type === "split"
        ? new Set(["cases", "actualOccurredAt"])
        : new Set(["cases", "loose", "actualOccurredAt"]);
    if (Object.keys(body).some((key) => key !== "expectedRevision" && !allowedFields.has(key))) {
      await client.query("ROLLBACK");
      return invalidRequest();
    }

    const before = transactionContent(transaction);
    const after = { ...before };
    if (Object.hasOwn(body, "cases")) {
      const validCases = transaction.operation_type === "split"
        ? Number.isInteger(body.cases) && body.cases > 0 && body.cases <= maxQuantity
        : quantity(body.cases);
      if (!validCases) {
        await client.query("ROLLBACK");
        return invalidRequest();
      }
      after.cases = body.cases;
    }
    if (Object.hasOwn(body, "loose")) {
      if (!quantity(body.loose)) {
        await client.query("ROLLBACK");
        return invalidRequest();
      }
      after.loose = body.loose;
    }
    if (Object.hasOwn(body, "actualOccurredAt")) {
      const actualOccurredAt = occurredAt(body.actualOccurredAt);
      if (!actualOccurredAt) {
        await client.query("ROLLBACK");
        return invalidRequest();
      }
      after.actualOccurredAt = actualOccurredAt.toISOString();
    }
    if (Object.hasOwn(body, "note")) {
      if (typeof body.note !== "string") {
        await client.query("ROLLBACK");
        return invalidRequest();
      }
      after.note = body.note;
    }
    if (transaction.operation_type === "split") {
      after.loose = after.cases * transaction.per_case_count;
      if (after.loose > maxQuantity) {
        await client.query("ROLLBACK");
        return invalidRequest();
      }
    }
    if (after.cases === 0 && after.loose === 0) {
      await client.query("ROLLBACK");
      return invalidRequest();
    }
    if (sameContent(before, after)) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "没有需要保存的更正内容。" }, { status: 400 });
    }

    const casesDelta = after.cases - before.cases;
    const looseDelta = after.loose - before.loose;
    let inventoryUpdated = true;
    if (casesDelta !== 0 || looseDelta !== 0) {
      if (transaction.operation_type === "inbound") {
        inventoryUpdated = await updateInventory(
          client,
          transaction.product_spec_id,
          transaction.location_id,
          casesDelta,
          looseDelta,
        );
      } else if (transaction.operation_type === "outbound" || transaction.operation_type === "split") {
        inventoryUpdated = await updateInventory(
          client,
          transaction.product_spec_id,
          transaction.location_id,
          -casesDelta,
          transaction.operation_type === "split" ? looseDelta : -looseDelta,
        );
      } else {
        inventoryUpdated = await updateMoveInventory(client, transaction, casesDelta, looseDelta);
      }
    }
    if (!inventoryUpdated) {
      await client.query("ROLLBACK");
      return inventoryConflict();
    }

    const actorResult = actor.sourceSystem === "admin"
      ? await client.query("SELECT display_name FROM admin_accounts WHERE account = $1", [actor.account])
      : await client.query("SELECT display_name FROM employee_accounts WHERE account = $1", [actor.account]);
    const actorDisplayName = actorResult.rows[0]?.display_name ?? actor.account;
    await client.query(
      `UPDATE inventory_transactions
          SET case_count = $1,
              loose_count = $2,
              actual_occurred_at = $3,
              note = $4
        WHERE id = $5`,
      [after.cases, after.loose, after.actualOccurredAt, after.note, transactionId],
    );
    const correctionResult = await client.query(
      `INSERT INTO inventory_transaction_corrections (
         transaction_id, actor_account_snapshot, actor_display_name_snapshot,
         source_system, before_content, after_content
       )
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, corrected_at`,
      [transactionId, actor.account, actorDisplayName, actor.sourceSystem, before, after],
    );
    await client.query("COMMIT");

    const correction = correctionResult.rows[0];
    return NextResponse.json({
      correction: {
        id: String(correction.id),
        actor: { account: actor.account, displayName: actorDisplayName },
        sourceSystem: actor.sourceSystem,
        correctedAt: correction.corrected_at.toISOString(),
        before,
        after,
      },
    }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
