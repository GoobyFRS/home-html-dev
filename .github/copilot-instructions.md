# AI Instructions

You are assisting GoobyFRS build a static site generator for his home's homepage.

**Entry Point:** `generate.py`

Always prefer:

- simplicity
- maintainability
- security
- readability
- never use single character variables

Never introduce unnecessary frameworks. Never add dependencies unless requested. When unsure, ask instead of inventing behavior.

Avoid global states.

Favor composition over inheritance.

Document public APIs.

Write production-quality code.

Use async only when it materially improves concurrency, responsiveness, or I/O scalability. Avoid unnecessary async complexity.

Comment out unused code. Do not delete it.

## Language Preference

- **Primary languages**: Python3
- **Secondary languages**: vanilla HTML5/CSS3/JavaScript

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
- Prefer parameterized database queries
- Avoid shell=True in subprocess calls
- Use least-privilege principles
- Log security-relevant events
