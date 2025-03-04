import {
  MiddlewareHandler,
  MiddlewareNext,
  Request,
  Response,
  Router,
  UsableSpreadableArguments,
} from "@forklaunch/hyper-express-fork";
import {
  Attributes,
  context,
  Span,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import {
  InstrumentationBase,
  InstrumentationNodeModuleDefinition,
} from "@opentelemetry/instrumentation";
import {
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
  ATTR_SERVICE_NAME,
  SEMATTRS_HTTP_FLAVOR,
  SEMATTRS_HTTP_HOST,
  SEMATTRS_HTTP_METHOD,
  SEMATTRS_HTTP_REQUEST_CONTENT_LENGTH,
  SEMATTRS_HTTP_ROUTE,
  SEMATTRS_HTTP_TARGET,
  SEMATTRS_HTTP_URL,
  SEMATTRS_HTTP_USER_AGENT,
} from "@opentelemetry/semantic-conventions";

export class HyperExpressInstrumentation extends InstrumentationBase {
  private readonly HTTP_METHODS = [
    "get",
    "post",
    "put",
    "delete",
    "patch",
    "head",
    "options",
  ];

  constructor(config = {}) {
    super("opentelemetry-instrumentation-hyperexpress", "0.0.1", config);
  }

  protected init() {
    return [
      new InstrumentationNodeModuleDefinition(
        "@forklaunch/hyper-express-fork",
        ["*"],
        (moduleExports) => {
          this._wrap(
            moduleExports.Router.prototype,
            "use",
            this._patchUse.bind(this)
          );

          for (const method of this.HTTP_METHODS) {
            this._wrap(
              moduleExports.Router.prototype,
              method,
              this._patchRoute.bind(this)
            );
          }

          return moduleExports;
        },
        (moduleExports) => {
          if (moduleExports === undefined) return;
          this._unwrap(moduleExports.Router.prototype, "use");

          for (const method of this.HTTP_METHODS) {
            this._unwrap(moduleExports.Router.prototype, method);
          }
        }
      ),
    ];
  }

  private _createTopLevelSpan(
    req: Request & {
      span?: Span;
      originalPath?: string;
      contractDetails?: {
        name: string;
      };
      context?: {
        correlationId: string;
      };
    },
    res: Response
  ) {
    if (!req.span) {
      req.span = this.tracer.startSpan(`${req.method} ${req.path}`, {
        root: true,
        attributes: {
          [ATTR_SERVICE_NAME]:
            process.env.OTEL_SERVICE_NAME ??
            process.env.SERVICE_NAME ??
            "unknown",
          [SEMATTRS_HTTP_FLAVOR]: "1.1",
          [SEMATTRS_HTTP_HOST]: req.headers.host,
          [SEMATTRS_HTTP_METHOD]: req.method,
          [SEMATTRS_HTTP_REQUEST_CONTENT_LENGTH]: req.headers["content-length"],
          [SEMATTRS_HTTP_URL]: `${req.protocol}://${req.headers.host}${req.url}`,
          [SEMATTRS_HTTP_TARGET]: req.path,
          [SEMATTRS_HTTP_USER_AGENT]: req.headers["user-agent"],
        },
      });

      res.on("finish", () => {
        if (req.span) {
          req.span.setAttributes({
            [ATTR_HTTP_ROUTE]: req.originalPath,
            [ATTR_HTTP_RESPONSE_STATUS_CODE]: res.statusCode,
            "http.status_text": res.statusMessage,
            "error.message": res.locals.errorMessage || "Unknown error",
          });
          if (res.statusCode && res.statusCode >= 400) {
            req.span.setStatus({
              code: SpanStatusCode.ERROR,
              message: `HTTP ${res.statusCode} error occurred`,
            });
            req.span.addEvent("error", {
              [ATTR_HTTP_ROUTE]: req.originalPath,
              [ATTR_HTTP_RESPONSE_STATUS_CODE]: res.statusCode,
              "http.status_text": res.statusMessage,
              "error.message": res.locals.errorMessage || "Unknown error",
            });
          }
          req.span.end();
        }
      });
    }
  }

  private _wrapMiddleware(middleware: MiddlewareHandler) {
    return (
      req: Request & { span?: Span },
      res: Response,
      next: MiddlewareNext
    ) => {
      this._createTopLevelSpan(req, res);
      return context.with(trace.setSpan(context.active(), req.span!), () => {
        const span = this.tracer.startSpan(
          `middleware - ${middleware.name || "<anonymous>"}`
        );
        const attributes: Attributes = {
          [SEMATTRS_HTTP_METHOD]: req.method,
          [SEMATTRS_HTTP_URL]: `${req.protocol}://${req.headers.host}${req.url}`,
          [SEMATTRS_HTTP_TARGET]: req.path,
        };
        span.setAttributes(attributes);

        return context.with(trace.setSpan(context.active(), span), () => {
          const result = middleware(req, res, (err?: Error) => {
            if (err) {
              span.recordException(err);
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: err.message,
              });
              span.addEvent("error", {
                "error.message": err.message,
                "error.stack": err.stack,
              });
            }
            span.end();
            next(err);
          });

          span.end();
          return result;
        });
      });
    };
  }

  private _wrapHandler(path: string, handler: MiddlewareHandler) {
    return (
      req: Request & {
        span?: Span;
        contractDetails?: { name: string };
        context?: { correlationId: string };
      },
      res: Response,
      next: MiddlewareNext
    ) => {
      this._createTopLevelSpan(req, res);
      return context.with(trace.setSpan(context.active(), req.span!), () => {
        req.span?.setAttributes({
          "api.name": req.contractDetails?.name ?? "undefined",
          "correlation.id": req.context?.correlationId,
        });
        const span = this.tracer.startSpan(`request handler - ${path}`);
        const attributes: Attributes = {
          "api.name": req.contractDetails?.name ?? "undefined",
          "correlation.id": req.context?.correlationId,
          [SEMATTRS_HTTP_METHOD]: req.method,
          [SEMATTRS_HTTP_URL]: `${req.protocol}://${req.headers.host}${req.url}`,
          [SEMATTRS_HTTP_TARGET]: req.path,
          [SEMATTRS_HTTP_ROUTE]: path,
        };
        span.setAttributes(attributes);

        return context.with(trace.setSpan(context.active(), span), () => {
          try {
            const result = handler(req, res, next);
            if (result instanceof Promise) {
              return result.finally(() => {
                span.end();
              });
            }
            span.end();
            return result;
          } catch (error: any) {
            span.recordException(error);
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: error.message,
            });
            span.addEvent("error", {
              "error.message": error.message,
              "error.stack": error.stack,
            });
            span.end();
            throw error;
          }
        });
      });
    };
  }

  private _patchUse(original: Function) {
    const instrumentation = this;
    return function (this: Router, ...args: UsableSpreadableArguments): Router {
      return original.apply(
        this,
        args.map((maybeMiddleware) => {
          switch (typeof maybeMiddleware) {
            case "function": {
              if (Array.isArray(maybeMiddleware)) {
                if (maybeMiddleware.length === 0) {
                  return maybeMiddleware;
                } else {
                  return maybeMiddleware.map((innerMiddleware) =>
                    instrumentation._wrapMiddleware(innerMiddleware)
                  );
                }
              }
              return instrumentation._wrapMiddleware(maybeMiddleware);
            }
            case "object": {
              if (maybeMiddleware.constructor.name === "Router") {
                return maybeMiddleware;
              } else if (
                "middleware" in maybeMiddleware &&
                typeof (maybeMiddleware as { middleware: MiddlewareHandler })
                  .middleware === "function"
              ) {
                return instrumentation._wrapMiddleware(
                  (maybeMiddleware as { middleware: MiddlewareHandler })
                    .middleware
                );
              }
              return maybeMiddleware;
            }
            default:
              return maybeMiddleware;
          }
        })
      );
    };
  }

  private _patchRoute(original: Function) {
    const instrumentation = this;
    return function (
      this: Router,
      path: string,
      ...args: UsableSpreadableArguments
    ) {
      const handler = args.pop();
      return original.apply(this, [
        path,
        ...args.map((arg) => {
          switch (typeof arg) {
            case "function":
              if (Array.isArray(arg)) {
                return arg.map((innerMiddleware) =>
                  instrumentation._wrapMiddleware(innerMiddleware)
                );
              }
              return instrumentation._wrapMiddleware(arg);
            default:
              return arg;
          }
        }),
        Array.isArray(handler)
          ? [
              ...handler
                .slice(0, -1)
                .map((innerHandler) =>
                  instrumentation._wrapMiddleware(innerHandler)
                ),
              instrumentation._wrapHandler(path, handler[handler.length - 1]),
            ]
          : typeof handler === "function"
          ? instrumentation._wrapHandler(path, handler)
          : handler,
      ]);
    };
  }
}
