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

function historyUrl(filters) {
  const searchParams = new URLSearchParams();
  if (filters.type) searchParams.set("type", filters.type);
  if (filters.query) searchParams.set("q", filters.query);
  if (filters.source) searchParams.set("source", filters.source);
  const query = searchParams.toString();
  return "/api/inventory/history" + (query ? `?${query}` : "");
}

export default function BusinessHistory() {
  const [type, setType] = useState("");
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("");
  const [records, setRecords] = useState([]);
  const [status, setStatus] = useState("loading");

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
  }, [type, query, source]);

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
    </section>
  );
}
