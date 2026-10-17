import * as XLSX from "xlsx";
import * as codepage from "xlsx/dist/cpexcel.full.mjs";

XLSX.set_cptable(codepage);

const fieldAliases = [
  ["spot", ["货位"]],
  ["productName", ["商品名称", "产品名称"]],
  ["material", ["材质"]],
  ["color", ["颜色"]],
  ["category", ["商品类别"]],
  ["categoryName", ["类别名称"]],
  ["note", ["备注"]],
  ["spec", ["规格", "产品规格"]],
  ["perCase", ["每件个数"]],
  ["cases", ["整件数"]],
  ["loose", ["散个数"]],
  ["warehouse", ["仓库"]],
];

const requiredFields = [
  ["perCase", "每件个数"],
  ["warehouse", "仓库"],
  ["spot", "货位"],
  ["cases", "整件数"],
  ["loose", "散个数"],
];

const numericFields = [
  ["cases", "整件数"],
  ["loose", "散个数"],
];

function fieldForHeader(value) {
  const label = String(value ?? "").trim();
  return fieldAliases.find(([, aliases]) => aliases.includes(label))?.[0];
}

function valueAt(sheet, rowIndex, columnIndex) {
  return sheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })];
}

function isBlank(value) {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

function identityValue(value) {
  return isBlank(value) ? "" : String(value).trim();
}

function headerColumns(sheet, headerRowIndex, startColumn, endColumn) {
  return Array.from({ length: endColumn - startColumn + 1 }, (_, offset) => {
    const columnIndex = startColumn + offset;
    const cell = valueAt(sheet, headerRowIndex, columnIndex);
    const header = cell?.v === undefined || cell?.v === null || cell.v === ""
      ? ""
      : String(cell.v);

    return {
      columnIndex,
      header,
      label: header.trim() || `第 ${columnIndex + 1} 列（表头空白）`,
      field: fieldForHeader(header),
    };
  });
}

function cellValue(sheet, rowIndex, column) {
  const source = valueAt(sheet, rowIndex, column.columnIndex);
  return {
    columnIndex: column.columnIndex,
    header: column.header,
    label: column.label,
    field: column.field,
    rawValue: source?.v,
    displayValue: source?.w,
    formula: source?.f,
    type: source?.t,
  };
}

function isNonnegativeInteger(value) {
  if (typeof value === "number") return Number.isInteger(value) && value >= 0;
  return typeof value === "string" && /^\d+$/.test(value.trim());
}

function isSupportedPerCase(value) {
  return [2, 4, 6].includes(value) || (typeof value === "string" && ["2", "4", "6"].includes(value.trim()));
}

function decodeCsv(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "");
  } catch {
    return codepage.utils.decode(936, bytes).replace(/^\uFEFF/, "");
  }
}

function rowIssues(cells) {
  const issues = [];
  const cellFor = (field) => cells.find((cell) => cell.field === field);

  for (const [field, label] of requiredFields) {
    const cell = cellFor(field);
    if (cell && isBlank(cell.rawValue)) issues.push(`缺少${label}`);
  }

  const perCase = cellFor("perCase");
  if (perCase && !isBlank(perCase.rawValue) && !isSupportedPerCase(perCase.rawValue)) {
    issues.push("每件个数只接受 2、4、6");
  }

  for (const [field, label] of numericFields) {
    const cell = cellFor(field);
    if (cell && !isBlank(cell.rawValue) && !isNonnegativeInteger(cell.rawValue)) {
      issues.push(`${label}必须为非负整数`);
    }
  }

  const cases = cellFor("cases");
  const loose = cellFor("loose");
  if (cases && loose
    && isNonnegativeInteger(cases.rawValue)
    && isNonnegativeInteger(loose.rawValue)
    && Number(cases.rawValue) === 0
    && Number(loose.rawValue) === 0) {
    issues.push("整件数和散个数至少一项大于0");
  }

  const quantity = cells.find((cell) => cell.header.trim() === "数量");
  if (quantity && !isBlank(quantity.rawValue)) {
    issues.push("“数量”列单位未确认，保留原始值，不映射到整件数或散个数");
  }

  return issues;
}

function parseSheet(name, sheet) {
  if (!sheet["!ref"]) {
    return {
      name,
      headerRowNumber: null,
      columns: [],
      rows: [],
      issues: ["工作表没有可解析的单元格。"],
    };
  }

  const range = XLSX.utils.decode_range(sheet["!ref"]);
  const columns = headerColumns(sheet, range.s.r, range.s.c, range.e.c);
  const dataRows = [];
  for (let rowIndex = range.s.r + 1; rowIndex <= range.e.r; rowIndex += 1) {
    const cells = columns.map((column) => cellValue(sheet, rowIndex, column));
    if (cells.some((cell) => !isBlank(cell.rawValue) || !isBlank(cell.displayValue))) {
      dataRows.push({ rowIndex, cells });
    }
  }

  const rows = dataRows.map(({ rowIndex, cells }) => ({
    rowNumber: rowIndex + 1,
    cells,
    issues: rowIssues(cells),
  }));

  const issues = [];
  const availableFields = new Set(columns.map((column) => column.field).filter(Boolean));
  const missingHeaders = requiredFields
    .filter(([field]) => !availableFields.has(field))
    .map(([, label]) => label);
  if (missingHeaders.length) issues.push(`缺少列：${missingHeaders.join("、")}`);
  if (columns.some((column) => column.header.trim() === "数量")) {
    issues.push("“数量”列含义未确认；解析仅保留原始值，不将其解释为整件数或散个数。");
  }

  return {
    name,
    headerRowNumber: range.s.r + 1,
    columns,
    rows,
    issues,
  };
}

export function parseInventoryFile(fileName, input) {
  const extension = fileName.split(".").at(-1)?.toLowerCase();
  if (!["xlsx", "xls", "csv"].includes(extension)) {
    throw new Error("仅支持 .xlsx、.xls、.csv 文件。");
  }

  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const workbook = XLSX.read(extension === "csv" ? decodeCsv(bytes) : bytes, {
    type: extension === "csv" ? "string" : "array",
    raw: true,
    cellFormula: true,
    cellNF: true,
    cellText: true,
    cellDates: false,
  });
  const sheets = workbook.SheetNames.map((name) => parseSheet(name, workbook.Sheets[name]));

  return {
    fileName,
    sheetNames: workbook.SheetNames,
    sheets,
  };
}

export function findExactCatalogCandidates(row, products) {
  const labels = {
    productName: "商品名称",
    spec: "规格",
    material: "材质",
    color: "颜色",
    perCase: "每件个数",
    warehouse: "仓库",
    spot: "货位",
  };
  const raw = Object.fromEntries(
    Object.keys(labels).map((field) => [field, row.cells.find((cell) => cell.field === field)?.rawValue]),
  );
  const missing = Object.entries(labels)
    .filter(([field]) => !["productName", "spec", "material", "color"].includes(field) && isBlank(raw[field]))
    .map(([, label]) => label);
  if (missing.length) {
    return { candidates: [], issue: `缺少${missing.join("、")}，无法精确查找已保存资料。` };
  }

  const perCase = typeof raw.perCase === "number" ? raw.perCase : Number(raw.perCase);
  if (!isSupportedPerCase(raw.perCase)) {
    return { candidates: [], issue: "每件个数不符合 2、4、6，无法精确查找已保存资料。" };
  }

  const candidates = products.filter((product) => (
    identityValue(product.name) === identityValue(raw.productName)
    && identityValue(product.spec) === identityValue(raw.spec)
    && identityValue(product.material) === identityValue(raw.material)
    && identityValue(product.color) === identityValue(raw.color)
    && product.perCase === perCase
    && identityValue(product.warehouse) === identityValue(raw.warehouse)
    && identityValue(product.spot) === identityValue(raw.spot)
  ));

  return {
    candidates,
    issue: candidates.length ? "" : "未找到完全匹配的产品包装与货位资料。",
  };
}
