/**
 * 轻量运行时指标（Prometheus 文本格式 + JSON 快照）。
 * 零依赖，模块级单例，与 logger.ts 同风格。Node 单线程下普通对象即线程安全。
 *
 * 用法：
 *   import { metrics } from "../metrics.ts";
 *   metrics.inc("llm.requests");
 *   metrics.observe("llm.latency_ms", ms);
 *
 * 暴露：GET /metrics → formatPrometheus()（Prometheus 文本格式，可直接被采集器抓取）
 */

/** 固定延迟桶（ms），用于近似分位数 */
const LATENCY_BUCKETS = [100, 250, 500, 1000, 2000, 5000, 10000, 30000, 60000];

interface Histogram {
	count: number;
	sum: number;
	max: number;
	/** buckets[i] = 落入 (buckets[i-1], buckets[i]] 的计数；buckets[0] 为 [0, 100] */
	buckets: number[];
}

class Metrics {
	private counters = new Map<string, number>();
	private histograms = new Map<string, Histogram>();
	private startedAt = Date.now();

	/** 计数器 +n（默认 +1）。首次出现自动初始化为 0 */
	inc(key: string, n = 1): void {
		this.counters.set(key, (this.counters.get(key) ?? 0) + n);
	}

	/** 延迟观测（毫秒）：计入直方图与计数器快照 */
	observe(key: string, ms: number): void {
		let h = this.histograms.get(key);
		if (!h) {
			h = { count: 0, sum: 0, max: 0, buckets: LATENCY_BUCKETS.map(() => 0) };
			this.histograms.set(key, h);
		}
		h.count++;
		h.sum += ms;
		if (ms > h.max) h.max = ms;
		for (let i = 0; i < LATENCY_BUCKETS.length; i++) {
			if (ms <= LATENCY_BUCKETS[i]!) {
				h.buckets[i]!++;
				break;
			}
		}
	}

	/** 直方图近似分位数（线性插值桶边界） */
	quantile(key: string, q: number): number | null {
		const h = this.histograms.get(key);
		if (!h || h.count === 0) return null;
		const target = q * h.count;
		let cum = 0;
		for (let i = 0; i < h.buckets.length; i++) {
			cum += h.buckets[i]!;
			if (cum >= target) return LATENCY_BUCKETS[i]!;
		}
		return h.max;
	}

	counterValue(key: string): number {
		return this.counters.get(key) ?? 0;
	}

	/** JSON 快照（/metrics 之外的自查、测试用） */
	snapshot(): {
		uptimeSeconds: number;
		startedAt: string;
		counters: Record<string, number>;
		latencyMs: Record<
			string,
			{
				count: number;
				sum: number;
				avg: number;
				max: number;
				p50: number | null;
				p95: number | null;
			}
		>;
	} {
		const counters: Record<string, number> = {};
		for (const [k, v] of this.counters) counters[k] = v;
		const latencyMs: Record<
			string,
			{
				count: number;
				sum: number;
				avg: number;
				max: number;
				p50: number | null;
				p95: number | null;
			}
		> = {};
		for (const [k, h] of this.histograms) {
			latencyMs[k] = {
				count: h.count,
				sum: Math.round(h.sum),
				avg: h.count ? Math.round(h.sum / h.count) : 0,
				max: Math.round(h.max),
				p50: this.quantile(k, 0.5),
				p95: this.quantile(k, 0.95),
			};
		}
		return {
			uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
			startedAt: new Date(this.startedAt).toISOString(),
			counters,
			latencyMs,
		};
	}

	/** Prometheus 文本格式（GET /metrics 输出） */
	formatPrometheus(): string {
		const { uptimeSeconds, counters, latencyMs } = this.snapshot();
		const lines: string[] = ["# wangdachui.pi runtime metrics"];
		lines.push(`wangdachui_uptime_seconds ${uptimeSeconds}`);
		for (const [k, v] of Object.entries(counters)) {
			lines.push(
				`wangdachui_${k.replaceAll(".", "_").replaceAll("-", "_")}_total ${v}`,
			);
		}
		for (const [k, h] of Object.entries(latencyMs)) {
			const name = `wangdachui_${k.replaceAll(".", "_").replaceAll("-", "_")}_milliseconds`;
			lines.push(`${name}_count ${h.count}`);
			lines.push(`${name}_sum ${h.sum}`);
			if (h.max > 0) lines.push(`${name}_max ${h.max}`);
			if (h.p50 !== null) lines.push(`${name}{quantile="0.5"} ${h.p50}`);
			if (h.p95 !== null) lines.push(`${name}{quantile="0.95"} ${h.p95}`);
		}
		return lines.join("\n") + "\n";
	}
}

export const metrics = new Metrics();
