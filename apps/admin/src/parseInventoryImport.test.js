import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import * as codepage from "xlsx/dist/cpexcel.full.mjs";
import { findExactCatalogCandidates, parseInventoryFile } from "./parseInventoryImport.js";

const headers = ["货位", "商品名称", "商品类别", "类别名称", "备注", "规格", "每件个数", "整件数", "散个数", "仓库", "数量", "材质", "颜色"];

function workbookBytes(bookType) {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    headers,
    ["A-01", "壁灯", "照明", "室内", "原样保留", "E27", 6, 2, 3, "一号仓", 17, "铝合金", "白色"],
  ]);
  sheet.H2 = { t: "n", v: 2, f: "1+1", z: "00" };
  sheet.N1 = { t: "s", v: "盘点日期" };
  sheet.N2 = { t: "n", v: 46300, z: "yyyy-mm-dd" };
  sheet["!ref"] = "A1:N2";
  XLSX.utils.book_append_sheet(workbook, sheet, "台账模板");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["其他工作表"], ["不应替代所选表"]]), "备用");
  return XLSX.write(workbook, { bookType, type: "array" });
}

function cellByField(row, field) {
  return row.cells.find((cell) => cell.field === field);
}

test("parses CSV rows with their physical row numbers and leaves quantities unassigned", () => {
  const csv = [
    headers.join(","),
    'A-01,灯泡,照明,室内,,E27,6,000,2,一号仓,12',
    "",
    'A-02,,照明,室内,,E27,8,-1,0.5,一号仓,未知',
    'A-03,壁灯,照明,室内,,E27,6,0,,一号仓,',
  ].join("\r\n");

  const result = parseInventoryFile("初始库存.csv", new TextEncoder().encode(csv));
  const [sheet] = result.sheets;

  assert.deepEqual(result.sheetNames, ["Sheet1"]);
  assert.equal(sheet.headerRowNumber, 1);
  assert.deepEqual(sheet.rows.map((row) => row.rowNumber), [2, 4, 5]);
  assert.equal(cellByField(sheet.rows[0], "productName").rawValue, "灯泡");
  assert.equal(cellByField(sheet.rows[0], "cases").rawValue, "000");
  assert.equal(cellByField(sheet.rows[0], "note").rawValue, undefined);
  assert.equal(cellByField(sheet.rows[0], "quantity"), undefined);
  assert.equal(sheet.rows[0].cells.find((cell) => cell.header === "数量").rawValue, "12");
  assert.match(sheet.rows[0].issues.join("；"), /数量.*单位未确认/);
  assert.equal(sheet.rows[1].rowNumber, 4);
  assert.equal(cellByField(sheet.rows[1], "productName").rawValue, undefined);
  assert.equal(cellByField(sheet.rows[1], "loose").rawValue, "0.5");
  assert.doesNotMatch(sheet.rows[1].issues.join("；"), /缺少商品名称/);
  assert.match(sheet.rows[1].issues.join("；"), /每件个数.*2、4、6/);
  assert.match(sheet.rows[1].issues.join("；"), /整件数.*非负整数/);
  assert.match(sheet.rows[1].issues.join("；"), /散个数.*非负整数/);
  assert.equal(cellByField(sheet.rows[2], "cases").rawValue, "0");
  assert.equal(cellByField(sheet.rows[2], "loose").rawValue, undefined);
  assert.match(sheet.rows[2].issues.join("；"), /缺少散个数/);
});

test("parses XLSX cells, formulas and available formatted values, and keeps every sheet selectable", () => {
  const result = parseInventoryFile("初始库存.xlsx", workbookBytes("xlsx"));
  const sheet = result.sheets.find((candidate) => candidate.name === "台账模板");
  const casesCell = cellByField(sheet.rows[0], "cases");

  assert.deepEqual(result.sheetNames, ["台账模板", "备用"]);
  assert.equal(sheet.rows[0].rowNumber, 2);
  assert.equal(cellByField(sheet.rows[0], "productName").rawValue, "壁灯");
  assert.equal(casesCell.rawValue, 2);
  assert.equal(casesCell.formula, "1+1");
  assert.equal(casesCell.displayValue, "02");
  assert.equal(cellByField(sheet.rows[0], "quantity"), undefined);
  assert.equal(sheet.rows[0].cells.find((cell) => cell.header === "数量").rawValue, 17);
  assert.equal(sheet.rows[0].cells.find((cell) => cell.header === "盘点日期").rawValue, 46300);
});

test("omits blank formula rows while keeping rows with source data", () => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    headers,
    [],
    ["A-01", "壁灯", "照明", "室内", "原样保留", "E27", 6, 2, 3, "一号仓", 17],
  ]);
  sheet.J2 = { t: "s", v: "", f: 'IF(A2="","",0)' };
  XLSX.utils.book_append_sheet(workbook, sheet, "台账模板");

  const result = parseInventoryFile("初始库存.xlsx", XLSX.write(workbook, { bookType: "xlsx", type: "array" }));

  assert.deepEqual(result.sheets[0].rows.map((row) => row.rowNumber), [3]);
  assert.equal(cellByField(result.sheets[0].rows[0], "productName").rawValue, "壁灯");
});

test("parses legacy XLS bytes and preserves Chinese source values", () => {
  const result = parseInventoryFile("初始库存.xls", workbookBytes("biff8"));

  assert.equal(result.sheets[0].rows[0].rowNumber, 2);
  assert.equal(cellByField(result.sheets[0].rows[0], "productName").rawValue, "壁灯");
  assert.equal(cellByField(result.sheets[0].rows[0], "warehouse").rawValue, "一号仓");
});

test("parses Windows-936 CSV when its bytes are not valid UTF-8", () => {
  const csv = [
    headers.join(","),
    "A-01,壁灯,照明,室内,备注,E27,6,2,3,一号仓,12",
  ].join("\r\n");
  const gbkBytes = Uint8Array.from(codepage.utils.encode(936, csv));
  const result = parseInventoryFile("旧版导出.csv", gbkBytes);

  assert.equal(cellByField(result.sheets[0].rows[0], "productName").rawValue, "壁灯");
  assert.equal(cellByField(result.sheets[0].rows[0], "warehouse").rawValue, "一号仓");
});

test("returns every exact catalog candidate without choosing near matches", () => {
  const csv = [
    headers.join(","),
    "A-01,壁灯,照明,室内,备注,E27,6,2,3,一号仓,12",
  ].join("\r\n");
  const row = parseInventoryFile("初始库存.csv", new TextEncoder().encode(csv)).sheets[0].rows[0];
  const catalog = [
    { id: "product-a", locationId: "location-a", name: "壁灯", spec: "E27", perCase: 6, warehouse: "一号仓", spot: "A-01" },
    { id: "product-b", locationId: "location-b", name: "壁灯", spec: "E27", perCase: 6, warehouse: "一号仓", spot: "A-01" },
    { id: "product-c", locationId: "location-c", name: "壁灯", spec: "E27", perCase: 6, warehouse: "一号仓", spot: "A-02" },
    { id: "product-d", locationId: "location-d", name: "壁灯", spec: "E27", perCase: 4, warehouse: "一号仓", spot: "A-01" },
  ];

  const result = findExactCatalogCandidates(row, catalog);
  assert.deepEqual(result.candidates.map((candidate) => candidate.locationId), ["location-a", "location-b"]);
  assert.equal(result.issue, "");
});

test("accepts blank identity values and matches every identity field exactly", () => {
  const csv = [
    headers.join(","),
    " A-01 ,,照明,室内,,E27,6,2,3, 一号仓 ,,铝合金,白色",
  ].join("\r\n");
  const row = parseInventoryFile("初始库存.csv", new TextEncoder().encode(csv)).sheets[0].rows[0];
  const candidates = [
    { id: "match", locationId: "location-match", name: "", spec: "E27", material: "铝合金", color: "白色", perCase: 6, warehouse: "一号仓", spot: "A-01" },
    { id: "wrong-material", locationId: "location-material", name: "", spec: "E27", material: "塑料", color: "白色", perCase: 6, warehouse: "一号仓", spot: "A-01" },
    { id: "wrong-color", locationId: "location-color", name: "", spec: "E27", material: "铝合金", color: "黑色", perCase: 6, warehouse: "一号仓", spot: "A-01" },
  ];

  assert.deepEqual(row.issues, []);
  assert.equal(cellByField(row, "productName").rawValue, undefined);
  assert.equal(cellByField(row, "spec").rawValue, "E27");
  assert.equal(cellByField(row, "material").rawValue, "铝合金");
  assert.equal(cellByField(row, "color").rawValue, "白色");
  assert.equal(cellByField(row, "spot").rawValue, " A-01 ");
  assert.deepEqual(findExactCatalogCandidates(row, candidates).candidates.map((candidate) => candidate.id), ["match"]);
});

test("marks rows without a positive case or loose quantity as unsubmitable", () => {
  const csv = [
    headers.join(","),
    "A-01,,,,,E27,2,0,0,一号仓,,铝合金,白色",
  ].join("\r\n");
  const row = parseInventoryFile("初始库存.csv", new TextEncoder().encode(csv)).sheets[0].rows[0];

  assert.match(row.issues.join("；"), /整件数和散个数至少一项大于0/);
});

test("rejects file extensions outside the three confirmed formats", () => {
  assert.throws(() => parseInventoryFile("库存.ods", new Uint8Array()), /仅支持 \.xlsx、\.xls、\.csv/);
});
