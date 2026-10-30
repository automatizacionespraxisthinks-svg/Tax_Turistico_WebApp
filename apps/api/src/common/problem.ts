import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ExceptionFilter,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { API_ERROR_CODES } from '@tax/shared';

/**
 * Errores en formato RFC 9457 (`application/problem+json`).
 *
 * El agente de n8n no lee el texto: ramifica por `code`, que es estable y
 * versionado junto al contrato (§7.1). Añadir un código es compatible; cambiar
 * el significado de uno existente no lo es.
 */

/** Códigos del contrato con n8n más los internos de la API. */
export const ERROR_CODES = {
  ...API_ERROR_CODES,

  VALIDATION_FAILED: 'El cuerpo de la petición no cumple el esquema',
  NOT_FOUND: 'El recurso no existe',
  UNAUTHORIZED: 'Credenciales ausentes o inválidas',
  FORBIDDEN: 'Sin permiso para esta operación',
  RATE_LIMITED: 'Demasiadas peticiones',
  IDEMPOTENCY_MISMATCH: 'La misma clave de idempotencia con una petición distinta',
  IDEMPOTENCY_IN_PROGRESS: 'La misma petición todavía se está procesando',

  /* Zonas y lugares creados desde el panel. */
  ZONE_OVERLAP: 'La zona se monta sobre otra',
  NAME_TAKEN: 'Ya existe otro con ese nombre',
  KEYWORD_TAKEN: 'Esa palabra clave ya es de otro lugar',

  /*
   * Segundo factor (§8.1). Son tres situaciones distintas y el panel tiene
   * que ramificar por ellas: pedir el código, decir que no sirvió, o llevar
   * al alta. Que `TOTP_REQUIRED` revele que la contraseña era correcta es
   * inherente a cualquier segundo factor: justamente el punto es que la
   * contraseña sola ya no basta.
   */
  TOTP_REQUIRED: 'Falta el código del segundo factor',
  TOTP_INVALID: 'Código del segundo factor incorrecto o ya usado',
  TOTP_SETUP_REQUIRED: 'Hay que activar el segundo factor antes de usar el panel',

  /*
   * Contraseña temporal (§8.1): la que genera otra persona al crear o
   * reiniciar una cuenta. El panel ramifica por estos dos: uno lleva al
   * cambio obligatorio, el otro dice que hay que pedir otra.
   */
  PASSWORD_CHANGE_REQUIRED: 'Hay que cambiar la contraseña temporal antes de usar el panel',
  TEMP_PASSWORD_EXPIRED: 'La contraseña temporal caducó',

  LOGIN_TAKEN: 'Ya existe una cuenta con ese usuario',
  OPERATOR_LIMIT_REACHED: 'Se alcanzó el máximo de operadores activos',

  /*
   * Confirmar con el segundo factor un cambio que da poder (roles y
   * permisos). No son 401 a propósito: la sesión sigue siendo buena, y un
   * 401 haría que el panel volviera al acceso por un código mal escrito.
   */
  SECOND_FACTOR_REQUIRED: 'Confirma con el código de tu aplicación de autenticación',
  SECOND_FACTOR_INVALID: 'Código incorrecto o ya usado',
  ROLE_IN_USE: 'El rol tiene usuarios',
  LAST_ADMIN: 'Tiene que quedar al menos un administrador activo',

  INVALID_TRANSITION: 'La máquina de estados no permite ese cambio',
  RIDE_ALREADY_TAKEN: 'Otro conductor aceptó la carrera primero',
  OFFER_NOT_VALID: 'La oferta venció o fue revocada',
  DRIVER_BUSY: 'El conductor ya tiene una carrera activa',
  DRIVER_OFF_SHIFT: 'El conductor no tiene un turno abierto',
  /* La PWA ramifica por este: muestra hasta cuándo, no «PIN incorrecto». */
  DRIVER_SUSPENDED: 'El conductor está suspendido',
  DRIVER_NO_ELECTRONIC_PAYMENT: 'El conductor no recibe pagos electrónicos',
  RIDE_TOO_SHORT: 'Todavía no ha pasado el tiempo mínimo para finalizar',
  NO_FARE_RULE: 'No hay regla tarifaria vigente para ese par de zonas',

  INTERNAL: 'Error interno',
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

const STATUS_BY_CODE: Record<ErrorCode, HttpStatus> = {
  MISSING_LOCATION: HttpStatus.UNPROCESSABLE_ENTITY,
  OUT_OF_COVERAGE: HttpStatus.UNPROCESSABLE_ENTITY,
  RIDE_ALREADY_ACTIVE: HttpStatus.CONFLICT,

  VALIDATION_FAILED: HttpStatus.BAD_REQUEST,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  UNAUTHORIZED: HttpStatus.UNAUTHORIZED,
  FORBIDDEN: HttpStatus.FORBIDDEN,
  RATE_LIMITED: HttpStatus.TOO_MANY_REQUESTS,
  IDEMPOTENCY_MISMATCH: HttpStatus.CONFLICT,
  IDEMPOTENCY_IN_PROGRESS: HttpStatus.CONFLICT,

  ZONE_OVERLAP: HttpStatus.CONFLICT,
  NAME_TAKEN: HttpStatus.CONFLICT,
  KEYWORD_TAKEN: HttpStatus.CONFLICT,

  TOTP_REQUIRED: HttpStatus.UNAUTHORIZED,
  TOTP_INVALID: HttpStatus.UNAUTHORIZED,
  TOTP_SETUP_REQUIRED: HttpStatus.FORBIDDEN,

  PASSWORD_CHANGE_REQUIRED: HttpStatus.FORBIDDEN,
  TEMP_PASSWORD_EXPIRED: HttpStatus.UNAUTHORIZED,

  LOGIN_TAKEN: HttpStatus.CONFLICT,
  OPERATOR_LIMIT_REACHED: HttpStatus.CONFLICT,
  SECOND_FACTOR_REQUIRED: HttpStatus.FORBIDDEN,
  SECOND_FACTOR_INVALID: HttpStatus.FORBIDDEN,
  ROLE_IN_USE: HttpStatus.CONFLICT,
  LAST_ADMIN: HttpStatus.CONFLICT,

  INVALID_TRANSITION: HttpStatus.CONFLICT,
  RIDE_ALREADY_TAKEN: HttpStatus.CONFLICT,
  OFFER_NOT_VALID: HttpStatus.GONE,
  DRIVER_BUSY: HttpStatus.CONFLICT,
  DRIVER_OFF_SHIFT: HttpStatus.CONFLICT,
  DRIVER_SUSPENDED: HttpStatus.FORBIDDEN,
  DRIVER_NO_ELECTRONIC_PAYMENT: HttpStatus.CONFLICT,
  RIDE_TOO_SHORT: HttpStatus.CONFLICT,
  NO_FARE_RULE: HttpStatus.UNPROCESSABLE_ENTITY,

  INTERNAL: HttpStatus.INTERNAL_SERVER_ERROR,
};

/** Códigos genéricos para las excepciones que no nacen como `AppError`. */
const CODE_BY_STATUS: Partial<Record<number, ErrorCode>> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'RIDE_ALREADY_ACTIVE',
  422: 'VALIDATION_FAILED',
  429: 'RATE_LIMITED',
};

export interface ProblemDocument {
  type: string;
  title: string;
  status: number;
  code: ErrorCode;
  detail?: string;
  instance?: string;
  /** Campos que fallaron la validación, cuando aplica. */
  errors?: { path: string; message: string }[];
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: HttpStatus;
  readonly errors?: { path: string; message: string }[];

  constructor(
    code: ErrorCode,
    detail?: string,
    errors?: { path: string; message: string }[],
  ) {
    super(detail ?? ERROR_CODES[code]);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.errors = errors;
  }

  toProblem(instance?: string): ProblemDocument {
    return {
      type: `https://docs.taxturistico.co/errores/${this.code.toLowerCase()}`,
      title: ERROR_CODES[this.code],
      status: this.status,
      code: this.code,
      detail: this.message === ERROR_CODES[this.code] ? undefined : this.message,
      instance,
      errors: this.errors,
    };
  }
}

@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger('Problem');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const reply = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<{ url?: string; id?: string }>();
    const instance = request?.url;

    if (exception instanceof AppError) {
      const problem = exception.toProblem(instance);
      this.send(reply, problem);
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      this.send(reply, {
        type: 'about:blank',
        title: exception.message,
        status,
        code: CODE_BY_STATUS[status] ?? 'INTERNAL',
        instance,
      });
      return;
    }

    // Lo inesperado se registra entero y se devuelve sin detalles: un error
    // interno no debe filtrar la forma de la base ni rutas del servidor.
    this.logger.error(
      { err: exception, instance },
      'Error no controlado',
    );
    this.send(reply, {
      type: 'about:blank',
      title: ERROR_CODES.INTERNAL,
      status: 500,
      code: 'INTERNAL',
      instance,
    });
  }

  private send(reply: FastifyReply, problem: ProblemDocument): void {
    void reply.status(problem.status).header('content-type', 'application/problem+json').send(problem);
  }
}
