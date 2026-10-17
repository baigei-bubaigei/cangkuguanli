import { useRef, useState } from "react";
import { completeInventoryMutation, inventoryMutationOptions } from "./submission.js";

function localDateTimeNow() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export default function MoveForm({ products, initialProductId, initialSourceLocationId, onClose, onSaved }) {
  const initialProduct = products.find((product) => product.id === initialProductId) ?? products[0];
  const initialSourceLocation = initialProduct?.locations.find((location) => location.id === initialSourceLocationId)
    ?? initialProduct?.locations[0];
  const [productSpecId, setProductSpecId] = useState(initialProduct?.id ?? "");
  const [sourceLocationId, setSourceLocationId] = useState(initialSourceLocation?.id ?? "");
  const [targetLocationId, setTargetLocationId] = useState(() => (
    initialProduct?.locations.find((location) => location.id !== initialSourceLocation?.id)?.id ?? ""
  ));
  const [cases, setCases] = useState("0");
  const [loose, setLoose] = useState("0");
  const [actualOccurredAt, setActualOccurredAt] = useState(localDateTimeNow);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const submissionRef = useRef(null);
  const selectedProduct = products.find((product) => product.id === productSpecId);
  const sourceLocation = selectedProduct?.locations.find((location) => location.id === sourceLocationId);
  const targetLocation = selectedProduct?.locations.find((location) => location.id === targetLocationId);

  function handleProductChange(event) {
    const nextProductId = event.target.value;
    const nextProduct = products.find((product) => product.id === nextProductId);
    const nextSourceId = nextProduct?.locations[0]?.id ?? "";
    const nextTargetId = nextProduct?.locations.find((location) => location.id !== nextSourceId)?.id ?? "";
    setProductSpecId(nextProductId);
    setSourceLocationId(nextSourceId);
    setTargetLocationId(nextTargetId);
    setError("");
  }

  function handleSourceChange(event) {
    const nextSourceId = event.target.value;
    setSourceLocationId(nextSourceId);
    if (nextSourceId === targetLocationId) {
      setTargetLocationId(selectedProduct?.locations.find((location) => location.id !== nextSourceId)?.id ?? "");
    }
    setError("");
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");

    const caseCount = Number(cases);
    const looseCount = Number(loose);
    if (!sourceLocationId || !targetLocationId || sourceLocationId === targetLocationId) {
      setError("请选择不同的来源货位和目标货位。");
      return;
    }
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
        sourceLocationId,
        targetLocationId,
        cases: caseCount,
        loose: looseCount,
        actualOccurredAt: new Date(actualOccurredAt).toISOString(),
        note,
      };
      const response = await fetch("/api/inventory/move", inventoryMutationOptions(
        submissionRef,
        "/api/inventory/move",
        payload,
      ));
      const result = await response.json();
      if (!response.ok) {
        setError(result.error || "移库未完成，请检查资料后重试。");
        return;
      }

      completeInventoryMutation(submissionRef);
      await onSaved();
    } catch {
      setError("移库未完成，当前输入已保留，请检查网络后重试。");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="inventory-query-move-backdrop">
      <section className="inventory-query-move-dialog" role="dialog" aria-modal="true" aria-labelledby="inventory-move-title">
        <div className="inventory-query-move-heading">
          <div>
            <p>库存业务</p>
            <h2 id="inventory-move-title">移动货位</h2>
          </div>
          <button className="inventory-query-move-close" type="button" aria-label="关闭" onClick={onClose} disabled={pending}>×</button>
        </div>
        <p className="inventory-query-move-description">从一个货位移至另一个货位，整件和散个分别记录，提交时按来源及目标货位库存校验。</p>
        <form className="inventory-query-move-form" onSubmit={handleSubmit}>
          <label>
            <span>产品规格</span>
            <select value={productSpecId} onChange={handleProductChange} required>
              {products.map((product) => (
                <option key={product.id} value={product.id}>{product.name} · {product.spec}</option>
              ))}
            </select>
          </label>
          <label>
            <span>来源货位</span>
            <select value={sourceLocationId} onChange={handleSourceChange} required>
              {selectedProduct?.locations.map((location) => (
                <option key={location.id} value={location.id}>{location.warehouse} / {location.spot}</option>
              ))}
            </select>
          </label>
          <label>
            <span>目标货位</span>
            <select value={targetLocationId} onChange={(event) => { setTargetLocationId(event.target.value); setError(""); }} required disabled={!selectedProduct || selectedProduct.locations.length < 2}>
              <option value="">请选择目标货位</option>
              {selectedProduct?.locations
                .filter((location) => location.id !== sourceLocationId)
                .map((location) => (
                  <option key={location.id} value={location.id}>{location.warehouse} / {location.spot}</option>
                ))}
            </select>
          </label>
          {selectedProduct && selectedProduct.locations.length < 2 ? (
            <p className="inventory-query-move-availability" role="status">该产品规格只有一个货位，请先在“产品与货位”中增加另一个货位。</p>
          ) : sourceLocation && targetLocation ? (
            <p className="inventory-query-move-availability">
              来源有 {sourceLocation.cases} 件、{sourceLocation.loose} 个；目标有 {targetLocation.cases} 件、{targetLocation.loose} 个。
            </p>
          ) : null}
          <div className="inventory-query-move-counts">
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
          {error && <p className="inventory-query-move-error" role="alert">{error}</p>}
          <div className="inventory-query-move-actions">
            <button className="button button-outline" type="button" onClick={onClose} disabled={pending}>取消</button>
            <button className="button button-dark" type="submit" disabled={pending || !products.length || !sourceLocationId || !targetLocationId}>
              {pending ? "正在保存…" : "确认移库"}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
