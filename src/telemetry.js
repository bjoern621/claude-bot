/**
 * OpenTelemetry wiring: metrics, traces and structured events over OTLP.
 *
 * The SDK starts only when OTEL_EXPORTER_OTLP_ENDPOINT is set. Without it the
 * OpenTelemetry API hands back no-op implementations, so every instrument call
 * elsewhere in the bot stays valid and costs nothing. That is why call sites
 * never test whether telemetry is on.
 *
 * Import this module first. Instruments must exist before anything records to
 * them, and ESM evaluates dependencies in import order.
 *
 * No auto-instrumentation. The obvious candidate, HTTP client spans, would be
 * dominated by the typing indicator the bot refreshes every eight seconds per
 * in-flight question, which says nothing and would outnumber every span that
 * does. The spans here are the ones with an answer in them.
 */

import { metrics, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME || "claude-bot";
const ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

let telemetrySdk;

if (ENDPOINT) {
  const { NodeSDK } = await import("@opentelemetry/sdk-node");
  const { PeriodicExportingMetricReader } = await import("@opentelemetry/sdk-metrics");
  const { BatchLogRecordProcessor } = await import("@opentelemetry/sdk-logs");
  const { resourceFromAttributes } = await import("@opentelemetry/resources");
  const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = await import(
    "@opentelemetry/semantic-conventions"
  );
  const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
  const { OTLPMetricExporter } = await import("@opentelemetry/exporter-metrics-otlp-http");
  const { OTLPLogExporter } = await import("@opentelemetry/exporter-logs-otlp-http");

  const sdk = new NodeSDK({
    // Built by hand rather than detected. The collector's remote-write exporter
    // runs with resource_to_telemetry_conversion enabled, which turns every
    // resource attribute into a metric label; the default process detector
    // contributes process.command_args, an unbounded string, and it would land
    // on every series this bot produces.
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: SERVICE_NAME,
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version || "unknown",
    }),
    resourceDetectors: [],
    instrumentations: [],
    traceExporter: new OTLPTraceExporter(),
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
        exportIntervalMillis: Number(process.env.OTEL_METRIC_EXPORT_INTERVAL || 15_000),
      }),
    ],
    logRecordProcessors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter() })],
  });

  sdk.start();
  telemetrySdk = sdk;
  console.log(`Telemetry exporting to ${ENDPOINT} as ${SERVICE_NAME}.`);
}

export const tracer = trace.getTracer(SERVICE_NAME);
export const logger = logs.getLogger(SERVICE_NAME);

const meter = metrics.getMeter(SERVICE_NAME);

/**
 * Units in braces are annotations rather than real units, and the OTLP to
 * Prometheus translation leaves them out of the metric name. Only the durations
 * carry a unit that becomes a suffix, which is how `_seconds` gets there.
 */
export const instruments = {
  questions: meter.createCounter("claude_bot.questions", {
    description: "Questions the bot was asked, by what it decided to do with them.",
    unit: "{question}",
  }),
  duration: meter.createHistogram("claude_bot.question.duration", {
    description: "Wall-clock time from admitted question to posted answer.",
    unit: "s",
    // The default boundaries are milliseconds-shaped and would put every
    // question in the top bucket.
    advice: { explicitBucketBoundaries: [0.5, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 120] },
  }),
  toolCalls: meter.createCounter("claude_bot.tool.calls", {
    description: "Discord tool invocations by the model.",
    unit: "{call}",
  }),
  toolDuration: meter.createHistogram("claude_bot.tool.duration", {
    description: "Time spent inside one Discord tool call.",
    unit: "s",
    advice: { explicitBucketBoundaries: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10] },
  }),
  turns: meter.createHistogram("claude_bot.claude.turns", {
    description: "Model turns spent on one question.",
    unit: "{turn}",
    advice: { explicitBucketBoundaries: [1, 2, 3, 4, 5, 6, 8, 10] },
  }),
  cost: meter.createCounter("claude_bot.claude.cost_usd", {
    description: "Cost the Agent SDK reported for a question. Zero on subscription auth.",
    unit: "{usd}",
  }),
  claudeTokens: meter.createCounter("claude_bot.claude.tokens", {
    description: "Model tokens billed, by kind.",
    unit: "{token}",
  }),
};

/** Observable gauges, whose current value is read at export time. */
export function observe(name, description, callback) {
  const gauge = meter.createObservableGauge(name, { description, unit: "{item}" });
  gauge.addCallback((result) => callback(result));
  return gauge;
}

/**
 * Emit one structured event.
 *
 * Attributes reach VictoriaLogs as queryable fields, so this is where anything
 * too high-cardinality for a metric label belongs: user IDs, the exact refusal,
 * how long it has left to run.
 *
 * `app` is stamped on every event so a LogsQL query selects the bot's own events
 * by a field this module controls, rather than by whichever name the ingest path
 * happens to give the service resource attribute.
 *
 * Attribute keys are underscored throughout, not dotted. Metric attributes reach
 * Prometheus with dots rewritten to underscores anyway, and matching the two
 * means one name works in both PromQL and LogsQL.
 */
export function event(body, attributes = {}, severityText = "INFO") {
  logger.emit({
    body,
    severityText,
    severityNumber: severityText === "ERROR" ? 17 : severityText === "WARN" ? 13 : 9,
    attributes: { app: SERVICE_NAME, ...attributes },
  });
}

/** Flush queued spans, metrics and events. Called from the signal handlers. */
export async function shutdownTelemetry() {
  if (telemetrySdk) await telemetrySdk.shutdown().catch(() => {});
}
