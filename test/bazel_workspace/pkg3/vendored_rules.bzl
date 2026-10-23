"""Rules defined the way rules_rust defines them.

Every `attrs =` shape found in rules_rust appears here once so the
extension's tests can check keyword completion against each of them.
"""

load(":vendored_attrs.bzl", "COMMON_ATTRS", "RUSTC_ATTRS", "VendoredInfo")
load(":vendored_utils.bzl", "dedent")

_BINARY_ATTRS = {
    "linker_script": attr.label(doc = "Passed to the linker via `-C link-arg`."),
    "out_binary": attr.bool(doc = "Force a binary output."),
}

_TEST_ATTRS = {
    "crate": attr.label(doc = "Target inline tests are declared in."),
    "env": attr.string_dict(doc = "Environment for the test."),
} | {
    "use_libtest_harness": attr.bool(default = True, doc = "Use libtest."),
}

_WRAPPERLESS = {
    "wrapperless": attr.bool(doc = "No wrapper."),
}

def _common_attrs_for_binary_without_process_wrapper(attrs):
    new_attr = dict(attrs)
    new_attr["_process_wrapper"] = attr.label(default = None)
    new_attr["bootstrap"] = attr.bool(doc = "Bootstrap mode.")
    return new_attr

def _test_attrs_for_binary_without_process_wrapper(attrs):
    new_attrs = {}
    new_attrs.update(attrs)
    new_attrs["crate_root"] = attr.label(doc = "The crate root.")
    return new_attrs

def _impl(ctx):
    out = ctx.actions.declare_file(ctx.label.name)
    ctx.actions.write(out, "", is_executable = True)
    return [
        DefaultInfo(executable = out),
        VendoredInfo(aliases = {}, name = ctx.label.name, root = None),
    ]

vendored_library = rule(
    implementation = _impl,
    attrs = COMMON_ATTRS | {
        "disable_pipelining": attr.bool(
            default = False,
            doc = "Disables pipelining for this rule.",
        ),
    },
    doc = dedent("""\
        Builds a vendored library crate.

        Example:
          vendored_library(name = "hello_lib")
    """),
)

vendored_binary = rule(
    implementation = _impl,
    attrs = COMMON_ATTRS | _BINARY_ATTRS,
    executable = True,
    doc = "Builds a vendored binary crate.",
)

vendored_test = rule(
    implementation = _impl,
    attrs = COMMON_ATTRS | _TEST_ATTRS,
    test = True,
)

vendored_proc_macro = rule(
    implementation = _impl,
    attrs = {name: value for name, value in COMMON_ATTRS.items() if name != "deps"},
)

vendored_binary_without_process_wrapper = rule(
    implementation = _impl,
    attrs = _common_attrs_for_binary_without_process_wrapper(COMMON_ATTRS | _BINARY_ATTRS),
    executable = True,
)

vendored_library_without_process_wrapper = rule(
    implementation = _impl,
    attrs = dict(_common_attrs_for_binary_without_process_wrapper(COMMON_ATTRS).items()),
)

vendored_without_process_wrapper_test = rule(
    implementation = _impl,
    attrs = _test_attrs_for_binary_without_process_wrapper(COMMON_ATTRS | _TEST_ATTRS),
    test = True,
)

vendored_lint_test = rule(
    implementation = _impl,
    attrs = dict(_WRAPPERLESS, **{
        "targets": attr.label_list(doc = "Targets to lint."),
    }),
    test = True,
)

vendored_prost_library = rule(
    implementation = _impl,
    attrs = dict({
        "compile_well_known_types": attr.bool(doc = "Compile WKTs."),
    }),
)

_FROM_COMMON = {
    "manifests": COMMON_ATTRS["srcs"],
    "pinned": RUSTC_ATTRS["rustc_flags"],
}

vendored_tag = tag_class(
    attrs = {
        "cargo_lockfile": attr.label(doc = "The lockfile."),
    } | _FROM_COMMON,
)

def vendored_test_suite(name, srcs, shared_srcs = [], **kwargs):
    """Generates a test target for each source file.

    Args:
        name: The name of the test suite.
        srcs: All test sources, typically `glob(["tests/**/*.rs"])`.
        shared_srcs: Shared source files included in every test.
        **kwargs: Additional keyword arguments for the underlying
            vendored_test targets.
    """
    tests = []
    for src in srcs:
        test_name = name + "_" + src.replace("/", "_")
        tests.append(test_name)
        vendored_test(
            name = test_name,
            srcs = [src] + shared_srcs,
            tags = ["suite"],
            **kwargs
        )
    native.test_suite(name = name, tests = tests)

vendored_common = struct(
    crate_info = VendoredInfo,
    create_crate_info = _impl,
    default_version = "1.0",
)
