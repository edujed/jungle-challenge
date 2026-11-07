/**
 * Entry point — Jungle Gaming Backend (NestJS)
 *
 * Monta:
 *   1. AppModule (providers: ENV, DATABASE, SQS_CLIENT; controllers; workers)
 *   2. Interceptor global: X-Instance-Id
 *   3. HTTP Server (NestFactory.create + app.listen)
 *   4. Workers via lifecycle hooks (OnModuleInit/OnModuleDestroy)
 *   5. Graceful shutdown (enableShutdownHooks)
 *
 * Escala horizontal: 1 processo por container. Múltiplos containers =
 * múltiplas instâncias independentes (ADR-011).
 */

import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./api/app.module.js";
import { InstanceIdInterceptor } from "./api/interceptors/instance-id.interceptor.js";
import { LoggingInterceptor } from "./api/interceptors/logging.interceptor.js";
import { AuthGuard } from "./api/auth/auth.guard.js";
import { loadEnv } from "./config/env.js";
import { createLogger } from "./observability/logger.js";

async function main(): Promise<void> {
  const env = loadEnv();
  const log = createLogger("main", env.instanceId);
  log.info("starting", { instanceId: env.instanceId });

  const app = await NestFactory.create(AppModule, { logger: false });

  // Guard global: AuthGuard (ponto de extensão para auth — §2)
  // Injeta TOKEN_VALIDATOR via DI (NoopTokenValidator ou KeycloakTokenValidator).
  app.useGlobalGuards(app.get(AuthGuard));

  // Interceptors globais (injetados pelo DI — ordem: logging primeiro, depois instance-id)
  app.useGlobalInterceptors(
    app.get(LoggingInterceptor),
    app.get(InstanceIdInterceptor),
  );

  // Graceful shutdown: SIGTERM/SIGINT → OnModuleDestroy nos workers + app.close()
  app.enableShutdownHooks();

  await app.listen(env.port);
  log.info("http server listening", { port: env.port });
}

main().catch((error) => {
  console.error("[main] Fatal error:", error);
  process.exit(1);
});
