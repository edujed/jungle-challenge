/**
 * AppModule — raiz do NestJS.
 *
 * Registra:
 *   - Providers singletons: ENV, DATABASE, SQS_CLIENT (criados via useFactory).
 *   - Controllers: Health, Wallets, Transactions.
 *   - Workers (providers com hooks de ciclo de vida): SqsConsumer,
 *     PendingReferenceWorker, OutboxPublisher.
 *
 * Os workers usam OnModuleInit/OnModuleDestroy para start/stop, e o
 * graceful shutdown é tratado por app.enableShutdownHooks() no main.ts.
 */

import { Module, Global } from "@nestjs/common";
import { loadEnv } from "../config/env.js";
import { createDatabase } from "../infrastructure/database/db.js";
import { createSqsClient } from "../infrastructure/sqs/sqs-client.js";
import { SqsConsumer } from "../infrastructure/workers/sqs-consumer.js";
import { PendingReferenceWorker } from "../infrastructure/workers/pending-reference-worker.js";
import { OutboxPublisher } from "../infrastructure/outbox/outbox-publisher.js";
import { AppLogger } from "../observability/app-logger.js";
import { MetricsCollector } from "../observability/metrics.js";
import { HealthController } from "./controllers/health.controller.js";
import { WalletsController } from "./controllers/wallets.controller.js";
import { TransactionsController } from "./controllers/transactions.controller.js";
import { ENV, DATABASE, SQS_CLIENT } from "./tokens.js";
import { LoggingInterceptor } from "./interceptors/logging.interceptor.js";
import { InstanceIdInterceptor } from "./interceptors/instance-id.interceptor.js";
import { AuthGuard, TOKEN_VALIDATOR } from "./auth/auth.guard.js";
import { NoopTokenValidator } from "./auth/noop-token-validator.js";
import { KeycloakTokenValidator } from "./auth/keycloak-token-validator.js";

@Global()
@Module({
  providers: [
    {
      provide: ENV,
      useFactory: () => loadEnv(),
    },
    {
      provide: DATABASE,
      inject: [ENV],
      useFactory: async (env: ReturnType<typeof loadEnv>) =>
        createDatabase(env.databaseUrl),
    },
    {
      provide: SQS_CLIENT,
      inject: [ENV],
      useFactory: (env: ReturnType<typeof loadEnv>) =>
        createSqsClient(env.sqsEndpoint, env.awsRegion),
    },
    {
      provide: TOKEN_VALIDATOR,
      inject: [ENV],
      useFactory: (env: ReturnType<typeof loadEnv>) => {
        if (env.authEnabled) {
          return new KeycloakTokenValidator({
            issuer: env.keycloakIssuer,
            audience: env.keycloakAudience,
            jwksCacheTtlMs: env.keycloakJwksCacheTtlMs,
          });
        }
        return new NoopTokenValidator();
      },
    },
    AppLogger,
    MetricsCollector,
    LoggingInterceptor,
    InstanceIdInterceptor,
    SqsConsumer,
    PendingReferenceWorker,
    OutboxPublisher,
    AuthGuard,
  ],
  controllers: [HealthController, WalletsController, TransactionsController],
})
export class AppModule {}
