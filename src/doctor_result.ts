/**
 * The shape every doctor check returns.
 *
 * Its own module so a check can be hosted outside cli_doctor.ts without importing that module:
 * `import type` would be erased at build time too, but only for as long as nobody drops the
 * `type` keyword, and the cost of that slip is a megabyte back in the hook bundle's eager set
 * (see walk_mode.ts). A value-free module cannot regress that way.
 */

/** Result of a single doctor check. */
export interface DoctorResult {
  name: string
  status: 'ok' | 'warn' | 'fail'
  message: string
}
