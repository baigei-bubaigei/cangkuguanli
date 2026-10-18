import { useEffect, useState } from "react";
import "./system-operation-logs.css";

const operationLabels = {
  login: "登录",
  logout: "退出",
  inventory_history_corrected: "更正业务记录",
  employee_account_created: "创建员工账号",
  employee_account_status_changed: "修改员工状态",
  product_spec_created: "新增产品规格",
  location_created: "新增货位",
  inventory_inbound: "入库",
  inventory_outbound: "出库",
  inventory_move: "移动货位",
  inventory_split: "拆件",
  initial_inventory_import: "初始库存导入",
};

const contentLabels = {
  action: "操作",
  account: "账号",
  batchId: "批次",
  cases: "整件",
  casesSplit: "拆开件数",
  category: "商品类别",
  categoryName: "类别名称",
  color: "颜色",
  displayName: "姓名",
  loose: "散个",
  material: "材质",
  note: "备注",
  perCase: "每件个数",
  perCaseCount: "每件个数",
  productName: "产品名称",
  spec: "规格",
  spot: "货位",
  status: "状态",
  warehouse: "仓库",
};

function contentDetails(content) {
  return Object.entries(content || {})
    .map(([key, value]) => `${contentLabels[key] || key}：${typeof value === "object" && value !== null ? JSON.stringify(value) : value}`)
    .join(" · ");
}

function formatTime(value) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

export default function SystemOperationLogs({ system }) {
  const isAdmin = system === "admin";
  const [source, setSource] = useState("");
  const [actorAccount, setActorAccount] = useState("");
  const [keyword, setKeyword] = useState("");
  const [records, setRecords] = useState([]);
  const [actors, setActors] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams();
    if (isAdmin && source) params.set("source", source);
    if (actorAccount) params.set("actorAccount", actorAccount);
    if (keyword.trim()) params.set("q", keyword.trim());
    const query = params.size ? `?${params}` : "";
    const path = isAdmin ? "/api/admin/system-logs" : "/api/employee/system-logs";

    async function loadLogs() {
      setLoading(true);
      setError("");
      try {
        const response = await fetch(`${path}${query}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "系统操作日志读取失败，请重试。");
        setRecords(result.records);
        setActors(result.actors);
      } catch (loadError) {
        if (loadError.name === "AbortError") return;
        setError(loadError.message || "系统操作日志读取失败，请重试。");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }

    loadLogs();
    return () => controller.abort();
  }, [actorAccount, isAdmin, keyword, source]);

  return (
    <section className="system-operation-logs" aria-labelledby="system-operation-logs-title">
      <header className="system-operation-logs__header">
        <div>
          <p className="system-operation-logs__eyebrow">{isAdmin ? "管理员 · 全部系统日志" : "员工端日志"}</p>
          <h2 id="system-operation-logs-title">{isAdmin ? "全部系统操作记录" : "员工系统操作记录"}</h2>
          <p>{isAdmin ? "查看管理员和员工两端的系统操作记录。" : "查看员工端的系统操作记录。"}</p>
        </div>
        <div className="system-operation-logs__filters">
          <label className="system-operation-logs__search">
            <span>搜索操作内容或账号</span>
            <input
              type="search"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="搜索操作内容或账号"
            />
          </label>
          {isAdmin && (
            <label>
              <span>来源系统</span>
              <select value={source} onChange={(event) => setSource(event.target.value)}>
                <option value="">全部系统</option>
                <option value="employee">员工系统</option>
                <option value="admin">管理员系统</option>
              </select>
            </label>
          )}
          <label>
            <span>操作人</span>
            <select value={actorAccount} onChange={(event) => setActorAccount(event.target.value)}>
              <option value="">全部操作人</option>
              {actors.map((actor) => (
                <option key={actor.account} value={actor.account}>
                  {actor.displayName}（{actor.account}）
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>

      {loading ? (
        <p className="system-operation-logs__state" aria-live="polite">正在读取系统操作日志…</p>
      ) : error ? (
        <p className="system-operation-logs__state system-operation-logs__error" role="alert">{error}</p>
      ) : records.length === 0 ? (
        <p className="system-operation-logs__state" aria-live="polite">没有符合条件的系统操作记录。</p>
      ) : (
        <>
          <div className="system-operation-logs__table-wrap">
            <table className="system-operation-logs__table">
              <thead>
                <tr>
                  <th scope="col">操作内容</th>
                  <th scope="col">操作人 / 账号</th>
                  <th scope="col">来源系统</th>
                  <th scope="col">操作时间</th>
                </tr>
              </thead>
              <tbody>
                {records.map((record) => (
                  <tr key={record.id}>
                    <td data-label="操作内容">
                      <strong>{operationLabels[record.operationType] || record.operationType}</strong>
                      {contentDetails(record.content) && <small>{contentDetails(record.content)}</small>}
                    </td>
                    <td data-label="操作人 / 账号">
                      <strong>{record.actorDisplayName}</strong>
                      <small>{record.actorAccount}</small>
                    </td>
                    <td data-label="来源系统">{record.sourceSystem === "admin" ? "管理员系统" : "员工系统"}</td>
                    <td data-label="操作时间">
                      <time dateTime={record.recordedAt}>{formatTime(record.recordedAt)}</time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <footer className="system-operation-logs__footer" aria-live="polite">
            {records.length} 条符合条件的记录
          </footer>
        </>
      )}
    </section>
  );
}
