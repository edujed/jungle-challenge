/**
 * NoopTokenValidator — validadora no-op para desenvolvimento/testes.
 *
 * Sempre retorna uma Identity sintética. Usada quando a autenticação
 * está desabilitada (default em dev/test).
 *
 * README §2: "Se você optar por não implementar, isso é aceito: ...
 * deixe o ponto de extensão explícito no código (por exemplo um AuthGuard
 * no-op ou um ProviderIdentityPort)."
 *
 * Esta validadora é o "no-op" — o guard injeta esta validadora quando
 * `AUTH_ENABLED=false` (default). Para ativar auth real, setar
 * `AUTH_ENABLED=true` e configurar `KEYCLOAK_ISSUER`/`KEYCLOAK_AUDIENCE`.
 */

import type { Identity } from "./identity.js";
import type { TokenValidator } from "./token-validator.js";

export class NoopTokenValidator implements TokenValidator {
  readonly issuer = "noop";

  async validate(_token: string): Promise<Identity> {
    // No-op: retorna uma Identity sintética.
    // Em produção com AUTH_ENABLED=true, esta validadora não é usada.
    return {
      subject: "anonymous",
      name: "anonymous",
      scopes: [],
      issuer: this.issuer,
      expiresAt: Date.now() + 3600_000, // 1h (irrelevante para no-op)
    };
  }
}
