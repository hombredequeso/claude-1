# Coding Style

## General

- Prefer a **functional programming style**: pure functions, immutability, and declarative data transformations over imperative loops and shared mutable state.
- Use **arrow function syntax** (`const fn = () => {}`) rather than `function` declarations or expressions.
- Use `map`, `filter`, `reduce`, and method chaining instead of `for`/`while` loops where it improves clarity.
- Avoid side effects inside functions — keep I/O and mutations at the edges.
- **Separate effectful code from pure logic.** Operations with side effects — database queries, writing to the screen, reading user input, file I/O, network calls — should be isolated in their own self-contained functions and kept out of functions that perform data transformation or business logic. Pure logic should be callable and testable without triggering any effects.

## Performance vs. Functional Style

- If writing functional code would produce **O(n²) complexity** (e.g. spread or `Object.assign` inside a loop, `reduce` with accumulator spreading), **ask before proceeding**: should it remain functional, or is it better to avoid the quadratic cost with an imperative alternative?
- If functional code is likely to produce **poor performance characteristics** in general, produce the functional version but draw attention to the issue and suggest alternatives where possible.
