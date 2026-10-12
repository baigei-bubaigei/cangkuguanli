import { useState } from "react";

function localDateTimeNow() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export default function InboundForm({ products, initialProductId, initialLocationId, onClose, onSaved }) {
  const initialProduct = products.find((product) => product.id === initialProductId) ?? products[0];
  const [productSpecId, setProductSpecId] = useState(initialProduct?.id ?? "");
  const [locationId, setLocationId] = useState(() => (
    initialProduct?.locations.some((location) => location.id === initialLocationId)
      ? initialLocationId
      : initialProduct?.locations[0]?.id ?? ""
  ));
  const [cases, setCases] = useState("0");
  const [loose, setLoose] = useState("0");
  const [actualOccurredAt, setActualOccurredAt] = useState(localDateTimeNow);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const selectedProduct = products.find((product) => product.id === productSpecId);

  function handleProductChange(event) {
    const nextProductId = event.target.value;
    const nextProduct = products.find((product) => product.id === nextProductId);
    setProductSpecId(nextProductId);
    setLocationId(nextProduct?.locations[0]?.id ?? "");
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");

    const caseCount = Number(cases);
    const looseCount = Number(loose);
    if (!Number.isInteger(caseCount) || caseCount < 0 || caseCount > 2147483647
      || !Number.isInteger(looseCount) || looseCount < 0 || looseCount > 2147483647
      || (caseCount === 0 && looseCount === 0)) {
      setError("整件和散个须为非负整数，且至少一项大于零。");
      return;
    }

    setPending(true);
    try {
      const response = await fetch("/api/inventory/inbound", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productSpecId,
          locationId,
          cases: caseCount,
          loose: looseCount,
          actualOccurredAt: new Date(actualOccurredAt).toISOString(),
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        setError(result.error || "入库未完成，请检查资料后重试。");
        return;
      }

      await onSaved();
    } catch {
      setError("入库未完成，当前输入已保留，请检查网络后重试。");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="inventory-query-inbound-backdrop">
      <section className="inventory-query-inbound-dialog" role="dialog" aria-modal="true" aria-labelledby="inventory-inbound-title">
        <div className="inventory-query-inbound-heading">
          <div>
            <p>库存业务</p>
            <h2 id="inventory-inbound-title">登记入库</h2>
          </div>
          <button className="inventory-query-inbound-close" type="button" aria-label="关闭" onClick={onClose} disabled={pending}>×</button>
        </div>
        <p className="inventory-query-inbound-description">输入本次增加的库存数量，整件和散个分别保存。</p>
        <form className="inventory-query-inbound-form" onSubmit={handleSubmit}>
          <label>
            <span>产品规格</span>
            <select value={productSpecId} onChange={handleProductChange} required>
              {products.map((product) => (
                <option key={product.id} value={product.id}>{product.name} · {product.spec}</option>
              ))}
            </select>
          </label>
          <label>
            <span>仓库 / 货位</span>
            <select value={locationId} onChange={(event) => setLocationId(event.target.value)} required>
              {selectedProduct?.locations.map((location) => (
                <option key={location.id} value={location.id}>{location.warehouse} / {location.spot}</option>
              ))}
            </select>
          </label>
          {selectedProduct && <p className="inventory-query-inbound-ratio">每件 {selectedProduct.perCase} 个</p>}
          <div className="inventory-query-inbound-counts">
            <label>
              <span>整件</span>
              <input type="number" min="0" max="2147483647" step="1" inputMode="numeric" value={cases} onChange={(event) => setCases(event.target.value)} required />
            </label>
            <label>
              <span>散个</span>
              <input type="number" min="0" max="2147483647" step="1" inputMode="numeric" value={loose} onChange={(event) => setLoose(event.target.value)} required />
            </label>
          </div>
          <label>
            <span>实际发生时间</span>
            <input type="datetime-local" value={actualOccurredAt} onChange={(event) => setActualOccurredAt(event.target.value)} required />
          </label>
          {error && <p className="inventory-query-inbound-error" role="alert">{error}</p>}
          <div className="inventory-query-inbound-actions">
            <button className="button button-outline" type="button" onClick={onClose} disabled={pending}>取消</button>
            <button className="button button-dark" type="submit" disabled={pending || !products.length || !locationId}>
              {pending ? "正在保存…" : "确认入库"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
