import { useEffect, useState } from "react";
import InboundForm from "./InboundForm.jsx";
import "./inventory-query.css";

export default function InventoryQuery() {
  const [inventory, setInventory] = useState({ warehouses: [], products: [] });
  const [status, setStatus] = useState("loading");
  const [query, setQuery] = useState("");
  const [warehouse, setWarehouse] = useState("");
  const [inboundContext, setInboundContext] = useState(null);

  async function loadInventory() {
    setStatus("loading");
    try {
      const response = await fetch("/api/inventory", { cache: "no-store" });
      if (!response.ok) throw new Error("库存查询失败。");
      setInventory(await response.json());
      setStatus("loaded");
    } catch {
      setStatus("error");
    }
  }

  useEffect(() => {
    void loadInventory();
  }, []);

  const searchTerm = query.toLowerCase();
  const products = inventory.products.filter((product) => {
    if (warehouse && !product.locations.some((location) => location.warehouse === warehouse)) {
      return false;
    }
    if (!searchTerm) return true;

    const searchableText = [
      product.name,
      product.spec,
      product.category,
      product.categoryName,
      ...product.locations.map((location) => location.spot),
    ];
    return searchableText.some((value) => String(value ?? "").toLowerCase().includes(searchTerm));
  });

  return (
    <section className="inventory-query" aria-label="共享库存查询">
      <div className="inventory-query-toolbar">
        <div>
          <p className="inventory-query-eyebrow">共用库存</p>
          <h2>库存列表</h2>
          <p>整件和散个分别汇总，货位数量按规格跨仓库统计。</p>
        </div>
        <div className="inventory-query-filters">
          <label className="inventory-query-search">
            <span>关键词</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索产品、规格或货位"
            />
          </label>
          <label className="inventory-query-warehouse">
            <span>仓库</span>
            <select value={warehouse} onChange={(event) => setWarehouse(event.target.value)}>
              <option value="">全部仓库</option>
              {inventory.warehouses.map((name) => (
                <option value={name} key={name}>{name}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="inventory-query-actions">
        <button
          className="button button-dark"
          type="button"
          disabled={!inventory.products.length}
          onClick={() => setInboundContext({})}
        >
          登记入库
        </button>
      </div>

      {status === "loading" ? (
        <div className="inventory-query-state" aria-live="polite">正在读取库存…</div>
      ) : status === "error" ? (
        <div className="inventory-query-state" role="alert">
          <p>暂时无法读取库存，查询失败不代表库存为零。</p>
          <button className="inventory-query-retry" type="button" onClick={loadInventory}>重试</button>
        </div>
      ) : inventory.products.length === 0 ? (
        <div className="inventory-query-state">暂无库存规格资料。</div>
      ) : products.length === 0 ? (
        <div className="inventory-query-state">没有符合条件的库存。</div>
      ) : (
        <div className="inventory-query-table-wrap">
          <table className="inventory-query-table">
            <thead>
              <tr>
                <th scope="col">产品规格</th>
                <th scope="col">每件个数</th>
                <th scope="col">货位分布</th>
                <th scope="col">整件合计</th>
                <th scope="col">散个合计</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {products.map((product) => (
                <tr className="inventory-query-row" key={product.id}>
                  <td className="inventory-query-product">
                    <strong>{product.name}</strong>
                    <small>{product.spec}</small>
                  </td>
                  <td>{product.perCase} 个 / 件</td>
                  <td>{product.locations.length} 个货位</td>
                  <td className="inventory-query-quantity">
                    <strong>{product.totalCases}</strong> 件
                  </td>
                  <td className="inventory-query-quantity">
                    <strong>{product.totalLoose}</strong> 个
                  </td>
                  <td className="inventory-query-action">
                    <button
                      className="inventory-query-inbound-toggle"
                      type="button"
                      onClick={() => setInboundContext({ productId: product.id })}
                    >
                      入库
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {inboundContext && (
        <InboundForm
          products={inventory.products}
          initialProductId={inboundContext.productId}
          initialLocationId={inboundContext.locationId}
          onClose={() => setInboundContext(null)}
          onSaved={async () => {
            setInboundContext(null);
            await loadInventory();
          }}
        />
      )}
    </section>
  );
}
