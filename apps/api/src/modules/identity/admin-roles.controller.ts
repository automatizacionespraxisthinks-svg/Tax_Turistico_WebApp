import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { rolSchema } from '@tax/shared';
import { zodBody } from '../../common/zod.pipe';
import { RequierePermiso, SessionGuard } from './guards';
import { RolesService } from './roles.service';
import { actorConPermisos } from './admin-users.controller';

const codigo = z.string().trim().max(20).optional();
const nuevoRolSchema = rolSchema.extend({ codigo });
const cambioRolSchema = rolSchema.partial().extend({ codigo });

const claveDeRol = z.string().trim().min(1).max(40);

/**
 * Roles y permisos desde el panel (RBAC, §8.1). Con «Gestionar roles».
 *
 * Crear un rol o cambiar sus permisos pide el código de la aplicación de
 * autenticación de quien lo hace; las reglas están en `RolesService`.
 */
@Controller('v1/admin/roles')
@UseGuards(SessionGuard)
@RequierePermiso('roles.gestionar')
export class AdminRolesController {
  constructor(private readonly roles: RolesService) {}

  @Get()
  list(@Req() request: FastifyRequest) {
    return this.roles.list(actorConPermisos(request));
  }

  @Post()
  create(
    @Req() request: FastifyRequest,
    @Body(zodBody(nuevoRolSchema)) body: z.infer<typeof nuevoRolSchema>,
  ) {
    return this.roles.create(body, actorConPermisos(request));
  }

  @Patch(':key')
  @HttpCode(204)
  async update(
    @Req() request: FastifyRequest,
    @Param('key') key: string,
    @Body(zodBody(cambioRolSchema)) body: z.infer<typeof cambioRolSchema>,
  ) {
    await this.roles.update(claveDeRol.parse(key), body, actorConPermisos(request));
  }

  /** Solo roles creados en el panel y sin nadie que los tenga. */
  @Delete(':key')
  @HttpCode(204)
  async remove(@Req() request: FastifyRequest, @Param('key') key: string) {
    await this.roles.remove(claveDeRol.parse(key), actorConPermisos(request));
  }
}
