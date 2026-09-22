# Development Process

Guidelines for the iterative process of generating code — e.g. building a feature layer by layer,
TDD-style. These are about *how* code gets built up over a session, not what the resulting code
should look like (see `STYLE.md` for that).

## Layer boundaries

When a layer of the program is already complete, do not modify it while generating a layer that
depends on it. For example: if the domain layer is done, do not modify it while generating the
HTTP/REST API layer that calls into it.

If it appears there is no way to implement the new layer without changing a completed layer, stop
and explain, rather than making the change:

- What the problem is — the specific way the completed layer doesn't support what the new layer
  needs.
- Why a change to the completed layer seems necessary — why the new layer can't be built against
  it as it stands.

Then give the option to provide an alternative solution before proceeding with any change to the
completed layer.
