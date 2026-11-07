/**
 * Logger estruturado (JSON) — seção 12 do README.
 *
 * Emite logs em JSON com os campos obrigatórios:
 *   correlationId, messageId, transactionId, walletId, providerId
 *
 * Regras:
 *   - Sem dados sensíveis ou payloads financeiros completos.
 *   - `instanceId` e `timestamp` em todo log.
 *   - Níveis: debug, info, warn, error.
 *
 * Uso:
 *   const log = createLogger("sqs-consumer", env.instanceId);
 *   log.info("message processed", { messageId, transactionId, status });
 *   log.error("poll error", { error: err.message });
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  /** ID de correlação (ex.: externalTransactionId). */
  correlationId?: string;
  /** ID da mensagem SQS. */
  messageId?: string;
  /** ID da transação. */
  transactionId?: string;
  /** ID da wallet. */
  walletId?: string;
  /** ID do provedor. */
  providerId?: string;
  /** Campos extras (sem dados sensíveis). */
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export function createLogger(
  component: string,
  instanceId: string,
  minLevel: LogLevel = "info",
): Logger {
  function emit(level: LogLevel, message: string, context?: LogContext): void {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[minLevel]) return;

    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      component,
      instanceId,
      message,
    };

    if (context) {
      for (const [key, value] of Object.entries(context)) {
        if (value !== undefined) entry[key] = value;
      }
    }

    const line = JSON.stringify(entry);
    if (level === "error") {
      console.error(line);
    } else if (level === "warn") {
      console.warn(line);
    } else {
      console.log(line);
    }
  }

  return {
    debug: (message, context) => emit("debug", message, context),
    info: (message, context) => emit("info", message, context),
    warn: (message, context) => emit("warn", message, context),
    error: (message, context) => emit("error", message, context),
  };
}
