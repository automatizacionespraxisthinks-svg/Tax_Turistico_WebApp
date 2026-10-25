import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { TEMP_PASSWORD_HOURS, isValidLogin, normalizeLogin } from '@tax/shared';
import { zodBody } from '../../common/zod.pipe';
import { Roles, SessionGuard } from './guards';
import { UsersAdminService } from './users-admin.service';
import type { AdminActor } from '../fleet/fleet-admin.service';

const nuevoOperadorSchema = z.object({
  name: z.string().trim().min(3, 'Escribe nombre y apellido').max(120),
  /** Un correo o un nombre de usuario: con eso entrará al panel. */
  login: z.string().transform(normalizeLogin).refine(isValidLogin, 'Usuario o correo no válido'),
});

const estadoSchema = z.object({ active: z.boolean() });

function actorDe(request: FastifyRequest): AdminActor {
  const user = request.user!;
  return { id: user.id, name: user.name, role: user.role, ip: request.ip };
}

/**
 * Usuarios de la oficina desde el panel (§8.1). Solo administradores.
 *
 * Lo que NO hay aquí, a propósito: crear administradores ni reiniciar el
 * segundo factor de nadie. Las dos cosas convertirían a cualquier
 * administrador en capaz de entrar en la cuenta de otro, y se quedan en el
 * terminal del servidor (`cli/usuarios.js`, `cli/crear-usuario.js`).
 */
@Controller('v1/admin/users')
@UseGuards(SessionGuard)
@Roles('administrador')
export class AdminUsersController {
  constructor(private readonly usuarios: UsersAdminService) {}

  @Get()
  list() {
    return this.usuarios.list();
  }

  /**
   * Da de alta un operador. Su contraseña temporal se devuelve **una sola
   * vez**: al entrar con ella tendrá que cambiarla y activar el segundo factor.
   */
  @Post()
  async create(
    @Req() request: FastifyRequest,
    @Body(zodBody(nuevoOperadorSchema)) body: z.infer<typeof nuevoOperadorSchema>,
  ) {
    const creado = await this.usuarios.create(body, actorDe(request));
    return {
      ...creado,
      aviso: `Esta contraseña no se vuelve a mostrar y caduca en ${TEMP_PASSWORD_HOURS} horas.`,
    };
  }

  /** Desactiva o reactiva un operador. Desactivar cierra sus sesiones. */
  @Patch(':userId')
  @HttpCode(204)
  async setActive(
    @Req() request: FastifyRequest,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body(zodBody(estadoSchema)) body: z.infer<typeof estadoSchema>,
  ) {
    await this.usuarios.setActive(userId, body.active, actorDe(request));
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
    const { email, password, expiresAt } = await this.usuarios.resetPassword(userId, actorDe(request));
    return {
      email,
      password,
      expiresAt,
      aviso: 'Esta contraseña no se vuelve a mostrar. Al entrar tendrá que cambiarla; su segundo factor sigue activo.',
    };
  }
}
