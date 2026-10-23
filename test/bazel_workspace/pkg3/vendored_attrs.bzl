"""Attribute dictionaries composed the way rules_rust composes them.

These exist to check that the extension's static evaluation of `attrs`
follows the idioms used in real rulesets: shared dictionaries, `|` unions,
attribute factories, constructor aliases and `dedent()`-wrapped docs.
"""

load(":vendored_utils.bzl", "dedent")

VendoredInfo = provider(
    doc = "A provider describing a vendored crate.",
    fields = {
        "aliases": "Dict[Target, String]: Renamed and aliased crates",
        "name": (
            "str: The name of this crate, which may differ " +
            "from the target name."
        ),
        "root": "File: The source File entrypoint to this crate.",
    },
)

_EDITIONS = ["2015", "2018", "2021"]

RUSTC_ATTRS = {
    "_process_wrapper": attr.label(
        default = Label("//pkg3:data"),
        cfg = "exec",
    ),
    "rustc_flags": attr.string_list(
        doc = dedent("""\
            List of compiler flags passed to `rustc`.

            These strings are subject to Make variable expansion.
        """),
    ),
}

def _stamp_attribute(default_value):
    return attr.int(
        doc = dedent("""\
            Whether to encode build information into the output.
        """),
        default = default_value,
        values = [1, 0, -1],
    )

_relative_label_list = attr.string_list

COMMON_ATTRS = {
    "crate_name": attr.string(
        doc = (
            "Crate name to use for this target. " +
            "Defaults to the target name."
        ),
    ),
    "deps": attr.label_list(
        doc = "List of other libraries to be linked to this library target.",
        providers = [[VendoredInfo]],
    ),
    "edition": attr.string(
        doc = "The rust edition to use for this crate. Allowed: {}".format(_EDITIONS),
    ),
    "extra": _relative_label_list(doc = "Extra things."),
    "srcs": attr.label_list(
        doc = """List of `.rs` source files used to build the library.""",
        allow_files = True,
        mandatory = True,
    ),
    "stamp": _stamp_attribute(default_value = 0),
} | RUSTC_ATTRS
