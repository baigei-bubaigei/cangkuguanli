import { useRef, useState } from "react";
import { completeInventoryMutation, inventoryMutationOptions } from "./submission.js";
import { productOptionLabel } from "./productOptionLabel.js";

function localDateTimeNow() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export default function OutboundForm({ products, initialProductId, initialLocationId, onClose, onSaved }) {
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
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const submissionRef = useRef(null);
  const selectedProduct = products.find((product) => product.id === productSpecId);
  const selectedLocation = selectedProduct?.locations.find((location) => location.id === locationId);

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
      const payload = {
        productSpecId,
        locationId,
        cases: caseCount,
        loose: looseCount,
        actualOccurredAt: new Date(actualOccurredAt).toISOString(),
        note,
      };
      const response = await fetch("/api/inventory/outbound", inventoryMutationOptions(
        submissionRef,
        "/api/inventory/outbound",
        payload,
      ));
      const result = await response.json();
      if (!response.ok) {
        setError(result.error || "出库未完成，请检查资料后重试。");
        return;
      }

      completeInventoryMutation(submissionRef);
      await onSaved();
    } catch {
      setError("出库未完成，当前输入已保留，请检查网络后重试。");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="inventory-query-outbound-backdrop">
      <section className="inventory-query-outbound-dialog" role="dialog" aria-modal="true" aria-labelledby="inventory-outbound-title">
        <div className="inventory-query-outbound-heading">
          <div>
            <p>库存业务</p>
            <h2 id="inventory-outbound-title">登记出库</h2>
          </div>
          <button className="inventory-query-outbound-close" type="button" aria-label="关闭" onClick={onClose} disabled={pending}>×</button>
        </div>
        <p className="inventory-query-outbound-description">选择货位并输入本次离库的整件和散个数量。系统会按提交时库存校验。</p>
        <form className="inventory-query-outbound-form" onSubmit={handleSubmit}>
          <label>
            <span>产品规格</span>
            <select value={productSpecId} onChange={handleProductChange} required>
              {products.map((product) => (
                <option key={product.id} value={product.id}>{productOptionLabel(product)}</option>
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
          {selectedProduct && selectedLocation && (
            <p className="inventory-query-outbound-ratio">
              每件 {selectedProduct.perCase} 个；该货位有 {selectedLocation.cases} 件、{selectedLocation.loose} 个
            </p>
          )}
          <div className="inventory-query-outbound-counts">
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
          <label>
            <span>备注（选填）</span>
            <input type="text" value={note} onChange={(event) => setNote(event.target.value)} />
          </label>
          {error && <p className="inventory-query-outbound-error" role="alert">{error}</p>}
          <div className="inventory-query-outbound-actions">
            <button className="button button-outline" type="button" onClick={onClose} disabled={pending}>取消</button>
            <button className="button button-dark" type="submit" disabled={pending || !products.length || !locationId}>
              {pending ? "正在保存…" : "确认出库"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
