"""Rule implementations mirroring `cc/private/rules_impl` in rules_cc."""

load(
    ":vendored_cc_attrs.bzl",
    "cc_binary_attrs",
    "cc_test_attrs",
    "common_attrs",
    "objc_attrs",
)

VendoredCcInfo, _new_vendored_cc_info = provider(
    "A provider with a positional doc and an init, as CcInfo has.",
    fields = ["compilation_context", "linking_context"],
    init = lambda compilation_context = None, linking_context = None: {
        "compilation_context": compilation_context,
        "linking_context": linking_context,
    },
)

def _impl(ctx):
    out = ctx.actions.declare_file(ctx.label.name)
    ctx.actions.write(out, "", is_executable = True)
    return [DefaultInfo(executable = out)]

vendored_cc_binary = rule(
    implementation = _impl,
    attrs = cc_binary_attrs | {"_impl_delegate": attr.label(
        default = Label("//pkg3:data"),
    )},
    executable = True,
    doc = "Produces a vendored binary.",
)

vendored_cc_library = rule(
    implementation = _impl,
    attrs = common_attrs | {
        "alwayslink": attr.bool(doc = "Link all object files."),
    },
)

vendored_cc_test = rule(
    implementation = _impl,
    attrs = cc_test_attrs | {
        "licenses": attr.license() if hasattr(attr, "license") else attr.string_list(),
    },
    test = True,
)

# Rule arguments assembled in a dict and splatted, as objc_library does.
OBJC_LIBRARY_RULE_KWARGS = dict(
    implementation = _impl,
    doc = "Produces a vendored Objective-C library.",
    attrs = objc_attrs.union(
        {
            "data": attr.label_list(allow_files = True),
        },
        objc_attrs.COMPILING_RULE,
        objc_attrs.COPTS_RULE,
        objc_attrs.LICENSES,
    ),
)

vendored_objc_library = rule(
    **OBJC_LIBRARY_RULE_KWARGS
)
