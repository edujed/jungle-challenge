/**
 * Configuração de ambiente — lida uma única vez no boot.
 *
 * Variáveis:
 *   PORT              — porta HTTP (default 3000)
 *   DATABASE_URL      — string de conexão PostgreSQL
 *   SQS_ENDPOINT      — endpoint LocalStack/MiniStack
 *   SQS_QUEUE_URL     — URL da fila principal
 *   SQS_DLQ_URL       — URL da DLQ
 *   SQS_CONSUMER_NAME — nome do consumer (para dedup de inbox)
 *   AWS_REGION        — região AWS (default us-east-1)
 *   INSTANCE_ID       — ID único da instância (para logs)
 *   AUTH_ENABLED      — "true"/"false" (default: "false") — habilita autenticação
 *   KEYCLOAK_ISSUER   — URL do issuer Keycloak (ex.: http://localhost:8081/realms/jungle)
 *   KEYCLOAK_AUDIENCE — audience esperada (ex.: "jungle-api")
 *   KEYCLOAK_JWKS_CACHE_TTL_MS — TTL do cache JWKS (default: 600000)
 */

export interface Env {
  port: number;
  databaseUrl: string;
  sqsEndpoint: string;
  sqsQueueUrl: string;
  sqsDlqUrl: string;
  sqsConsumerName: string;
  awsRegion: string;
  instanceId: string;
  authEnabled: boolean;
  keycloakIssuer: string;
  keycloakAudience: string;
  keycloakJwksCacheTtlMs: number;
}

export function loadEnv(): Env {
  const port = parseInt(process.env.PORT ?? "3000", 10);
  const databaseUrl = process.env.DATABASE_URL ?? "postgresql://wagering:wagering@localhost:5432/wagering";
  const sqsEndpoint = process.env.SQS_ENDPOINT ?? "http://localhost:4566";
  const sqsQueueUrl = process.env.SQS_QUEUE_URL ?? "";
  const sqsDlqUrl = process.env.SQS_DLQ_URL ?? "";
  const sqsConsumerName = process.env.SQS_CONSUMER_NAME ?? `backend-${process.pid}`;
  const awsRegion = process.env.AWS_REGION ?? "us-east-1";
  const instanceId = process.env.INSTANCE_ID ?? `inst-${process.pid}`;
  const authEnabled = process.env.AUTH_ENABLED === "true";
  const keycloakIssuer = process.env.KEYCLOAK_ISSUER ?? "";
  const keycloakAudience = process.env.KEYCLOAK_AUDIENCE ?? "";
  const keycloakJwksCacheTtlMs = parseInt(
    process.env.KEYCLOAK_JWKS_CACHE_TTL_MS ?? "600000",
    10,
  );

  return {
    port,
    databaseUrl,
    sqsEndpoint,
    sqsQueueUrl,
    sqsDlqUrl,
    sqsConsumerName,
    awsRegion,
    instanceId,
    authEnabled,
    keycloakIssuer,
    keycloakAudience,
    keycloakJwksCacheTtlMs,
  };
}
