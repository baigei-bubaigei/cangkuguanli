import { NextResponse } from "next/server";
import { hasCatalogSession } from "../../../../../src/auth/catalog-auth.js";
import { database } from "../../../../../src/db.js";

export const runtime = "nodejs";

function requiredText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function invalidRequest() {
  return NextResponse.json({ error: "请填写有效规格、仓库和货位名称。" }, { status: 400 });
}

export async function POST(request) {
  if (!await hasCatalogSession(request)) {
    return NextResponse.json({ error: "需要登录后维护产品与货位。" }, { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return invalidRequest();
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return invalidRequest();

  const productSpecId = requiredText(body.productSpecId);
  const warehouse = requiredText(body.warehouse);
  const spot = requiredText(body.spot);
  if (!productSpecId || !/^\d+$/.test(productSpecId) || !warehouse || !spot) {
    return invalidRequest();
  }

  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const productResult = await client.query(
      "SELECT 1 FROM product_specs WHERE id = $1",
      [productSpecId],
    );
    if (!productResult.rowCount) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "所选产品规格不存在，请刷新后重试。" }, { status: 404 });
    }

    const duplicateResult = await client.query(
      `SELECT 1
         FROM product_spec_locations sl
         JOIN locations l ON l.id = sl.location_id
         JOIN warehouses w ON w.id = l.warehouse_id
        WHERE sl.product_spec_id = $1
          AND w.name = $2
          AND LOWER(l.name) = LOWER($3)
        LIMIT 1`,
      [productSpecId, warehouse, spot],
    );
    if (duplicateResult.rowCount) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "该规格已经存在这个货位。" }, { status: 409 });
    }

    const warehouseResult = await client.query(
      "INSERT INTO warehouses (name) VALUES ($1) RETURNING id",
      [warehouse],
    );
    const locationResult = await client.query(
      "INSERT INTO locations (warehouse_id, name) VALUES ($1, $2) RETURNING id",
      [warehouseResult.rows[0].id, spot],
    );
    const relationResult = await client.query(
      `INSERT INTO product_spec_locations (product_spec_id, location_id)
       VALUES ($1, $2)
       RETURNING case_count, loose_count`,
      [productSpecId, locationResult.rows[0].id],
    );
    await client.query("COMMIT");

    return NextResponse.json({
      locationId: String(locationResult.rows[0].id),
      warehouse,
      spot,
      cases: relationResult.rows[0].case_count,
      loose: relationResult.rows[0].loose_count,
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
