/**
 * Tokens de injeção de dependência (NestJS).
 *
 * Usados no AppModule para expor as dependências "manuais" (Database,
 * SqsClient, Env) como providers singletons, permitindo que controllers e
 * workers as injetem via @Inject().
 */

// Tokens de injeção — strings simples funcionam como tokens no NestJS.
// (No NestJS 12, InjectionToken é apenas um tipo, não um valor.)
export const DATABASE = "DATABASE" as const;
export const SQS_CLIENT = "SQS_CLIENT" as const;
export const ENV = "ENV" as const;
