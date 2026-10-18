export function groupProductsByIdentity(products) {
  const groups = new Map();
  for (const product of products) {
    const identity = [product.name, product.spec, product.material, product.color]
      .map((value) => value ?? "");
    const id = JSON.stringify(identity);
    let group = groups.get(id);
    if (!group) {
      group = {
        id,
        name: identity[0],
        spec: identity[1],
        material: identity[2],
        color: identity[3],
        products: [],
      };
      groups.set(id, group);
    }
    group.products.push(product);
  }
  return [...groups.values()];
}
