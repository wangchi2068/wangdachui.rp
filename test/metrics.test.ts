import { test } from "node:test";
import assert from "node:assert/strict";
import { metrics } from "../src/metrics.ts";

test("metrics：计数器累加与快照", () => {
	metrics.inc("test.counter");
	metrics.inc("test.counter", 3);
	assert.equal(metrics.counterValue("test.counter"), 4);
	const snap = metrics.snapshot();
	assert.equal(snap.counters["test.counter"], 4);
});

test("metrics：延迟观测与分位数", () => {
	for (const ms of [50, 120, 300, 900, 2500, 12000]) {
		metrics.observe("test.latency_ms", ms);
	}
	const snap = metrics.snapshot();
	const h = snap.latencyMs["test.latency_ms"];
	assert.ok(h);
	assert.equal(h.count, 6);
	assert.equal(h.max, 12000);
	// p50/p95 应落在对应桶边界附近
	assert.ok(h.p50 !== null && h.p50 >= 250 && h.p50 <= 1000);
	assert.ok(h.p95 !== null && h.p95 >= 5000 && h.p95 <= 30000);
});

test("metrics：Prometheus 文本格式", () => {
	metrics.inc("test.prom");
	const text = metrics.formatPrometheus();
	assert.match(text, /^# wangdachui\.pi runtime metrics/m);
	assert.match(text, /wangdachui_test_prom_total 1/);
	assert.match(text, /wangdachui_uptime_seconds \d+/);
});

test("metrics：空直方图分位数为 null", () => {
	assert.equal(metrics.quantile("nonexistent.latency_ms", 0.5), null);
});
