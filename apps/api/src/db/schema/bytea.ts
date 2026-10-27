import { customType } from 'drizzle-orm/pg-core';

/** `bytea` de PostgreSQL: pg lo devuelve como `Buffer`. */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});
