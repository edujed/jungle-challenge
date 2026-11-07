/**
 * AppLogger — provider NestJS para o logger estruturado (seção 12 do README).
 *
 * Singleton do módulo: injeta ENV (instanceId) e expõe `child(component)`
 * para cada classe criar seu logger com o nome do componente.
 *
 * Uso:
 *   constructor(private readonly logger: AppLogger) {}
 *   private readonly log = this.logger.child("sqs-consumer");
 *   this.log.info("message processed", { messageId, status });
 *
 * O `createLogger` de `logger.ts` continua exportado para uso fora do DI
 * (ex.: bootstrap no main.ts, antes do NestFactory.create).
 */

import { Injectable, Inject } from "@nestjs/common";
import { ENV } from "../api/tokens.js";
import type { Env } from "../config/env.js";
import { createLogger, type Logger } from "./logger.js";

@Injectable()
export class AppLogger {
  private readonly root: Logger;

  constructor(@Inject(ENV) private readonly env: Env) {
    this.root = createLogger("app", env.instanceId);
  }

  /** Cria um logger filho com o nome do componente. */
  child(component: string): Logger {
    return createLogger(component, this.env.instanceId);
  }

  /** Logger raiz (componente "app") — para logs de nível geral. */
  get rootLogger(): Logger {
    return this.root;
  }
}
