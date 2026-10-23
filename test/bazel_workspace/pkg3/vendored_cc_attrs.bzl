"""Attribute dictionaries assembled the way rules_cc assembles them."""

load(":vendored_semantics.bzl", "semantics")

common_attrs = {
    "srcs": attr.label_list(
        allow_files = True,
        doc = """
The list of C and C++ files that are processed to create the target.
""",
    ),
    "hdrs": attr.label_list(allow_files = True, doc = "Header files."),
} | semantics.allowlist_attrs

stamp_doc = """
Whether to encode build information into the binary.
""" + semantics.stamp_extra_docs

def get_postmark_attrs():
    return {
        "_postmark": attr.label(default = Label("//pkg3:data")),
        "postmark_enabled": attr.bool(doc = "Whether postmark runs."),
    }

dynamic_deps_attrs = {
    "dynamic_deps": attr.label_list(doc = "Shared libraries linked dynamically."),
}

cc_binary_attrs = common_attrs | get_postmark_attrs() | {
    "deps": attr.label_list(
        allow_rules = semantics.ALLOWED_RULES_IN_DEPS,
        doc = "Other libraries to link into the binary.",
    ),
    "stamp": attr.int(doc = stamp_doc, default = -1),
    "_stl": semantics.get_stl(),
}

cc_binary_attrs.update(dynamic_deps_attrs)

def _union(*dictionaries):
    result = {}
    for dictionary in dictionaries:
        result.update(dictionary)
    return result

def _get_compiling_rule_attrs():
    attrs = {
        "copts": attr.string_list(doc = "Compiler options."),
    }
    attrs["defines"] = attr.string_list(doc = "Preprocessor defines.")
    if semantics.is_enable_modules_attr_allowed:
        attrs["enable_modules"] = attr.bool(doc = "Enables clang modules.")
    if semantics.is_module_map_attr_allowed:
        attrs["module_map"] = attr.label(doc = "A custom module map.")
    return attrs

# The test-rule dictionary is a mutated copy, as in rules_cc's cc_test.bzl.
cc_test_attrs = dict(cc_binary_attrs)

cc_test_attrs.update(
    _is_test = attr.bool(default = True),
    linkstatic = attr.bool(doc = "Link statically.", default = False),
)

cc_test_attrs.update(semantics.get_licenses_attr())

objc_attrs = struct(
    union = _union,
    COMPILING_RULE = _get_compiling_rule_attrs(),
    LICENSES = semantics.get_licenses_attr(),
    COPTS_RULE = {
        "conlyopts": attr.string_list(doc = "C-only options."),
    },
)
