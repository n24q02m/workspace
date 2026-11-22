/**
 * Ties a domain tool's advertised JSON-schema properties to the service it
 * dispatches to. `makeDomainRun` hands the tool arguments to the service
 * method as they arrive, so the schema is the only place a client learns a
 * parameter's name: one the method reads but the schema leaves out is never
 * sent by a model that follows the schema, and is dropped by a client that
 * filters arguments by schema. Wrapping a domain's `inputProps` in
 * `serviceInputProps<Service, typeof ACTIONS>()` makes type-check fail on such
 * a gap, on a property declared with a JSON type its parameter cannot have,
 * on a union parameter whose schema leaves out one of its JSON types (a
 * `string | string[]` needs `anyOf` over both), and on a property no listed
 * action reads, which a client following the schema would send for nothing.
 * The response bounds `max_chars` and `full`, which the factory reads itself,
 * are allowed alongside.
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

/** A schema node typed with one of the JSON types `T` allows; other keywords are open. */
type TypedNode<T> = { readonly type: T; readonly [keyword: string]: unknown }

/**
 * One schema property per parameter: a single `type`, or `anyOf` branches for
 * a parameter that takes more than one JSON shape, each typed with a JSON type
 * the parameter can take. Other keywords (description, items, enum) and
 * tool-level properties are open, so a missing parameter is reported as such
 * rather than hidden behind excess-property errors on the rest of the literal.
 */
type ServiceProps<U> = {
  [K in InputKey<U>]:
    | TypedNode<JsonType<InputValue<U, K>>>
    | { readonly anyOf: readonly TypedNode<JsonType<InputValue<U, K>>>[]; readonly [keyword: string]: unknown }
} & { readonly [property: string]: unknown }

/** The JSON types a schema property declares: its `type`, or the `type` of every `anyOf` branch. */
type DeclaredTypes<P> = P extends { readonly type: infer T }
  ? T
  : P extends { readonly anyOf: readonly (infer B)[] }
    ? B extends { readonly type: infer T }
      ? T
      : never
    : never

/** The members of the parameter type `V` that none of the declared JSON types `D` can carry. */
type Uncovered<V, D> = V extends unknown ? ([Extract<JsonType<V>, D>] extends [never] ? V : never) : never

/** `never` for every advertised parameter whose schema cannot carry one of its type's members. */
type NoUncoveredMembers<P, U> = {
  readonly [K in Extract<keyof P, InputKey<U>> as [Uncovered<InputValue<U, K>, DeclaredTypes<P[K]>>] extends [never]
    ? never
    : K]: never
}

/** Tool-level properties `makeDomainRun` reads itself (response bounds) rather than the service. */
type FactoryProp = 'max_chars' | 'full'

/** `never` for every property of `P` that neither the service nor the factory reads. */
type NoUnreadProps<P, U> = { readonly [K in Exclude<keyof P, InputKey<U> | FactoryProp>]: never }

export function serviceInputProps<S, A extends readonly string[]>() {
  return <
    const P extends ServiceProps<ActionInput<S, A[number]>> &
      NoUnreadProps<P, ActionInput<S, A[number]>> &
      NoUncoveredMembers<P, ActionInput<S, A[number]>>
  >(
    props: P
  ): P => props
}
