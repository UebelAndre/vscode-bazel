"""Starlark definitions used by the language support tests."""

def _my_test_impl(ctx):
    out = ctx.actions.declare_file(ctx.label.name)
    ctx.actions.write(out, "", is_executable = True)
    return [DefaultInfo(executable = out)]

my_test = rule(
    implementation = _my_test_impl,
    doc = "A test rule used by the extension's tests.",
    test = True,
)

def my_macro(name, **kwargs):
    """A macro that creates a filegroup and a generated companion target.

    Args:
        name: The name of the main target.
        **kwargs: Passed through to the filegroup.
    """
    native.filegroup(name = name, **kwargs)
    native.filegroup(name = name + "_gen", srcs = [])
