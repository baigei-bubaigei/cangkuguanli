import { useEffect, useState } from "react";

function createdDate(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

export default function EmployeeAccounts() {
  const [accounts, setAccounts] = useState([]);
  const [status, setStatus] = useState("loading");
  const [formOpen, setFormOpen] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [account, setAccount] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [pendingEmployeeId, setPendingEmployeeId] = useState("");
  const [temporaryCredential, setTemporaryCredential] = useState(null);

  useEffect(() => {
    let current = true;

    async function loadAccounts() {
      try {
        const response = await fetch("/api/admin/employees", { cache: "no-store" });
        if (!response.ok) throw new Error("无法读取员工账号。");
        const result = await response.json();
        if (current) {
          setAccounts(result);
          setStatus("ready");
        }
      } catch {
        if (current) {
          setStatus("error");
          setMessage("暂时无法读取员工账号，请稍后重试。");
        }
      }
    }

    loadAccounts();
    return () => {
      current = false;
    };
  }, []);

  async function createAccount(event) {
    event.preventDefault();
    setPending(true);
    setMessage("");

    try {
      const response = await fetch("/api/admin/employees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account, displayName }),
      });
      const result = await response.json();
      if (!response.ok) {
        setMessage(result.error || "员工账号创建失败，请检查输入。");
        return;
      }

      setAccounts((current) => [result.employee, ...current]);
      setTemporaryCredential({
        account: result.employee.account,
        password: result.temporaryPassword,
      });
      setDisplayName("");
      setAccount("");
      setFormOpen(false);
    } catch {
      setMessage("暂时无法连接管理员系统，请检查网络后重试。");
    } finally {
      setPending(false);
    }
  }

  async function changeEmployeeStatus(employee) {
    const nextStatus = employee.status === "active" ? "disabled" : "active";
    setPendingEmployeeId(employee.id);
    setMessage("");

    try {
      const response = await fetch(`/api/admin/employees/${encodeURIComponent(employee.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      });
      const result = await response.json();
      if (!response.ok) {
        setMessage(result.error || "员工账号状态更新失败，请稍后重试。");
        return;
      }

      setAccounts((current) => current.map((item) => (
        item.id === result.id ? { ...item, status: result.status } : item
      )));
    } catch {
      setMessage("暂时无法连接管理员系统，请检查网络后重试。");
    } finally {
      setPendingEmployeeId("");
    }
  }

  return (
    <section className="employee-accounts" aria-label="员工账号管理">
      <div className="employee-accounts-toolbar">
        <div>
          <h2>账号列表</h2>
          <p>新建员工账号会生成一次性临时密码，员工首次登录时必须修改。</p>
        </div>
        <button
          className="button button-dark"
          type="button"
          onClick={() => {
            setFormOpen((open) => !open);
            setMessage("");
          }}
        >
          {formOpen ? "取消" : "新增员工账号"}
        </button>
      </div>

      {message && !formOpen && <p className="employee-account-message" role="alert">{message}</p>}

      {temporaryCredential && (
        <section className="employee-account-credential" aria-live="polite">
          <div>
            <h3>员工账号已创建</h3>
            <p>请将临时密码交付给该员工。首次登录后必须修改；离开此页后不会再次显示。</p>
          </div>
          <dl>
            <div><dt>登录账号</dt><dd>{temporaryCredential.account}</dd></div>
            <div><dt>一次性临时密码</dt><dd><code>{temporaryCredential.password}</code></dd></div>
          </dl>
          <button className="button button-dark" type="button" onClick={() => setTemporaryCredential(null)}>
            我已记录临时密码
          </button>
        </section>
      )}

      {formOpen && (
        <div className="employee-account-modal-backdrop">
          <section className="employee-account-modal" role="dialog" aria-modal="true" aria-labelledby="employee-account-form-title">
            <div className="employee-account-modal-head">
              <div>
                <h3 id="employee-account-form-title">新增员工账号</h3>
                <p>此账号仅用于员工系统。</p>
              </div>
              <button className="employee-account-modal-close" type="button" onClick={() => setFormOpen(false)} aria-label="关闭">
                ×
              </button>
            </div>
            <form className="employee-account-form" onSubmit={createAccount}>
              <label className="field">
                <span>员工姓名</span>
                <input
                  name="displayName"
                  type="text"
                  autoComplete="name"
                  required
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                />
              </label>
              <label className="field">
                <span>登录账号</span>
                <input
                  name="account"
                  type="text"
                  autoComplete="username"
                  required
                  value={account}
                  onChange={(event) => setAccount(event.target.value)}
                />
              </label>
              {message && <p className="employee-account-message" role="alert">{message}</p>}
              <div className="employee-account-form-actions">
                <button className="employee-account-cancel" type="button" onClick={() => setFormOpen(false)} disabled={pending}>
                  取消
                </button>
                <button className="button button-dark" type="submit" disabled={pending}>
                  {pending ? "正在创建…" : "创建员工账号"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}

      <div className="employee-accounts-table-wrap">
        <table className="employee-accounts-table">
          <thead>
            <tr><th>员工</th><th>登录账号</th><th>状态</th><th>创建日期</th><th>操作</th></tr>
          </thead>
          <tbody>
            {accounts.map((employee) => (
              <tr key={employee.id}>
                <td><strong>{employee.displayName}</strong></td>
                <td>{employee.account}</td>
                <td><span className={`employee-account-status employee-account-status-${employee.status}`}>
                  {employee.status === "active" ? "启用" : "停用"}
                </span></td>
                <td>{createdDate(employee.createdAt)}</td>
                <td>
                  <button
                    className="employee-account-toggle"
                    type="button"
                    aria-label={`${employee.status === "active" ? "停用" : "启用"}员工账号 ${employee.displayName}`}
                    disabled={pendingEmployeeId !== ""}
                    onClick={() => changeEmployeeStatus(employee)}
                  >
                    {pendingEmployeeId === employee.id
                      ? "正在更新…"
                      : employee.status === "active" ? "停用账号" : "启用账号"}
                  </button>
                </td>
              </tr>
            ))}
            {status === "ready" && accounts.length === 0 && (
              <tr><td className="employee-accounts-empty" colSpan={5}>暂无员工账号</td></tr>
            )}
            {status === "loading" && (
              <tr><td className="employee-accounts-empty" colSpan={5}>正在读取员工账号…</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
