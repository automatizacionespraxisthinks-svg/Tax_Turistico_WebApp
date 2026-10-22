import { Controller, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Roles, SessionGuard } from './guards';
import { UsersAdminService } from './users-admin.service';
import type { AdminActor } from '../fleet/fleet-admin.service';

function actorDe(request: FastifyRequest): AdminActor {
  const user = request.user!;
  return { id: user.id, name: user.name, role: user.role, ip: request.ip };
}

/**
 * Usuarios de la oficina desde el panel (§8.1). Solo administradores.
 *
 * Lo que NO hay aquí, a propósito: reiniciar el segundo factor de nadie. Eso
 * convertiría a cualquier administrador en capaz de entrar en la cuenta de
 * otro, y se queda en el terminal del servidor (`cli/usuarios.js`).
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
   * Genera una contraseña nueva. Se devuelve **una sola vez** y cierra las
   * sesiones abiertas de esa persona.
   */
  @Post(':userId/password')
  async resetPassword(
    @Req() request: FastifyRequest,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    const { email, password } = await this.usuarios.resetPassword(userId, actorDe(request));
    return {
      email,
      password,
      aviso: 'Esta contraseña no se vuelve a mostrar. Su segundo factor sigue activo.',
    };
  }
}
