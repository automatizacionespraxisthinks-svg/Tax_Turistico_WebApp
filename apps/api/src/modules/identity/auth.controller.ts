import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isValidLogin, normalizeLogin } from '@tax/shared';
import { zodBody } from '../../common/zod.pipe';
import { loadEnv } from '../../config/env';
import { IdentityService } from './identity.service';
import { AllowWithTemporaryPassword, AllowWithoutTotp, SESSION_COOKIE, SessionGuard } from './guards';

const driverLoginSchema = z.object({
  code: z.string().min(1),
  plate: z.string().min(5),
  pin: z.string().min(4).max(6).regex(/^\d+$/, 'El PIN es numérico'),
  device: z.string().min(1).max(120).default('Dispositivo del conductor'),
  /**
   * Identificador que la aplicación se genera y guarda la primera vez, para
   * que volver a entrar desde el mismo celular no cree otro dispositivo.
   * Opcional: una versión antigua de la PWA no lo manda.
   */
  install: z.string().min(8).max(64).optional(),
});

const userLoginSchema = z.object({
  /** El usuario de acceso: un correo o un nombre de usuario. */
  email: z
    .string()
    .transform(normalizeLogin)
    .refine(isValidLogin, 'Usuario o correo no válido'),
  password: z.string().min(8),
  /**
   * El código del segundo factor. Un solo campo para los seis dígitos del
   * teléfono y para un código de respaldo (`ABCDE-FGHIJ`), porque el operador
   * escribe en la misma casilla lo que tenga a mano.
   */
  totp: z.string().trim().min(6).max(20).optional(),
});

const cambioClaveSchema = z.object({
  currentPassword: z.string().min(1, 'Escribe tu contraseña actual'),
  // El largo mínimo real lo juzga la política compartida; aquí solo se corta
  // lo absurdo antes de gastar un Argon2 en ello.
  newPassword: z.string().min(1).max(200),
});

const totpActivateSchema = z.object({
  code: z.string().trim().regex(/^\d{6}$/, 'Son seis dígitos'),
});

@Controller('v1/auth')
export class AuthController {
  constructor(private readonly identity: IdentityService) {}

  @Post('driver')
  async driverLogin(@Body(zodBody(driverLoginSchema)) body: z.infer<typeof driverLoginSchema>) {
    const { driver, refreshToken } = await this.identity.loginDriver(
      body.code,
      body.plate,
      body.pin,
      body.device,
      body.install,
    );
    return { driver: { id: driver.id, code: driver.code, name: driver.name }, token: refreshToken };
  }

  @Post('session')
  async userLogin(
    @Body(zodBody(userLoginSchema)) body: z.infer<typeof userLoginSchema>,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const env = loadEnv();
    const { user, token, expiresAt } = await this.identity.loginUser(
      body.email,
      body.password,
      body.totp,
      request.ip,
      request.headers['user-agent'],
    );

    void reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      expires: expiresAt,
    });

    return { user };
  }

  /**
   * Quién está en sesión. El panel la llama al arrancar para decidir si
   * muestra el acceso o la operación; devuelve 401 si no hay sesión, que es
   * exactamente lo que el cliente necesita distinguir.
   */
  @Get('me')
  @UseGuards(SessionGuard)
  @AllowWithoutTotp()
  @AllowWithTemporaryPassword()
  async me(@Req() request: FastifyRequest) {
    const user = request.user!;
    return {
      user,
      // Para avisar cuando quedan pocos repuestos, antes de que se acaben.
      recoveryCodesLeft: user.totpEnabled
        ? await this.identity.recoveryCodesLeft(user.id)
        : null,
    };
  }

  /**
   * El propio usuario cambia su contraseña.
   *
   * No es `/v1/admin/...` a propósito: cualquiera con sesión puede cambiar la
   * suya, administrador u operador. Lo que lo protege no es el rol, es tener
   * que escribir la actual.
   */
  @Post('password')
  @UseGuards(SessionGuard)
  // Es justo lo que tiene que hacer quien entra con una temporal, y antes de
  // tener segundo factor: ese orden lo impone el guardia.
  @AllowWithoutTotp()
  @AllowWithTemporaryPassword()
  @HttpCode(204)
  async changePassword(
    @Req() request: FastifyRequest,
    @Body(zodBody(cambioClaveSchema)) body: z.infer<typeof cambioClaveSchema>,
  ) {
    await this.identity.changeOwnPassword(
      request.user!.id,
      body.currentPassword,
      body.newPassword,
      request.cookies?.[SESSION_COOKIE],
      request.ip,
    );
  }

  /* --------------------------------------------------- segundo factor --- */

  /**
   * Genera el secreto y devuelve el `otpauth://` que el panel pinta como QR.
   *
   * Hace falta sesión: para llegar aquí hay que haber pasado la contraseña.
   * Queda la grieta de que quien la tenga puede darse de alta él mismo antes
   * que el operador legítimo; por eso el alta se fuerza en el primer acceso,
   * cuando la cuenta se acaba de crear y nadie más la conoce.
   */
  @Post('totp/setup')
  @UseGuards(SessionGuard)
  @AllowWithoutTotp()
  setupTotp(@Req() request: FastifyRequest) {
    return this.identity.startTotpEnrollment(request.user!.id);
  }

  /** Confirma el alta con un código y entrega los de respaldo, una sola vez. */
  @Post('totp/activate')
  @UseGuards(SessionGuard)
  @AllowWithoutTotp()
  async activateTotp(
    @Req() request: FastifyRequest,
    @Body(zodBody(totpActivateSchema)) body: z.infer<typeof totpActivateSchema>,
  ) {
    const recoveryCodes = await this.identity.activateTotp(request.user!.id, body.code);
    return { recoveryCodes };
  }

  @Post('logout')
  @AllowWithoutTotp()
  async logout(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const token = request.cookies?.[SESSION_COOKIE];
    if (token) await this.identity.logout(token);
    void reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }
}
