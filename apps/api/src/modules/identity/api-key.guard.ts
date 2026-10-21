import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../../common/problem';
import { sha256Hex } from '../../common/crypto';
import { IdentityService, type ApiPrincipal } from './identity.service';

export const SCOPES_KEY = 'tax:scopes';

/** Ámbitos exigidos por el endpoint: `rides:read`, `rides:write` (§7.1). */
export const Scopes = (...scopes: string[]) => SetMetadata(SCOPES_KEY, scopes);

declare module 'fastify' {
  interface FastifyRequest {
    principal?: ApiPrincipal;
  }
}

/**
 * Autenticación de la integración (n8n) por clave de API.
 *
 * La clave se guarda como hash Argon2, que a propósito tarda unos 20 ms. n8n
 * llama varias veces por carrera, así que verificar en cada petición se nota:
 * una vez comprobada, el resultado se cachea en memoria 60 s indexado por el
 * SHA-256 de la clave. Una clave revocada deja de servir como mucho un minuto
 * después; para revocar en el acto está `IdentityService.forget()`.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate, OnModuleDestroy {
  private readonly cache = new Map<string, { principal: ApiPrincipal; expiresAt: number }>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(
    private readonly reflector: Reflector,
    private readonly identity: IdentityService,
  ) {
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.sweeper);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const presented = request.headers['x-api-key'];

    if (typeof presented !== 'string' || presented.length < 16) {
      throw new AppError('UNAUTHORIZED', 'Falta la cabecera X-Api-Key');
    }

    const principal = await this.resolve(presented);
    request.principal = principal;

    const required = this.reflector.getAllAndOverride<string[]>(SCOPES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (required?.length) {
      const allowed = required.some((scope) => principal.scopes.includes(scope));
      if (!allowed) {
        throw new AppError('FORBIDDEN', `Se requiere uno de: ${required.join(', ')}`);
      }
    }

    return true;
  }

  private async resolve(presented: string): Promise<ApiPrincipal> {
    const fingerprint = sha256Hex(presented);
    const cached = this.cache.get(fingerprint);
    if (cached && cached.expiresAt > Date.now()) return cached.principal;

    const principal = await this.identity.verifyApiKey(presented);
    if (!principal) {
      // No se cachea el fallo: si se cacheara, un atacante podría medir la
      // diferencia de tiempo entre intentos repetidos.
      throw new AppError('UNAUTHORIZED', 'Clave de API inválida o revocada');
    }

    this.cache.set(fingerprint, { principal, expiresAt: Date.now() + 60_000 });
    return principal;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache) {
      if (entry.expiresAt <= now) this.cache.delete(key);
    }
  }
}
