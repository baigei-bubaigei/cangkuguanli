function identityPart(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function productOptionLabel(product) {
  return [
    `产品名：${identityPart(product.name, "未填写")}`,
    `规格：${identityPart(product.spec, "未填写")}`,
    `材质：${identityPart(product.material, "未填写")}`,
    `颜色：${identityPart(product.color, "未填写")}`,
    `每件 ${product.perCase} 个`,
  ].join(" · ");
}
