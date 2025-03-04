# opentelemetry-instrumentation-hyper-express
An OpenTelemetry Instrumentation for HyperExpress, specifically built for forklaunch.

## What this does:
* Wraps apis in spans that give debugging information and tracks middleware execution as well.

## How can it be improved:
* Integrate with uwebsockets instrumentation to capture lower level telemetry as part of the instrumentation,
* Conform more to the style laid out in other instrumentation libraries,
* Tests.

## What makes it unique to forklaunch:
* Certain metadata is added in a first party way; this can be added via the `requestHook` pattern,
* Does not make use of `safeExecute` functions from OTLP libraries, due to how forklaunch handles errors.
