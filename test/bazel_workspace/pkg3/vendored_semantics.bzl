"""A `semantics` struct mirroring `cc/common/semantics.bzl` in rules_cc.

Rulesets use such a struct to swap attribute dictionaries, documentation
fragments and attribute factories between internal and external builds.
"""

def _get_stl():
    return attr.label(default = Label("//pkg3:data"))

def _get_licenses_attr():
    return {
        "licenses": attr.license() if hasattr(attr, "license") else attr.string_list(),
    }

semantics = struct(
    allowlist_attrs = {
        "_semantics_tool": attr.label(
            default = Label("//pkg3:data"),
        ),
        "allowlisted_extra": attr.string(doc = "Comes from the semantics struct."),
    },
    stamp_extra_docs = " Extra documentation appended by semantics.",
    get_stl = _get_stl,
    get_licenses_attr = _get_licenses_attr,
    ALLOWED_RULES_IN_DEPS = ["vendored_library"],
    is_enable_modules_attr_allowed = True,
    is_module_map_attr_allowed = False,
)
