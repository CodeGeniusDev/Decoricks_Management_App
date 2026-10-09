#!/usr/bin/env python3
"""
Injects the central authorization gate into every existing Phase 1 API route.

Two mechanical edits per handler:
  1. Rename `export async function GET` -> `async function __GET` and append
     `export const GET = withAuth(__GET)`. This leaves the handler body and its
     existing catch block untouched while still mapping thrown
     AuthenticationError/AuthorizationError to 401/403 — without it, an
     authorization failure would be swallowed by the route's generic
     `errorResponse(..., 500)` and SPEC Test 4/5/6 would see 500 instead of 403.
  2. Insert the `authorize(...)` call as the first statement of the handler, so
     it runs before any database read or write.
"""

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
API = ROOT / "src" / "app" / "api"

# (route file, {METHOD: (module, action)})  -- "all" = aggregate views helper
PLAN = {
    "budgets/route.ts": {"GET": ("budget", "view"), "POST": ("budget", "create")},
    "budgets/[id]/route.ts": {
        "GET": ("budget", "view"),
        "PUT": ("budget", "edit"),
        "DELETE": ("budget", "delete"),
    },
    "chat/route.ts": {"GET": ("chat", "view"), "POST": ("chat", "create")},
    "dashboard/summary/route.ts": {"GET": ("all", ["finance", "inventory", "sales", "tasks"])},
    "finance/route.ts": {"GET": ("finance", "view"), "POST": ("finance", "create")},
    "finance/[type]/[id]/route.ts": {"PUT": ("finance", "edit"), "DELETE": ("finance", "delete")},
    "finance/summary/route.ts": {"GET": ("finance", "view")},
    "orders/route.ts": {"GET": ("sales", "view"), "POST": ("sales", "create")},
    "orders/[id]/route.ts": {
        "GET": ("sales", "view"),
        "PATCH": ("sales", "edit"),
        "PUT": ("__scoped_sales_full_edit__", None),
        "DELETE": ("sales", "delete"),
    },
    "products/route.ts": {"GET": ("inventory", "view"), "POST": ("inventory", "create")},
    "products/[id]/route.ts": {
        "GET": ("inventory", "view"),
        "PUT": ("inventory", "edit"),
        "DELETE": ("inventory", "delete"),
    },
    "reports/period/route.ts": {"GET": ("all", ["finance", "inventory", "sales", "tasks"])},
    "stock/route.ts": {"GET": ("inventory", "view")},
    "suppliers/route.ts": {"GET": ("suppliers", "view"), "POST": ("suppliers", "create")},
    "suppliers/[id]/route.ts": {
        "GET": ("suppliers", "view"),
        "PUT": ("suppliers", "edit"),
        "DELETE": ("suppliers", "delete"),
    },
    "tasks/route.ts": {"GET": ("tasks", "view"), "POST": ("tasks", "create")},
    "tasks/[id]/route.ts": {
        "GET": ("tasks", "view"),
        "PUT": ("tasks", "edit"),
        "PATCH": ("tasks", "edit"),
        "DELETE": ("tasks", "delete"),
    },
}

# Health check stays open so uptime probes keep working (SPEC §8.5).
SKIP = {"health/route.ts"}

AUTH_IMPORTS = {
    "plain": "import { authorize } from '@/lib/authorization'",
    "all": (
        "import { authorizeAllViews } from '@/lib/authorization'"
    ),
    "lahore": (
        "import { authorize, canRecordLahoreStock } from '@/lib/authorization'"
    ),
    "scoped_sales": (
        "import { hasScopedGrant, SCOPED_SALES_FULL_EDIT } from '@/lib/authorization'"
    ),
}

HTTP_IMPORT = "import { withAuth } from '@/lib/http'"

GUARD = {
    "plain": lambda m, a: f"    await authorize('{m}', '{a}')",
    "all": lambda m, a: f"    await authorizeAllViews({a!r})",
    "lahore": lambda m, a: (
        "    // SPEC §4.2 Inventory: Hasnat/Ali have inventory.create = false but may\n"
        "    // \"record Lahore stock movements\". Allow either the generic grant or\n"
        "    // that scoped exception, and audit which path granted it.\n"
        "    const auth = await authorize('inventory', 'create', { suppressAudit: true })\n"
        "    if (!(await canRecordLahoreStock(auth.user.role))) {\n"
        "      await authorize('inventory', 'create')\n"
        "    }"
    ),
    "scoped_sales": lambda m, a: (
        "    // SPEC §4.2 Sales Edit for Hasnat covers delivery outcomes/returns only,\n"
        "    // not order contents, customer details or pricing.\n"
        "    const auth = await authorize('sales', 'edit', { suppressAudit: true })\n"
        "    if (!(await hasScopedGrant(auth.user.role, SCOPED_SALES_FULL_EDIT))) {\n"
        "      await authorize('sales', 'edit')\n"
        "    }"
    ),
}


def guard_for(kind):
    if kind == "all":
        return "all"
    if kind == "__lahore_stock__":
        return "lahore"
    if kind == "__scoped_sales_full_edit__":
        return "scoped_sales"
    return "plain"


def patch(rel_path, methods):
    path = API / rel_path
    src = path.read_text()
    original = src
    needed_kinds = set()

    for method, spec in methods.items():
        kind = guard_for(spec[0])
        needed_kinds.add(kind)

        # Rename the exported handler so we can re-export it wrapped.
        pattern = re.compile(rf"^export async function {method}\(", re.M)
        if not pattern.search(src):
            print(f"  !! {rel_path}: no exported {method} found")
            continue
        src = pattern.sub(f"async function __{method}(", src, count=1)

        # Insert the guard as the first statement inside `try {`.
        # Anchor on the renamed signature through to its `try {`.
        idx = src.index(f"async function __{method}(")
        try_idx = src.index("  try {", idx)
        insert_at = try_idx + len("  try {")
        guard = GUARD[kind](spec[0], spec[1])
        src = src[:insert_at] + "\n" + guard + "\n" + src[insert_at:]

    # Add imports.
    imports = []
    if "plain" in needed_kinds:
        imports.append(AUTH_IMPORTS["plain"])
    if "all" in needed_kinds:
        imports.append(AUTH_IMPORTS["all"])
    if "lahore" in needed_kinds:
        imports.append(AUTH_IMPORTS["lahore"])
    if "scoped_sales" in needed_kinds:
        imports.append(AUTH_IMPORTS["scoped_sales"])
    for imp in imports:
        if imp not in src:
            src = imp + "\n" + src
    if HTTP_IMPORT not in src:
        src = HTTP_IMPORT + "\n" + src

    # Append the wrapped re-exports.
    exports = "\n".join(f"export const {m} = withAuth(_{m})" for m in methods)
    src = src.rstrip() + "\n\n" + exports + "\n"

    if src != original:
        path.write_text(src)
        return True
    return False


def main():
    changed = 0
    for rel, methods in PLAN.items():
        if rel in SKIP:
            continue
        if patch(rel, methods):
            print(f"  patched {rel}")
            changed += 1
    print(f"{changed} route files patched.")


if __name__ == "__main__":
    sys.exit(main())