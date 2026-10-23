"""Re-export layer standing in for rules_cc's compatibility proxy repository."""

load(
    ":vendored_cc_rules.bzl",
    _vendored_cc_binary = "vendored_cc_binary",
    _vendored_cc_library = "vendored_cc_library",
    _vendored_cc_test = "vendored_cc_test",
    _vendored_objc_library = "vendored_objc_library",
)

vendored_cc_binary = _vendored_cc_binary
vendored_cc_library = _vendored_cc_library
vendored_cc_test = _vendored_cc_test
vendored_objc_library = _vendored_objc_library
