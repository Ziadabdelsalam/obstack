/**
 * The instrumentation scope every span obstack-js emits is stamped with, and
 * the version reported alongside it.
 *
 * The version is restated rather than read out of package.json because the CJS
 * build compiles `src/` in isolation and importing the manifest would drag it
 * into the emitted tree. `init.test.ts` asserts the two are equal, so the copy
 * cannot rot silently.
 */
export const SDK_NAME = "obstack-js";
export const SDK_VERSION = "0.1.0";
