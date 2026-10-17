import { NextResponse } from "next/server";
import { currentCatalogActor } from "../../../../src/auth/catalog-auth.js";
import { database } from "../../../../src/db.js";
import { writeOperationLog } from "../../../../src/operation-logs.js";

export const runtime = "nodejs";

function requiredId(value) {
  return typeof value === "string" && /^\d+$/.test(value) ? value : null;
}

function quantity(value) {
  return Number.isInteger(value) && value >= 0 && value <= 2147483647;
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
  return NextResponse.json({ error: "请检查产品规格、货位、数量和实际发生时间。" }, { status: 400 });
}

export async function POST(request) {
  const actor = await currentCatalogActor(request);
  if (!actor) {
    return NextResponse.json({ error: "需要登录后办理库存业务。" }, {
      status: 401,
      headers: { "Cache-Control": "no-store" },
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return invalidRequest();
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return invalidRequest();

  const productSpecId = requiredId(body.productSpecId);
  const locationId = requiredId(body.locationId);
  const actualOccurredAt = occurredAt(body.actualOccurredAt);
  if (!productSpecId || !locationId
    || !quantity(body.cases) || !quantity(body.loose)
    || (body.cases === 0 && body.loose === 0)
    || !actualOccurredAt) {
    return invalidRequest();
  }

  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const inventoryResult = await client.query(
      `SELECT case_count, loose_count
         FROM product_spec_locations
        WHERE product_spec_id = $1
          AND location_id = $2
        FOR UPDATE`,
      [productSpecId, locationId],
    );
    if (!inventoryResult.rowCount) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "所选货位不属于该产品规格，请刷新后重试。" }, { status: 404 });
    }

    const available = inventoryResult.rows[0];
    if (body.cases > available.case_count || body.loose > available.loose_count) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "出库数量超过所选货位的现有库存，请刷新库存后重试。" }, { status: 409 });
    }

    const updatedInventory = await client.query(
      `UPDATE product_spec_locations
          SET case_count = case_count - $1,
              loose_count = loose_count - $2
        WHERE product_spec_id = $3
          AND location_id = $4
        RETURNING case_count, loose_count`,
      [body.cases, body.loose, productSpecId, locationId],
    );
    const transactionResult = await client.query(
      `INSERT INTO inventory_transactions (
         operation_type, product_spec_id, location_id, case_count, loose_count,
         actual_occurred_at, actor_account, source_system
       )
       VALUES ('outbound', $1, $2, $3, $4, $5, $6, $7)
       RETURNING id, actual_occurred_at, recorded_at`,
      [
        productSpecId,
        locationId,
        body.cases,
        body.loose,
        actualOccurredAt,
        actor.account,
        actor.sourceSystem,
      ],
    );
    const transaction = transactionResult.rows[0];
    await writeOperationLog(client, {
      actor,
      operationType: "inventory_outbound",
      targetType: "inventory_transaction",
      targetId: transaction.id,
      content: {
        productSpecId,
        locationId,
        cases: body.cases,
        loose: body.loose,
        actualOccurredAt: transaction.actual_occurred_at.toISOString(),
      },
    });
    await client.query("COMMIT");

    return NextResponse.json({
      transactionId: String(transaction.id),
      operationType: "outbound",
      productSpecId,
      locationId,
      cases: body.cases,
      loose: body.loose,
      actualOccurredAt: transaction.actual_occurred_at.toISOString(),
      recordedAt: transaction.recorded_at.toISOString(),
      actorAccount: actor.account,
      sourceSystem: actor.sourceSystem,
      locationCases: updatedInventory.rows[0].case_count,
      locationLoose: updatedInventory.rows[0].loose_count,
    }, {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
