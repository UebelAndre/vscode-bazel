"""A module extension and repository rule, as a ruleset would define them."""

def _vendored_repo_impl(repository_ctx):
    repository_ctx.file("BUILD.bazel", "")
    repository_ctx.file(
        "defs.bzl",
        "VENDORED_VALUE = %r\n" % repository_ctx.attr.value,
    )

vendored_repo = repository_rule(
    implementation = _vendored_repo_impl,
    doc = "Writes a repository holding a constant.",
    attrs = {
        "value": attr.string(doc = "The constant to write.", mandatory = True),
    },
)

_parse = tag_class(
    doc = "Parses a requirements lock file into a hub repository.",
    attrs = {
        "name": attr.string(doc = "Name of the hub repository.", mandatory = True),
        "requirements_lock": attr.label(doc = "The lock file."),
        "extra_pip_args": attr.string_list(doc = "Extra arguments for pip."),
    },
)

def _requirements_impl(module_ctx):
    for mod in module_ctx.modules:
        for parse in mod.tags.parse:
            vendored_repo(name = parse.name, value = str(parse.requirements_lock))

requirements = module_extension(
    implementation = _requirements_impl,
    doc = "Resolves Python requirements.",
    tag_classes = {
        "parse": _parse,
        "annotate": tag_class(
            attrs = {
                "package": attr.string(doc = "Package to annotate."),
                "copts": attr.string_list(),
            },
        ),
    },
)
