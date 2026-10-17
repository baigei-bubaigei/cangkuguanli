import { Fragment, useEffect, useState } from "react";
import InboundForm from "./InboundForm.jsx";
import OutboundForm from "./OutboundForm.jsx";
import SplitForm from "./SplitForm.jsx";
import "./inventory-query.css";

export default function InventoryQuery() {
  const [inventory, setInventory] = useState({ warehouses: [], products: [] });
  const [status, setStatus] = useState("loading");
  const [query, setQuery] = useState("");
  const [warehouse, setWarehouse] = useState("");
  const [expandedProductId, setExpandedProductId] = useState(null);
  const [inboundContext, setInboundContext] = useState(null);
  const [outboundContext, setOutboundContext] = useState(null);
  const [splitContext, setSplitContext] = useState(null);

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
          onClick={() => {
            setOutboundContext(null);
            setSplitContext(null);
            setInboundContext({});
          }}
        >
          登记入库
        </button>
        <button
          className="button button-outline"
          type="button"
          disabled={!inventory.products.length}
          onClick={() => {
            setInboundContext(null);
            setSplitContext(null);
            setOutboundContext({});
          }}
        >
          登记出库
        </button>
        <button
          className="button button-outline"
          type="button"
          disabled={!inventory.products.length}
          onClick={() => {
            setInboundContext(null);
            setOutboundContext(null);
            setSplitContext({});
          }}
        >
          登记拆件
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
              {products.map((product) => {
                const expanded = expandedProductId === product.id;
                const detailId = `inventory-location-detail-${product.id}`;
                const toggleDetails = () => {
                  setExpandedProductId((currentId) => currentId === product.id ? null : product.id);
                };

                return (
                  <Fragment key={product.id}>
                    <tr className="inventory-query-row">
                      <td className="inventory-query-product">
                        <button
                          className="inventory-query-product-toggle"
                          type="button"
                          aria-expanded={expanded}
                          aria-controls={expanded ? detailId : undefined}
                          onClick={toggleDetails}
                        >
                          <strong>{product.name}</strong>
                          <small>{product.spec}</small>
                        </button>
                      </td>
                      <td>{product.perCase} 个 / 件</td>
                      <td>
                        <button
                          className="inventory-query-location-toggle"
                          type="button"
                          aria-expanded={expanded}
                          aria-controls={expanded ? detailId : undefined}
                          onClick={toggleDetails}
                        >
                          {product.locations.length} 个货位 <span>{expanded ? "收起" : "查看"}</span>
                        </button>
                      </td>
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
                          onClick={() => {
                            setOutboundContext(null);
                            setSplitContext(null);
                            setInboundContext({ productId: product.id });
                          }}
                        >
                          入库
                        </button>
                        <button
                          className="inventory-query-outbound-toggle"
                          type="button"
                          onClick={() => {
                            setInboundContext(null);
                            setSplitContext(null);
                            setOutboundContext({ productId: product.id });
                          }}
                        >
                          出库
                        </button>
                        <button
                          className="inventory-query-split-toggle"
                          type="button"
                          onClick={() => {
                            setInboundContext(null);
                            setOutboundContext(null);
                            setSplitContext({ productId: product.id });
                          }}
                        >
                          拆件
                        </button>
                      </td>
                    </tr>
                    {expanded && (
                      <tr className="inventory-query-detail-row" id={detailId}>
                        <td colSpan={6}>
                          <div className="inventory-query-detail">
                            <div className="inventory-query-detail-head">
                              <span>货位明细</span>
                              <span>每件 {product.perCase} 个</span>
                            </div>
                            <div className="inventory-query-detail-list">
                              {product.locations.map((location) => (
                                <div className="inventory-query-location" key={location.id}>
                                  <span className="inventory-query-location-name">
                                    <small>{location.warehouse}</small>
                                    {location.spot}
                                  </span>
                                  <span className="inventory-query-location-cases">
                                    <strong>{location.cases}</strong> 件
                                  </span>
                                  <span className="inventory-query-location-loose">
                                    <strong>{location.loose}</strong> 个
                                  </span>
                                  <span className="inventory-query-location-actions">
                                    <button
                                      className="inventory-query-inbound-toggle"
                                      type="button"
                                      onClick={() => {
                                        setOutboundContext(null);
                                        setSplitContext(null);
                                        setInboundContext({ productId: product.id, locationId: location.id });
                                      }}
                                    >
                                      入库
                                    </button>
                                  </span>
                                </div>
                              ))}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
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
      {outboundContext && (
        <OutboundForm
          products={inventory.products}
          initialProductId={outboundContext.productId}
          initialLocationId={outboundContext.locationId}
          onClose={() => setOutboundContext(null)}
          onSaved={async () => {
            setOutboundContext(null);
            await loadInventory();
          }}
        />
      )}
      {splitContext && (
        <SplitForm
          products={inventory.products}
          initialProductId={splitContext.productId}
          initialLocationId={splitContext.locationId}
          onClose={() => setSplitContext(null)}
          onSaved={async () => {
            setSplitContext(null);
            await loadInventory();
          }}
        />
      )}
    </section>
  );
}
