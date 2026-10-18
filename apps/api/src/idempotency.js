import { createHash } from "node:crypto";
import { NextResponse } from "next/server";

export function requestIdempotencyKey(request) {
  const key = request.headers.get("Idempotency-Key");
  return key && key.length <= 255 && key.trim() === key ? key : null;
}
export async function readIdempotencyPayload(request) {
  const rawBody = await request.text();
  try {
    const body = JSON.parse(rawBody);
    return { body, payload: body };
  } catch {
    return { body: undefined, payload: { unparsedJson: rawBody } };
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

function payloadHash(payload) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalJson(payload)))
    .digest("hex");
}

export async function claimIdempotency(client, { actor, scope, key, payload }) {
  const hash = payloadHash(payload);
  const inserted = await client.query(
    `INSERT INTO inventory_request_idempotency (
       source_system, actor_account, request_scope, idempotency_key, payload_hash
     ) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (source_system, actor_account, request_scope, idempotency_key) DO NOTHING
     RETURNING id`,
    [actor.sourceSystem, actor.account, scope, key, hash],
  );
  if (inserted.rowCount) return { kind: "new", id: inserted.rows[0].id };

  const existingResult = await client.query(
    `SELECT id, payload_hash, response_status, response_body
       FROM inventory_request_idempotency
      WHERE source_system = $1
        AND actor_account = $2
        AND request_scope = $3
        AND idempotency_key = $4
      FOR UPDATE`,
    [actor.sourceSystem, actor.account, scope, key],
  );
  const existing = existingResult.rows[0];
  if (existing.payload_hash !== hash) return { kind: "conflict" };
  return {
    kind: "replay",
    status: existing.response_status,
    body: existing.response_body,
  };
}

export async function completeIdempotency(client, id, status, body) {
  await client.query(
    `UPDATE inventory_request_idempotency
        SET response_status = $1,
            response_body = $2
      WHERE id = $3`,
    [status, body, id],
  );
}

export function idempotencyResponse(claim) {
  if (claim.kind === "conflict") {
    return NextResponse.json(
      { error: "此提交标识已用于不同内容，请使用新的提交标识重试。" },
      { status: 409, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (claim.kind === "replay") {
    return NextResponse.json(claim.body, {
      status: claim.status,
      headers: { "Cache-Control": "no-store" },
    });
  }
  return null;
}

export function missingIdempotencyKeyResponse() {
  return NextResponse.json(
    { error: "缺少库存业务提交标识，请刷新后重试。" },
    { status: 400, headers: { "Cache-Control": "no-store" } },
  );
}
