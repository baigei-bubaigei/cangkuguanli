import { useEffect, useState } from "react";
import ProductCatalog from "@cangkuguanli/product-catalog";
import InventoryQuery from "@cangkuguanli/inventory-query";

const employeePages = [
  { label: "库存查询", group: "库存工作区" },
  { label: "库存业务记录", group: "库存工作区" },
  { label: "产品与货位", group: "基础资料" },
  { label: "系统操作日志", group: "记录与管理" },
];

export default function App() {
  const [status, setStatus] = useState("checking");
  const [employee, setEmployee] = useState(null);
  const [activePage, setActivePage] = useState("库存查询");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let current = true;

    async function restoreSession() {
      try {
        const response = await fetch("/api/employee/auth/session", {
          cache: "no-store",
        });
        if (!current) return;

        if (response.status === 401) {
          setStatus("signed-out");
          return;
        }
        if (!response.ok) throw new Error("无法验证员工会话。");

        setEmployee(await response.json());
        setStatus("signed-in");
      } catch {
        if (!current) return;
        setStatus("unavailable");
        setMessage("暂时无法连接员工系统，请稍后重试。");
      }
    }

    restoreSession();
    return () => {
      current = false;
    };
  }, []);

  async function handleLogin(event) {
    event.preventDefault();
    setPending(true);
    setMessage("");

    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/employee/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account: form.get("account"),
          password: form.get("password"),
        }),
      });

      const result = await response.json();
      if (!response.ok) {
        setMessage(result.error || "登录失败，请检查账号和密码。");
        return;
      }

      setEmployee(result);
      setActivePage("库存查询");
      setStatus("signed-in");
    } catch {
      setMessage("暂时无法连接员工系统，请检查网络后重试。");
    } finally {
      setPending(false);
    }
  }

  async function handleLogout() {
    setPending(true);
    setMessage("");

    try {
      const response = await fetch("/api/employee/auth/session", {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("退出失败。");
      setEmployee(null);
      setStatus("signed-out");
      setMobileOpen(false);
    } catch {
      setMessage("退出未完成，请重试。");
    } finally {
      setPending(false);
    }
  }

  if (status === "checking") {
    return <main className="loading-screen" aria-live="polite">正在验证员工会话…</main>;
  }

  if (status === "unavailable") {
    return (
      <main className="loading-screen" aria-labelledby="connection-title">
        <h1 id="connection-title">无法连接员工系统</h1>
        <p role="alert">{message}</p>
        <button className="button button-dark" type="button" onClick={() => window.location.reload()}>
          重试
        </button>
      </main>
    );
  }

  if (status === "signed-out") {
    return (
      <main className="login-page">
        <section className="login-side" aria-label="员工系统">
          <a className="brand-lockup" href="/" aria-label="仓库库存管理">
            <span className="brand-mark" aria-hidden="true">仓</span>
            <span>仓库库存管理</span>
          </a>
          <div className="login-message">
            <p className="eyebrow">EMPLOYEE PORTAL</p>
            <h1>员工系统<br />独立登录入口</h1>
            <p>使用已建立的员工账号登录，员工会话由服务端验证。</p>
          </div>
          <span className="login-side-foot">员工系统</span>
        </section>

        <section className="login-panel" aria-labelledby="login-title">
          <div className="login-form-wrap">
            <p className="eyebrow">独立登录</p>
            <h2 id="login-title">登录员工系统</h2>
            <p className="muted">请输入员工账号和密码。</p>
            <form className="form-stack" onSubmit={handleLogin}>
              <label className="field">
                <span>账号</span>
                <input name="account" type="text" autoComplete="username" required />
              </label>
              <label className="field">
                <span>密码</span>
                <input name="password" type="password" autoComplete="current-password" required />
              </label>
              {message && <p className="form-error" role="alert">{message}</p>}
              <button className="button button-dark button-wide" type="submit" disabled={pending}>
                {pending ? "正在登录…" : "登录员工系统"}
              </button>
            </form>
            <div className="login-separator"><span>当前入口</span></div>
            <div className="login-entry-name">员工系统<span>· 独立账号</span></div>
          </div>
        </section>
      </main>
    );
  }

  const groups = [...new Set(employeePages.map((page) => page.group))];

  return (
    <div className="app-shell">
      {mobileOpen && (
        <button
          className="mobile-scrim"
          type="button"
          aria-label="关闭菜单"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <aside id="employee-navigation" className={`sidebar ${mobileOpen ? "sidebar-open" : ""}`}>
        <div className="sidebar-brand">
          <a className="brand-lockup" href="/" aria-label="仓库库存管理">
            <span className="brand-mark" aria-hidden="true">仓</span>
            <span>仓库库存管理</span>
          </a>
          <span className="system-badge">员工系统</span>
        </div>
        <nav className="nav-scroll" aria-label="员工系统导航">
          {groups.map((group) => (
            <div className="nav-group" key={group}>
              <p className="nav-group-title">{group}</p>
              {employeePages.filter((page) => page.group === group).map((page) => (
                <button
                  className={`nav-link ${activePage === page.label ? "nav-link-active" : ""}`}
                  type="button"
                  key={page.label}
                  aria-current={activePage === page.label ? "page" : undefined}
                  onClick={() => {
                    setActivePage(page.label);
                    setMobileOpen(false);
                  }}
                >
                  {page.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="user-block">
            <span className="avatar" aria-hidden="true">{employee.displayName.slice(0, 1)}</span>
            <span className="user-copy">
              <strong>{employee.displayName}</strong>
              <small>{employee.account}</small>
            </span>
          </div>
          <button className="logout-button" type="button" onClick={handleLogout} disabled={pending}>
            退出当前系统
          </button>
          {message && <p className="sidebar-error" role="alert">{message}</p>}
        </div>
      </aside>

      <div className="main-column">
        <header className="app-topbar">
          <button
            className="mobile-menu-button"
            type="button"
            aria-expanded={mobileOpen}
            aria-controls="employee-navigation"
            onClick={() => setMobileOpen((open) => !open)}
          >
            菜单
          </button>
          <div className="breadcrumb">
            <span>员工系统</span>
            <span aria-hidden="true" className="crumb-divider">/</span>
            <strong>{activePage}</strong>
          </div>
          <span className="employee-topbar-name">{employee.displayName}</span>
        </header>
        <main className="page-content">
          <p className="eyebrow">员工专属</p>
          <h1>{activePage}</h1>
          {activePage === "库存查询" ? (
            <InventoryQuery />
          ) : activePage === "产品与货位" ? (
            <ProductCatalog />
          ) : (
            <section className="page-placeholder" aria-live="polite">
              <span className="system-badge">员工系统</span>
              <p>当前员工会话有效。{activePage}页面将在对应功能任务中接入。</p>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
