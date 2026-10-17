import assert from "node:assert/strict";
import test from "node:test";
import { productOptionLabel } from "./productOptionLabel.js";

test("product selectors distinguish complete identity and package quantity", () => {
  assert.equal(productOptionLabel({
    name: "壁灯",
    spec: "E27",
    material: "铝合金",
    color: "白色",
    perCase: 6,
  }), "产品名：壁灯 · 规格：E27 · 材质：铝合金 · 颜色：白色 · 每件 6 个");
});

test("product selectors label nullable identity fields explicitly", () => {
  assert.equal(productOptionLabel({
    name: null,
    spec: "",
    material: undefined,
    color: "白色",
    perCase: 4,
  }), "产品名：未填写 · 规格：未填写 · 材质：未填写 · 颜色：白色 · 每件 4 个");
});
