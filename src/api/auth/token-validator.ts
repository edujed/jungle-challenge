/**
 * TokenValidator — contrato para validação de tokens de autenticação.
 *
 * Ponto de extensão (README §2): a implementação concreta (Keycloak,
 * Zitadel, etc.) implementa esta interface. O guard injeta a validadora
 * via DI e delega a ela a verificação do token.
 *
 * Desenho:
 *   - `validate(token)` → `Identity` se válido, lança `AuthError` se inválido.
 *   - A validadora é responsável por:
 *     1. Verificar assinatura (JWKS para OIDC).
 *     2. Validar expiração (exp/iat).
 *     3. Validar issuer (iss) e audience (aud).
 *     4. Extrair subject (sub), name, scopes/roles.
 *   - Cache de JWKS é responsabilidade da validadora (não do guard).
 *
 * Por que uma interface e não uma classe concreta?
 *   - Testabilidade: mocks triviais nos testes de unidade.
 *   - Troca de IdP: Keycloak → Zitadel sem tocar no guard.
 *   - Zero-trust: a validação é explícita e auditável.
 */

import type { Identity } from "./identity.js";

/**
 * Erro de autenticação — lançado pela validadora quando o token é inválido.
 *
 * `status` indica o HTTP status que o guard deve responder:
 *   - 401: token ausente, malformado, expirado, assinatura inválida.
 *   - 403: token válido mas sem escopo/role suficiente (raro no guard;
 *          normalmente tratado em decorator @RequireScope).
 */
export class AuthError extends Error {
  constructor(
    message: string,
    public readonly status: 401 | 403 = 401,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

/**
 * Contrato de validação de tokens.
 *
 * Implementações:
 *   - `KeycloakTokenValidator` (OIDC via JWKS) — ver doc/auth-keycloak.md.
 *   - `NoopTokenValidator` (sempre retorna Identity sintético) — dev/test.
 *   - `ZitadelTokenValidator` (OIDC via JWKS) — futuro.
 */
export interface TokenValidator {
  /**
   * Valida um token Bearer e retorna a Identity correspondente.
   *
   * @param token — string do token (sem o prefixo "Bearer ").
   * @returns Identity do principal autenticado.
   * @throws AuthError se o token for inválido.
   */
  validate(token: string): Promise<Identity>;

  /**
   * Nome do issuer (ex.: "keycloak", "zitadel").
   * Usado para logging e métricas.
   */
  readonly issuer: string;
}
