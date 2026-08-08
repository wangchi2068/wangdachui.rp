/** 结构化 JSON 行日志：{time, level, event, ...}，一行一个事件，便于 grep/采集 */
type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  time: string;
  level: LogLevel;
  event: string;
  [k: string]: unknown;
}

function emit(level: LogLevel, event: string, extra?: Record<string, unknown>): void {
  const entry: LogEntry = { time: new Date().toISOString(), level, event, ...(extra ?? {}) };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (event: string, extra?: Record<string, unknown>) => emit("debug", event, extra),
  info: (event: string, extra?: Record<string, unknown>) => emit("info", event, extra),
  warn: (event: string, extra?: Record<string, unknown>) => emit("warn", event, extra),
  error: (event: string, extra?: Record<string, unknown>) => emit("error", event, extra),
};
