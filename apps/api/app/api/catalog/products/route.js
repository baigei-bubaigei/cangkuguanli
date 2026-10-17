import { NextResponse } from "next/server";
import { currentCatalogActor, hasCatalogSession } from "../../../../src/auth/catalog-auth.js";
import { database } from "../../../../src/db.js";
import { writeOperationLog } from "../../../../src/operation-logs.js";

export const runtime = "nodejs";

function unauthorized() {
  return NextResponse.json({ error: "需要登录后维护产品规格。" }, {
    status: 401,
    headers: { "Cache-Control": "no-store" },
  });
}

function invalidRequest() {
  return NextResponse.json({ error: "请检查产品规格资料和每件个数。" }, { status: 400 });
}

function requiredText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function identityText(value) {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value.trim() : undefined;
}

function optionalText(value) {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : undefined;
}

const productSelect = `SELECT p.id, l.id AS location_id, p.product_name, p.material, p.color, p.category, p.category_name, p.spec,
                              p.per_case_count, p.note, w.name AS warehouse, l.name AS spot,
                              sl.case_count, sl.loose_count
                         FROM product_specs p
                         JOIN product_spec_locations sl ON sl.product_spec_id = p.id
                         JOIN locations l ON l.id = sl.location_id
                         JOIN warehouses w ON w.id = l.warehouse_id`;

function productFields(row) {
  return {
    id: String(row.id),
    locationId: String(row.location_id),
    name: row.product_name,
    material: row.material,
    color: row.color,
    category: row.category,
    categoryName: row.category_name,
    spec: row.spec,
    perCase: row.per_case_count,
    note: row.note,
    warehouse: row.warehouse,
    spot: row.spot,
    cases: row.case_count,
    loose: row.loose_count,
  };
}

export async function GET(request) {
  if (!await hasCatalogSession(request)) return unauthorized();

  const client = await database().connect();
  try {
    const result = await client.query(`${productSelect} ORDER BY p.id, l.id`);
    return NextResponse.json(result.rows.map(productFields), {
      headers: { "Cache-Control": "no-store" },
    });
  } finally {
    client.release();
  }
}

export async function POST(request) {
  const actor = await currentCatalogActor(request);
  if (!actor) return unauthorized();

  let body;
  try {
    body = await request.json();
  } catch {
    return invalidRequest();
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return invalidRequest();

  const name = identityText(body.name);
  const material = identityText(body.material);
  const color = identityText(body.color);
  const spec = identityText(body.spec);
  const warehouse = requiredText(body.warehouse);
  const spot = requiredText(body.spot);
  const category = optionalText(body.category);
  const categoryName = optionalText(body.categoryName);
  const note = optionalText(body.note);
  const perCase = Number(body.perCase);
  if (name === undefined || material === undefined || color === undefined || spec === undefined
    || !warehouse || !spot
    || category === undefined || categoryName === undefined || note === undefined
    || !Number.isInteger(perCase) || ![2, 4, 6].includes(perCase)) {
    return invalidRequest();
  }

  const client = await database().connect();
  try {
    await client.query("BEGIN");
    const existingVariant = await client.query(
      `SELECT id FROM product_specs
        WHERE product_name = $1 AND spec = $2 AND material = $3 AND color = $4 AND per_case_count = $5
        LIMIT 1`,
      [name, spec, material, color, perCase],
    );
    if (existingVariant.rowCount) {
      await client.query("ROLLBACK");
      return NextResponse.json({ error: "相同产品身份和每件个数的包装规格已存在，请为该规格新增货位。" }, { status: 409 });
    }

    const productResult = await client.query(
      `INSERT INTO product_specs (product_name, spec, material, color, category, category_name, note, per_case_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [name, spec, material, color, category, categoryName, note, perCase],
    );
    const warehouseResult = await client.query(
      "INSERT INTO warehouses (name) VALUES ($1) RETURNING id",
      [warehouse],
    );
    const locationResult = await client.query(
      "INSERT INTO locations (warehouse_id, name) VALUES ($1, $2) RETURNING id",
      [warehouseResult.rows[0].id, spot],
    );
    await client.query(
      `INSERT INTO product_spec_locations (product_spec_id, location_id)
       VALUES ($1, $2)`,
      [productResult.rows[0].id, locationResult.rows[0].id],
    );
    const result = await client.query(
      `${productSelect} WHERE p.id = $1 ORDER BY l.id`,
      [productResult.rows[0].id],
    );
    await writeOperationLog(client, {
      actor,
      operationType: "product_spec_created",
      targetType: "product_spec",
      targetId: productResult.rows[0].id,
      content: {
        productName: name,
        material,
        color,
        spec,
        category,
        categoryName,
        perCaseCount: perCase,
        note,
        warehouse,
        spot,
      },
    });
    await client.query("COMMIT");
    return NextResponse.json(productFields(result.rows[0]), {
      status: 201,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505" && error.constraint === "product_specs_identity_package_unique") {
      return NextResponse.json({ error: "相同产品身份和每件个数的包装规格已存在，请为该规格新增货位。" }, { status: 409 });
    }
    throw error;
  } finally {
    client.release();
  }
}
