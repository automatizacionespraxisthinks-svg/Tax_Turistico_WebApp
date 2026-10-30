import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { TEMP_PASSWORD_HOURS, isValidLogin, normalizeLogin } from '@tax/shared';
import { zodBody } from '../../common/zod.pipe';
import { RequierePermiso, SessionGuard } from './guards';
import { UsersAdminService } from './users-admin.service';
import type { ActorConPermisos } from './roles.service';

/** El código de la aplicación de autenticación de quien hace el cambio. */
const codigo = z.string().trim().max(20).optional();

const nuevoUsuarioSchema = z.object({
  name: z.string().trim().min(3, 'Escribe nombre y apellido').max(120),
  /** Un correo o un nombre de usuario: con eso entrará al panel. */
  login: z.string().transform(normalizeLogin).refine(isValidLogin, 'Usuario o correo no válido'),
  /** Clave del rol; sin ella, operador. */
  role: z.string().trim().min(1).max(40).optional(),
  codigo,
});

const estadoSchema = z.object({ active: z.boolean() });
const rolSchema = z.object({ role: z.string().trim().min(1).max(40), codigo });

export function actorConPermisos(request: FastifyRequest): ActorConPermisos {
  const user = request.user!;
  return { id: user.id, name: user.name, role: user.role, permissions: user.permissions, ip: request.ip };
}

/**
 * Usuarios de la oficina desde el panel (§8.1). Con «Gestionar usuarios».
 *
 * Lo que NO hay aquí, a propósito: reiniciar el segundo factor de nadie. Junto
 * con reiniciar la contraseña permitiría entrar en la cuenta de otro, y se
 * queda en el terminal del servidor (`cli/usuarios.js`).
 */
@Controller('v1/admin/users')
@UseGuards(SessionGuard)
@RequierePermiso('usuarios.gestionar')
export class AdminUsersController {
  constructor(private readonly usuarios: UsersAdminService) {}

  @Get()
  list(@Req() request: FastifyRequest) {
    return this.usuarios.list(actorConPermisos(request));
  }

  /**
   * Da de alta a alguien. Su contraseña temporal se devuelve **una sola
   * vez**: al entrar con ella tendrá que cambiarla y activar el segundo factor.
   */
  @Post()
  async create(
    @Req() request: FastifyRequest,
    @Body(zodBody(nuevoUsuarioSchema)) body: z.infer<typeof nuevoUsuarioSchema>,
  ) {
    const creado = await this.usuarios.create(body, actorConPermisos(request));
    return {
      ...creado,
      aviso: `Esta contraseña no se vuelve a mostrar y caduca en ${TEMP_PASSWORD_HOURS} horas.`,
    };
  }

  /** Desactiva o reactiva a alguien. Desactivar cierra sus sesiones. */
  @Patch(':userId')
  @HttpCode(204)
  async setActive(
    @Req() request: FastifyRequest,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body(zodBody(estadoSchema)) body: z.infer<typeof estadoSchema>,
  ) {
    await this.usuarios.setActive(userId, body.active, actorConPermisos(request));
  }

  /** Cambia el rol. Pide el código de la aplicación de quien lo cambia. */
  @Patch(':userId/role')
  @HttpCode(204)
  async cambiarRol(
    @Req() request: FastifyRequest,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body(zodBody(rolSchema)) body: z.infer<typeof rolSchema>,
  ) {
    await this.usuarios.cambiarRol(userId, body, actorConPermisos(request));
  }

  /**
   * Genera una contraseña temporal nueva. Se devuelve **una sola vez** y
   * cierra las sesiones abiertas de esa persona.
   */
  @Post(':userId/password')
  async resetPassword(
    @Req() request: FastifyRequest,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    const { email, password, expiresAt } = await this.usuarios.resetPassword(userId, actorConPermisos(request));
    return {
      email,
      password,
      expiresAt,
      aviso: 'Esta contraseña no se vuelve a mostrar. Al entrar tendrá que cambiarla; su segundo factor sigue activo.',
    };
  }
}
