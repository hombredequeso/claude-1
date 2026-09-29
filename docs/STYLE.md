# Coding Style

## General

- Prefer a **functional programming style**: pure functions, immutability, and declarative data transformations over imperative loops and shared mutable state.
- Use **arrow function syntax** (`const fn = () => {}`) rather than `function` declarations or expressions.
- Use `map`, `filter`, `reduce`, and method chaining instead of `for`/`while` loops where it improves clarity.
- Avoid side effects inside functions — keep I/O and mutations at the edges.
- **Separate effectful code from pure logic.** Operations with side effects — database queries, writing to the screen, reading user input, file I/O, network calls — should be isolated in their own self-contained functions and kept out of functions that perform data transformation or business logic. Pure logic should be callable and testable without triggering any effects.

## Referential transparency

- Domain entities and their operations must be **referentially transparent**: given the same inputs, they must always produce the same outputs, with no hidden reliance on ambient/global state.
- Do not call non-deterministic or impure sources (system clock, GUID generation, random number generators, environment variables, etc.) directly from domain code. Instead, pass in a function that provides the value (e.g. `getCurrentTime: () => Date`, `generateId: () => string`) as a parameter, and have the caller supply the real implementation.
- This applies to any operation whose result would otherwise vary between calls with identical arguments — not just I/O in the traditional sense.

## Functional core, imperative shell

- Where simplicity allows, push impure/effectful operations to the boundaries of the code and keep domain logic pure. Structure operations as:
  1. **Effectful setup** — perform impure/effectful operations to gather the data required for the operation (reads, current time, generated IDs, etc.).
  2. **Pure domain logic** — perform the actual business logic as pure, referentially transparent domain operations over that data.
  3. **Effectful commit** — perform impure/effectful operations to apply the result (typically writes/updates to databases or other external systems).
- Don't force this shape where it adds complexity beyond what the operation warrants — apply it where it keeps domain logic simple and testable, not as a rigid rule for every function.

## Performance vs. Functional Style

- If writing functional code would produce **O(n²) complexity** (e.g. spread or `Object.assign` inside a loop, `reduce` with accumulator spreading), **ask before proceeding**: should it remain functional, or is it better to avoid the quadratic cost with an imperative alternative?
- If functional code is likely to produce **poor performance characteristics** in general, produce the functional version but draw attention to the issue and suggest alternatives where possible.

## Errors

- Do not throw exceptions on errors. Instead, use algebraic types (discriminated unions) to return all possible error cases as values alongside the success case.
- A function's return type should express only the outcomes it can actually produce. Don't include
  an error case in a result union unless the function can return it.

## Discriminated unions

- When code needs to determine which member of an algebraic/union type a value is, do not use type guard functions. Instead, give every member a property named `kind` holding the type's name, and switch/branch on `kind`.

## Avoid behavior-parameter indirection

- Don't extract a shared function whose job is to call *another function passed into it* (e.g. a domain operation) just to remove duplication between similar call sites — e.g. `applyTransition(ctx, store, cancelOrder)` called from several routes. This smuggles the actual operation in as a parameter, so no single call site shows what happens — you have to open the shared function to find out, and every call site becomes coupled to it.
- Call the operation directly at its call site instead, even if that means a route handler, use case, or similar entry point ends up structurally similar to its siblings. A reader should be able to see what happens by reading the call site itself, not by tracing into a shared dispatcher.
- If call sites share real boilerplate, extract small, targeted functions over *data* — looking up a record, rendering a response, shaping a result — not over *behavior*. A shared helper may take a value or a result to act on; it should not take a function representing "the operation to perform."
- Some duplication across call sites (e.g. repeating a `store.save` call or a `switch` over a result's `kind`) is expected and preferable to this kind of coupling. Compose the small data-oriented helpers directly in each call site rather than routing every case through one shared function.

## Object construction

- Do not use spread operators. Assign each property explicitly, so every field on the resulting object is visible at the construction site.

## Type casting

- Avoid casting types (`as`, `<Type>value`). Check types explicitly at boundaries instead — e.g. parse and validate an HTTP response body immediately on receipt — so that later code works with an already-verified type and casting is never needed.

## null vs. undefined

- Prefer `null` over `undefined` when the absence of a value is known — i.e. it has been determined that there is no value.
- Use `undefined` only when required by an underlying library or JavaScript construct (e.g. optional object properties, function arguments), or when it specifically carries the meaning that it is *unknown* whether a value exists.
