"""Public wrappers mirroring `cc/cc_binary.bzl` and friends in rules_cc."""

load(
    ":vendored_cc_proxy.bzl",
    _vendored_cc_binary = "vendored_cc_binary",
    _vendored_cc_library = "vendored_cc_library",
    _vendored_cc_test = "vendored_cc_test",
    _vendored_objc_library = "vendored_objc_library",
)

def vendored_cc_binary(**attrs):
    _vendored_cc_binary(**attrs)

def vendored_cc_test(**kwargs):
    _vendored_cc_test(**kwargs)

def vendored_objc_library(**kwargs):
    _vendored_objc_library(**kwargs)

vendored_cc_library = _vendored_cc_library
