/**
 * Interceptor: X-Instance-Id
 *
 * Adiciona o header X-Instance-Id a todas as respostas HTTP (ADR-011 —
 * observabilidade de distribuição de carga no load balancer).
 *
 * Substitui o `withInstanceId` do roteamento manual do main.ts antigo.
 */

import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Inject,
} from "@nestjs/common";
import { Observable } from "rxjs";
import { ENV } from "../tokens.js";

@Injectable()
export class InstanceIdInterceptor implements NestInterceptor {
  constructor(@Inject(ENV) private readonly env: { instanceId: string }) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const ctx = context.switchToHttp();
    const response = ctx.getResponse();

    // Express response: set() o header.
    if (typeof response.set === "function") {
      response.set("X-Instance-Id", this.env.instanceId);
    }

    return next.handle();
  }
}
