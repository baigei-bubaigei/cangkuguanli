import assert from "node:assert/strict";
import { test } from "node:test";
import { groupProductsByIdentity } from "./identityGroups.js";

test("groups packages by product identity without combining their stock or locations", () => {
  const products = [
    {
      id: "pack-6",
      name: "壁灯",
      spec: "E27",
      material: "铝合金",
      color: "白色",
      perCase: 6,
      totalCases: 3,
      totalLoose: 2,
      locations: [{ id: "location-6", cases: 3, loose: 2 }],
    },
    {
      id: "pack-4",
      name: "壁灯",
      spec: "E27",
      material: "铝合金",
      color: "白色",
      perCase: 4,
      totalCases: 5,
      totalLoose: 1,
      locations: [{ id: "location-4", cases: 5, loose: 1 }],
    },
    {
      id: "other-material",
      name: "壁灯",
      spec: "E27",
      material: "塑料",
      color: "白色",
      perCase: 6,
      totalCases: 0,
      totalLoose: 0,
      locations: [],
    },
    {
      id: "other-color",
      name: "壁灯",
      spec: "E27",
      material: "铝合金",
      color: "黑色",
      perCase: 6,
      totalCases: 0,
      totalLoose: 0,
      locations: [],
    },
  ];

  const groups = groupProductsByIdentity(products);

  assert.equal(groups.length, 3);
  assert.deepEqual(groups.map(({ name, spec, material, color, products: packages }) => ({
    name,
    spec,
    material,
    color,
    packages: packages.map(({ id, perCase, totalCases, totalLoose, locations }) => ({
      id,
      perCase,
      totalCases,
      totalLoose,
      locations,
    })),
  })), [
    {
      name: "壁灯",
      spec: "E27",
      material: "铝合金",
      color: "白色",
      packages: [
        {
          id: "pack-6",
          perCase: 6,
          totalCases: 3,
          totalLoose: 2,
          locations: [{ id: "location-6", cases: 3, loose: 2 }],
        },
        {
          id: "pack-4",
          perCase: 4,
          totalCases: 5,
          totalLoose: 1,
          locations: [{ id: "location-4", cases: 5, loose: 1 }],
        },
      ],
    },
    {
      name: "壁灯",
      spec: "E27",
      material: "塑料",
      color: "白色",
      packages: [{ id: "other-material", perCase: 6, totalCases: 0, totalLoose: 0, locations: [] }],
    },
    {
      name: "壁灯",
      spec: "E27",
      material: "铝合金",
      color: "黑色",
      packages: [{ id: "other-color", perCase: 6, totalCases: 0, totalLoose: 0, locations: [] }],
    },
  ]);
});

test("treats empty identity fields as equal when grouping packages", () => {
  const groups = groupProductsByIdentity([
    { id: "empty", name: "", spec: "", material: "", color: "", perCase: 2, locations: [] },
    { id: "nullable", name: "", spec: "", material: null, color: null, perCase: 4, locations: [] },
  ]);

  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].products.map(({ id, perCase }) => ({ id, perCase })), [
    { id: "empty", perCase: 2 },
    { id: "nullable", perCase: 4 },
  ]);
});
