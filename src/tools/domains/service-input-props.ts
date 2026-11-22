/**
 * Ties a domain tool's advertised JSON-schema properties to the service it
 * dispatches to. `makeDomainRun` hands the tool arguments to the service
 * method as they arrive, so the schema is the only place a client learns a
 * parameter's name: one the method reads but the schema leaves out is never
 * sent by a model that follows the schema, and is dropped by a client that
 * filters arguments by schema. Wrapping a domain's `inputProps` in
 * `serviceInputProps<Service, typeof ACTIONS>()` makes type-check fail on such
 * a gap, on a property declared with a JSON type its parameter cannot have,
 * and on a property no listed action reads, which a client following the
 * schema would send for nothing. The response bounds `max_chars` and `full`,
 * which the factory reads itself, are allowed alongside.
 */

/** The input object (first parameter) of each listed action of `S`. */
type ActionInput<S, A> = A extends keyof S
  ? S[A] extends (input: infer I, ...rest: never[]) => unknown
    ? NonNullable<I>
    : never
  : never

/** Every parameter name read by any of the inputs in the union `U`. */
type InputKey<U> = U extends unknown ? Extract<keyof U, string> : never

/** The value type of parameter `K` across the inputs in the union `U`. */
type InputValue<U, K extends string> = U extends unknown ? (K extends keyof U ? NonNullable<U[K]> : never) : never

type JsonTypeName = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object'

/** The JSON-schema `type` values a TypeScript parameter type can be sent as. */
type JsonType<T> = unknown extends T
  ? JsonTypeName
  : T extends string
    ? 'string'
    : T extends number
      ? 'number' | 'integer'
      : T extends boolean
        ? 'boolean'
        : T extends readonly unknown[]
          ? 'array'
          : 'object'

/**
 * One schema property per parameter, each typed with a JSON type its parameter
 * can take. Other keywords (description, items, enum) and tool-level
 * properties are open, so a missing parameter is reported as such rather than
 * hidden behind excess-property errors on the rest of the literal.
 */
type ServiceProps<U> = {
  [K in InputKey<U>]: { readonly type: JsonType<InputValue<U, K>>; readonly [keyword: string]: unknown }
} & { readonly [property: string]: unknown }

/** Tool-level properties `makeDomainRun` reads itself (response bounds) rather than the service. */
type FactoryProp = 'max_chars' | 'full'

/** `never` for every property of `P` that neither the service nor the factory reads. */
type NoUnreadProps<P, U> = { readonly [K in Exclude<keyof P, InputKey<U> | FactoryProp>]: never }

export function serviceInputProps<S, A extends readonly string[]>() {
  return <const P extends ServiceProps<ActionInput<S, A[number]>> & NoUnreadProps<P, ActionInput<S, A[number]>>>(
    props: P
  ): P => props
}
