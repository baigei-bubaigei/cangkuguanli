import { NextResponse } from "next/server";
import { currentCatalogActor } from "../../../../../src/auth/catalog-auth.js";
import { database } from "../../../../../src/db.js";
import {
  claimIdempotency,
  completeIdempotency,
  idempotencyResponse,
  missingIdempotencyKeyResponse,
  requestIdempotencyKey,
  readIdempotencyPayload,
} from "../../../../../src/idempotency.js";
import { writeOperationLog } from "../../../../../src/operation-logs.js";

export const runtime = "nodejs";

const maximumQuantity = 2147483647;

function invalidRequest(message, batchId, status = 400) {
  return NextResponse.json({ error: message, batchId }, { status });
}

function normalizedIdentityText(value) {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value.trim() : undefined;
}

function optionalText(value) {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : undefined;
}

function requiredText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isQuantity(value) {
  return Number.isInteger(value) && value >= 0 && value <= maximumQuantity;
}

function prepareRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;

  const groupedRows = new Map();
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return { error: `第 ${index + 1} 行资料无效。` };

    const rowNumber = Number.isInteger(row.rowNumber) && row.rowNumber >= 1 ? row.rowNumber : index + 1;
    const productName = normalizedIdentityText(row.productName);
    const spec = normalizedIdentityText(row.spec);
    const material = normalizedIdentityText(row.material);
    const color = normalizedIdentityText(row.color);
    const warehouse = requiredText(row.warehouse);
    const spot = requiredText(row.spot);
    const perCase = Number(row.perCase);
    const cases = row.cases;
    const loose = row.loose;
    const category = optionalText(row.category);
    const categoryName = optionalText(row.categoryName);
    const note = optionalText(row.note);

    if (productName === undefined || spec === undefined || material === undefined || color === undefined
      || !warehouse || !spot || ![2, 4, 6].includes(perCase)
      || !isQuantity(cases) || !isQuantity(loose)
      || (cases === 0 && loose === 0)
      || category === undefined || categoryName === undefined || note === undefined) {
      return { error: `第 ${rowNumber} 行资料无效，请修正原文件后重新上传。` };
    }

    const key = JSON.stringify([productName, spec, material, color, perCase, warehouse, spot]);
    const groupedRow = groupedRows.get(key);
    if (groupedRow) {
      if (groupedRow.category !== category
        || groupedRow.categoryName !== categoryName
        || groupedRow.note !== note) {
        groupedRow.metadataConflict = true;
      }
      const nextCases = groupedRow.cases + cases;
      const nextLoose = groupedRow.loose + loose;
      if (nextCases > maximumQuantity || nextLoose > maximumQuantity) {
        return { error: `第 ${rowNumber} 行与文件内重复行合并后的数量超出允许范围。` };
      }
      groupedRow.cases = nextCases;
      groupedRow.loose = nextLoose;
      groupedRow.sourceRows.push(rowNumber);
      continue;
    }

    groupedRows.set(key, {
      productName,
      spec,
      material,
      color,
      perCase,
      category,
      categoryName,
      note,
      warehouse,
      spot,
      cases,
      loose,
      sourceRows: [rowNumber],
    });
  }

  const groups = [...groupedRows.values()];
  const conflictingRows = [...new Set(groups
    .filter((row) => row.metadataConflict)
    .flatMap((row) => row.sourceRows))]
    .sort((left, right) => left - right);
  if (conflictingRows.length) {
    return {
      error: `同一产品、包装规格、仓库和货位的重复行中，商品类别、类别名称或备注不一致。请核对第 ${conflictingRows.join("、")} 行后重新上传。`,
    };
  }

  return { groups };
}

async function productSpecId(client, row) {
  const inserted = await client.query(
    `INSERT INTO product_specs (
       product_name, spec, material, color, category, category_name, note, per_case_count
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (product_name, spec, material, color, per_case_count) DO NOTHING
     RETURNING id`,
    [row.productName, row.spec, row.material, row.color, row.category, row.categoryName, row.note, row.perCase],
  );
  if (inserted.rowCount) return inserted.rows[0].id;

  const existing = await client.query(
    `SELECT id FROM product_specs
      WHERE product_name = $1 AND spec = $2 AND material = $3 AND color = $4 AND per_case_count = $5
      ORDER BY id
      LIMIT 1`,
    [row.productName, row.spec, row.material, row.color, row.perCase],
  );
  return existing.rows[0].id;
}

async function locationId(client, row, specId) {
  const productLocation = await client.query(
    `SELECT l.id
       FROM product_spec_locations sl
       JOIN locations l ON l.id = sl.location_id
       JOIN warehouses w ON w.id = l.warehouse_id
      WHERE sl.product_spec_id = $1
        AND w.name = $2
        AND l.name = $3
      ORDER BY l.id
      LIMIT 1`,
    [specId, row.warehouse, row.spot],
  );
  if (productLocation.rowCount) return productLocation.rows[0].id;

  const existing = await client.query(
    `SELECT l.id
       FROM locations l
       JOIN warehouses w ON w.id = l.warehouse_id
      WHERE w.name = $1 AND l.name = $2
      ORDER BY l.id
      LIMIT 1`,
    [row.warehouse, row.spot],
  );
  if (existing.rowCount) return existing.rows[0].id;

  const warehouseResult = await client.query(
    "SELECT id FROM warehouses WHERE name = $1 ORDER BY id LIMIT 1",
    [row.warehouse],
  );
  const warehouseId = warehouseResult.rowCount
    ? warehouseResult.rows[0].id
    : (await client.query("INSERT INTO warehouses (name) VALUES ($1) RETURNING id", [row.warehouse])).rows[0].id;
  return (await client.query(
    "INSERT INTO locations (warehouse_id, name) VALUES ($1, $2) RETURNING id",
    [warehouseId, row.spot],
  )).rows[0].id;
}

async function failedImportResponse(client, actor, claimId, batchId, receivedRows, message, status = 400) {
  const responseBody = { error: message, batchId };
  await writeOperationLog(client, {
    actor,
    operationType: "initial_inventory_import",
    targetType: "initial_inventory_import_batch",
    targetId: batchId,
    content: {
      batchId,
      result: "failed",
      receivedRows,
      importedRows: 0,
      error: message,
    },
  });
  await completeIdempotency(client, claimId, status, responseBody);
  await client.query("COMMIT");
  return NextResponse.json(responseBody, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request) {
  const actor = await currentCatalogActor(request);
  if (!actor) {
    return NextResponse.json({ error: "需要管理员登录后导入初始库存。" }, {
      status: 401,
      headers: { "Cache-Control": "no-store" },
    });
  }
  if (actor.sourceSystem !== "admin") {
    return NextResponse.json({ error: "只有管理员可以导入初始库存。" }, { status: 403 });
  }
  const idempotencyKey = requestIdempotencyKey(request);
  if (!idempotencyKey) return missingIdempotencyKeyResponse();

  let body;
  let payload;
  try {
    ({ body, payload } = await readIdempotencyPayload(request));
  } catch {
    return invalidRequest("请检查初始库存文件内容后重新上传。", null);
  }

  const client = await database().connect();
  let batchId;
  let receivedRows = null;
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    const claim = await claimIdempotency(client, {
      actor,
      scope: "admin/initial-inventory/imports",
      key: idempotencyKey,
      payload,
    });
    const priorResponse = idempotencyResponse(claim);
    if (priorResponse) {
      await client.query("ROLLBACK");
      transactionOpen = false;
      return priorResponse;
    }

    const batchResult = await client.query("SELECT nextval('initial_inventory_import_batch_id_seq')::TEXT AS id");
    batchId = batchResult.rows[0].id;

    if (body === undefined) {
      const response = await failedImportResponse(
        client,
        actor,
        claim.id,
        batchId,
        receivedRows,
        "请检查初始库存文件内容后重新上传。",
      );
      transactionOpen = false;
      return response;
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      const response = await failedImportResponse(
        client,
        actor,
        claim.id,
        batchId,
        receivedRows,
        "请检查初始库存行中的产品、包装规格、仓库、货位和数量。",
      );
      transactionOpen = false;
      return response;
    }

    receivedRows = Array.isArray(body.rows) ? body.rows.length : null;
    const prepared = prepareRows(body.rows);
    if (!prepared) {
      const response = await failedImportResponse(
        client,
        actor,
        claim.id,
        batchId,
        receivedRows,
        "文件没有可提交的库存行。",
      );
      transactionOpen = false;
      return response;
    }
    if (prepared.error) {
      const response = await failedImportResponse(
        client,
        actor,
        claim.id,
        batchId,
        receivedRows,
        prepared.error,
      );
      transactionOpen = false;
      return response;
    }

    const actualOccurredAt = new Date();
    for (const row of prepared.groups) {
      const specId = await productSpecId(client, row);
      const spotId = await locationId(client, row, specId);
      await client.query(
        `INSERT INTO product_spec_locations (product_spec_id, location_id)
         VALUES ($1, $2)
         ON CONFLICT (product_spec_id, location_id) DO NOTHING`,
        [specId, spotId],
      );
      const inventoryResult = await client.query(
        `UPDATE product_spec_locations
            SET case_count = case_count + $1::INTEGER,
                loose_count = loose_count + $2::INTEGER
          WHERE product_spec_id = $3
            AND location_id = $4
            AND case_count <= $5::INTEGER - $1::INTEGER
            AND loose_count <= $5::INTEGER - $2::INTEGER
          RETURNING case_count, loose_count`,
        [row.cases, row.loose, specId, spotId, maximumQuantity],
      );
      if (!inventoryResult.rowCount) {
        await client.query("ROLLBACK");
        transactionOpen = false;
        await client.query("BEGIN");
        transactionOpen = true;
        const failureClaim = await claimIdempotency(client, {
          actor,
          scope: "admin/initial-inventory/imports",
          key: idempotencyKey,
          payload,
        });
        const failureReplay = idempotencyResponse(failureClaim);
        if (failureReplay) {
          await client.query("ROLLBACK");
          transactionOpen = false;
          return failureReplay;
        }
        const response = await failedImportResponse(
          client,
          actor,
          failureClaim.id,
          batchId,
          receivedRows,
          "导入数量超出该货位可保存范围，整批未登记。",
          409,
        );
        transactionOpen = false;
        return response;
      }

      const transactionResult = await client.query(
        `INSERT INTO inventory_transactions (
           operation_type, product_spec_id, location_id, case_count, loose_count,
           actual_occurred_at, actor_account, source_system
         ) VALUES ('initial', $1, $2, $3, $4, $5, $6, 'admin')
         RETURNING id`,
        [specId, spotId, row.cases, row.loose, actualOccurredAt, actor.account],
      );
      const transaction = transactionResult.rows[0];
      await writeOperationLog(client, {
        actor,
        operationType: "initial_inventory_import",
        targetType: "inventory_transaction",
        targetId: transaction.id,
        content: {
          batchId,
          productSpecId: String(specId),
          perCase: row.perCase,
          warehouse: row.warehouse,
          spot: row.spot,
          cases: row.cases,
          loose: row.loose,
          sourceRows: row.sourceRows,
        },
      });
    }

    await writeOperationLog(client, {
      actor,
      operationType: "initial_inventory_import",
      targetType: "initial_inventory_import_batch",
      targetId: batchId,
      content: {
        batchId,
        result: "success",
        receivedRows,
        importedRows: prepared.groups.length,
      },
    });
    const responseBody = {
      batchId,
      receivedRows,
      importedRows: prepared.groups.length,
    };
    await completeIdempotency(client, claim.id, 201, responseBody);
    await client.query("COMMIT");
    transactionOpen = false;
    return NextResponse.json(responseBody, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch {
    if (transactionOpen) {
      await client.query("ROLLBACK");
      transactionOpen = false;
    }
    if (batchId) {
      try {
        await client.query("BEGIN");
        transactionOpen = true;
        const failureClaim = await claimIdempotency(client, {
          actor,
          scope: "admin/initial-inventory/imports",
          key: idempotencyKey,
          payload,
        });
        const failureReplay = idempotencyResponse(failureClaim);
        if (failureReplay) {
          await client.query("ROLLBACK");
          transactionOpen = false;
          return failureReplay;
        }
        const response = await failedImportResponse(
          client,
          actor,
          failureClaim.id,
          batchId,
          receivedRows,
          "初始库存整批提交失败，未登记。请检查数据库连接后重试。",
          500,
        );
        transactionOpen = false;
        return response;
      } catch {
        if (transactionOpen) {
          await client.query("ROLLBACK");
          transactionOpen = false;
        }
      }
    }
    return NextResponse.json({
      error: "初始库存整批提交失败，未登记。请检查数据库连接后重试。",
      ...(batchId ? { batchId } : {}),
    }, { status: 500 });
  } finally {
    client.release();
  }
}
