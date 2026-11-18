# AI Instructions

You are assisting GoobyFRS build a static site generator for his home's homepage.

**Entry Point:** `generate.py`

Always prefer:

- simplicity
- maintainability
- security
- readability

- Never use single character variables
- Never introduce unnecessary frameworks. Never add dependencies unless requested. When unsure, ask instead of inventing behavior.
- Avoid global states.
- Favor composition over inheritance.
- Document public APIs.
- Write production-quality code.
- Use async only when it materially improves concurrency, responsiveness, or I/O scalability. Avoid unnecessary async complexity.
- Comment out unused code. Do not delete it.

## Language Preference

- **Primary languages**: vanilla HTML5/CSS3/JavaScript
- **Secondary languages**: Python3

### Naming Conventions

| Type | Convention | Example |
| --- | --- | --- |
| Variables | `snake_case` | `user_count`, `total_items` |
| Constants | `UPPERCASE` | `MAX_RETRIES`, `API_BASE_URL` |
| Functions | `snake_case` | `get_user_data()`, `calculate_total()` |
| Classes | `PascalCase` | `UsercodeManager`, `DataProcessor` |
| Private/Internal | `_leading_underscore` | `_internal_helper()`, `_cache` |
| Ignored variables | `_` prefix | `for _ in range(10)`, `x, _ = get_pair()` |
| Module constants | `SCREAMING_SNAKE_CASE` | `DEFAULT_TIMEOUT = 30` |

### Security Requirements

- Never hardcode secrets
- Use environment variables for configuration
- Validate all user input
- Escape or sanitize rendered content
- Avoid shell=True in subprocess calls
- Log security-relevant events

### Logging

- Use structured logging where practical
- Never log secrets or credentials
- Include contextual identifiers in logs
- Prefer informative warnings/errors over generic messages

### Function Guidelines

- Use descriptive names that indicate purpose
- Prefer pure functions where possible
- Use type hints as often as reasonably possible but also remain human readable.
- **Maximum nesting depth**: 4 levels
- Use early returns, guard clauses, and extraction to reduce nesting
- Prefer flat over nested
- Handle `None` explicitly - don't let it propagate silently
- Use type hints to make return types explicit
- Declare variables **as close to first use** as possible
- Avoid module-level mutable state
- Use local variables over instance variables when possible
- Delete references to large objects when no longer needed
- All loops must have a **deterministic, verifiable upper bound** unless the loop is part of a long-running service worker
with explicit cancellation or timeout handling.
- Avoid `while True` without clear, guaranteed exit conditions
- Use `for` loops with explicit ranges when possible
- **No recursion** in production code (direct or indirect)
- Avoid complex control flow that's hard to trace
- Use iteration instead of recursion; if recursion is unavoidable, add explicit depth limits

### Docstrings

- Use **Google style** docstrings
- Required for public functions, classes, and modules
- Include: summary, args, returns, raises (when applicable)
- Use `Args:` for parameters, `Returns:` for return values, and `Raises:` for exceptions
- Include type hints in the docstring if not present in the function signature.
