import { useEffect, useState } from "react";
import { findExactCatalogCandidates, parseInventoryFile } from "./parseInventoryImport.js";
import "./initial-inventory-import.css";

function showRawValue(value) {
  if (value === undefined || value === null || value === "") return "（空白）";
  return String(value);
}

function ImportCell({ cell }) {
  const rawValue = showRawValue(cell.rawValue);
  const displayDiffers = cell.displayValue !== undefined && cell.displayValue !== rawValue;

  return (
    <div className="initial-import-cell">
      <span>{rawValue}</span>
      {displayDiffers && <small>单元格显示：{cell.displayValue}</small>}
      {cell.formula && <small>公式：={cell.formula}</small>}
    </div>
  );
}

function CatalogCandidates({ row, catalog, loading, error }) {
  if (loading) return <span className="initial-import-muted">正在查询…</span>;
  if (error) return <span className="initial-import-muted">暂不可查询</span>;

  const result = findExactCatalogCandidates(row, catalog);
  if (!result.candidates.length) return <span className="initial-import-muted">{result.issue}</span>;

  return (
    <ul className="initial-import-candidates">
      {result.candidates.map((candidate, index) => (
        <li key={`${candidate.id}-${candidate.locationId}`}>
          <strong>
            {result.candidates.length > 1 ? `候选 ${index + 1} · ` : ""}
            {candidate.name} · {candidate.spec} · 每件 {candidate.perCase} 个
          </strong>
          <span>{candidate.warehouse} · {candidate.spot}</span>
          <span>商品类别：{candidate.category || "（空白）"} · 类别名称：{candidate.categoryName || "（空白）"} · 备注：{candidate.note || "（空白）"}</span>
          <small>资料记录 {candidate.id} · 货位记录 {candidate.locationId} · 完全匹配候选，未选择或绑定</small>
        </li>
      ))}
    </ul>
  );
}

export default function InitialInventoryImport() {
  const [fileName, setFileName] = useState("");
  const [parsed, setParsed] = useState(null);
  const [selectedSheetName, setSelectedSheetName] = useState("");
  const [error, setError] = useState("");
  const [reading, setReading] = useState(false);
  const [catalog, setCatalog] = useState([]);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState("");
  const selectedSheet = parsed?.sheets.find((sheet) => sheet.name === selectedSheetName);

  async function loadCatalog() {
    setCatalogLoading(true);
    setCatalogError("");
    try {
      const response = await fetch("/api/catalog/products", { cache: "no-store" });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || `目录查询失败（HTTP ${response.status}）。`);
      }
      setCatalog(await response.json());
    } catch (lookupError) {
      setCatalogError(lookupError.message || "目录查询失败。");
    } finally {
      setCatalogLoading(false);
    }
  }

  useEffect(() => {
    void loadCatalog();
  }, []);

  async function handleFileChange(event) {
    const file = event.currentTarget.files?.[0];
    if (!file) return;

    setFileName(file.name);
    setParsed(null);
    setSelectedSheetName("");
    setError("");
    setReading(true);

    try {
      const result = parseInventoryFile(file.name, new Uint8Array(await file.arrayBuffer()));
      setParsed(result);
      setSelectedSheetName(result.sheetNames[0] || "");
    } catch (parseError) {
      setError(parseError.message || "文件解析失败，请检查文件内容后重试。");
    } finally {
      setReading(false);
    }
  }

  return (
    <section className="initial-import" aria-labelledby="initial-import-title">
      <div className="initial-import-heading">
        <div>
          <p className="eyebrow">管理员专属 · 只读预览</p>
          <h2 id="initial-import-title">初始库存文件预览</h2>
          <p className="initial-import-description">
            解析来源文件并保留原始单元格内容，只读显示五项信息完全一致的产品与货位候选；不会自动选择、写入或换算库存。
          </p>
        </div>
        <label className={`button button-dark initial-import-file-button${reading ? " initial-import-file-button-pending" : ""}`}>
          {reading ? "正在解析…" : "选择文件"}
          <input
            type="file"
            accept=".xlsx,.xls,.csv"
            onChange={handleFileChange}
            disabled={reading}
            aria-label="选择初始库存文件"
          />
        </label>
      </div>

      <div className="initial-import-file-state" aria-live="polite">
        <span>当前文件</span>
        <strong>{fileName || "尚未选择文件"}</strong>
      </div>

      {error && <p className="initial-import-error" role="alert">{error}</p>}
      {catalogLoading && <p className="initial-import-catalog-state" role="status">正在读取已保存的产品规格与货位资料…</p>}
      {catalogError && (
        <div className="initial-import-error initial-import-catalog-error" role="alert">
          <span>已保存资料查询失败：{catalogError} 文件预览仍可查看，候选匹配暂不可用。</span>
          <button className="button button-outline" type="button" onClick={() => void loadCatalog()}>重试查询</button>
        </div>
      )}

      {selectedSheet && (
        <>
          <div className="initial-import-toolbar">
            {parsed.sheetNames.length > 1 ? (
              <label className="initial-import-sheet-select">
                <span>工作表</span>
                <select
                  value={selectedSheetName}
                  onChange={(event) => setSelectedSheetName(event.target.value)}
                >
                  {parsed.sheetNames.map((name) => <option key={name} value={name}>{name}</option>)}
                </select>
              </label>
            ) : (
              <span className="initial-import-sheet-name">工作表：{selectedSheet.name}</span>
            )}
            <span>{selectedSheet.rows.length} 行原始数据</span>
          </div>

          {selectedSheet.issues.length > 0 && (
            <div className="initial-import-sheet-issues" role="status">
              <strong>工作表待核对</strong>
              <ul>{selectedSheet.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>
            </div>
          )}

          <div className="initial-import-table-wrap">
            <table className="initial-import-table">
              <thead>
                <tr>
                  <th scope="col">原行号</th>
                  {selectedSheet.columns.map((column) => (
                    <th scope="col" key={column.columnIndex}>
                      {column.label}
                    </th>
                  ))}
                  <th scope="col">解析问题</th>
                  <th scope="col">已保存资料候选</th>
                </tr>
              </thead>
              <tbody>
                {selectedSheet.rows.length === 0 ? (
                  <tr><td colSpan={selectedSheet.columns.length + 3}>工作表没有数据行。</td></tr>
                ) : selectedSheet.rows.map((row) => (
                  <tr key={row.rowNumber}>
                    <th scope="row">{row.rowNumber}</th>
                    {row.cells.map((cell) => (
                      <td key={cell.columnIndex}>
                        <ImportCell cell={cell} />
                      </td>
                    ))}
                    <td>
                      {row.issues.length ? (
                        <ul className="initial-import-row-issues">
                          {row.issues.map((issue) => <li key={issue}>{issue}</li>)}
                        </ul>
                      ) : <span className="initial-import-no-issues">未发现基础格式问题</span>}
                    </td>
                    <td>
                      <CatalogCandidates row={row} catalog={catalog} loading={catalogLoading} error={catalogError} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="initial-import-note">
            空白保持为空白；“数量”列的单位尚未确认，仅显示原值。产品规格、仓库和货位的关联规则仍待确认，预览不会自动选择或保存候选资料。
          </p>
        </>
      )}
    </section>
  );
}
