// Run: node --test "tests/js/*.test.mjs"
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  robustPoint, placementProblem, selfIntersects, edgeLengths, horizontalDistance, levelProblem,
  floorFromRay, refineFloor,
} from "../../frontend/js/ar-geometry.js";

const sample = (t, x, z, kind = "plane", y = 0) => ({ t, p: { x, y, z }, kind });

test("robustPoint ignores a stray frame and the press jolt", () => {
  const s = [];
  for (let t = 1000; t <= 1500; t += 50) s.push(sample(t, 2, 3));
  s.push(sample(1250, 2.5, 3.4));         // one-frame jump
  s.sort((a, b) => a.t - b.t);
  s.push(sample(1580, 2.2, 3.1));         // finger hits the screen
  const est = robustPoint(s, 1600);
  assert.ok(Math.abs(est.p.x - 2) < 1e-9 && Math.abs(est.p.z - 3) < 1e-9);
  assert.ok(est.spread < 0.01);
});

test("robustPoint does not mix plane and feature-point hits", () => {
  const s = [sample(1000, 0, 0, "point"), sample(1100, 0, 0, "point"),
    sample(1200, 1, 1), sample(1300, 1, 1), sample(1400, 1, 1)];
  const est = robustPoint(s, 1600);
  assert.equal(est.kind, "plane");
  assert.equal(est.n, 3);
  assert.equal(est.p.x, 1);
});

test("robustPoint needs a few samples", () => {
  assert.equal(robustPoint([sample(1000, 0, 0)], 1200), null);
  assert.equal(robustPoint([], 1200), null);
});

test("a moving aim is reported as shaky", () => {
  const s = [];
  for (let i = 0; i <= 10; i++) s.push(sample(1000 + i * 50, i * 0.03, 0));  // sweeping 30 cm
  const pr = placementProblem(robustPoint(s, 1600), { x: 0, y: 1.4, z: 0 });
  assert.equal(pr.code, "shaky");
});

test("far corners are refused, near ones accepted", () => {
  const s = [];
  for (let t = 1000; t <= 1500; t += 50) s.push(sample(t, 6, 0));
  const est = robustPoint(s, 1600);
  assert.equal(placementProblem(est, { x: 0, y: 1.4, z: 0 }).code, "far");
  assert.equal(placementProblem(est, { x: 3, y: 1.4, z: 0 }), null);
  assert.equal(placementProblem(est, null), null);  // camera unknown: no range check
});

test("selfIntersects detects corners tapped out of order", () => {
  assert.equal(selfIntersects([[0, 0], [4, 0], [4, 3], [0, 3]]), false);
  assert.equal(selfIntersects([[0, 0], [4, 3], [4, 0], [0, 3]]), true);   // bow tie
  assert.equal(selfIntersects([[0, 0], [4, 0], [2, 3]]), false);
  assert.equal(selfIntersects([[0, 0], [6, 0], [6, 4], [3, 4], [3, 2], [0, 2]]), false);  // L-shape
});

test("edgeLengths and horizontalDistance", () => {
  assert.deepEqual(edgeLengths([[0, 0], [3, 0], [3, 4]]), [3, 4, 5]);
  assert.equal(horizontalDistance({ x: 0, y: 5, z: 0 }, { x: 3, y: 0, z: 4 }), 5);
});

test("levelProblem separates drift from off-floor hits", () => {
  assert.equal(levelProblem(0.03), null);          // terrace slope / noise
  assert.equal(levelProblem(0.15), "drift");       // seen in a phone log while walking 2 m
  assert.equal(levelProblem(-0.12), "drift");
  assert.equal(levelProblem(0.6), "offfloor");     // parapet top or tank
});

test("floorFromRay reaches far corners on the locked floor", () => {
  const cam = { x: 0, y: 1.4, z: 0 };
  const aim = (x, z) => { const d = Math.hypot(x, -1.4, z); return { x: x / d, y: -1.4 / d, z: z / d }; };
  const p = floorFromRay(cam, aim(4.5, 0), 0);
  assert.ok(Math.abs(p.x - 4.5) < 1e-9 && Math.abs(p.z) < 1e-9 && p.y === 0);
  assert.equal(floorFromRay(cam, { x: 1, y: 0, z: 0 }, 0), null);      // looking at the horizon
  assert.equal(floorFromRay(cam, { x: 0, y: 1, z: 0 }, 0), null);      // looking up
  assert.equal(floorFromRay(cam, aim(40, 0), 0), null);                // absurdly far
});

test("refineFloor follows small drift and ignores false planes", () => {
  assert.ok(Math.abs(refineFloor(0, 0.04) - 0.002) < 1e-12);
  assert.equal(refineFloor(0, -0.55), 0);   // false plane 55 cm below, seen in a phone log
  assert.equal(refineFloor(0, 0.29), 0);
});

test("orderAroundCentre untangles corners tapped out of order", async () => {
  const { orderAroundCentre } = await import("../../frontend/js/ar-geometry.js");
  const tank = [[0, 0], [0.8, 0.8], [0.8, 0], [0, 0.8]];  // bow tie: diagonal taps on a 0.8 m tank
  assert.equal(selfIntersects(tank), true);
  const fixed = orderAroundCentre(tank).map((i) => tank[i]);
  assert.equal(selfIntersects(fixed), false);
  const area = Math.abs(fixed.reduce((a, [x1, z1], i) => { const [x2, z2] = fixed[(i + 1) % 4]; return a + x1 * z2 - x2 * z1; }, 0)) / 2;
  assert.ok(Math.abs(area - 0.64) < 1e-9);
  const round = [0, 3, 1, 5, 2, 4].map((k) => [Math.cos(k), Math.sin(k)]);  // 6 taps around a round tank, jumbled
  assert.equal(selfIntersects(orderAroundCentre(round).map((i) => round[i])), false);
});
