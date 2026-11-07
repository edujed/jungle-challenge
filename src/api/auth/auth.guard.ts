/**
 * AuthGuard — ponto de extensão para autenticação (README §2).
 *
 * Substitui o antigo `NoopAuthGuard`. Agora o guard é genérico:
 *   - Injeta um `TokenValidator` via DI.
 *   - Se `AUTH_ENABLED=false` (default), injeta `NoopTokenValidator`.
 *   - Se `AUTH_ENABLED=true`, injeta `KeycloakTokenValidator`.
 *
 * Fluxo:
 *   1. Extrair o token Bearer da request (`Authorization: Bearer <token>`).
 *   2. Se não houver token:
 *      - Se a rota é "aberta" (health checks), permitir sem auth.
 *      - Senão, lançar 401.
 *   3. Se houver token, delegar a validação ao `TokenValidator`.
 *   4. Se válido, colocar a `Identity` em `request.user`.
 *   5. Se inválido, lançar 401 (o NestJS converte para HTTP response).
 *
 * Rotas abertas (sem auth):
 *   - `GET /health/live`
 *   - `GET /health/ready`
 *
 * README §2: "os endpoints de health ficam abertos, e mensagens vindas da
 * fila são tratadas como canal interno confiável".
 *
 * Como plugar um IdP real:
 *   1. Setar `AUTH_ENABLED=true` no env.
 *   2. Configurar `KEYCLOAK_ISSUER` e `KEYCLOAK_AUDIENCE`.
 *   3. O `AuthModule` injeta `KeycloakTokenValidator` automaticamente.
 *   4. Os controllers podem usar `@Req() req => req.user` para acessar a Identity.
 *
 * Ver `doc/auth-keycloak.md` para o desenho completo da integração.
 */

import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Inject,
} from "@nestjs/common";
import { Request } from "express";
import type { TokenValidator } from "./token-validator.js";
import type { Identity } from "./identity.js";

/**
 * Token de injeção para o TokenValidator.
 * O AuthModule decide qual implementação injetar (Noop ou Keycloak).
 */
export const TOKEN_VALIDATOR = "TOKEN_VALIDATOR" as const;

/**
 * Rotas que ficam abertas (sem autenticação).
 * README §2: "os endpoints de health ficam abertos".
 */
const OPEN_ROUTES: ReadonlySet<string> = new Set([
  "GET /health/live",
  "GET /health/ready",
]);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(TOKEN_VALIDATOR) private readonly validator: TokenValidator) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const route = `${request.method} ${request.path}`;

    // Rotas abertas: permitir sem auth.
    if (OPEN_ROUTES.has(route)) {
      (request as Request & { user?: Identity | null }).user = null;
      return true;
    }

    // Extrair token Bearer.
    const token = this.extractBearerToken(request);
    if (!token) {
      throw new UnauthorizedException("Missing Authorization header (Bearer token)");
    }

    // Validar token.
    try {
      const identity = await this.validator.validate(token);
      (request as Request & { user?: Identity | null }).user = identity;
      return true;
    } catch (e) {
      if (e instanceof UnauthorizedException) throw e;
      const message = e instanceof Error ? e.message : String(e);
      throw new UnauthorizedException(`Invalid token: ${message}`);
    }
  }

  /**
   * Extrai o token Bearer da header `Authorization`.
   *
   * Formato esperado: `Authorization: Bearer <token>`
   * Retorna `null` se a header não existir ou não for Bearer.
   */
  private extractBearerToken(request: Request): string | null {
    const header = request.headers.authorization;
    if (!header) return null;
    if (!header.startsWith("Bearer ")) return null;
    return header.slice(7); // Remove "Bearer "
  }
}
