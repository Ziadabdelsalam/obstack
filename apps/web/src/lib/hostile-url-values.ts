/**
 * The hostile-value corpus every URL-contract module's parse must survive
 * (D68).
 *
 * A surface's contract module (`logs-filter.ts`, `traces-filter.ts`, and every
 * D65-shaped module M3 adds) turns untrusted query parameters into a filter
 * object the server then binds into SQL. That parse is the only thing standing
 * between a hand-typed URL and the query layer, and it has already failed once
 * for real: `?range=toString` resolved through the prototype chain, made the
 * time window `NaN` and 500'd `/app/logs` in live mode. One example fixed in
 * one module is not a property; this corpus is, and it is shared so the
 * property is stated once.
 *
 * THE CONTRACT (D68 totality): for every value here, in every parameter, a
 * parse must (a) never throw, and (b) return an in-domain filter object —
 * enum-valued fields hold a member of their vocabulary, numeric fields hold a
 * value inside their bounds, and every non-string field falls back to its
 * default rather than carrying hostile input forward. Free-text and free-string
 * parameters (a search box, a pod name) legitimately ACCEPT these strings: a
 * search for the word "toString" is a real search, and asserting a default
 * there would assert a falsehood.
 *
 * M3 surfaces inherit this BY RULE, not by copy: a new contract module adds its
 * parse to the totality test rather than growing its own corpus.
 *
 * Deliberately dependency-free and client-safe — a contract module is imported
 * by client components, so its fixtures must be too.
 */

/** A query parameter as the router hands it over: one value, or several for a repeated key. */
export type HostileUrlValue = string | string[];

/**
 * Why each family is here: prototype names and `__proto__` because `in` and
 * bare property lookup walk the chain (the measured 500); the numeric strings
 * because a parse that does arithmetic can produce `Infinity`, `NaN`, a
 * negative window or a precision-lost integer, each of which becomes a bound
 * the database evaluates; the empty string and the repeated-parameter array
 * because both are shapes the router really produces; `%00` and the 5000-char
 * string because a value reaching SQL as a bound parameter must be judged on
 * length and content it will actually see in the wild.
 */
export const HOSTILE_URL_VALUES: readonly HostileUrlValue[] = [
  "toString",
  "constructor",
  "valueOf",
  "hasOwnProperty",
  "__proto__",
  "1e21",
  "99999999999999999999",
  "-5",
  "1.9",
  "1e999",
  "NaN",
  "",
  ["first", "second"],
  "%00",
  "x".repeat(5000),
];
