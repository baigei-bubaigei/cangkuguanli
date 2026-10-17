import { NextResponse } from "next/server";
import { currentCatalogActor } from "../../../../src/auth/catalog-auth.js";
import { database } from "../../../../src/db.js";
import {
  claimIdempotency,
  completeIdempotency,
  idempotencyResponse,
  missingIdempotencyKeyResponse,
  requestIdempotencyKey,
} from "../../../../src/idempotency.js";
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
  const idempotencyKey = requestIdempotencyKey(request);
  if (!idempotencyKey) return missingIdempotencyKeyResponse();

  let body;
  let payload;
  try {
    const rawBody = await request.text();
    try {
      body = JSON.parse(rawBody);
      payload = body;
    } catch {
      payload = { unparsedJson: rawBody };
    }
  } catch {
    return invalidRequest();
  }

  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const claim = await claimIdempotency(client, {
      actor,
      scope: "inventory/inbound",
      key: idempotencyKey,
      payload,
    });
    const priorResponse = idempotencyResponse(claim);
    if (priorResponse) {
      await client.query("ROLLBACK");
      return priorResponse;
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      await client.query("ROLLBACK");
      return invalidRequest();
    }

    const productSpecId = requiredId(body.productSpecId);
    const locationId = requiredId(body.locationId);
    const actualOccurredAt = occurredAt(body.actualOccurredAt);
    if (!productSpecId || !locationId
      || !quantity(body.cases) || !quantity(body.loose)
      || (body.cases === 0 && body.loose === 0)
      || !actualOccurredAt) {
      await client.query("ROLLBACK");
      return invalidRequest();
    }

    const inventoryResult = await client.query(
      `UPDATE product_spec_locations
          SET case_count = case_count + $1,
              loose_count = loose_count + $2
        WHERE product_spec_id = $3
          AND location_id = $4
        RETURNING case_count, loose_count`,
      [body.cases, body.loose, productSpecId, locationId],
    );
    if (!inventoryResult.rowCount) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "所选货位不属于该产品规格，请刷新后重试。" }, { status: 404 });
    }

    const transactionResult = await client.query(
      `INSERT INTO inventory_transactions (
         operation_type, product_spec_id, location_id, case_count, loose_count,
         actual_occurred_at, actor_account, source_system
       )
       VALUES ('inbound', $1, $2, $3, $4, $5, $6, $7)
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
      operationType: "inventory_inbound",
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
    const responseBody = {
      transactionId: String(transaction.id),
      operationType: "inbound",
      productSpecId,
      locationId,
      cases: body.cases,
      loose: body.loose,
      actualOccurredAt: transaction.actual_occurred_at.toISOString(),
      recordedAt: transaction.recorded_at.toISOString(),
      actorAccount: actor.account,
      sourceSystem: actor.sourceSystem,
      locationCases: inventoryResult.rows[0].case_count,
      locationLoose: inventoryResult.rows[0].loose_count,
    };
    await completeIdempotency(client, claim.id, 201, responseBody);
    await client.query("COMMIT");

    return NextResponse.json(responseBody, {
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
