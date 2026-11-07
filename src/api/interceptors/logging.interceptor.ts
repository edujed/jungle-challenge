/**
 * Interceptor: Logging estruturado + latência (seção 12 do README).
 *
 * Para cada requisição HTTP:
 *   - Gera/propaga o correlationId (header X-Correlation-Id).
 *   - Loga a requisição em JSON com method, path, status, latência.
 *   - Registra a latência no coletor de métricas (canal "http").
 *
 * O correlationId é extraído do header X-Correlation-Id (se presente) ou
 * gerado (UUID). É propagado na resposta para o cliente poder correlacionar.
 */

import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from "@nestjs/common";
import { Observable } from "rxjs";
import { tap } from "rxjs/operators";
import { randomUUID } from "node:crypto";
import { AppLogger } from "../../observability/app-logger.js";
import type { Logger } from "../../observability/logger.js";
import { MetricsCollector } from "../../observability/metrics.js";

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly log: Logger;

  constructor(
    private readonly appLogger: AppLogger,
    private readonly metrics: MetricsCollector,
  ) {
    this.log = this.appLogger.child("http");
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const ctx = context.switchToHttp();
    const request = ctx.getRequest();
    const response = ctx.getResponse();

    const method: string = request.method;
    const path: string = request.url ?? request.originalUrl ?? "";

    // CorrelationId: do header ou gerado.
    const correlationId: string =
      request.headers?.["x-correlation-id"] ?? randomUUID();

    // Propaga na resposta.
    if (typeof response.set === "function") {
      response.set("X-Correlation-Id", correlationId);
    }

    const start = Date.now();

    return next.handle().pipe(
      tap({
        next: () => {
          const latencyMs = Date.now() - start;
          const status: number = response.statusCode ?? 200;
          this.metrics.recordLatency("http", latencyMs);
          this.log.info("request", {
            correlationId,
            method,
            path,
            status,
            latencyMs,
          });
        },
        error: (err: unknown) => {
          const latencyMs = Date.now() - start;
          const status: number = response.statusCode ?? 500;
          this.metrics.recordLatency("http", latencyMs);
          const message = err instanceof Error ? err.message : String(err);
          this.log.error("request failed", {
            correlationId,
            method,
            path,
            status,
            latencyMs,
            error: message,
          });
        },
      }),
    );
  }
}
