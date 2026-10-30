import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { PERMISOS, type Permiso } from '@tax/shared';
import { AppError } from '../../common/problem';
import { IdentityService, type DriverPrincipal, type UserPrincipal } from './identity.service';

export const PERMISO_KEY = 'tax:permiso';

/**
 * El permiso que exige el endpoint (RBAC, §8.1). Los permisos son del rol
 * del usuario y se editan en el panel; el catálogo está en `@tax/shared`.
 * Sin esta marca, basta con tener sesión: ver la operación es de todos.
 */
export const RequierePermiso = (permiso: Permiso) => SetMetadata(PERMISO_KEY, permiso);

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

export const ALLOW_WITH_TEMP_PASSWORD = 'tax:allow-with-temp-password';

/**
 * Las rutas que una sesión abierta con contraseña temporal puede usar: ver
 * quién soy y cambiarla. Ni siquiera el alta del segundo factor: primero la
 * contraseña, porque quien generó la temporal también la conoce y podría
 * adelantarse a dar de alta su propio teléfono.
 */
export const AllowWithTemporaryPassword = () => SetMetadata(ALLOW_WITH_TEMP_PASSWORD, true);

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

    if (user.mustChangePassword) {
      const permitida = this.reflector.getAllAndOverride<boolean>(ALLOW_WITH_TEMP_PASSWORD, [
        context.getHandler(),
        context.getClass(),
      ]);

      if (!permitida) {
        throw new AppError(
          'PASSWORD_CHANGE_REQUIRED',
          'Cambia la contraseña temporal antes de seguir',
        );
      }
    }

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

    const requerido = this.reflector.getAllAndOverride<Permiso | undefined>(PERMISO_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (requerido && !user.permissions.includes(requerido)) {
      const nombre = PERMISOS.find((p) => p.clave === requerido)?.nombre ?? requerido;
      throw new AppError('FORBIDDEN', `Tu rol no tiene el permiso «${nombre}»`);
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
