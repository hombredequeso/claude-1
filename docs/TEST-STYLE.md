# Unit Test Style

## Assertions

- Do not test object properties individually. Prefer `toStrictEqual` to compare the whole object (or array) in one assertion, rather than asserting each field separately.
