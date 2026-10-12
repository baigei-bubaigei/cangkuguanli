import { useEffect, useState } from "react";
import "./catalog.css";

export default function ProductCatalog() {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [pending, setPending] = useState(false);

  async function loadProducts() {
    setLoading(true);
    setLoadError("");
    try {
      const response = await fetch("/api/catalog/products", { cache: "no-store" });
      if (!response.ok) throw new Error("产品规格读取失败，请重试。");
      setProducts(await response.json());
    } catch {
      setLoadError("暂时无法读取产品规格，请重试。");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadProducts();
  }, []);

  async function handleSave(event) {
    event.preventDefault();
    setPending(true);
    setSaveError("");

    const form = new FormData(event.currentTarget);
    const product = Object.fromEntries(form.entries());
    product.perCase = Number(product.perCase);
    try {
      const response = await fetch("/api/catalog/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(product),
      });
      const result = await response.json();
      if (!response.ok) {
        setSaveError(result.error || "产品规格保存失败，请检查后重试。");
        return;
      }

      setFormOpen(false);
      await loadProducts();
    } catch {
      setSaveError("暂时无法保存产品规格，请检查网络后重试。");
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="catalog-panel" aria-label="共用产品规格">
      <div className="catalog-toolbar">
        <div>
          <p className="catalog-eyebrow">共用基础资料</p>
          <h2>产品规格</h2>
          <p>管理员和员工查看同一份已保存资料。</p>
        </div>
        <button className="button button-dark" type="button" onClick={() => { setSaveError(""); setFormOpen(true); }}>
          新增产品规格
        </button>
      </div>

      {loading ? (
        <div className="catalog-state" aria-live="polite">正在读取产品规格…</div>
      ) : loadError ? (
        <div className="catalog-state" role="alert">
          <p>{loadError}</p>
          <button className="button button-outline" type="button" onClick={loadProducts}>重试</button>
        </div>
      ) : products.length === 0 ? (
        <div className="catalog-state">暂无产品规格，请新增一条资料。</div>
      ) : (
        <div className="catalog-table-wrap">
          <table className="catalog-table">
            <thead>
              <tr>
                <th>产品名称</th>
                <th>商品类别</th>
                <th>类别名称</th>
                <th>规格</th>
                <th>每件个数</th>
                <th>备注</th>
                <th>仓库</th>
                <th>货位</th>
              </tr>
            </thead>
            <tbody>
              {products.map((product) => (
                <tr key={product.locationId}>
                  <td><strong>{product.name}</strong></td>
                  <td>{product.category}</td>
                  <td>{product.categoryName}</td>
                  <td>{product.spec}</td>
                  <td>{product.perCase} 个 / 件</td>
                  <td>{product.note}</td>
                  <td>{product.warehouse}</td>
                  <td>{product.spot}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {formOpen && (
        <div className="catalog-modal-backdrop">
          <section className="catalog-dialog" role="dialog" aria-modal="true" aria-labelledby="product-dialog-title">
            <div className="catalog-dialog-heading">
              <div>
                <p className="catalog-eyebrow">基础资料</p>
                <h2 id="product-dialog-title">新增产品规格</h2>
              </div>
              <button
                className="catalog-close-button"
                type="button"
                aria-label="关闭"
                onClick={() => setFormOpen(false)}
              >×</button>
            </div>
            <p className="catalog-dialog-description">商品类别、类别名称和备注分别保存。</p>
            <form className="catalog-form" onSubmit={handleSave}>
              <div className="catalog-form-grid">
                <label className="catalog-field">
                  <span>产品名称</span>
                  <input name="name" type="text" autoComplete="off" required />
                </label>
                <label className="catalog-field">
                  <span>规格名称</span>
                  <input name="spec" type="text" autoComplete="off" required />
                </label>
                <label className="catalog-field">
                  <span>商品类别</span>
                  <input name="category" type="text" autoComplete="off" />
                </label>
                <label className="catalog-field">
                  <span>类别名称</span>
                  <input name="categoryName" type="text" autoComplete="off" />
                </label>
                <label className="catalog-field catalog-field-full">
                  <span>备注</span>
                  <input name="note" type="text" autoComplete="off" />
                </label>
                <label className="catalog-field">
                  <span>每件个数</span>
                  <select name="perCase" defaultValue="4" required>
                    <option value="2">2 个 / 件</option>
                    <option value="4">4 个 / 件</option>
                    <option value="6">6 个 / 件</option>
                  </select>
                </label>
                <label className="catalog-field">
                  <span>仓库</span>
                  <input name="warehouse" type="text" autoComplete="off" required />
                </label>
                <label className="catalog-field">
                  <span>货位</span>
                  <input name="spot" type="text" autoComplete="off" required />
                </label>
              </div>
              {saveError && <p className="catalog-form-error" role="alert">{saveError}</p>}
              <div className="catalog-form-actions">
                <button className="button button-outline" type="button" onClick={() => setFormOpen(false)} disabled={pending}>
                  取消
                </button>
                <button className="button button-dark" type="submit" disabled={pending}>
                  {pending ? "正在保存…" : "保存规格"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </section>
  );
}
