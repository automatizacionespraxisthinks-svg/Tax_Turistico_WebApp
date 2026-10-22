import { Global, Module } from '@nestjs/common';
import { IdentityService } from './identity.service';
import { ApiKeyGuard } from './api-key.guard';
import { DriverGuard, SessionGuard } from './guards';
import { AuthController } from './auth.controller';
import { AdminUsersController } from './admin-users.controller';
import { UsersAdminService } from './users-admin.service';

/**
 * Identidad.
 *
 * Es dueño de usuarios, roles, sesiones, claves de API y 2FA, y expone
 * guardas de autorización al resto (§4.1). Global porque cualquier módulo
 * necesita las guardas, pero su servicio no se usa para leer datos de otros.
 */
@Global()
@Module({
  providers: [IdentityService, UsersAdminService, ApiKeyGuard, SessionGuard, DriverGuard],
  controllers: [AuthController, AdminUsersController],
  exports: [IdentityService, UsersAdminService, ApiKeyGuard, SessionGuard, DriverGuard],
})
export class IdentityModule {}
