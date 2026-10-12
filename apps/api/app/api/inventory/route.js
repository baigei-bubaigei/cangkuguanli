import { NextResponse } from "next/server";
import { hasCatalogSession } from "../../../src/auth/catalog-auth.js";
import { database } from "../../../src/db.js";

export const runtime = "nodejs";

export async function GET(request) {
  if (!await hasCatalogSession(request)) {
    return NextResponse.json({ error: "需要登录后查询库存。" }, {
      status: 401,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const client = await database().connect();
  try {
    const [inventoryResult, warehouseResult] = await Promise.all([
      client.query(
        `SELECT p.id, p.product_name, p.category, p.category_name, p.spec, p.per_case_count,
                COALESCE(SUM(sl.case_count), 0)::INTEGER AS total_cases,
                COALESCE(SUM(sl.loose_count), 0)::INTEGER AS total_loose,
                COALESCE(
                  json_agg(
                    json_build_object(
                      'id', l.id::TEXT,
                      'warehouse', w.name,
                      'spot', l.name,
                      'cases', sl.case_count,
                      'loose', sl.loose_count
                    ) ORDER BY w.name, l.name, l.id
                  ) FILTER (WHERE l.id IS NOT NULL),
                  '[]'::JSON
                ) AS locations
           FROM product_specs p
           LEFT JOIN product_spec_locations sl ON sl.product_spec_id = p.id
           LEFT JOIN locations l ON l.id = sl.location_id
           LEFT JOIN warehouses w ON w.id = l.warehouse_id
          GROUP BY p.id
          ORDER BY p.id`,
      ),
      client.query(
        `SELECT DISTINCT w.name
           FROM warehouses w
           JOIN locations l ON l.warehouse_id = w.id
           JOIN product_spec_locations sl ON sl.location_id = l.id
          ORDER BY w.name`,
      ),
    ]);

    return NextResponse.json({
      warehouses: warehouseResult.rows.map((row) => row.name),
      products: inventoryResult.rows.map((row) => ({
        id: String(row.id),
        name: row.product_name,
        category: row.category,
        categoryName: row.category_name,
        spec: row.spec,
        perCase: row.per_case_count,
        totalCases: row.total_cases,
        totalLoose: row.total_loose,
        locations: row.locations,
      })),
    }, {
      headers: { "Cache-Control": "no-store" },
    });
  } finally {
    client.release();
  }
}
