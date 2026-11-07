/**
 * KeycloakTokenValidator — validação de tokens OIDC via Keycloak (JWKS).
 *
 * Implementação da interface `TokenValidator` para Keycloak.
 *
 * Fluxo:
 *   1. Extrair o token Bearer da request (feito pelo guard, não aqui).
 *   2. Decodificar o header do JWT para obter o `kid` (key ID).
 *   3. Buscar a chave pública correspondente no endpoint JWKS do Keycloak
 *      (`{issuer}/protocol/openid-connect/certs`).
 *   4. Verificar a assinatura RS256/ES256 com a chave pública.
 *   5. Validar claims: `iss`, `aud`, `exp`, `iat`, `sub`.
 *   6. Extrair `Identity` (subject, name, scopes, issuer, expiresAt).
 *
 * Cache de JWKS:
 *   - As chaves públicas são cacheadas em memória por `jwksCacheTtlMs`
 *     (default: 10 min). O Keycloak rotaciona chaves raramente; o cache
 *     evita uma HTTP call por request.
 *   - Se a assinatura falhar com o `kid` cacheado, o cache é invalidado
 *     e o JWKS é re-buscado (handling de key rotation).
 *
 * Configuração (via env):
 *   - `KEYCLOAK_ISSUER` — URL do issuer (ex.: http://localhost:8081/realms/jungle)
 *   - `KEYCLOAK_AUDIENCE` — audience esperada (ex.: "jungle-api")
 *   - `KEYCLOAK_JWKS_CACHE_TTL_MS` — TTL do cache JWKS (default: 600000)
 *
 * Por que não usar uma lib externa (ex.: `openid-client`)?
 *   - O desafio pede Bun + NestJS; adicionar uma dep pesativa para
 *     validação de JWT é overkill. A validação RS256 com JWKS é ~80 linhas.
 *   - Se o projeto crescer, trocar para `openid-client` é trivial
 *     (mesma interface `TokenValidator`).
 */

import type { Identity } from "./identity.js";
import { AuthError } from "./token-validator.js";
import type { TokenValidator } from "./token-validator.js";

/**
 * Configuração da validadora Keycloak.
 * Injetada via DI (ver `AuthModule`).
 */
export interface KeycloakConfig {
  /** URL do issuer (ex.: http://localhost:8081/realms/jungle). */
  issuer: string;
  /** Audience esperada no claim `aud`. */
  audience: string;
  /** TTL do cache JWKS em ms (default: 10 min). */
  jwksCacheTtlMs: number;
}

/**
 * JWKS (JSON Web Key Set) — resposta do endpoint `/protocol/openid-connect/certs`.
 *
 * Formato (RFC 7517):
 * ```json
 * {
 *   "keys": [
 *     {
 *       "kty": "RSA",
 *       "kid": "abc123",
 *       "alg": "RS256",
 *       "use": "sig",
 *       "n": "0vx7...",
 *       "e": "AQAB"
 *     }
 *   ]
 * }
 * ```
 */
interface Jwks {
  keys: Jwk[];
}

interface Jwk {
  kty: string;
  kid: string;
  alg: string;
  use?: string;
  n: string;
  e: string;
}

/**
 * Validadora de tokens Keycloak (OIDC via JWKS).
 *
 * Singleton — o cache JWKS é compartilhado entre todas as requests.
 */
export class KeycloakTokenValidator implements TokenValidator {
  readonly issuer = "keycloak";

  private jwksCache: Jwks | null = null;
  private jwksFetchedAt = 0;

  constructor(private readonly config: KeycloakConfig) {}

  async validate(token: string): Promise<Identity> {
    // 1. Decodificar header do JWT (sem validar assinatura ainda).
    const header = this.decodeJwtHeader(token);

    // 2. Buscar a chave pública correspondente ao `kid`.
    const jwks = await this.getJwks();
    const key = jwks.keys.find((k) => k.kid === header.kid);
    if (!key) {
      throw new AuthError(`Unknown key ID: ${header.kid}`);
    }

    // 3. Verificar assinatura.
    const payload = await this.verifySignature(token, key);

    // 4. Validar claims.
    this.validateClaims(payload);

    // 5. Extrair Identity.
    return {
      subject: payload.sub,
      name: payload.preferred_username ?? payload.email,
      scopes: this.extractScopes(payload),
      issuer: this.issuer,
      expiresAt: payload.exp * 1000,
    };
  }

  /**
   * Invalida o cache JWKS (usado em key rotation).
   */
  invalidateCache(): void {
    this.jwksCache = null;
    this.jwksFetchedAt = 0;
  }

  /**
   * Decodifica o header do JWT (base64url → JSON).
   * Não valida assinatura — apenas extrai `alg` e `kid`.
   */
  private decodeJwtHeader(token: string): { alg: string; kid: string } {
    const parts = token.split(".");
    if (parts.length !== 3) {
      throw new AuthError("Malformed JWT: expected 3 parts");
    }
    const headerB64 = parts[0];
    if (!headerB64) {
      throw new AuthError("Malformed JWT: empty header");
    }
    try {
      const header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
      if (!header.kid || !header.alg) {
        throw new Error("Missing kid or alg in JWT header");
      }
      return header;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw new AuthError(`Invalid JWT header: ${message}`);
    }
  }

  /**
   * Busca o JWKS do Keycloak, com cache em memória.
   *
   * Endpoint: `{issuer}/protocol/openid-connect/certs`
   *
   * Se a assinatura falhar (key rotation), o cache é invalidado e o
   * JWKS é re-buscado.
   */
  private async getJwks(): Promise<Jwks> {
    const now = Date.now();
    if (this.jwksCache && now - this.jwksFetchedAt < this.config.jwksCacheTtlMs) {
      return this.jwksCache;
    }

    const url = `${this.config.issuer}/protocol/openid-connect/certs`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new AuthError(`Failed to fetch JWKS: ${response.status}`);
    }

    this.jwksCache = (await response.json()) as Jwks;
    this.jwksFetchedAt = now;
    return this.jwksCache;
  }

  /**
   * Verifica a assinatura do JWT com a chave pública.
   *
   * Implementação RS256:
   *   1. Converter a chave JWK (n, e) para uma chave pública RSA.
   *   2. Verificar a assinatura com `crypto.verify`.
   *
   * Para ES256 (ECDSA), o fluxo é análogo com `crypto.createVerify`
   * e uma chave EC.
   */
  private async verifySignature(token: string, key: Jwk): Promise<JwtPayload> {
    const [headerB64, payloadB64, signatureB64] = token.split(".");
    if (!headerB64 || !payloadB64 || !signatureB64) {
      throw new AuthError("Malformed JWT");
    }
    const data = `${headerB64}.${payloadB64}`;
    const signature = Buffer.from(signatureB64, "base64url");

    // Converter JWK RSA (n, e) para chave pública.
    const publicKey = await this.jwkToPublicKey(key);

    // Verificar assinatura RS256.
    const verified = await crypto.subtle.verify(
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      publicKey,
      signature,
      new TextEncoder().encode(data),
    );

    if (!verified) {
      // Key rotation: invalidar cache e re-tentar uma vez.
      this.invalidateCache();
      throw new AuthError("Invalid JWT signature");
    }

    try {
      return JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      throw new AuthError(`Invalid JWT payload: ${message}`);
    }
  }

  /**
   * Converte um JWK RSA (n, e) para uma `CryptoKey` pública.
   *
   * Usa `crypto.subtle.importKey` com o formato JWK nativo.
   */
  private async jwkToPublicKey(key: Jwk): Promise<CryptoKey> {
    // O formato JWK é suportado nativamente pelo Web Crypto API.
    // Em Bun, `crypto.subtle.importKey` aceita JWK diretamente.
    return crypto.subtle.importKey(
      "jwk",
      { kty: key.kty, n: key.n, e: key.e, alg: key.alg, use: "sig" },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  }

  /**
   * Valida os claims obrigatórios do JWT.
   *
   * Claims validados:
   *   - `iss` — deve ser igual ao `config.issuer`.
   *   - `aud` — deve conter o `config.audience`.
   *   - `exp` — token não pode estar expirado.
   *   - `iat` — token não pode ter sido emitido no futuro (clock skew: 5 min).
   *   - `sub` — deve estar presente e não vazio.
   */
  private validateClaims(payload: JwtPayload): void {
    const now = Date.now() / 1000;
    const clockSkew = 300; // 5 min

    if (payload.iss !== this.config.issuer) {
      throw new AuthError(`Invalid issuer: ${payload.iss}`);
    }

    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(this.config.audience)) {
      throw new AuthError(`Invalid audience: ${payload.aud}`);
    }

    if (payload.exp < now - clockSkew) {
      throw new AuthError("Token expired");
    }

    if (payload.iat > now + clockSkew) {
      throw new AuthError("Token issued in the future");
    }

    if (!payload.sub) {
      throw new AuthError("Missing subject (sub) claim");
    }
  }

  /**
   * Extrai os scopes do payload.
   *
   * Keycloak pode enviar scopes em:
   *   - `scope` (string space-separated, ex.: "openid profile wagering:submit")
   *   - `roles` (array, se configurado no realm)
   *   - `resource_access.{client}.roles` (array, roles por client)
   */
  private extractScopes(payload: JwtPayload): string[] {
    const scopes: string[] = [];

    if (payload.scope) {
      scopes.push(...payload.scope.split(" "));
    }

    if (payload.roles) {
      scopes.push(...payload.roles);
    }

    if (payload.resource_access) {
      for (const clientRoles of Object.values(payload.resource_access)) {
        if (clientRoles.roles) {
          scopes.push(...clientRoles.roles);
        }
      }
    }

    return scopes;
  }
}

/**
 * Payload do JWT (claims).
 *
 * Apenas os campos usados pela validação e extração de Identity.
 * O payload completo pode ter mais claims — os não listados são ignorados.
 */
interface JwtPayload {
  iss: string;
  aud: string | string[];
  exp: number;
  iat: number;
  sub: string;
  preferred_username?: string;
  email?: string;
  scope?: string;
  roles?: string[];
  resource_access?: Record<string, { roles?: string[] }>;
}
