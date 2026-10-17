import { NextResponse } from "next/server";
import { currentCatalogActor } from "../../../../src/auth/catalog-auth.js";
import { database } from "../../../../src/db.js";

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
  return NextResponse.json({ error: "请检查产品规格、来源货位、目标货位、数量和实际发生时间。" }, { status: 400 });
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
  const sourceLocationId = requiredId(body.sourceLocationId);
  const targetLocationId = requiredId(body.targetLocationId);
  const actualOccurredAt = occurredAt(body.actualOccurredAt);
  const note = body.note === undefined ? "" : body.note;
  if (!productSpecId || !sourceLocationId || !targetLocationId
    || sourceLocationId === targetLocationId
    || !quantity(body.cases) || !quantity(body.loose)
    || (body.cases === 0 && body.loose === 0)
    || typeof note !== "string"
    || !actualOccurredAt) {
    return invalidRequest();
  }

  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const locationsResult = await client.query(
      `SELECT location_id, case_count, loose_count
         FROM product_spec_locations
        WHERE product_spec_id = $1
          AND location_id IN ($2, $3)
        ORDER BY location_id
        FOR UPDATE`,
      [productSpecId, sourceLocationId, targetLocationId],
    );
    if (locationsResult.rowCount !== 2) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "来源或目标货位不属于该产品规格，请刷新后重试。" }, { status: 404 });
    }

    const source = locationsResult.rows.find((location) => String(location.location_id) === sourceLocationId);
    const target = locationsResult.rows.find((location) => String(location.location_id) === targetLocationId);
    if (body.cases > source.case_count || body.loose > source.loose_count) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "移库数量超过来源货位的现有库存，请刷新库存后重试。" }, { status: 409 });
    }
    if (body.cases > 2147483647 - target.case_count || body.loose > 2147483647 - target.loose_count) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "目标货位库存超出可记录范围，请刷新库存后重试。" }, { status: 409 });
    }

    const sourceInventoryResult = await client.query(
      `UPDATE product_spec_locations
          SET case_count = case_count - $1,
              loose_count = loose_count - $2
        WHERE product_spec_id = $3
          AND location_id = $4
        RETURNING case_count, loose_count`,
      [body.cases, body.loose, productSpecId, sourceLocationId],
    );
    const targetInventoryResult = await client.query(
      `UPDATE product_spec_locations
          SET case_count = case_count + $1,
              loose_count = loose_count + $2
        WHERE product_spec_id = $3
          AND location_id = $4
        RETURNING case_count, loose_count`,
      [body.cases, body.loose, productSpecId, targetLocationId],
    );
    const transactionResult = await client.query(
      `INSERT INTO inventory_transactions (
         operation_type, product_spec_id, location_id, target_location_id,
         case_count, loose_count, note, actual_occurred_at, actor_account, source_system
       )
       VALUES ('move', $1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, actual_occurred_at, recorded_at`,
      [
        productSpecId,
        sourceLocationId,
        targetLocationId,
        body.cases,
        body.loose,
        note,
        actualOccurredAt,
        actor.account,
        actor.sourceSystem,
      ],
    );
    await client.query("COMMIT");

    const transaction = transactionResult.rows[0];
    const sourceInventory = sourceInventoryResult.rows[0];
    const targetInventory = targetInventoryResult.rows[0];
    return NextResponse.json({
      transactionId: String(transaction.id),
      operationType: "move",
      productSpecId,
      sourceLocationId,
      targetLocationId,
      cases: body.cases,
      loose: body.loose,
      note,
      actualOccurredAt: transaction.actual_occurred_at.toISOString(),
      recordedAt: transaction.recorded_at.toISOString(),
      actorAccount: actor.account,
      sourceSystem: actor.sourceSystem,
      sourceCases: sourceInventory.case_count,
      sourceLoose: sourceInventory.loose_count,
      targetCases: targetInventory.case_count,
      targetLoose: targetInventory.loose_count,
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
