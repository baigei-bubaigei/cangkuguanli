import { useState } from "react";

function localDateTimeNow() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export default function SplitForm({ products, initialProductId, initialLocationId, onClose, onSaved }) {
  const initialProduct = products.find((product) => product.id === initialProductId) ?? products[0];
  const [productSpecId, setProductSpecId] = useState(initialProduct?.id ?? "");
  const [locationId, setLocationId] = useState(() => (
    initialProduct?.locations.some((location) => location.id === initialLocationId)
      ? initialLocationId
      : initialProduct?.locations[0]?.id ?? ""
  ));
  const [cases, setCases] = useState("");
  const [actualOccurredAt, setActualOccurredAt] = useState(localDateTimeNow);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const selectedProduct = products.find((product) => product.id === productSpecId);
  const selectedLocation = selectedProduct?.locations.find((location) => location.id === locationId);
  const splitCases = Number(cases || 0);

  function handleProductChange(event) {
    const nextProductId = event.target.value;
    const nextProduct = products.find((product) => product.id === nextProductId);
    setProductSpecId(nextProductId);
    setLocationId(nextProduct?.locations[0]?.id ?? "");
    setError("");
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");

    if (!Number.isInteger(splitCases) || splitCases <= 0 || splitCases > 2147483647) {
      setError("拆开件数须为大于 0 的整数。");
      return;
    }

    setPending(true);
    try {
      const response = await fetch("/api/inventory/split", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productSpecId,
          locationId,
          cases: splitCases,
          actualOccurredAt: new Date(actualOccurredAt).toISOString(),
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        setError(result.error || "拆件未完成，请检查资料后重试。");
        return;
      }

      await onSaved();
    } catch {
      setError("拆件未完成，当前输入已保留，请检查网络后重试。");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="inventory-query-split-backdrop">
      <section className="inventory-query-split-dialog" role="dialog" aria-modal="true" aria-labelledby="inventory-split-title">
        <div className="inventory-query-split-heading">
          <div>
            <p>库存业务</p>
            <h2 id="inventory-split-title">登记拆件</h2>
          </div>
          <button className="inventory-query-split-close" type="button" aria-label="关闭" onClick={onClose} disabled={pending}>×</button>
        </div>
        <p className="inventory-query-split-description">输入拆开件数，散个按产品规格的每件个数增加，不会自动折回整件。</p>
        <form className="inventory-query-split-form" onSubmit={handleSubmit}>
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
            <select value={locationId} onChange={(event) => { setLocationId(event.target.value); setError(""); }} required>
              {selectedProduct?.locations.map((location) => (
                <option key={location.id} value={location.id}>{location.warehouse} / {location.spot}</option>
              ))}
            </select>
          </label>
          {selectedProduct && selectedLocation && (
            <p className="inventory-query-split-available">
              当前货位可用：{selectedLocation.cases} 件、{selectedLocation.loose} 个。
            </p>
          )}
          <label>
            <span>拆开件数</span>
            <input type="number" min="1" max="2147483647" step="1" inputMode="numeric" value={cases} onChange={(event) => setCases(event.target.value)} required />
          </label>
          {selectedProduct && (
            <div className="inventory-query-split-preview" aria-live="polite">
              <span>拆件预览</span>
              <strong>{splitCases} 件 → 增加 {splitCases * selectedProduct.perCase} 个散个</strong>
              <small>每件 {selectedProduct.perCase} 个</small>
            </div>
          )}
          <label>
            <span>实际发生时间</span>
            <input type="datetime-local" value={actualOccurredAt} onChange={(event) => setActualOccurredAt(event.target.value)} required />
          </label>
          {error && <p className="inventory-query-split-error" role="alert">{error}</p>}
          <div className="inventory-query-split-actions">
            <button className="button button-outline" type="button" onClick={onClose} disabled={pending}>取消</button>
            <button className="button button-dark" type="submit" disabled={pending || !products.length || !locationId}>
              {pending ? "正在保存…" : "确认拆件"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
