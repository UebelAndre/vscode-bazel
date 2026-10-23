"""A module extension creating repositories for the extension's own tests.

It writes two tiny repositories without touching the network: `hub`, whose
BUILD file refers to `spoke`, and `spoke`. The main module imports `spoke`
under a different name (see MODULE.bazel) so that tests exercise repository
mapping rather than directory names.
"""

def _fixture_repo_impl(repository_ctx):
    repository_ctx.file("BUILD.bazel", repository_ctx.attr.build_file_content)
    repository_ctx.file("defs.bzl", repository_ctx.attr.defs_content)

_fixture_repo = repository_rule(
    implementation = _fixture_repo_impl,
    attrs = {
        "build_file_content": attr.string(),
        "defs_content": attr.string(),
    },
)

_HUB_BUILD = """\
load(":defs.bzl", "hub_macro")

alias(
    name = "thing",
    actual = "@spoke//:thing",
    visibility = ["//visibility:public"],
)

hub_macro(name = "from_macro")
"""

_HUB_DEFS = '''\
"""Definitions of the hub test repository."""

def hub_macro(name):
    """Creates a filegroup named `name`."""
    native.filegroup(name = name, visibility = ["//visibility:public"])
'''

_SPOKE_BUILD = """\
filegroup(
    name = "thing",
    visibility = ["//visibility:public"],
)
"""

def _fixture_repos_impl(_module_ctx):
    _fixture_repo(
        name = "hub",
        build_file_content = _HUB_BUILD,
        defs_content = _HUB_DEFS,
    )
    _fixture_repo(
        name = "spoke",
        build_file_content = _SPOKE_BUILD,
        defs_content = "",
    )

fixture_repos = module_extension(implementation = _fixture_repos_impl)
