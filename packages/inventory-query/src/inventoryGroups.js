export function groupInventoryProducts(products) {
  const groups = new Map();
  for (const product of products) {
    const identity = [product.name, product.spec, product.material, product.color]
      .map((value) => value ?? "");
    const key = JSON.stringify(identity);
    let group = groups.get(key);
    if (!group) {
      group = {
        id: key,
        name: identity[0],
        spec: identity[1],
        material: identity[2],
        color: identity[3],
        products: [],
      };
      groups.set(key, group);
    }
    group.products.push(product);
  }
  return [...groups.values()];
}
