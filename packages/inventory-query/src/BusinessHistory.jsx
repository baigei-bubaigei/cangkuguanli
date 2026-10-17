import { useEffect, useState } from "react";
import "./inventory-query.css";

const typeFilters = [
  { value: "", label: "全部类型" },
  { value: "inbound", label: "入库" },
  { value: "outbound", label: "出库" },
  { value: "move", label: "移动货位" },
  { value: "split", label: "拆件" },
  { value: "initial", label: "初始库存" },
];

const typeLabels = Object.fromEntries(typeFilters
  .filter((filter) => filter.value)
  .map((filter) => [filter.value, filter.label]));

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function localDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function quantityText(cases, loose) {
  return `${cases} 件 ${loose} 个`;
}

function changeText(record) {
  if (record.operationType === "inbound") return `增加 ${quantityText(record.cases, record.loose)}`;
  if (record.operationType === "outbound") return `减少 ${quantityText(record.cases, record.loose)}`;
  if (record.operationType === "move") return `移动 ${quantityText(record.cases, record.loose)}`;
  if (record.operationType === "split") return `拆开 ${record.cases} 件，增加 ${record.loose} 个散个`;
  if (record.operationType === "initial") return `初始库存 ${quantityText(record.cases, record.loose)}`;
  return quantityText(record.cases, record.loose);
}

function sourceLabel(sourceSystem) {
  return sourceSystem === "admin" ? "管理员系统" : "员工系统";
}

function correctionContent(record, content) {
  const quantity = record.operationType === "split"
    ? `拆开 ${content.cases} 件，增加 ${content.loose} 个散个`
    : quantityText(content.cases, content.loose);
  const note = record.operationType === "move" && content.note
    ? ` · 备注：${content.note}`
    : "";
  return `${quantity} · 实际发生 ${formatTime(content.actualOccurredAt)}${note}`;
}

function historyUrl(filters) {
  const searchParams = new URLSearchParams();
  if (filters.type) searchParams.set("type", filters.type);
  if (filters.query) searchParams.set("q", filters.query);
  if (filters.source) searchParams.set("source", filters.source);
  const query = searchParams.toString();
  return "/api/inventory/history" + (query ? `?${query}` : "");
}

export default function BusinessHistory({ sourceSystem }) {
  const [type, setType] = useState("");
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("");
  const [records, setRecords] = useState([]);
  const [status, setStatus] = useState("loading");
  const [refreshKey, setRefreshKey] = useState(0);
  const [editingRecord, setEditingRecord] = useState(null);
  const [editValues, setEditValues] = useState(null);
  const [savingCorrection, setSavingCorrection] = useState(false);
  const [correctionError, setCorrectionError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setStatus("loading");
    fetch(historyUrl({ type, query, source }), { cache: "no-store", signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("业务历史查询失败。");
        return response.json();
      })
      .then((result) => {
        setRecords(result.records);
        setStatus("loaded");
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus("error");
      });

    return () => controller.abort();
  }, [type, query, source, refreshKey]);

  function openCorrection(record) {
    setEditingRecord(record);
    setEditValues({
      cases: String(record.cases),
      loose: String(record.loose),
      actualOccurredAt: localDateTime(record.actualOccurredAt),
      note: record.note,
    });
    setCorrectionError("");
  }

  async function saveCorrection(event) {
    event.preventDefault();
    if (!editingRecord || !editValues) return;

    setCorrectionError("");
    setSavingCorrection(true);
    try {
      const body = {
        expectedRevision: editingRecord.revisionId,
        cases: Number(editValues.cases),
        actualOccurredAt: new Date(editValues.actualOccurredAt).toISOString(),
      };
      if (editingRecord.operationType !== "split") body.loose = Number(editValues.loose);
      if (editingRecord.operationType === "move") body.note = editValues.note;

      const response = await fetch(`/api/inventory/history/${editingRecord.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Inventory-Source-System": sourceSystem,
        },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) {
        setCorrectionError(result.error || "更正未完成，现有记录未改变，请刷新后重试。");
        return;
      }

      setEditingRecord(null);
      setEditValues(null);
      setRefreshKey((current) => current + 1);
    } catch {
      setCorrectionError("更正未完成，现有记录未改变；请检查网络后重试。");
    } finally {
      setSavingCorrection(false);
    }
  }

  return (
    <section className="business-history" aria-label="共享业务历史">
      <div className="business-history-toolbar">
        <div className="business-history-type-filter" role="group" aria-label="筛选业务类型">
          {typeFilters.map((filter) => (
            <button
              className={type === filter.value ? "business-history-type-active" : ""}
              type="button"
              aria-pressed={type === filter.value}
              key={filter.value || "all"}
              onClick={() => setType(filter.value)}
            >
              {filter.label}
            </button>
          ))}
        </div>
        <div className="business-history-filters">
          <label className="business-history-search">
            <span>关键词</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索产品、规格、货位或操作人"
            />
          </label>
          <label className="business-history-source">
            <span>来源系统</span>
            <select value={source} onChange={(event) => setSource(event.target.value)}>
              <option value="">全部系统</option>
              <option value="employee">员工系统</option>
              <option value="admin">管理员系统</option>
            </select>
          </label>
        </div>
      </div>

      {status === "loading" ? (
        <div className="business-history-state" aria-live="polite">正在读取业务历史…</div>
      ) : status === "error" ? (
        <div className="business-history-state" role="alert">暂时无法读取业务历史。</div>
      ) : records.length === 0 ? (
        <div className="business-history-state" aria-live="polite">没有符合条件的记录。</div>
      ) : (
        <div className="business-history-table-wrap">
          <table className="business-history-table">
            <thead>
              <tr>
                <th scope="col">业务类型</th>
                <th scope="col">产品与规格</th>
                <th scope="col">数量变化</th>
                <th scope="col">货位</th>
                <th scope="col">实际发生时间 / 登记时间</th>
                <th scope="col">操作人 / 来源系统</th>
              </tr>
            </thead>
            <tbody>
              {records.map((record) => (
                <tr key={record.id} data-record-id={record.id}>
                  <td><span className={`business-history-type business-history-${record.operationType}`}>{typeLabels[record.operationType] ?? record.operationType}</span></td>
                  <td className="business-history-product">
                    <strong>{record.product.name}</strong>
                    <small>{record.product.spec} · 每件 {record.product.perCase} 个</small>
                  </td>
                  <td className="business-history-change">{changeText(record)}</td>
                  <td className="business-history-location">
                    <span>{record.location.warehouse} · {record.location.spot}</span>
                    {record.targetLocation && <small>→ {record.targetLocation.warehouse} · {record.targetLocation.spot}</small>}
                  </td>
                  <td className="business-history-time">
                    <strong>{formatTime(record.actualOccurredAt)}</strong>
                    <small>登记 {formatTime(record.recordedAt)}</small>
                  </td>
                  <td className="business-history-actor">
                    <strong>{record.actor.displayName}</strong>
                    <small>{record.actor.account}</small>
                    <small>{sourceLabel(record.sourceSystem)}</small>
                    {record.operationType !== "initial" && (
                      <button className="business-history-correct" type="button" onClick={() => openCorrection(record)}>
                        更正记录
                      </button>
                    )}
                    {record.corrections.length > 0 && (
                      <details className="business-history-corrections">
                        <summary>修改记录（{record.corrections.length}）</summary>
                        {record.corrections.map((correction) => (
                          <div className="business-history-correction" key={correction.id}>
                            <strong>{correction.actor.displayName} · {correction.actor.account}</strong>
                            <small>{sourceLabel(correction.sourceSystem)} · {formatTime(correction.correctedAt)}</small>
                            <p>修改前：{correctionContent(record, correction.before)}</p>
                            <p>修改后：{correctionContent(record, correction.after)}</p>
                          </div>
                        ))}
                      </details>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <footer className="business-history-footer">
        <span>两套系统共用业务历史，每条记录注明来源系统。</span>
        <span>{status === "loaded" ? `${records.length} 条记录` : ""}</span>
      </footer>
      {editingRecord && editValues && (
        <div className="business-history-correction-backdrop">
          <section className="business-history-correction-dialog" role="dialog" aria-modal="true" aria-labelledby="business-history-correction-title">
            <div className="business-history-correction-heading">
              <div>
                <p>业务历史</p>
                <h2 id="business-history-correction-title">更正{typeLabels[editingRecord.operationType]}</h2>
              </div>
              <button
                className="business-history-correction-close"
                type="button"
                aria-label="关闭"
                onClick={() => setEditingRecord(null)}
                disabled={savingCorrection}
              >×</button>
            </div>
            <p className="business-history-correction-description">仅修改原业务支持的数量、实际发生时间或备注，提交后库存与历史会一起更新。</p>
            <form className="business-history-correction-form" onSubmit={saveCorrection}>
              {editingRecord.operationType === "split" ? (
                <label>
                  <span>拆开件数</span>
                  <input
                    type="number"
                    min="1"
                    max="2147483647"
                    step="1"
                    value={editValues.cases}
                    onChange={(event) => setEditValues({ ...editValues, cases: event.target.value })}
                    required
                  />
                  <small>按每件 {editingRecord.product.perCase} 个自动计算散个数量。</small>
                </label>
              ) : (
                <div className="business-history-correction-counts">
                  <label>
                    <span>整件</span>
                    <input
                      type="number"
                      min="0"
                      max="2147483647"
                      step="1"
                      value={editValues.cases}
                      onChange={(event) => setEditValues({ ...editValues, cases: event.target.value })}
                      required
                    />
                  </label>
                  <label>
                    <span>散个</span>
                    <input
                      type="number"
                      min="0"
                      max="2147483647"
                      step="1"
                      value={editValues.loose}
                      onChange={(event) => setEditValues({ ...editValues, loose: event.target.value })}
                      required
                    />
                  </label>
                </div>
              )}
              <label>
                <span>实际发生时间</span>
                <input
                  type="datetime-local"
                  value={editValues.actualOccurredAt}
                  onChange={(event) => setEditValues({ ...editValues, actualOccurredAt: event.target.value })}
                  required
                />
              </label>
              {editingRecord.operationType === "move" && (
                <label>
                  <span>备注（选填）</span>
                  <input
                    type="text"
                    value={editValues.note}
                    onChange={(event) => setEditValues({ ...editValues, note: event.target.value })}
                  />
                </label>
              )}
              {correctionError && <p className="business-history-correction-error" role="alert">{correctionError}</p>}
              <div className="business-history-correction-actions">
                <button className="button button-outline" type="button" onClick={() => setEditingRecord(null)} disabled={savingCorrection}>取消</button>
                <button className="button button-dark" type="submit" disabled={savingCorrection}>
                  {savingCorrection ? "正在保存…" : "保存更正"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </section>
  );
}
