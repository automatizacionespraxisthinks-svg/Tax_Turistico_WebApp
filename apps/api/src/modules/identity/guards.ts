import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../../common/problem';
import { IdentityService, type DriverPrincipal, type UserPrincipal } from './identity.service';

export const ROLES_KEY = 'tax:roles';

/** Roles de la oficina admitidos por el endpoint (RBAC, §8.1). */
export const Roles = (...roles: ('administrador' | 'operador')[]) => SetMetadata(ROLES_KEY, roles);

export const SESSION_COOKIE = 'tax_session';

export const ALLOW_WITHOUT_TOTP = 'tax:allow-without-totp';

/**
 * Marca las rutas que una sesión sin segundo factor todavía puede usar: ver
 * quién soy, darlo de alta y salir. Nada más.
 *
 * Sin esto el «obligatorio» de §8.1 sería un aviso en la interfaz, y quien
 * tuviera la contraseña se saltaría la interfaz.
 */
export const AllowWithoutTotp = () => SetMetadata(ALLOW_WITHOUT_TOTP, true);

declare module 'fastify' {
  interface FastifyRequest {
    user?: UserPrincipal;
    driver?: DriverPrincipal;
  }
}

/**
 * Sesión del panel: cookie HttpOnly, Secure, SameSite=Lax, 12 h (§8.1).
 * La cookie no viaja a otros orígenes y el token solo existe como hash en la
 * base, así que un volcado de la tabla no permite suplantar a nadie.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly identity: IdentityService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const token = readCookie(request.headers.cookie, SESSION_COOKIE);

    if (!token) throw new AppError('UNAUTHORIZED', 'Sesión ausente');

    const user = await this.identity.resolveSession(token);
    if (!user) throw new AppError('UNAUTHORIZED', 'Sesión expirada o revocada');

    request.user = user;

    if (!user.totpEnabled) {
      const permitida = this.reflector.getAllAndOverride<boolean>(ALLOW_WITHOUT_TOTP, [
        context.getHandler(),
        context.getClass(),
      ]);

      if (!permitida) {
        throw new AppError(
          'TOTP_SETUP_REQUIRED',
          'Activa el segundo factor antes de entrar al panel',
        );
      }
    }

    const required = this.reflector.getAllAndOverride<('administrador' | 'operador')[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (required?.length && !required.includes(user.role)) {
      throw new AppError('FORBIDDEN', `Se requiere rol: ${required.join(' o ')}`);
    }

    return true;
  }
}

/**
 * Sesión del conductor: token al portador ligado al dispositivo registrado.
 * No usa cookie porque la PWA puede estar instalada y conviene que el token
 * viva en el almacenamiento de la aplicación, revocable desde la oficina.
 */
@Injectable()
export class DriverGuard implements CanActivate {
  constructor(private readonly identity: IdentityService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const header = request.headers.authorization;

    if (!header?.startsWith('Bearer ')) {
      throw new AppError('UNAUTHORIZED', 'Falta el token del conductor');
    }

    const driver = await this.identity.resolveDriverToken(header.slice(7));
    if (!driver) throw new AppError('UNAUTHORIZED', 'Token inválido o dispositivo revocado');

    request.driver = driver;
    return true;
  }
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}
