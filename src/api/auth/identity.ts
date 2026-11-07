/**
 * Identity — identidade do principal autenticado.
 *
 * Abstração agnóstica de IdP: o guard resolve o token e produz uma
 * `Identity` tipada, que os controllers/interceptors consomem via
 * `request.user` (ou contexto de request).
 *
 * README §2: "a identidade do provedor contida na mensagem continua sujeita
 * às mesmas validações de domínio" — a Identity carrega apenas o "quem",
 * nunca o "o que" (o payload de negócio é validado no domínio).
 */

export interface Identity {
  /** Identificador único do principal (sub do JWT / user id do IdP). */
  subject: string;
  /** Nome amigável (ex.: e-mail, username). Opcional. */
  name?: string;
  /** Escopos/roles concedidos pelo IdP (ex.: ["wagering:submit"]). */
  scopes: string[];
  /** Origem do token (ex.: "keycloak", "zitadel", "noop"). */
  issuer: string;
  /** Expiração do token (epoch ms). Usado para cache/validação. */
  expiresAt: number;
}

/**
 * Contexto de autenticação pendente — preenchido pelo guard, lido pelos
 * controllers via `request.user`.
 *
 * `null` = request não autenticada (ex.: health checks, que ficam abertos).
 */
export type AuthContext = Identity | null;
